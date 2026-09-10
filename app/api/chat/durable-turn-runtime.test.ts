import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import * as Sentry from "@sentry/nextjs"
import type { TextStreamPart, ToolSet, UIMessage } from "ai"
import { fetchMutation as moduleFetchMutation } from "convex/nextjs"
import { getFunctionName } from "convex/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createConvexDurableTurn,
  createGuestDurableTurn,
  createHttpDurableWorkerWire,
  DurableWorkerWriteError,
  type DurableTurnInput,
  type DurableWorkerCall,
  type DurableWorkerWire,
  type ToolFacts,
} from "./durable-turn-runtime"

const startedTextStreams = new WeakSet<object>()
function emitTextChunk(stream: { onChunk: (chunk: TextStreamPart<ToolSet>) => unknown }, text: string) {
  if (!startedTextStreams.has(stream)) {
    startedTextStreams.add(stream)
    stream.onChunk({ type: "text-start", id: "text-1" })
  }
  return stream.onChunk({ type: "text-delta", id: "text-1", text })
}

// Durable turn runtime — the interface IS the test surface (ADR-0009/0011).
// The module default `fetchMutation` is never used by the Convex adapter (it
// injects deps.fetchMutation) nor the guest adapter (no network) — mock it so
// guest inertness can assert zero calls against the default.
vi.mock("convex/nextjs", () => ({
  fetchMutation: vi.fn(),
  fetchQuery: vi.fn(),
}))

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
}))

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function nameOf(ref: unknown): string {
  try {
    return getFunctionName(ref as Parameters<typeof getFunctionName>[0])
  } catch {
    return "<unknown>"
  }
}

function sameRef(a: unknown, b: unknown): boolean {
  return nameOf(a) === nameOf(b)
}

/** A stored Convex `messages` doc shaped for the durable-prepare return path. */
function makeStoredUserMessage() {
  return {
    _id: "usermsg1",
    _creationTime: 100,
    chatId: "chat_1",
    orderId: 0,
    role: "user",
    content: "What is the weather?",
    parts: [{ type: "text", text: "What is the weather?" }],
    createdAt: 100,
    updatedAt: 200,
    status: "completed",
    metadata: {},
  }
}

type PrepareResult = {
  runId: string
  assistantMessageId: string
  messages: unknown[]
}

/**
 * A recording fetchMutation for the ONE remaining user-token call: resolves
 * `prepareGeneration` to a run descriptor, lets callers override its outcome.
 */
function makeRecordingFetchMutation(
  overrides: {
    prepareResult?: PrepareResult
    prepareResponder?: (args: unknown) => unknown | Promise<unknown>
  } = {}
) {
  const prepareResult: PrepareResult = overrides.prepareResult ?? {
    runId: "run1",
    assistantMessageId: "msg1",
    messages: [makeStoredUserMessage()],
  }
  return vi.fn(async (ref: unknown, args: unknown, opts?: unknown) => {
    void opts
    if (sameRef(ref, api.chatRuntime.prepareGeneration)) {
      if (overrides.prepareResponder) return overrides.prepareResponder(args)
      return prepareResult
    }
    return undefined
  })
}

type RecordingWire = DurableWorkerWire & {
  calls: DurableWorkerCall[]
}

/**
 * A recording Durable worker wire — the ADR-0011 test seam. Records every
 * `{ op, args }` in order; per-op responders override outcomes.
 */
function makeRecordingWire(
  overrides: {
    responders?: Partial<
      Record<string, (args: Record<string, unknown>) => unknown>
    >
  } = {}
): RecordingWire {
  const calls: DurableWorkerCall[] = []
  const wire = (async (call: DurableWorkerCall) => {
    calls.push(call)
    const responder = overrides.responders?.[call.op]
    if (responder) return responder(call.args)
    return undefined
  }) as RecordingWire
  wire.calls = calls
  return wire
}

function wireCalls<Op extends DurableWorkerCall["op"]>(
  wire: RecordingWire,
  op: Op
) {
  return wire.calls.filter(
    (call): call is Extract<DurableWorkerCall, { op: Op }> => call.op === op
  )
}

function orderedOps(wire: RecordingWire): string[] {
  return wire.calls.map((call) => call.op)
}

function makeInput(
  overrides: Partial<DurableTurnInput> = {}
): DurableTurnInput {
  return {
    chatId: "convexchatid000000000000",
    requestId: "req-1",
    model: "test-model",
    messages: [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
    ] as UIMessage[],
    isAuthenticated: true,
    convexToken: "tok",
    ...overrides,
  }
}

function makeToolFacts(overrides: Partial<ToolFacts> = {}): ToolFacts {
  return {
    metadata: { source: () => "mcp" },
    approvalFor: (name: string) =>
      name === "send_email"
        ? { needsApproval: true, riskClass: "external_write", reason: "risk" }
        : undefined,
    toolApproval: { send_email: "user-approval" },
    ...overrides,
  }
}

function makeConvexTurn(
  input: DurableTurnInput & { convexToken: string },
  fetchMutation: ReturnType<typeof vi.fn>,
  wire: RecordingWire
) {
  return createConvexDurableTurn({
    input,
    deps: {
      fetchMutation:
        fetchMutation as unknown as typeof import("convex/nextjs").fetchMutation,
      workerWire: wire,
      settleRetryDelaysMs: [0, 0],
      admissionProofSigner: () => "f".repeat(64),
    },
  })
}

async function makePreparedTurn(
  options: {
    input?: Partial<DurableTurnInput>
    wire?: RecordingWire
    fetchMutation?: ReturnType<typeof vi.fn>
  } = {}
) {
  const wire = options.wire ?? makeRecordingWire()
  const fetchMutation = options.fetchMutation ?? makeRecordingFetchMutation()
  const turn = makeConvexTurn(
    makeInput(options.input) as DurableTurnInput & { convexToken: string },
    fetchMutation,
    wire
  )
  await turn.prepare({ provider: "anthropic" })
  return { turn, wire, fetchMutation }
}

const RESPONSE_MESSAGE = {
  id: "msg1",
  role: "assistant",
  parts: [{ type: "text", text: "done" }],
  metadata: {},
} as unknown as UIMessage

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe("durable worker HTTP transport", () => {
  it("uses the generated Convex site URL for local worker writes", async () => {
    vi.stubEnv("CONVEX_SITE_URL", "")
    vi.stubEnv("NEXT_PUBLIC_CONVEX_SITE_URL", "http://127.0.0.1:3211")
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "http://127.0.0.1:3210")
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true })))
    const wire = createHttpDurableWorkerWire({
      secret: "grant-secret",
      fetchImpl,
    })

    await wire({
      op: "markGenerationRunAborted",
      args: { runId: "run_1" as Id<"generationRuns"> },
    })

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:3211/chat-turn/worker",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer grant-secret",
        }),
      })
    )
  })

  it("derives the default hosted site URL when no site URL is available", async () => {
    vi.stubEnv("CONVEX_SITE_URL", "")
    vi.stubEnv("NEXT_PUBLIC_CONVEX_SITE_URL", "")
    vi.stubEnv(
      "NEXT_PUBLIC_CONVEX_URL",
      "https://happy-animal-123.convex.cloud"
    )
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true })))
    const wire = createHttpDurableWorkerWire({
      secret: "grant-secret",
      fetchImpl,
    })

    await wire({
      op: "markGenerationRunAborted",
      args: { runId: "run_1" as Id<"generationRuns"> },
    })

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://happy-animal-123.convex.site/chat-turn/worker",
      expect.anything()
    )
  })
})

