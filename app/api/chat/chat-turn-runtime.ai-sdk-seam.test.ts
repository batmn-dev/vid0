import { api } from "@/convex/_generated/api"
import { HEARTBEAT_INTERVAL_MS } from "@/convex/domain/generation_run_liveness"
import { loadUserMcpTools } from "@/lib/mcp/load-tools"
import { createLanguageModel } from "@/lib/openproviders/create-language-model"
import { getEffectiveToolKeyWithMode } from "@/lib/user-keys"
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { jsonSchema, streamText, tool } from "ai"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import { fetchMutation as convexNextjsFetchMutation } from "convex/nextjs"
import { getFunctionName } from "convex/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  createChatTurnRuntime,
  type ChatTurnDeps,
  type ChatTurnInput,
} from "./chat-turn-runtime"
import type {
  DurableWorkerCall,
  DurableWorkerWire,
} from "./durable-turn-runtime"

// AI SDK seam tests: run the REAL `ai` package —
// streamText, its v7 callback names (onStepEnd/onEnd/prepareStep), tool
// execution, and the UI-message Response — against the real Chat turn runtime
// and the real Tool runtime. The unit suite (chat-turn-runtime.test.ts) fakes
// streamText, so a callback the SDK renamed or silently dropped is invisible
// there; here only true externals are mocked:
//   - the provider model (MockLanguageModelV4 at the createLanguageModel seam),
//   - Convex (deps.fetchMutation for durable writes; convex/nextjs for the
//     budget store and audit sink), MCP servers (loadUserMcpTools),
//   - tool-key resolution, Sentry/PostHog/Braintrust.
// vi.mock("ai") is deliberately absent.

vi.mock("@sentry/nextjs", () => ({
  setTag: vi.fn(),
  setContext: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  startSpan: vi.fn((_opts: unknown, cb: () => unknown) => cb()),
}))

vi.mock("@/lib/observability/braintrust", () => ({
  getBraintrustStreamText: vi.fn(),
  withBraintrustTrace: vi.fn((_opts: unknown, cb: (span: null) => unknown) =>
    cb(null)
  ),
  hashBraintrustIdentifier: vi.fn(async () => "hash"),
  logBraintrustTraceMetadata: vi.fn(),
  getBraintrustErrorMetadata: vi.fn(() => ({})),
  flushBraintrust: vi.fn(async () => {}),
}))

vi.mock("@/lib/posthog", () => ({
  captureGeneration: vi.fn(),
  flushPostHog: vi.fn(async () => {}),
  getPostHogClient: vi.fn(() => null),
}))

vi.mock("@/lib/user-keys", () => ({
  getEffectiveToolKeyWithMode: vi.fn(),
}))

// MCP servers are remote processes — the one Tool layer whose loader is a true
// external. The tools it returns here are real ai@7 `tool()` definitions that
// execute locally, so the merged ToolSet flows through the real policy,
// naming, budget, and approval machinery.
vi.mock("@/lib/mcp/load-tools", () => ({
  loadUserMcpTools: vi.fn(),
}))

// convex/nextjs backs the Tool budget store (toolLimits.checkAndConsume) and
// the audit outcome sink (toolCallLog.log). The durable-run writes go through
// the runtime's injected deps.fetchMutation instead.
vi.mock("convex/nextjs", () => ({
  fetchMutation: vi.fn(),
  fetchQuery: vi.fn(),
}))

// The model-factory seam: the only place a fake enters the model path.
vi.mock("@/lib/openproviders/create-language-model", () => ({
  createLanguageModel: vi.fn(),
}))

const SERVER_CHAT_ID = "convexchatid000000000000"
const MODEL_ID = "claude-haiku-4-5-20251001"

// Loose-typed handle on the mocked convex/nextjs boundary (budget store +
// audit sink) — the real signature's tuple types fight mockImplementation.
const convexBoundaryMutation =
  convexNextjsFetchMutation as unknown as ReturnType<typeof vi.fn>

