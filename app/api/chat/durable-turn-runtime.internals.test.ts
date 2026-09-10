import type { TextStreamPart, ToolSet, UIMessage } from "ai"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Id } from "@/convex/_generated/dataModel"
import { extractTextFromMessageParts } from "@/lib/chat-messages/parts"
import {
  createDurableSnapshotTracker,
  createRuntimeApprovalPersistenceTransform,
  getLatestUserMessage,
  isDurableConvexChat,
  toDurableUiMessage,
} from "./durable-turn-runtime"

const startedTextStreams = new WeakSet<object>()
function emitTextChunk(stream: { onChunk: (chunk: TextStreamPart<ToolSet>) => unknown }, text: string) {
  if (!startedTextStreams.has(stream)) {
    startedTextStreams.add(stream)
    stream.onChunk({ type: "text-start", id: "text-1" })
  }
  return stream.onChunk({ type: "text-delta", id: "text-1", text })
}

afterEach(() => {
  vi.useRealTimers()
})

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })

  return { promise, resolve }
}

// The absorbed internals of the Durable turn runtime (was `durable-runtime.ts`):
// the stateless helpers, the snapshot tracker, and the approval-persistence
// transform. The interface-level behaviors live in durable-turn-runtime.test.ts.
// Both stateful internals are credential-free since ADR-0011 — they receive a
// worker-wire-backed persister and never see a token or transport.
describe("durable turn runtime internals", () => {
  it("only enables Convex durability for authenticated callers with a token", () => {
    expect(
      isDurableConvexChat({ isAuthenticated: true, convexToken: "token" })
    ).toBe(true)
    expect(
      isDurableConvexChat({ isAuthenticated: true, convexToken: undefined })
    ).toBe(false)
    expect(
      isDurableConvexChat({ isAuthenticated: false, convexToken: "token" })
    ).toBe(false)
  })

  it("uses the latest user message instead of trusting full client history", () => {
    const messages = [
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "old" }] },
      { id: "u1", role: "user", parts: [{ type: "text", text: "first" }] },
      { id: "u2", role: "user", parts: [{ type: "text", text: "latest" }] },
    ] as UIMessage[]

    expect(getLatestUserMessage(messages)?.id).toBe("u2")
  })

  it("persists tool approval requests before streaming approval chunks", async () => {
    const approvalWrite = createDeferred<void>()
    const approvalWritePromises: Promise<unknown>[] = []
    const events: string[] = []
    const approvalChunk = {
      type: "tool-approval-request",
      approvalId: "approval-1",
      toolCall: {
        toolCallId: "call-1",
        toolName: "send_email",
        input: { to: "person@example.com" },
      },
    } as unknown as TextStreamPart<ToolSet>

    const transform = createRuntimeApprovalPersistenceTransform({
      chatId: "chat_1",
      assistantMessageId: "message_1" as Id<"messages">,
      // The transform reads reason/riskClass off ToolFacts.approvalFor
      // (the map+resolver threading dissolved once the decision carried them).
      toolFacts: {
        metadata: { source: () => "mcp" },
        approvalFor: (name: string) =>
          name === "send_email"
            ? {
                needsApproval: true,
                reason: "External write",
                riskClass: "write",
              }
            : undefined,
        toolApproval: undefined,
      },
      approvalWritePromises,
      requestId: "request-1",
      persistApprovalRequest: async (args) => {
        events.push(`write-start:${args.approvalId}`)
        expect(args).toMatchObject({
          assistantMessageId: "message_1",
          approvalId: "approval-1",
          toolCallId: "call-1",
          toolName: "send_email",
          source: "mcp",
          reason: "External write",
          riskClass: "write",
          inputPreview: JSON.stringify({ to: "person@example.com" }),
        })
        await approvalWrite.promise
        events.push("write-finished")
      },
    })
    const stream = new ReadableStream<TextStreamPart<ToolSet>>({
      start(controller) {
        controller.enqueue(approvalChunk)
        controller.close()
      },
    }).pipeThrough(
      transform({
        tools: {},
        stopStream: () => {},
      })
    )

    const reader = stream.getReader()
    const firstRead = reader.read().then((result) => {
      events.push("chunk-read")
      return result
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(events).toEqual(["write-start:approval-1"])
    expect(approvalWritePromises).toHaveLength(1)

    approvalWrite.resolve()
    const result = await firstRead

    expect(result.done).toBe(false)
    expect(result.value).toBe(approvalChunk)
    expect(events).toEqual([
      "write-start:approval-1",
      "write-finished",
      "chunk-read",
    ])
    const trackedApprovalWrite = approvalWritePromises[0]
    if (!trackedApprovalWrite) throw new Error("Approval write was not tracked")
    await expect(trackedApprovalWrite).resolves.toBeUndefined()
  })

  it("maps streaming Convex messages into nonblank UI messages", () => {
    const message = toDurableUiMessage({
      _id: "msg_1",
      _creationTime: 100,
      chatId: "chat_1",
      orderId: 0,
      role: "assistant",
      content: "partial output",
      parts: [{ type: "text", text: "partial output" }],
      status: "aborted",
      createdAt: 100,
      updatedAt: 200,
    } as Parameters<typeof toDurableUiMessage>[0])

    expect(message.id).toBe("msg_1")
    expect(message.createdAt).toEqual(new Date(100))
    expect(message.status).toBe("aborted")
    expect(extractTextFromMessageParts(message.parts)).toBe("partial output")
    expect(message.metadata?.durableStatus).toBe("aborted")
  })

  it("writes snapshots through the injected persister", async () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const tracker = createDurableSnapshotTracker({ persist })

    emitTextChunk(tracker, "A")
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist).toHaveBeenCalledWith({
      sequence: 1,
      textSnapshot: "A",
      partsSnapshot: [{ type: "text", text: "A", state: "streaming" }],
    })
  })

  it("does not force-write an empty snapshot before the first semantic delta", async () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const tracker = createDurableSnapshotTracker({ persist })

    await tracker.flush()

    expect(persist).not.toHaveBeenCalled()
    expect(tracker.textSnapshot).toBe("")
    expect(tracker.partsSnapshot).toEqual([])
  })

  it("checkpoints ordered commentary, tool results, and final text with phase metadata", async () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const tracker = createDurableSnapshotTracker({ persist, throttleMs: 60_000 })
    const chunks: TextStreamPart<ToolSet>[] = [
      { type: "text-start", id: "c", providerMetadata: { openai: { phase: "commentary" } } },
      { type: "text-delta", id: "c", text: "Looking up. " },
      { type: "text-end", id: "c" },
      { type: "tool-call", toolCallId: "s", toolName: "search", input: { query: "news" } },
      { type: "tool-result", toolCallId: "s", toolName: "search", input: { query: "news" }, output: { found: true } },
      { type: "text-start", id: "f", providerMetadata: { openai: { phase: "final_answer" } } },
      { type: "text-delta", id: "f", text: "The answer." },
    ]
    for (const chunk of chunks) await tracker.onChunk(chunk)
    // Abort may flush before text-end. The partial answer must survive too.
    await Promise.all([tracker.flush(), tracker.flush()])
    expect(persist.mock.lastCall?.[0]).toMatchObject({
      textSnapshot: "Looking up. The answer.",
      partsSnapshot: [
        { type: "text", text: "Looking up. ", state: "done", providerMetadata: { openai: { phase: "commentary" } } },
        { type: "tool-search", toolCallId: "s", state: "output-available", input: { query: "news" }, output: { found: true } },
        { type: "text", text: "The answer.", state: "streaming", providerMetadata: { openai: { phase: "final_answer" } } },
      ],
    })
  })

  it("retains the approved assistant baseline when a continuation checkpoints its result", async () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const commentary = { type: "text" as const, text: "I can do that.", state: "done" as const,
      providerMetadata: { openai: { phase: "commentary" } } }
    const tracker = createDurableSnapshotTracker({ persist, initialMessage: {
      id: "assistant", role: "assistant", parts: [commentary, {
        type: "tool-edit", toolCallId: "edit", state: "approval-responded",
        input: { name: "draft" }, approval: { id: "approval", approved: true },
      }],
    } })
    await tracker.onChunk({ type: "tool-result", toolCallId: "edit", toolName: "edit",
      input: { name: "draft" }, output: { saved: true } })
    await tracker.flush()
    expect(persist.mock.lastCall?.[0]).toMatchObject({
      textSnapshot: commentary.text,
      partsSnapshot: [commentary, { type: "tool-edit", state: "output-available", output: { saved: true } }],
    })
  })

  it("waits for an in-flight snapshot write before flushing the final snapshot", async () => {
    const firstWrite = createDeferred<void>()
    const persist = vi
      .fn()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValue(undefined)

    const tracker = createDurableSnapshotTracker({
      persist,
      throttleMs: 60_000,
    })

    emitTextChunk(tracker, "A")
    emitTextChunk(tracker, "B")

    let flushed = false
    const flushPromise = tracker.flush().then(() => {
      flushed = true
    })

    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(flushed).toBe(false)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0]?.[0]).toMatchObject({
      sequence: 1,
      textSnapshot: "A",
      partsSnapshot: [{ type: "text", text: "A", state: "streaming" }],
    })

    firstWrite.resolve()
    await flushPromise

    expect(persist).toHaveBeenCalledTimes(2)
    expect(persist.mock.calls[1]?.[0]).toMatchObject({
      sequence: 2,
      textSnapshot: "AB",
      partsSnapshot: [{ type: "text", text: "AB", state: "streaming" }],
    })
  })

  it("sequences the final full-parts snapshot after every throttled write", async () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const tracker = createDurableSnapshotTracker({
      persist,
      throttleMs: 60_000,
    })

    emitTextChunk(tracker, "A")
    await new Promise<void>((resolve) => setImmediate(resolve))

    const finalParts = [
      { type: "text", text: "AB" },
      {
        type: "tool-get_weather",
        toolCallId: "c1",
        state: "output-available",
        input: {},
        output: {},
      },
    ]
    await tracker.flushFinal("AB", finalParts)

    expect(persist).toHaveBeenCalledTimes(2)
    // The final snapshot carries the COMPLETE response parts (tool parts
    // included), not the tracker's text/reasoning subset, and a later
    // sequence than the throttled write.
    expect(persist.mock.calls[1]?.[0]).toEqual({
      sequence: 2,
      textSnapshot: "AB",
      partsSnapshot: finalParts,
    })
  })

  it("checkpoints the tool-order candidate, clears it explicitly, and lets a resolved duration supersede it", async () => {
    // The candidate is metadata, not content: noting it must advance the
    // content version so the checkpoint writes it, and a later tool call must
    // reach the doc as an explicit null — otherwise a user Stop would promote
    // an onset that just became commentary.
    const persist = vi.fn().mockResolvedValue(undefined)
    const tracker = createDurableSnapshotTracker({ persist, throttleMs: 0 })

    emitTextChunk(tracker, "Answer")
    await tracker.flush()
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0]?.[0]).not.toHaveProperty("workSummaryCandidateMs")

    tracker.noteWorkSummary({ candidateMs: 4400 })
    await tracker.flush()
    expect(persist.mock.calls[1]?.[0]).toMatchObject({
      textSnapshot: "Answer",
      workSummaryCandidateMs: 4400,
    })
    expect(persist.mock.calls[1]?.[0]).not.toHaveProperty("workSummaryDurationMs")

    tracker.noteWorkSummary({ candidateMs: undefined })
    await tracker.flush()
    expect(persist.mock.calls[2]?.[0]).toMatchObject({ workSummaryCandidateMs: null })

    // Server-side abort after answer onset: the resolved value rides the flush
    // even though text and parts are unchanged, and the candidate is cleared.
    tracker.noteWorkSummary({ durationMs: 7265 })
    await tracker.flush()
    expect(persist).toHaveBeenCalledTimes(4)
    expect(persist.mock.calls[3]?.[0]).toMatchObject({
      workSummaryDurationMs: 7265,
      workSummaryCandidateMs: null,
    })

    // Re-noting the same values is a no-op: no write storm from repeated chunks.
    tracker.noteWorkSummary({ durationMs: 7265 })
    await tracker.flush()
    expect(persist).toHaveBeenCalledTimes(4)
  })

  it("resolves overlapping flushes with bounded writes (post-Stop livelock)", async () => {
    // Regression: onAbort and the response-level onFinish both flush() within
    // ~200ms of a Stop. With a shared boolean `pending` flag, the two forced
    // persist loops re-armed each other forever — flush() never resolved, so
    // markGenerationRunAborted never ran and snapshot writes continued at the
    // write-latency rate until the Convex token expired.
    vi.useFakeTimers()
    const persist = vi
      .fn()
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 5))
      )

    const tracker = createDurableSnapshotTracker({
      persist,
      throttleMs: 60_000,
    })

    // First chunk starts an in-flight write both flushes must contend with.
    emitTextChunk(tracker, "A")
    emitTextChunk(tracker, "B")

    const flushes = Promise.all([tracker.flush(), tracker.flush()])
    const outcomePromise = Promise.race([
      flushes.then(() => "flushed" as const),
      new Promise<"livelocked">((resolve) =>
        setTimeout(() => resolve("livelocked"), 500)
      ),
    ])
    await vi.advanceTimersByTimeAsync(500)
    const outcome = await outcomePromise

    expect(outcome).toBe("flushed")
    // One in-flight incremental write plus at most one forced final write.
    expect(persist.mock.calls.length).toBeLessThanOrEqual(3)
    const lastCall = persist.mock.calls.at(-1)
    expect(lastCall?.[0]).toMatchObject({ textSnapshot: "AB" })
    vi.useRealTimers()
  })

  it("times out stalled snapshot writes so flush can settle and retry", async () => {
    vi.useFakeTimers()
    const persist = vi.fn().mockImplementation(() => new Promise(() => {}))

    try {
      const tracker = createDurableSnapshotTracker({ persist })

      emitTextChunk(tracker, "A")

      const flushPromise = tracker.flush()
      const flushExpectation = expect(flushPromise).rejects.toThrow(
        "Timed out writing assistant snapshot after 10000ms"
      )
      await vi.advanceTimersByTimeAsync(10_000)
      await flushExpectation

      persist.mockResolvedValue(undefined)
      await tracker.flush()

      expect(persist).toHaveBeenCalledTimes(2)
      expect(persist.mock.calls[1]?.[0]).toMatchObject({
        sequence: 2,
        textSnapshot: "A",
        partsSnapshot: [{ type: "text", text: "A", state: "streaming" }],
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("catches rejected incremental snapshot writes", async () => {
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason)
    }
    const persist = vi.fn().mockRejectedValueOnce(new Error("snapshot failed"))

    process.on("unhandledRejection", onUnhandledRejection)

    try {
      const tracker = createDurableSnapshotTracker({ persist })

      emitTextChunk(tracker, "A")

      await new Promise<void>((resolve) => setImmediate(resolve))
    } finally {
      process.off("unhandledRejection", onUnhandledRejection)
    }

    expect(persist).toHaveBeenCalledTimes(1)
    expect(unhandledRejections).toEqual([])
  })
})