describe("durable turn runtime — handoff loud-miss", () => {
  it("settle without captureFinish warns + Sentry, still completes with countToolParts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const { turn, wire } = await makePreparedTurn()
      const binding = turn.bind(makeToolFacts())

      // No captureFinish() — the missed handoff. The response message carries
      // two tool parts (one errored) so the part-counted fallback yields {2,1}.
      const responseMessage = {
        id: "msg1",
        role: "assistant",
        parts: [
          { type: "text", text: "done" },
          {
            type: "tool-get_weather",
            toolCallId: "c1",
            state: "output-available",
            input: {},
            output: {},
          },
          {
            type: "tool-send_email",
            toolCallId: "c2",
            state: "output-error",
            input: {},
            errorText: "boom",
          },
        ],
        metadata: {},
      } as unknown as UIMessage

      const receipt = await binding.envelope.settle({
        responseMessage,
        isAborted: false,
      })

      const warnLine = warn.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes("durable_finish_handoff_missed"))
      expect(warnLine).toBeDefined()
      expect(JSON.parse(warnLine ?? "{}")).toMatchObject({
        _tag: "durable_finish_handoff_missed",
        requestId: "req-1",
        chatId: "convexchatid000000000000",
        runId: "run1",
      })
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        "durable_finish_handoff_missed",
        { level: "warning" }
      )

      expect(receipt).toEqual({
        status: "confirmed",
        runId: "run1",
        outcome: "completed",
      })
      const completed = wireCalls(wire, "markGenerationRunCompleted")[0]
      expect(completed.args).toMatchObject({
        runId: "run1",
        messageId: "msg1",
        content: "done",
        totalToolCalls: 2,
        failedToolCalls: 1,
      })
      // No captured usage/finishReason survived the missed handoff.
      expect(completed.args.usage).toBeUndefined()
    } finally {
      warn.mockRestore()
    }
  })
})

describe("durable turn runtime — settlement ordering", () => {
  it("settles approvals → flushes → final full-parts snapshot → completes, awaiting the approval write", async () => {
    const approvalDeferred = createDeferred<undefined>()
    const wire = makeRecordingWire({
      responders: {
        createToolApprovalRequest: () => approvalDeferred.promise,
      },
    })
    const { turn } = await makePreparedTurn({ wire })
    const binding = turn.bind(makeToolFacts())

    // Drive a tool-approval-request chunk through the transform — it pushes a
    // (pending) approval write into the module-private backpressure array and
    // blocks on it before enqueuing the chunk.
    const approvalChunk = {
      type: "tool-approval-request",
      approvalId: "approval-1",
      toolCall: {
        toolCallId: "call-1",
        toolName: "send_email",
        input: { to: "x@example.com" },
      },
    } as unknown as TextStreamPart<ToolSet>
    const stream = new ReadableStream<TextStreamPart<ToolSet>>({
      start(controller) {
        controller.enqueue(approvalChunk)
        controller.close()
      },
    }).pipeThrough(
      binding.streamTextExtras.experimental_transform!({
        tools: {},
        stopStream: () => {},
      } as never)
    )
    const reader = stream.getReader()
    const readPromise = reader.read()
    await flush()

    // Dirty the snapshot: the first delta writes immediately, the throttled
    // second leaves the tracker dirty so the settle flush actually writes.
    emitTextChunk(binding.stream, "A")
    emitTextChunk(binding.stream, "B")
    await flush()

    binding.stream.captureFinish({
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      finishReason: "stop",
      toolCounts: { totalToolCalls: 1, failedToolCalls: 0 },
    })

    // Settlement must block on the pending approval write before completing.
    const responseMessage = {
      id: "msg1",
      role: "assistant",
      parts: [
        { type: "text", text: "AB" },
        {
          type: "tool-send_email",
          toolCallId: "call-1",
          state: "output-available",
          input: {},
          output: {},
        },
      ],
      metadata: {},
    } as unknown as UIMessage
    let settled = false
    const settlePromise = binding.envelope
      .settle({ responseMessage, isAborted: false, finishReason: "stop" })
      .then((receipt) => {
        settled = true
        return receipt
      })
    await flush()

    expect(settled).toBe(false)
    expect(wireCalls(wire, "markGenerationRunCompleted")).toHaveLength(0)

    approvalDeferred.resolve(undefined)
    await readPromise
    const receipt = await settlePromise
    expect(receipt).toEqual({
      status: "confirmed",
      runId: "run1",
      outcome: "completed",
    })

    // The completion write is last, preceded by the final full-parts snapshot
    // (content survival, ADR-0011); the captured finish facts drive it.
    const ops = orderedOps(wire)
    expect(ops.at(-1)).toBe("markGenerationRunCompleted")
    const lastSnapshot = ops.lastIndexOf("updateAssistantSnapshot")
    const complete = ops.lastIndexOf("markGenerationRunCompleted")
    expect(lastSnapshot).toBeGreaterThanOrEqual(0)
    expect(lastSnapshot).toBeLessThan(complete)

    const finalSnapshot = wireCalls(wire, "updateAssistantSnapshot").at(-1)
    // The final pre-terminal snapshot carries the COMPLETE response parts
    // (tool parts included), even when the last checkpoint was throttled.
    expect(finalSnapshot?.args).toMatchObject({
      runId: "run1",
      messageId: "msg1",
      textSnapshot: "AB",
      partsSnapshot: responseMessage.parts,
    })

    const completed = wireCalls(wire, "markGenerationRunCompleted")[0]
    expect(completed.args).toMatchObject({
      finishReason: "stop",
      totalToolCalls: 1,
      failedToolCalls: 0,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    })
    expect(Sentry.captureMessage).not.toHaveBeenCalled()
  })

  it("issues both abort writes with distinct reasons when stream onAbort precedes settle (double-terminal, first-terminal-wins)", async () => {
    const { turn, wire } = await makePreparedTurn()
    const binding = turn.bind(makeToolFacts())
    await binding.stream.onChunk({
      type: "text-start", id: "final", providerMetadata: { openai: { phase: "final_answer" } },
    }, { durationMs: 1250 })
    await binding.stream.onChunk({ type: "text-delta", id: "final", text: "done" }, { durationMs: 1250 })

    // The stream `onAbort` half flushes + marks aborted ("stream aborted")...
    await binding.stream.onAbort("stream aborted", 2500)
    // ...then the envelope half marks aborted again ("ui message stream
    // aborted"). Both fire by design; the Generation run lifecycle's
    // first-terminal-wins absorbs the second, and settle never rejects.
    const receipt = await binding.envelope.settle({
      responseMessage: RESPONSE_MESSAGE,
      isAborted: true,
      finishReason: "stop",
    })
    expect(receipt).toEqual({
      status: "confirmed",
      runId: "run1",
      outcome: "aborted",
    })

    const abortReasons = wireCalls(wire, "markGenerationRunAborted").map(
      (call) => call.args.reason
    )
    expect(abortReasons).toEqual([
      "stream aborted",
      "ui message stream aborted",
    ])
    expect(wireCalls(wire, "markGenerationRunCompleted")).toHaveLength(0)

    // The final full-parts snapshot is unconditional (ADR-0011) — abort
    // included — and precedes the envelope's abort mark, so an aborted answer
    // keeps its complete parts, not just the throttled subset.
    const ops = orderedOps(wire)
    expect(wire.calls.slice(0, ops.indexOf("markGenerationRunAborted"))
      .some((call) => call.op === "updateAssistantSnapshot" &&
        call.args.workSummaryDurationMs === 1250)).toBe(true)
    const lastSnapshot = ops.lastIndexOf("updateAssistantSnapshot")
    expect(lastSnapshot).toBeGreaterThanOrEqual(0)
    expect(lastSnapshot).toBeLessThan(
      ops.lastIndexOf("markGenerationRunAborted")
    )
    expect(
      wireCalls(wire, "updateAssistantSnapshot").at(-1)?.args
    ).toMatchObject({
      textSnapshot: "done",
      partsSnapshot: RESPONSE_MESSAGE.parts,
    })
  })

  it("drains observed step usage before abort settlement", async () => {
    const stepDeferred = createDeferred<undefined>()
    const wire = makeRecordingWire({
      responders: {
        recordToolInvocations: () => stepDeferred.promise,
      },
    })
    const { turn } = await makePreparedTurn({ wire })
    const binding = turn.bind(makeToolFacts())

    binding.stream.recordStep({
      stepNumber: 1,
      usage: { inputTokens: 111, outputTokens: 22 },
      toolCalls: [] as never,
      toolResults: [] as never,
    })
    const abortPromise = binding.stream.onAbort("stream aborted", 2500)
    await flush()

    expect(wireCalls(wire, "markGenerationRunAborted")).toHaveLength(0)

    stepDeferred.resolve(undefined)
    await abortPromise

    const ops = orderedOps(wire)
    expect(ops.indexOf("recordToolInvocations")).toBeLessThan(
      ops.indexOf("markGenerationRunAborted")
    )
  })

  it("drains observed step usage before stream-error settlement", async () => {
    const stepDeferred = createDeferred<undefined>()
    const wire = makeRecordingWire({
      responders: {
        recordToolInvocations: () => stepDeferred.promise,
      },
    })
    const { turn } = await makePreparedTurn({ wire })
    const binding = turn.bind(makeToolFacts())

    binding.stream.recordStep({
      stepNumber: 1,
      usage: { inputTokens: 111, outputTokens: 22 },
      toolCalls: [] as never,
      toolResults: [] as never,
    })
    binding.stream.noteStreamError(
      {
        message: "provider exploded",
        recovery: "retry_with_shorter_generation_budget",
      },
      2500
    )
    await flush()

    expect(wireCalls(wire, "markGenerationRunFailed")).toHaveLength(0)

    stepDeferred.resolve(undefined)
    await vi.waitFor(() => {
      expect(wireCalls(wire, "markGenerationRunFailed")).toHaveLength(1)
    })
    expect(wireCalls(wire, "markGenerationRunFailed")[0]?.args).toMatchObject({
      error: "provider exploded",
      errorRecovery: "retry_with_shorter_generation_budget",
    })

    const ops = orderedOps(wire)
    expect(ops.indexOf("recordToolInvocations")).toBeLessThan(
      ops.indexOf("markGenerationRunFailed")
    )
  })
})