// v4-spec usage for each mock step; streamText aggregates across steps.
const STEP_USAGE = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

function stepUsage(outputTokens: number): typeof STEP_USAGE {
  return {
    ...STEP_USAGE,
    outputTokens: {
      total: outputTokens,
      text: outputTokens,
      reasoning: undefined,
    },
  }
}

const TOOL_STEPS = 4 // crosses PREPARE_STEP_THRESHOLD (3) on the final step

function makeToolCallStepChunks(
  step: number,
  usage: typeof STEP_USAGE = STEP_USAGE
): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start" as const, warnings: [] },
    {
      type: "tool-call" as const,
      toolCallId: `call-${step}`,
      toolName: "get_weather",
      input: JSON.stringify({ city: `City ${step}` }),
    },
    {
      type: "finish" as const,
      finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
      usage,
    },
  ]
}

function makeFinalTextStepChunks(): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start" as const, warnings: [] },
    { type: "text-start" as const, id: "t1" },
    { type: "text-delta" as const, id: "t1", delta: "The weather is " },
    { type: "text-delta" as const, id: "t1", delta: "sunny — 20°C." },
    { type: "text-end" as const, id: "t1" },
    {
      type: "finish" as const,
      finishReason: { unified: "stop" as const, raw: "end_turn" },
      usage: STEP_USAGE,
    },
  ]
}

/** A model that answers with TOOL_STEPS tool-call steps, then a text step. */
function makeToolLoopModel() {
  let call = 0
  return new MockLanguageModelV4({
    doStream: async () => {
      call += 1
      return {
        stream: simulateReadableStream({
          chunks:
            call <= TOOL_STEPS
              ? makeToolCallStepChunks(call)
              : makeFinalTextStepChunks(),
          chunkDelayInMs: null,
        }),
      }
    },
  })
}

/** A tool-only loop whose usage exactly consumes a 12-token turn budget. */
function makeBudgetedToolLoopModel() {
  const outputByStep = [5, 4, 3]
  let call = 0
  return new MockLanguageModelV4({
    doStream: async () => {
      const outputTokens = outputByStep[call] ?? 1
      call += 1
      return {
        stream: simulateReadableStream({
          chunks: makeToolCallStepChunks(call, stepUsage(outputTokens)),
          chunkDelayInMs: null,
        }),
      }
    },
  })
}

/** A model that streams text slowly enough for the request to abort mid-way. */
function makeSlowTextModel() {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream<LanguageModelV4StreamPart>({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          ...Array.from({ length: 8 }, (_, i): LanguageModelV4StreamPart => ({
            type: "text-delta",
            id: "t1",
            delta: `chunk-${i} `,
          })),
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "end_turn" },
            usage: STEP_USAGE,
          },
        ],
        chunkDelayInMs: 30,
      }),
    }),
  })
}

const PACED_STOP_SLAB =
  "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu"

/**
 * One coarse text slab followed by an approval-needing tool call. Runtime
 * transform ordering keeps the later control part behind the paced text.
 */
function makePacedTextThenApprovalModel() {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream<LanguageModelV4StreamPart>({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: PACED_STOP_SLAB },
          { type: "text-end", id: "t1" },
          {
            type: "tool-call",
            toolCallId: "call-after-text",
            toolName: "scratch_pad",
            input: JSON.stringify({ note: "must remain behind paced text" }),
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool_use" },
            usage: STEP_USAGE,
          },
        ],
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    }),
  })
}

function makeReasoningModel() {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream<LanguageModelV4StreamPart>({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "reasoning-start", id: "r1" },
          { type: "reasoning-delta", id: "r1", delta: "Check the facts." },
          { type: "reasoning-end", id: "r1" },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Final answer." },
          { type: "text-end", id: "t1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "end_turn" },
            usage: STEP_USAGE,
          },
        ],
        chunkDelayInMs: null,
      }),
    }),
  })
}