describe("durable turn runtime — settlement receipts (never rejects)", () => {
  it("times out every stalled completion attempt before degrading", async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const wire = makeRecordingWire({
        responders: {
          markGenerationRunCompleted: () => new Promise(() => {}),
        },
      })
      const { turn } = await makePreparedTurn({ wire })
      const binding = turn.bind(makeToolFacts())
      binding.stream.captureFinish({
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: "stop",
        toolCounts: { totalToolCalls: 0, failedToolCalls: 0 },
      })

      const receiptPromise = binding.envelope.settle({
        responseMessage: RESPONSE_MESSAGE,
        isAborted: false,
        finishReason: "stop",
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(wireCalls(wire, "markGenerationRunCompleted")).toHaveLength(1)
      await vi.runAllTimersAsync()

      await expect(receiptPromise).resolves.toEqual({
        status: "degraded",
        runId: "run1",
        reason: "completion write failed after retries",
      })
      expect(wireCalls(wire, "markGenerationRunCompleted")).toHaveLength(3)
      const terminalWarnings = warn.mock.calls
        .map(([message]) => JSON.parse(String(message)))
        .filter((message) => message._tag === "durable_completion_write_failed")
      expect(terminalWarnings).toEqual([
        expect.objectContaining({
          requestId: "req-1",
          chatId: "convexchatid000000000000",
          runId: "run1",
          op: "markGenerationRunCompleted",
          attempt: 1,
          error:
            "Timed out writing terminal operation markGenerationRunCompleted after 10000ms",
        }),
        expect.objectContaining({ attempt: 2 }),
        expect.objectContaining({ attempt: 3 }),
      ])
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it("resolves a degraded receipt after bounded completion retries, capturing loudly", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const wire = makeRecordingWire({
        responders: {
          markGenerationRunCompleted: () => {
            throw new Error("convex unavailable")
          },
        },
      })
      const { turn } = await makePreparedTurn({ wire })
      const binding = turn.bind(makeToolFacts())
      binding.stream.captureFinish({
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: "stop",
        toolCounts: { totalToolCalls: 0, failedToolCalls: 0 },
      })

      const receipt = await binding.envelope.settle({
        responseMessage: RESPONSE_MESSAGE,
        isAborted: false,
        finishReason: "stop",
      })

      // settleRetryDelaysMs [0, 0] → three attempts, then degradation.
      expect(wireCalls(wire, "markGenerationRunCompleted")).toHaveLength(3)
      expect(receipt).toEqual({
        status: "degraded",
        runId: "run1",
        reason: "completion write failed after retries",
      })
      const degradedLine = warn.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes("durable_settlement_degraded"))
      expect(degradedLine).toBeDefined()
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        "durable_settlement_degraded",
        expect.objectContaining({ level: "error" })
      )
      // The final full-parts snapshot still landed before the failed terminal
      // write — the answer content survives on the message doc.
      expect(wireCalls(wire, "updateAssistantSnapshot")).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })

  it("marks aborted without rejecting even when the abort write keeps failing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const wire = makeRecordingWire({
        responders: {
          markGenerationRunAborted: () => {
            throw new Error("convex unavailable")
          },
        },
      })
      const { turn } = await makePreparedTurn({ wire })
      const binding = turn.bind(makeToolFacts())

      const receipt = await binding.envelope.settle({
        responseMessage: RESPONSE_MESSAGE,
        isAborted: true,
        finishReason: "stop",
      })
      expect(receipt).toEqual({
        status: "degraded",
        runId: "run1",
        reason: "abort write failed",
      })

      const aborted = wireCalls(wire, "markGenerationRunAborted")[0]
      expect(aborted.args).toMatchObject({
        runId: "run1",
        messageId: "msg1",
        reason: "ui message stream aborted",
      })
      expect(wireCalls(wire, "markGenerationRunCompleted")).toHaveLength(0)
      const warnLine = warn.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes("durable_run_abort_write_failed"))
      expect(warnLine).toBeDefined()
      // A degraded abort is as loud as a degraded completion.
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        "durable_settlement_degraded",
        expect.objectContaining({ level: "error" })
      )
    } finally {
      warn.mockRestore()
    }
  })

  it("confirms after a retry when the first completion attempt fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      let attempts = 0
      const wire = makeRecordingWire({
        responders: {
          markGenerationRunCompleted: () => {
            attempts += 1
            if (attempts === 1) throw new Error("transient convex hiccup")
            return undefined
          },
        },
      })
      const { turn } = await makePreparedTurn({ wire })
      const binding = turn.bind(makeToolFacts())
      binding.stream.captureFinish({
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: "stop",
        toolCounts: { totalToolCalls: 0, failedToolCalls: 0 },
      })

      const receipt = await binding.envelope.settle({
        responseMessage: RESPONSE_MESSAGE,
        isAborted: false,
        finishReason: "stop",
      })

      expect(receipt).toEqual({
        status: "confirmed",
        runId: "run1",
        outcome: "completed",
      })
      expect(wireCalls(wire, "markGenerationRunCompleted")).toHaveLength(2)
      // The first attempt still warned — retries are observable, not silent.
      const attemptWarnings = warn.mock.calls
        .map(([message]) => JSON.parse(String(message)))
        .filter((message) => message._tag === "durable_completion_write_failed")
      expect(attemptWarnings).toEqual([expect.objectContaining({ attempt: 1 })])
      expect(Sentry.captureMessage).not.toHaveBeenCalledWith(
        "durable_settlement_degraded",
        expect.anything()
      )
    } finally {
      warn.mockRestore()
    }
  })

  it("warns durable_final_snapshot_write_failed and still confirms the terminal write", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const wire = makeRecordingWire({
        responders: {
          updateAssistantSnapshot: () => {
            throw new Error("snapshot write refused")
          },
        },
      })
      const { turn } = await makePreparedTurn({ wire })
      const binding = turn.bind(makeToolFacts())
      binding.stream.captureFinish({
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: "stop",
        toolCounts: { totalToolCalls: 0, failedToolCalls: 0 },
      })

      const receipt = await binding.envelope.settle({
        responseMessage: RESPONSE_MESSAGE,
        isAborted: false,
        finishReason: "stop",
      })

      // The failed final snapshot degrades nothing by itself: the completion
      // write carries the same content+parts and its receipt decides.
      expect(receipt).toEqual({
        status: "confirmed",
        runId: "run1",
        outcome: "completed",
      })
      const snapshotWarning = warn.mock.calls
        .map(([message]) => JSON.parse(String(message)))
        .find(
          (message) => message._tag === "durable_final_snapshot_write_failed"
        )
      expect(snapshotWarning).toMatchObject({
        requestId: "req-1",
        runId: "run1",
        error: "snapshot write refused",
      })
    } finally {
      warn.mockRestore()
    }
  })

  it("absorbs a grant-unauthorized rejection as settled-elsewhere instead of degrading or claiming this outcome", async () => {
    // An absorbing outcome (stream onAbort's write, a landed failure) revokes
    // the grant, so the envelope's benign double-terminal write now rejects at
    // the grant gate. That rejection must read as idempotent settlement — not
    // a degraded receipt on every user Stop — but it must NOT claim the
    // requested outcome either: the run settled with the REVOKER's outcome
    // (which could be `failed` under a completion write), and only Convex
    // knows which. `settled-elsewhere` keeps the receipt honest.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const wire = makeRecordingWire({
        responders: {
          markGenerationRunAborted: () => {
            throw new DurableWorkerWriteError({
              op: "markGenerationRunAborted",
              status: 401,
              detail:
                '{"ok":false,"code":"grant_unauthorized","error":"Execution grant not authorized"}',
              grantRejection: "grant_unauthorized",
            })
          },
        },
      })
      const { turn } = await makePreparedTurn({ wire })
      const binding = turn.bind(makeToolFacts())

      const receipt = await binding.envelope.settle({
        responseMessage: RESPONSE_MESSAGE,
        isAborted: true,
        finishReason: "stop",
        timingReceipt: { prepareMs: 40, wireStreamMs: 12 },
      })

      expect(receipt).toEqual({
        status: "confirmed",
        runId: "run1",
        outcome: "settled-elsewhere",
      })
      // No retries: the rejection is deterministic and benign.
      expect(wireCalls(wire, "markGenerationRunAborted")).toHaveLength(1)
      // The run timing receipt the rejected abort carried still lands, once,
      // through the attach capability the Stop transaction minted (ADR-0030).
      const attaches = wireCalls(wire, "attachRunTimingReceipt")
      expect(attaches).toHaveLength(1)
      expect(attaches[0]?.args.timingReceipt).toEqual({
        prepareMs: 40,
        wireStreamMs: 12,
        settlementMs: expect.any(Number),
      })
      const settledWarning = warn.mock.calls
        .map(([message]) => JSON.parse(String(message)))
        .find(
          (message) =>
            message._tag === "durable_terminal_write_rejected_settled"
        )
      expect(settledWarning).toMatchObject({
        runId: "run1",
        op: "markGenerationRunAborted",
      })
      expect(Sentry.captureMessage).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it("short-circuits every later worker write after a grant rejection (post-Stop 401 storm)", async () => {
    // A Stop lands mid-stream: the FIRST rejected write discovers revocation;
    // everything after it — snapshot flushes, the final full-parts snapshot,
    // the terminal write — must settle locally instead of hammering the
    // endpoint with more 401s.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const wire = makeRecordingWire({
        responders: {
          updateAssistantSnapshot: () => {
            throw new DurableWorkerWriteError({
              op: "updateAssistantSnapshot",
              status: 401,
              detail: '{"ok":false,"code":"grant_unauthorized"}',
              grantRejection: "grant_unauthorized",
            })
          },
        },
      })
      const { turn } = await makePreparedTurn({ wire })
      const binding = turn.bind(makeToolFacts())

      // Stream chunk → throttled snapshot write → 401 discovers revocation.
      emitTextChunk(binding.stream, "partial")
      await vi.waitFor(() => {
        expect(wireCalls(wire, "updateAssistantSnapshot")).toHaveLength(1)
      })
      expect(turn.executionAbortSignal.aborted).toBe(true)
      expect(turn.executionAbortSignal.reason).toBeInstanceOf(DOMException)
      expect(turn.executionAbortSignal.reason).toMatchObject({
        name: "AbortError",
        message: "Durable worker execution lost: grant grant_unauthorized",
      })

      const receipt = await binding.envelope.settle({
        responseMessage: RESPONSE_MESSAGE,
        isAborted: true,
        finishReason: "stop",
      })

      expect(receipt).toEqual({
        status: "confirmed",
        runId: "run1",
        outcome: "settled-elsewhere",
      })
      // ONE wire write total after prepare: the discovering snapshot. The
      // final snapshot and the terminal abort write were both gated locally.
      expect(wireCalls(wire, "updateAssistantSnapshot")).toHaveLength(1)
      expect(wireCalls(wire, "markGenerationRunAborted")).toHaveLength(0)
      const revokedWarnings = warn.mock.calls
        .map(([message]) => JSON.parse(String(message)))
        .filter(
          (message) => message._tag === "durable_worker_authority_revoked"
        )
      expect(revokedWarnings).toHaveLength(1)
      expect(Sentry.captureMessage).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it("reports grant-gated boundary writes as uncommitted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const wire = makeRecordingWire({
        responders: {
          updateAssistantSnapshot: () => {
            throw new DurableWorkerWriteError({
              op: "updateAssistantSnapshot",
              status: 401,
              detail: '{"ok":false,"code":"grant_unauthorized"}',
              grantRejection: "grant_unauthorized",
            })
          },
        },
      })
      const { turn } = await makePreparedTurn({ wire })
      const binding = turn.bind(makeToolFacts())

      emitTextChunk(binding.stream, "partial")
      await vi.waitFor(() => {
        expect(turn.executionAbortSignal.aborted).toBe(true)
      })

      await expect(binding.stream.startWork(123)).resolves.toBe(false)
      await expect(
        binding.stream.recordTitleUsageEvidence({
          kind: "started-without-usage",
          routeId: "title-route",
          pricingRole: "title",
        })
      ).resolves.toBe(false)
      expect(wireCalls(wire, "markGenerationWorkStarted")).toHaveLength(0)
      expect(wireCalls(wire, "recordTitleUsageEvidence")).toHaveLength(0)
    } finally {
      warn.mockRestore()
    }
  })

  it("degrades — never claims settlement — when grant EXPIRY is discovered mid-settlement", async () => {
    // Expiry means the TTL lapsed with NO known terminal anywhere. The final
    // snapshot discovers it; the completion write must then degrade instead
    // of resolving a local skip as a landed (or settled-elsewhere) outcome.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const wire = makeRecordingWire({
        responders: {
          updateAssistantSnapshot: () => {
            throw new DurableWorkerWriteError({
              op: "updateAssistantSnapshot",
              status: 401,
              detail: '{"ok":false,"code":"grant_expired"}',
              grantRejection: "grant_expired",
            })
          },
        },
      })
      const { turn } = await makePreparedTurn({ wire })
      const binding = turn.bind(makeToolFacts())

      const receipt = await binding.envelope.settle({
        responseMessage: RESPONSE_MESSAGE,
        isAborted: false,
        finishReason: "stop",
      })

      expect(receipt).toEqual({
        status: "degraded",
        runId: "run1",
        reason: "completion write failed after retries",
      })
      // The completion write was gated locally — no wire attempt could land.
      expect(wireCalls(wire, "markGenerationRunCompleted")).toHaveLength(0)
    } finally {
      warn.mockRestore()
    }
  })

  it("a grant rejection from a TOOL-INVOCATION write gates later writes too", async () => {
    // "ANY worker write" discovers revocation — not just heartbeat/snapshot/
    // terminal. The first rejected record write must close the local gate.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const wire = makeRecordingWire({
        responders: {
          recordToolInvocations: () => {
            throw new DurableWorkerWriteError({
              op: "recordToolInvocations",
              status: 401,
              detail: '{"ok":false,"code":"grant_unauthorized"}',
              grantRejection: "grant_unauthorized",
            })
          },
        },
      })
      const { turn } = await makePreparedTurn({ wire })
      const binding = turn.bind(makeToolFacts())

      binding.stream.recordStep({
        stepNumber: 1,
        toolCalls: [
          { toolCallId: "call_1", toolName: "web_search", input: {} },
        ] as never,
        toolResults: [] as never,
      })
      await vi.waitFor(() => {
        expect(turn.executionAbortSignal.aborted).toBe(true)
      })

      // A later snapshot chunk is gated locally — no second 401.
      emitTextChunk(binding.stream, "tail")
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(wireCalls(wire, "recordToolInvocations")).toHaveLength(1)
      expect(wireCalls(wire, "updateAssistantSnapshot")).toHaveLength(0)
    } finally {
      warn.mockRestore()
    }
  })

  it("forwards per-step token usage as durable settlement evidence (ADR-0021)", async () => {
    const wire = makeRecordingWire()
    const { turn } = await makePreparedTurn({ wire })
    const binding = turn.bind(makeToolFacts())

    binding.stream.recordStep({
      stepNumber: 1,
      usage: { inputTokens: 111, outputTokens: 22 },
      toolCalls: [] as never,
      toolResults: [] as never,
    })
    // A step whose usage carries no numeric field crosses WITHOUT a usage
    // payload — the accumulator must never see an all-undefined object.
    binding.stream.recordStep({
      stepNumber: 2,
      usage: { inputTokens: undefined, outputTokens: undefined },
      toolCalls: [] as never,
      toolResults: [] as never,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const calls = wireCalls(wire, "recordToolInvocations")
    expect(calls).toHaveLength(2)
    expect(calls[0]!.args).toMatchObject({
      stepNumber: 1,
      usage: { inputTokens: 111, outputTokens: 22 },
    })
    expect((calls[1]!.args as { usage?: unknown }).usage).toBeUndefined()
  })
})