function makeMcpToolsFixture() {
  const weatherExecute = vi.fn(async ({ city }: { city: string }) => ({
    city,
    temperature: 21,
  }))

  const tools = {
    // Trusted read-only tool — passes runtime approval ungated and stays
    // available in late steps.
    get_weather: tool({
      description: "Look up the current weather for a city",
      inputSchema: jsonSchema<{ city: string }>({
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      }),
      execute: weatherExecute,
    }),
    // Untrusted-hints decoy — early-step advisory allow, late-step
    // fail-closed. Its disappearance from the last model call proves the
    // real streamText consulted prepareStep.
    scratch_pad: tool({
      description: "Jot a scratch note",
      inputSchema: jsonSchema<{ note: string }>({
        type: "object",
        properties: { note: { type: "string" } },
        required: ["note"],
        additionalProperties: false,
      }),
      execute: async (): Promise<{ ok: true }> => {
        throw new Error("scratch_pad must never execute in this test")
      },
    }),
  }

  const loadResult = {
    tools,
    clients: [{ close: vi.fn(async () => {}) }],
    toolServerMap: new Map([
      [
        "get_weather",
        {
          displayName: "get_weather",
          serverName: "Weather Server",
          serverId: "srv-weather",
          readOnly: true,
          policyHintsTrusted: true,
        },
      ],
      [
        "scratch_pad",
        {
          displayName: "scratch_pad",
          serverName: "Scratch Server",
          serverId: "srv-scratch",
        },
      ],
    ]),
    failedServerCount: 0,
  }

  return { loadResult, weatherExecute }
}

function makeInput(overrides: Partial<ChatTurnInput> = {}): ChatTurnInput {
  return {
    messages: [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "What is the weather in Berlin?" }],
      },
    ] as ChatTurnInput["messages"],
    chatId: SERVER_CHAT_ID,
    model: MODEL_ID,
    systemPrompt: "You are a weather assistant.",
    enableSearch: false,
    chatVersion: 1,
    requestId: "req-seam-1",
    userId: "user-1",
    anonymousId: undefined,
    isAuthenticated: true,
    convexToken: "tok",
    credential: {
      provider: "anthropic",
      apiKey: "sk-test",
      source: "byok",
    },
    route: {
      modelId: MODEL_ID,
      routeId: MODEL_ID,
      providerId: "anthropic",
      upstreamModelId: MODEL_ID,
      credentialSource: "byok",
      routeReason: "priority_byok",
    },
    ...overrides,
  }
}

/** A stored user message shaped like the Convex `messages` doc the durable
 * prepare returns — flows through the real adapter + validateUIMessages. */
function makeStoredUserMessage() {
  return {
    _id: "usermsg1",
    role: "user",
    content: "What is the weather in Berlin?",
    parts: [{ type: "text", text: "What is the weather in Berlin?" }],
    createdAt: Date.now() - 1000,
    status: "completed",
    metadata: {},
  }
}

function sameRef(a: unknown, b: unknown): boolean {
  try {
    return (
      getFunctionName(a as Parameters<typeof getFunctionName>[0]) ===
      getFunctionName(b as Parameters<typeof getFunctionName>[0])
    )
  } catch {
    return false
  }
}

function makeDurableFetchMutation() {
  return vi.fn(async (ref: unknown) => {
    if (sameRef(ref, api.chatRuntime.prepareGeneration)) {
      return {
        runId: "run1",
        assistantMessageId: "msg1",
        messages: [makeStoredUserMessage()],
      }
    }
    return undefined
  })
}

function findCalls(fn: ReturnType<typeof vi.fn>, ref: unknown) {
  return fn.mock.calls.filter((call) => sameRef(call[0], ref))
}

// Post-prepare durable writes travel the Durable worker wire (ADR-0011), not
// fetchMutation — the recording wire is their test seam.
type RecordingWire = DurableWorkerWire & { calls: DurableWorkerCall[] }

function makeWorkerWire(): RecordingWire {
  const calls: DurableWorkerCall[] = []
  const wire = (async (call: DurableWorkerCall) => {
    calls.push(call)
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

function extractTextDeltasFromSse(sse: string): string {
  return sse
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice("data: ".length)) as unknown)
    .filter(
      (chunk): chunk is { type: "text-delta"; delta: string } =>
        typeof chunk === "object" &&
        chunk !== null &&
        (chunk as { type?: unknown }).type === "text-delta" &&
        typeof (chunk as { delta?: unknown }).delta === "string"
    )
    .map((chunk) => chunk.delta)
    .join("")
}

function makeDeps(
  fetchMutation: ReturnType<typeof vi.fn>,
  wire: RecordingWire = makeWorkerWire()
): ChatTurnDeps {
  return {
    streamText,
    generateText: vi.fn(async () => ({
      text: "Weather in Berlin",
    })) as unknown as ChatTurnDeps["generateText"],
    fetchMutation: fetchMutation as unknown as ChatTurnDeps["fetchMutation"],
    fetchQuery: vi.fn(async () => []) as unknown as ChatTurnDeps["fetchQuery"],
    after: vi.fn() as unknown as ChatTurnDeps["after"],
    getPostHogClient: (() =>
      null) as unknown as ChatTurnDeps["getPostHogClient"],
    durableWorkerWire: wire,
    durableSettleRetryDelaysMs: [0],
    chatAdmissionProofSigner: () => "f".repeat(64),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.mocked(getEffectiveToolKeyWithMode).mockResolvedValue({
    key: undefined,
    keyMode: undefined,
  } as unknown as Awaited<ReturnType<typeof getEffectiveToolKeyWithMode>>)
  // Budget store: allow every consume; audit-log writes resolve.
  convexBoundaryMutation.mockImplementation(async (ref: unknown) => {
    if (sameRef(ref, api.toolLimits.checkAndConsume)) {
      return { allowed: true, remaining: 99 }
    }
    return null
  })
})

describe("chat turn runtime × real ai@7 streamText", () => {
  it("forwards real reasoning lifecycle events into finite finish metadata", async () => {
    const { loadResult } = makeMcpToolsFixture()
    vi.mocked(loadUserMcpTools).mockResolvedValue(
      loadResult as unknown as Awaited<ReturnType<typeof loadUserMcpTools>>
    )
    vi.mocked(createLanguageModel).mockReturnValue(
      makeReasoningModel() as unknown as ReturnType<typeof createLanguageModel>
    )
    const runtime = createChatTurnRuntime({
      input: makeInput({ requestId: "req-seam-reasoning" }),
      deps: makeDeps(makeDurableFetchMutation()),
    })

    await runtime.prepare()
    const sse = await (
      await runtime.toResponse(new AbortController().signal)
    ).text()

    expect(sse).toContain("Check the facts.")
    expect(extractTextDeltasFromSse(sse)).toBe("Final answer.")
    expect(sse).toMatch(/"reasoningDurationMs":\d+/)
  })

  it("runs a durable multi-step tool turn end-to-end: step hooks, sinks, ordered durable writes, streamed Response", async () => {
    const { loadResult, weatherExecute } = makeMcpToolsFixture()
    vi.mocked(loadUserMcpTools).mockResolvedValue(
      loadResult as unknown as Awaited<ReturnType<typeof loadUserMcpTools>>
    )
    const model = makeToolLoopModel()
    vi.mocked(createLanguageModel).mockReturnValue(
      model as unknown as ReturnType<typeof createLanguageModel>
    )
    const durableFetchMutation = makeDurableFetchMutation()
    const wire = makeWorkerWire()

    const runtime = createChatTurnRuntime({
      input: makeInput(),
      deps: makeDeps(durableFetchMutation, wire),
    })
    await runtime.prepare()
    const response = await runtime.toResponse(new AbortController().signal)

    expect(response.status).toBe(200)
    expect(Object.fromEntries(response.headers)).toEqual({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-vercel-ai-ui-message-stream": "v1",
      "x-accel-buffering": "no",
    })
    const sse = await response.text()
    expect(sse).toContain('"messageId":"msg1"') // durable assistant id
    expect(extractTextDeltasFromSse(sse)).toBe("The weather is sunny — 20°C.")
    expect(sse).toContain('"type":"finish"')
    expect(sse.trimEnd().endsWith("data: [DONE]")).toBe(true)

    // The real streamText looped TOOL_STEPS tool steps plus the final text
    // step, and consulted prepareStep each time: past PREPARE_STEP_THRESHOLD
    // the untrusted-hints tool is gone while the read-only tool remains.
    expect(model.doStreamCalls).toHaveLength(TOOL_STEPS + 1)
    const toolNames = (call: (typeof model.doStreamCalls)[number]) =>
      (call.tools ?? []).map((t) => t.name).sort()
    expect(toolNames(model.doStreamCalls[0])).toEqual([
      "get_weather",
      "scratch_pad",
    ])
    expect(toolNames(model.doStreamCalls[TOOL_STEPS])).toEqual(["get_weather"])

    expect(weatherExecute).toHaveBeenCalledTimes(TOOL_STEPS)
    expect(weatherExecute.mock.calls[0][0]).toEqual({ city: "City 1" })

    // Per-step accounting through the Tool runtime's onStepFinish, observed at
    // its sinks: budget accounting + one audit-log outcome per call.
    const budgetCalls = findCalls(
      convexBoundaryMutation,
      api.toolLimits.checkAndConsume
    )
    expect(budgetCalls.length).toBeGreaterThanOrEqual(TOOL_STEPS)
    const auditCalls = findCalls(convexBoundaryMutation, api.toolCallLog.log)
    expect(auditCalls).toHaveLength(TOOL_STEPS)
    expect(auditCalls.map((call) => call[1])).toEqual(
      Array.from({ length: TOOL_STEPS }, (_, i) =>
        expect.objectContaining({
          toolKey: "get_weather",
          success: true,
          stepNumber: i + 1,
          requestId: "req-seam-1",
        })
      )
    )

    // Durable persistence happened in order: the user-token admission call is
    // the ONLY fetchMutation call (ADR-0011); per-step tool invocation writes
    // and snapshots travel the worker wire, completion last.
    await vi.waitFor(() => {
      expect(wireCalls(wire, "markGenerationRunCompleted")).toHaveLength(1)
    })
    const fetchNames = durableFetchMutation.mock.calls.map((call) =>
      getFunctionName(call[0] as Parameters<typeof getFunctionName>[0])
    )
    expect(fetchNames).toEqual([
      getFunctionName(api.chatRuntime.prepareGeneration),
    ])
    expect(wire.calls.at(-1)?.op).toBe("markGenerationRunCompleted")

    // EVERY step records durably (ADR-0021): the four tool steps carry their
    // invocations, and the final text-only step still writes its per-step
    // usage as abort/failure settlement evidence.
    const invocationWrites = wireCalls(wire, "recordToolInvocations")
    expect(invocationWrites).toHaveLength(TOOL_STEPS + 1)
    expect(invocationWrites.map((call) => call.args.stepNumber)).toEqual([
      1, 2, 3, 4, 5,
    ])
    expect(invocationWrites[0].args).toMatchObject({
      runId: "run1",
      messageId: "msg1",
      usage: { inputTokens: 10, outputTokens: 5 },
      invocations: [
        expect.objectContaining({
          toolCallId: "call-1",
          toolName: "get_weather",
          source: "mcp",
          status: "completed",
        }),
      ],
    })
    const finalStepWrite = invocationWrites.at(-1)!
    expect(finalStepWrite.args).toMatchObject({
      stepNumber: TOOL_STEPS + 1,
      invocations: [],
      usage: { inputTokens: 10, outputTokens: 5 },
    })

    expect(
      wireCalls(wire, "updateAssistantSnapshot").length
    ).toBeGreaterThanOrEqual(1)

    // The completion write carries the streamText onEnd aggregate — usage
    // across ALL steps and the runtime's tool-outcome totals.
    const completed = wireCalls(wire, "markGenerationRunCompleted")[0]
    expect(completed.args).toMatchObject({
      runId: "run1",
      messageId: "msg1",
      content: "The weather is sunny — 20°C.",
      finishReason: "stop",
      totalToolCalls: TOOL_STEPS,
      failedToolCalls: 0,
      usage: {
        inputTokens: 10 * (TOOL_STEPS + 1),
        outputTokens: 5 * (TOOL_STEPS + 1),
      },
    })

    // No failure/abort writes on the happy path.
    expect(wireCalls(wire, "markGenerationRunFailed")).toHaveLength(0)
    expect(wireCalls(wire, "markGenerationRunAborted")).toHaveLength(0)
  })

  it("applies one cumulative output budget across real AI SDK tool steps, including fixed reasoning", async () => {
    const { loadResult, weatherExecute } = makeMcpToolsFixture()
    vi.mocked(loadUserMcpTools).mockResolvedValue(
      loadResult as unknown as Awaited<ReturnType<typeof loadUserMcpTools>>
    )
    const model = makeBudgetedToolLoopModel()
    vi.mocked(createLanguageModel).mockReturnValue(
      model as unknown as ReturnType<typeof createLanguageModel>
    )
    const wire = makeWorkerWire()
    const runtime = createChatTurnRuntime({
      input: makeInput({
        requestId: "req-seam-output-budget",
        // Haiku's catalogued fixed-thinking budget is 5,000. The AI SDK-facing
        // visible-output remainder is therefore 12, then 7, then 3.
        generationBudget: 5_012,
      }),
      deps: makeDeps(makeDurableFetchMutation(), wire),
    })

    await runtime.prepare()
    await (await runtime.toResponse(new AbortController().signal)).text()

    expect(model.doStreamCalls.map((call) => call.maxOutputTokens)).toEqual([
      12, 7, 3,
    ])
    expect(weatherExecute).toHaveBeenCalledTimes(3)
    expect(wireCalls(wire, "recordToolInvocations")).toHaveLength(3)
  })

  it("keeps streaming to durable completion when the request signal aborts mid-stream (client disconnect)", async () => {
    const { loadResult } = makeMcpToolsFixture()
    vi.mocked(loadUserMcpTools).mockResolvedValue(
      loadResult as unknown as Awaited<ReturnType<typeof loadUserMcpTools>>
    )
    vi.mocked(createLanguageModel).mockReturnValue(
      makeSlowTextModel() as unknown as ReturnType<typeof createLanguageModel>
    )
    const durableFetchMutation = makeDurableFetchMutation()
    const wire = makeWorkerWire()

    const runtime = createChatTurnRuntime({
      input: makeInput({ requestId: "req-seam-abort" }),
      deps: makeDeps(durableFetchMutation, wire),
    })
    await runtime.prepare()

    const abortController = new AbortController()
    const response = await runtime.toResponse(abortController.signal)
    const reader = response.body!.getReader()

    // Wait for the stream to actually start, then abort the request signal —
    // In the reload/disconnect case, a durable turn's provider consumption
    // deliberately excludes req.signal, so the worker
    // streams on to a normal durable completion. Stop reaches the worker
    // through the heartbeat/grant path, never through client disconnect.
    await reader.read()
    abortController.abort()
    while (!(await reader.read()).done) {
      // drain whatever the runtime still emits after the disconnect
    }

    await vi.waitFor(() => {
      expect(
        wireCalls(wire, "markGenerationRunCompleted").length
      ).toBeGreaterThanOrEqual(1)
    })
    const completionWrite = wireCalls(wire, "markGenerationRunCompleted")[0]
    expect(completionWrite.args).toMatchObject({
      runId: "run1",
      messageId: "msg1",
    })
    expect(wireCalls(wire, "markGenerationRunAborted")).toHaveLength(0)
    expect(wireCalls(wire, "markGenerationRunFailed")).toHaveLength(0)
  })

  it("stops the real runtime mid-pacing with one displayed, canonical, and durable prefix", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const { loadResult } = makeMcpToolsFixture()
      vi.mocked(loadUserMcpTools).mockResolvedValue(
        loadResult as unknown as Awaited<ReturnType<typeof loadUserMcpTools>>
      )
      vi.mocked(createLanguageModel).mockReturnValue(
        makePacedTextThenApprovalModel() as unknown as ReturnType<
          typeof createLanguageModel
        >
      )
      const durableFetchMutation = makeDurableFetchMutation()
      const calls: DurableWorkerCall[] = []
      const stopAwareWire = (async (call: DurableWorkerCall) => {
        calls.push(call)
        return call.op === "heartbeatGenerationRun"
          ? { result: { kind: "lost", reason: "stopped-by-user" } }
          : undefined
      }) as RecordingWire
      stopAwareWire.calls = calls

      const runtime = createChatTurnRuntime({
        input: makeInput({ requestId: "req-seam-paced-stop" }),
        deps: makeDeps(durableFetchMutation, stopAwareWire),
      })
      await runtime.prepare()

      // Put the heartbeat — the durable worker's production Stop/supersession
      // discovery path — five milliseconds away, then start the real response.
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS - 5)
      const response = await runtime.toResponse(new AbortController().signal)
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let sse = ""

      // Consume independently from the runtime's SSE tee until the first paced
      // word is genuinely visible on the response branch.
      while (!sse.includes('"type":"text-delta"')) {
        const next = await reader.read()
        expect(next.done).toBe(false)
        sse += decoder.decode(next.value, { stream: true })
      }
      expect(extractTextDeltasFromSse(sse)).toBe("alpha ")

      // The heartbeat now reports Stop while the pacing timer is live. Real
      // streamText aborts and cancels the remaining text before the queued
      // approval request can cross its durable persistence boundary.
      vi.advanceTimersByTime(5)
      await Promise.resolve()
      await Promise.resolve()
      while (true) {
        const next = await reader.read()
        if (next.done) break
        sse += decoder.decode(next.value, { stream: true })
      }
      sse += decoder.decode()

      const displayedText = extractTextDeltasFromSse(sse)
      expect(displayedText).toMatch(/^alpha (?:beta )?$/)
      expect(PACED_STOP_SLAB.startsWith(displayedText)).toBe(true)
      expect(displayedText).not.toContain("gamma")
      expect(sse).toContain('"type":"abort"')
      expect(sse).not.toContain("tool-approval-request")

      await vi.waitFor(() => {
        expect(
          wireCalls(stopAwareWire, "markGenerationRunAborted").length
        ).toBeGreaterThanOrEqual(1)
      })
      const abortWrites = wireCalls(stopAwareWire, "markGenerationRunAborted")
      // The stream callback and envelope settlement may both issue the same
      // idempotent terminal write, but their relative completion is an AI SDK
      // scheduling detail. The durable contract is that an abort is recorded.
      expect(abortWrites.length).toBeLessThanOrEqual(2)
      expect(
        abortWrites.every((call) => {
          const reason = call.args.reason
          return (
            typeof reason === "string" &&
            ["stream aborted", "ui message stream aborted"].includes(reason)
          )
        })
      ).toBe(true)
      const snapshotWrites = wireCalls(stopAwareWire, "updateAssistantSnapshot")
      expect(snapshotWrites.length).toBeGreaterThanOrEqual(1)
      expect(snapshotWrites.at(-1)?.args.textSnapshot).toBe(displayedText)
      expect(
        snapshotWrites.every((call) =>
          displayedText.startsWith(call.args.textSnapshot)
        )
      ).toBe(true)
      expect(
        wireCalls(stopAwareWire, "createToolApprovalRequest")
      ).toHaveLength(0)
      expect(
        wireCalls(stopAwareWire, "markGenerationRunCompleted")
      ).toHaveLength(0)
      expect(wireCalls(stopAwareWire, "markGenerationRunFailed")).toHaveLength(
        0
      )
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