describe("durable turn runtime — heartbeat loop", () => {
  function heartbeatCalls(wire: RecordingWire) {
    return wireCalls(wire, "heartbeatGenerationRun")
  }

  it("starts after prepare, renews on cadence, and never overlaps", async () => {
    vi.useFakeTimers()
    try {
      const wire = makeRecordingWire({
        responders: {
          heartbeatGenerationRun: () => ({
            result: { kind: "renewed", leaseExpiresAt: Date.now() + 45_000 },
          }),
        },
      })
      const { turn } = await makePreparedTurn({ wire })
      expect(heartbeatCalls(wire)).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(10_000)
      expect(heartbeatCalls(wire)).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(heartbeatCalls(wire)).toHaveLength(2)
      expect(turn.executionAbortSignal.aborted).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("stops on paused WITHOUT aborting (the approval worker's finalize is still legitimate)", async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const wire = makeRecordingWire({
        responders: {
          heartbeatGenerationRun: () => ({ result: { kind: "paused" } }),
        },
      })
      const { turn } = await makePreparedTurn({ wire })

      await vi.advanceTimersByTimeAsync(10_000)
      expect(heartbeatCalls(wire)).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(30_000)
      // Loop stopped — no further beats, no abort.
      expect(heartbeatCalls(wire)).toHaveLength(1)
      expect(turn.executionAbortSignal.aborted).toBe(false)
      const rejectedLine = warn.mock.calls
        .map(([message]) => JSON.parse(String(message)))
        .find((message) => message._tag === "run_heartbeat_rejected")
      expect(rejectedLine).toMatchObject({ outcome: "paused" })
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it("aborts provider consumption on lost and stops the loop", async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const wire = makeRecordingWire({
        responders: {
          heartbeatGenerationRun: () => ({
            result: { kind: "lost", reason: "not-owner" },
          }),
        },
      })
      const { turn } = await makePreparedTurn({ wire })

      await vi.advanceTimersByTimeAsync(10_000)
      expect(turn.executionAbortSignal.aborted).toBe(true)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(heartbeatCalls(wire)).toHaveLength(1)
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it("tolerates two transport failures, aborts on the third — a grant rejection aborts immediately", async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const wire = makeRecordingWire({
        responders: {
          heartbeatGenerationRun: () => {
            throw new Error("socket reset")
          },
        },
      })
      const { turn } = await makePreparedTurn({ wire })

      await vi.advanceTimersByTimeAsync(10_000) // beat 1 fails
      expect(turn.executionAbortSignal.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(3_100) // jittered retry → failure 2
      expect(turn.executionAbortSignal.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(3_100) // failure 3 → budget exhausted
      expect(turn.executionAbortSignal.aborted).toBe(true)
      expect(heartbeatCalls(wire)).toHaveLength(3)

      // Grant rejection path: never retried.
      const rejectedWire = makeRecordingWire({
        responders: {
          heartbeatGenerationRun: () => {
            throw new DurableWorkerWriteError({
              op: "heartbeatGenerationRun",
              status: 401,
              detail: '{"ok":false,"code":"grant_unauthorized"}',
              grantRejection: "grant_unauthorized",
            })
          },
        },
      })
      const { turn: rejectedTurn } = await makePreparedTurn({
        wire: rejectedWire,
      })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(rejectedTurn.executionAbortSignal.aborted).toBe(true)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(heartbeatCalls(rejectedWire)).toHaveLength(1)
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it("recovers after a transient failure and settle() stops the loop for good", async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      let failures = 0
      const wire = makeRecordingWire({
        responders: {
          heartbeatGenerationRun: () => {
            if (failures < 1) {
              failures += 1
              throw new Error("blip")
            }
            return {
              result: { kind: "renewed", leaseExpiresAt: Date.now() + 45_000 },
            }
          },
        },
      })
      const { turn } = await makePreparedTurn({ wire })
      const binding = turn.bind(makeToolFacts())
      binding.stream.captureFinish({
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: "stop",
        toolCounts: { totalToolCalls: 0, failedToolCalls: 0 },
      })

      await vi.advanceTimersByTimeAsync(10_000) // failure 1
      await vi.advanceTimersByTimeAsync(3_100) // jittered retry → renewed
      expect(heartbeatCalls(wire)).toHaveLength(2)
      expect(turn.executionAbortSignal.aborted).toBe(false)

      const receipt = await binding.envelope.settle({
        responseMessage: RESPONSE_MESSAGE,
        isAborted: false,
        finishReason: "stop",
      })
      expect(receipt).toMatchObject({ status: "confirmed" })

      const beatsAtSettle = heartbeatCalls(wire).length
      await vi.advanceTimersByTimeAsync(60_000)
      expect(heartbeatCalls(wire)).toHaveLength(beatsAtSettle)
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe("durable turn runtime — prepare() error mapping and grant minting", () => {
  it("rejects regeneration that carries pending approval responses (400, no network)", async () => {
    const fetchMutation = makeRecordingFetchMutation()
    const input = makeInput({
      regeneration: {
        targetAssistantMessageId: "a1",
        targetAssistantCreatedAt: 1,
        expectedChatVersion: 3,
        precedingUserMessageId: "u1",
      },
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          parts: [
            {
              type: "tool-send_email",
              toolCallId: "call-1",
              state: "approval-responded",
              input: {},
              approval: { id: "approval-1", approved: false },
            },
          ],
        },
      ] as unknown as UIMessage[],
    }) as DurableTurnInput & { convexToken: string }
    const turn = makeConvexTurn(input, fetchMutation, makeRecordingWire())

    await expect(turn.prepare({ provider: "anthropic" })).rejects.toMatchObject(
      {
        statusCode: 400,
        code: "INVALID_REQUEST",
      }
    )
    expect(fetchMutation).not.toHaveBeenCalled()
  })

  it("maps a Convex argument-validation rejection to 400 after warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const fetchMutation = makeRecordingFetchMutation({
        prepareResponder: () => {
          throw new Error("ArgumentValidationError: bad id")
        },
      })
      const turn = makeConvexTurn(
        makeInput() as DurableTurnInput & { convexToken: string },
        fetchMutation,
        makeRecordingWire()
      )

      await expect(
        turn.prepare({ provider: "anthropic" })
      ).rejects.toMatchObject({ statusCode: 400, code: "INVALID_REQUEST" })
      const warnLine = warn.mock.calls
        .map(([message]) => String(message))
        .find((message) =>
          message.includes("durable_prepare_argument_rejected")
        )
      expect(warnLine).toBeDefined()
    } finally {
      warn.mockRestore()
    }
  })

  it("maps an approval continuation race to the branded 409 contract", async () => {
    const fetchMutation = makeRecordingFetchMutation({
      prepareResponder: () => {
        throw { data: { code: "approval_continuation_conflict" } }
      },
    })
    const turn = makeConvexTurn(
      makeInput() as DurableTurnInput & { convexToken: string },
      fetchMutation,
      makeRecordingWire()
    )

    await expect(turn.prepare({ provider: "anthropic" })).rejects.toMatchObject(
      {
        name: "PublicChatHttpError",
        statusCode: 409,
        code: "APPROVAL_CONTINUATION_CONFLICT",
        message: "Approval continuation already dispatched",
      }
    )
  })

  it("maps an authoritative approval provider mismatch to branded 409", async () => {
    const fetchMutation = makeRecordingFetchMutation({
      prepareResponder: () => {
        throw { data: { code: "approval_provider_mismatch" } }
      },
    })
    const turn = makeConvexTurn(
      makeInput() as DurableTurnInput & { convexToken: string },
      fetchMutation,
      makeRecordingWire()
    )

    await expect(turn.prepare({ provider: "google" })).rejects.toMatchObject({
      name: "PublicChatHttpError",
      statusCode: 409,
      code: "APPROVAL_PROVIDER_MISMATCH",
    })
  })

  it("maps an unresolved approval to the surfaced branded 409, not the swallowed conflict", async () => {
    const fetchMutation = makeRecordingFetchMutation({
      prepareResponder: () => {
        throw { data: { code: "approval_unresolved" } }
      },
    })
    const turn = makeConvexTurn(
      makeInput() as DurableTurnInput & { convexToken: string },
      fetchMutation,
      makeRecordingWire()
    )

    await expect(turn.prepare({ provider: "openai" })).rejects.toMatchObject({
      name: "PublicChatHttpError",
      statusCode: 409,
      code: "APPROVAL_UNRESOLVED",
    })
  })

  it("maps a stale canonical generation plan to a retryable branded 409", async () => {
    const fetchMutation = makeRecordingFetchMutation({
      prepareResponder: () => {
        throw { data: { code: "generation_input_changed" } }
      },
    })
    const turn = makeConvexTurn(
      makeInput({ generationInputHash: "a".repeat(64) }) as DurableTurnInput & {
        convexToken: string
      },
      fetchMutation,
      makeRecordingWire()
    )

    await expect(turn.prepare({ provider: "openai" })).rejects.toMatchObject({
      name: "PublicChatHttpError",
      statusCode: 409,
      code: "GENERATION_INPUT_CHANGED",
      message: "This chat changed before generation started. Please try again.",
    })
  })

  it("passes a concurrency-guard rejection through untouched (no 400 remap)", async () => {
    const guardError = new Error("expectedVisibleMessageCount mismatch")
    const fetchMutation = makeRecordingFetchMutation({
      prepareResponder: () => {
        throw guardError
      },
    })
    const turn = makeConvexTurn(
      makeInput() as DurableTurnInput & { convexToken: string },
      fetchMutation,
      makeRecordingWire()
    )

    const thrown = await turn.prepare({ provider: "anthropic" }).then(
      () => null,
      (error) => error
    )
    expect(thrown).toBe(guardError)
    expect((thrown as { statusCode?: number }).statusCode).toBeUndefined()
  })

  it("forwards the selected-path-token + edit guard args verbatim and mints the grant digest", async () => {
    const fetchMutation = makeRecordingFetchMutation()
    const edit = {
      editedMessageId: "m9",
      editCutoffTimestamp: 123,
      expectedChatVersion: 7,
      replacementMessage: {
        id: "m9",
        role: "user" as const,
        content: "edited",
        parts: [{ type: "text", text: "edited" }] as UIMessage["parts"],
      },
    }
    const turn = makeConvexTurn(
      makeInput({
        expectedVisibleMessageCount: 42,
        tailMessageId: "tail-xyz",
        edit,
      }) as DurableTurnInput & { convexToken: string },
      fetchMutation,
      makeRecordingWire()
    )

    await turn.prepare({ provider: "anthropic" })

    const prepareCall = fetchMutation.mock.calls.find((call) =>
      sameRef(call[0], api.chatRuntime.prepareGeneration)
    )
    const prepareArgs = prepareCall?.[1] as Record<string, unknown>
    expect(prepareArgs.expectedVisibleMessageCount).toBe(42)
    expect(prepareArgs.tailMessageId).toBe("tail-xyz")
    expect(prepareArgs.edit).toBe(edit)
    expect(prepareArgs.provider).toBe("anthropic")
    // An edit turn never re-sends the latest client user message.
    expect(prepareArgs.latestUserMessage).toBeUndefined()
    // The execution grant digest rides the admission call (ADR-0011): a
    // 64-hex SHA-256 — never the raw secret (which is 64 hex of entropy too,
    // but the digest is deterministic given the secret; assert shape only).
    expect(prepareArgs.grantDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(prepareArgs.admissionIssuedAt).toEqual(expect.any(Number))
    expect(prepareArgs.admissionProof).toBe("f".repeat(64))
    // The user token authorizes the admission call and nothing after it.
    expect(prepareCall?.[2]).toEqual({ token: "tok" })
  })
})

describe("durable turn runtime — approval continuation scope (trailing tail only)", () => {
  const staleDeniedAssistant = {
    id: "a-stale",
    role: "assistant",
    metadata: { provider: "openai" },
    parts: [
      {
        type: "dynamic-tool",
        toolName: "deepwiki_ask_question",
        toolCallId: "call-stale",
        state: "approval-responded",
        input: { question: "q" },
        approval: { id: "approval-stale", approved: false, reason: "denied" },
      },
      { type: "text", text: "" },
    ],
  } as unknown as UIMessage

  it("does not classify a stale mid-history approval part as a continuation (regression: silent message loss)", async () => {
    // denyPendingApprovalsForChat persists approval-responded{approved:false}
    // parts into durable history; they arrive with every later POST. Before
    // the fix, extractApprovalResponses scanned ALL messages, so the user's
    // NEW trailing message was never persisted (latestUserMessage suppressed)
    // and the turn 409ed against the settled run — swallowed by the client.
    const fetchMutation = makeRecordingFetchMutation()
    const turn = makeConvexTurn(
      makeInput({
        messages: [
          {
            id: "u1",
            role: "user",
            parts: [{ type: "text", text: "hi" }],
          },
          staleDeniedAssistant,
          {
            id: "u2",
            role: "user",
            parts: [{ type: "text", text: "world" }],
          },
        ] as UIMessage[],
      }) as DurableTurnInput & { convexToken: string },
      fetchMutation,
      makeRecordingWire()
    )

    await turn.prepare({ provider: "openai" })

    const prepareCall = fetchMutation.mock.calls.find(([ref]) =>
      getFunctionName(ref as never).includes("prepareGeneration")
    )
    expect(prepareCall).toBeDefined()
    const args = prepareCall?.[1] as {
      approvalResponses: unknown[]
      latestUserMessage?: { id: string }
    }
    expect(args.approvalResponses).toEqual([])
    expect(args.latestUserMessage?.id).toBe("u2")
  })

  it("still extracts a live trailing approval tail as a continuation", async () => {
    const fetchMutation = makeRecordingFetchMutation()
    const turn = makeConvexTurn(
      makeInput({
        messages: [
          {
            id: "u1",
            role: "user",
            parts: [{ type: "text", text: "run it" }],
          },
          {
            id: "a-live",
            role: "assistant",
            metadata: { provider: "openai" },
            parts: [
              {
                type: "dynamic-tool",
                toolName: "deepwiki_ask_question",
                toolCallId: "call-live",
                state: "approval-responded",
                input: { question: "q" },
                approval: { id: "approval-live", approved: true },
              },
            ],
          },
        ] as unknown as UIMessage[],
      }) as DurableTurnInput & { convexToken: string },
      fetchMutation,
      makeRecordingWire()
    )

    await turn.prepare({ provider: "openai" })

    const prepareCall = fetchMutation.mock.calls.find(([ref]) =>
      getFunctionName(ref as never).includes("prepareGeneration")
    )
    const args = prepareCall?.[1] as {
      approvalResponses: Array<{ approvalId: string; approved: boolean }>
      latestUserMessage?: unknown
    }
    expect(args.approvalResponses).toEqual([
      expect.objectContaining({
        approvalId: "approval-live",
        approved: true,
        toolCallId: "call-live",
        toolName: "deepwiki_ask_question",
      }),
    ])
    expect(args.latestUserMessage).toBeUndefined()
  })
})

describe("durable turn runtime — guest inertness", () => {
  it("drives the full lifecycle with zero network and identity passthrough", async () => {
    const guest = createGuestDurableTurn(
      makeInput({
        messages: [
          { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
        ] as UIMessage[],
      })
    )

    expect(guest.mode).toBe("guest")

    const canonical = await guest.prepare({ provider: "anthropic" })
    expect(canonical).toHaveLength(1)
    expect(canonical[0]?.id).toBe("u1")

    const binding = guest.bind(makeToolFacts())
    expect(binding.streamTextExtras).toEqual({})

    const validated = [
      { id: "v1", role: "user", parts: [{ type: "text", text: "hi" }] },
    ] as UIMessage[]
    const identity = binding.envelope.identity(validated)
    expect(identity.originalMessages).toBe(validated)
    expect(identity.generateMessageId).toBeUndefined()

    // Every write method is an inert no-op; settle resolves the guest receipt.
    emitTextChunk(binding.stream, "A")
    binding.stream.recordStep({
      stepNumber: 1,
      toolCalls: [{ toolCallId: "c", toolName: "t", input: {} }],
      toolResults: [],
    })
    binding.stream.noteStreamError("boom", 2500)
    binding.stream.captureFinish({
      usage: {},
      finishReason: "stop",
      toolCounts: { totalToolCalls: 0, failedToolCalls: 0 },
    })
    await expect(
      binding.stream.onAbort("stream aborted", 2500)
    ).resolves.toBeUndefined()
    await expect(
      binding.envelope.settle({
        responseMessage: {
          id: "v1",
          role: "assistant",
          parts: [],
          metadata: {},
        } as unknown as UIMessage,
        isAborted: false,
        finishReason: "stop",
      })
    ).resolves.toEqual({ status: "guest" })
    await expect(guest.fail("nope")).resolves.toBeUndefined()

    expect(moduleFetchMutation).not.toHaveBeenCalled()
  })
})

describe("durable turn runtime — fail() at each phase", () => {
  it("is a no-op before prepare() (no run exists)", async () => {
    const wire = makeRecordingWire()
    const fetchMutation = makeRecordingFetchMutation()
    const turn = makeConvexTurn(
      makeInput() as DurableTurnInput & { convexToken: string },
      fetchMutation,
      wire
    )
    await expect(turn.fail("early")).resolves.toBeUndefined()
    expect(fetchMutation).not.toHaveBeenCalled()
    expect(wire.calls).toHaveLength(0)
  })

  it("marks the run failed over the worker wire after prepare(), with the assistant message id", async () => {
    const { turn, wire } = await makePreparedTurn()
    await turn.fail("provider exploded")

    const failed = wireCalls(wire, "markGenerationRunFailed")[0]
    expect(failed.args).toMatchObject({
      runId: "run1",
      messageId: "msg1",
      error: "provider exploded",
    })
  })

  it("drains observed step usage before an outer failure settles the run", async () => {
    const stepDeferred = createDeferred<undefined>()
    const wire = makeRecordingWire({
      responders: {
        recordToolInvocations: () => stepDeferred.promise,
      },
    })
    const { turn } = await makePreparedTurn({ wire })
    const binding = turn.bind(makeToolFacts())

    binding.stream.recordStep({
      stepNumber: 1,
      usage: { inputTokens: 111, outputTokens: 22 },
      toolCalls: [] as never,
      toolResults: [] as never,
    })
    const failPromise = turn.fail("provider exploded")
    await flush()

    expect(wireCalls(wire, "markGenerationRunFailed")).toHaveLength(0)

    stepDeferred.resolve(undefined)
    await failPromise

    const ops = orderedOps(wire)
    expect(ops.indexOf("recordToolInvocations")).toBeLessThan(
      ops.indexOf("markGenerationRunFailed")
    )
  })

  it("warns and resolves when the failure write itself rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const wire = makeRecordingWire({
        responders: {
          markGenerationRunFailed: () => {
            throw new Error("convex unavailable")
          },
        },
      })
      const { turn } = await makePreparedTurn({ wire })

      await expect(turn.fail("boom")).resolves.toBeUndefined()
      const warnLine = warn.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes("durable_run_failed_write_failed"))
      expect(warnLine).toBeDefined()
    } finally {
      warn.mockRestore()
    }
  })
})

describe("durable turn runtime — cancellation terminal-usage evidence (ADR-0021 amendment)", () => {
  const RESERVATION_ID = "res1" as Id<"usageReservations">

  it("ships abort evidence with the terminal write, adding the partial estimate", async () => {
    const { turn, wire } = await makePreparedTurn({
      input: { reservationId: RESERVATION_ID },
    })
    const binding = turn.bind(makeToolFacts())
    emitTextChunk(binding.stream, "partial answer!!")

    await binding.stream.onAbort("stream aborted", 1_000, {
      primary: { kind: "completed-steps", inputTokens: 500, outputTokens: 20 },
      title: {
        kind: "started-without-usage",
        routeId: "title-route",
        pricingRole: "title",
      },
    })

    const aborts = wireCalls(wire, "markGenerationRunAborted")
    expect(aborts).toHaveLength(1)
    // 16 persisted characters → 4 estimated partial-output tokens.
    expect(aborts[0]!.args.terminalUsage).toEqual({
      primary: {
        kind: "completed-steps",
        inputTokens: 500,
        outputTokens: 20,
        partialOutputTokens: 4,
      },
      title: {
        kind: "started-without-usage",
        routeId: "title-route",
        pricingRole: "title",
      },
    })
    // The terminal write landed the evidence — no settlement-only receipt.
    expect(wireCalls(wire, "finalizeTerminalUsage")).toHaveLength(0)
  })

  it("defers the Stop settlement receipt until the envelope has final evidence", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      const wire = makeRecordingWire({
        responders: {
          markGenerationRunAborted: () => {
            throw new DurableWorkerWriteError({
              op: "markGenerationRunAborted",
              status: 401,
              detail: "",
              grantRejection: "grant_unauthorized",
            })
          },
          finalizeTerminalUsage: () => ({
            ok: true,
            result: { outcome: "settled" },
          }),
        },
      })
      const { turn } = await makePreparedTurn({
        wire,
        input: { reservationId: RESERVATION_ID },
      })
      const binding = turn.bind(makeToolFacts())

      await binding.stream.onAbort("stream aborted", 1_000, {
        primary: { kind: "started-without-usage" },
        title: { kind: "not-run" },
      })
      expect(wireCalls(wire, "finalizeTerminalUsage")).toHaveLength(0)

      // The envelope's final parts and fresher title state must win over the
      // earlier onAbort evidence.
      await binding.envelope.settle({
        responseMessage: RESPONSE_MESSAGE,
        isAborted: true,
        terminalFacts: {
          title: {
            kind: "actual",
            routeId: "title-route",
            pricingRole: "title",
            inputTokens: 10,
            outputTokens: 2,
          },
        },
      })

      const receipts = wireCalls(wire, "finalizeTerminalUsage")
      expect(receipts).toHaveLength(1)
      expect(receipts[0]!.args).toMatchObject({
        runId: "run1",
        reservationId: RESERVATION_ID,
      })
      expect(receipts[0]!.args.terminalUsage).toEqual({
        primary: {
          kind: "started-without-usage",
          // The final response contains "done" → one estimated token.
          partialOutputTokens: 1,
        },
        title: {
          kind: "actual",
          routeId: "title-route",
          pricingRole: "title",
          inputTokens: 10,
          outputTokens: 2,
        },
      })
    } finally {
      warn.mockRestore()
    }
  })

  it("skips the receipt entirely for turns without a reservation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      const wire = makeRecordingWire({
        responders: {
          markGenerationRunAborted: () => {
            throw new DurableWorkerWriteError({
              op: "markGenerationRunAborted",
              status: 401,
              detail: "",
              grantRejection: "grant_unauthorized",
            })
          },
        },
      })
      const { turn } = await makePreparedTurn({ wire })
      const binding = turn.bind(makeToolFacts())
      await binding.stream.onAbort("stream aborted", 1_000, {
        primary: { kind: "started-without-usage" },
        title: { kind: "not-run" },
      })
      expect(wireCalls(wire, "finalizeTerminalUsage")).toHaveLength(0)
    } finally {
      warn.mockRestore()
    }
  })
})
