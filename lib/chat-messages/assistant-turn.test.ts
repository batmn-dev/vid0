import type { UIMessage } from "ai"
import { describe, expect, it, vi } from "vitest"
import {
  deriveAssistantActivityModel,
  deriveAssistantActivityPresentation,
  type AssistantActivityModel,
  type AssistantActivityTimelineEntry,
} from "./assistant-activity"
import {
  assistantTurnViewsEqual,
  deriveAssistantTurnPhase,
  deriveAssistantTurnView,
  deriveReasoningView,
  type AssistantTurnRenderStatus,
} from "./assistant-turn"
import { deriveTurnEvidence } from "./turn-evidence"

// Real implementation, spied so the one-walk contract below is observable.
vi.mock("./turn-evidence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./turn-evidence")>()
  return { ...actual, deriveTurnEvidence: vi.fn(actual.deriveTurnEvidence) }
})

const parts = (value: unknown) => value as UIMessage["parts"]

describe("one evidence walk per view", () => {
  it("view, phase and presentation walk the parts exactly once", () => {
    vi.mocked(deriveTurnEvidence).mockClear()
    const view = deriveAssistantTurnView(
      {
        parts: parts([
          { type: "reasoning", text: "plan", state: "done" },
          {
            type: "tool-web_search",
            toolCallId: "call-1",
            state: "input-available",
            input: { query: "q" },
          },
          { type: "text", text: "so far" },
        ]),
      },
      "streaming"
    )
    const phase = deriveAssistantTurnPhase(view, {
      status: "streaming",
      isLast: true,
    })
    deriveAssistantActivityPresentation(view, phase)

    expect(phase.kind).toBe("tooling")
    expect(deriveTurnEvidence).toHaveBeenCalledTimes(1)
  })
})

describe("deriveReasoningView", () => {
  it("is thinking while any reasoning part streams", () => {
    const view = deriveReasoningView(
      parts([{ type: "reasoning", text: "…", state: "streaming" }]),
      "streaming"
    )
    expect(view.phase).toBe("thinking")
    expect(view.isStreaming).toBe(true)
  })

  it("completes on done parts and reads the persisted duration via the metadata module", () => {
    const view = deriveReasoningView(
      parts([{ type: "reasoning", text: "done", state: "done" }]),
      "ready",
      { reasoningDurationMs: 2000 }
    )
    expect(view.phase).toBe("complete")
    expect(view.text).toBe("done")
    expect(view.persistedDurationMs).toBe(2000)
  })

  it("keeps isStreaming a raw part fact: state-less stored parts never shimmer historical triggers", () => {
    // A stored opaque-reasoning part without a `state` field, read while some
    // OTHER turn streams: the panel's phase inference may say "thinking", but
    // the row trigger must not — isStreaming is the literal part state.
    const view = deriveReasoningView(
      parts([{ type: "reasoning", text: "" }]),
      "streaming"
    )
    expect(view.phase).toBe("thinking")
    expect(view.isStreaming).toBe(false)
  })

  it("treats a persisted duration without reasoning parts as completed opaque reasoning", () => {
    // The persist layer drops empty opaque reasoning parts; the stamped
    // duration is the surviving evidence. The settled trigger must not vanish
    // when the durable snapshot is adopted.
    const view = deriveReasoningView(parts([]), "ready", {
      reasoningDurationMs: 3000,
    })
    expect(view.phase).toBe("complete")
    expect(view.isOpaque).toBe(true)
    expect(view.persistedDurationMs).toBe(3000)

    // No parts AND no duration stays idle (e.g. the pending placeholder).
    expect(deriveReasoningView(parts([]), "ready").phase).toBe("idle")
  })

  it("settles a part frozen in 'streaming' state once the chat status ends (Stop/error kills the timer)", () => {
    // Abort/stop/error never transitions part states, so a stuck "streaming"
    // part must read complete on a settled turn — this is what freezes the
    // panel's elapsed timer and the trigger's shimmer after Stop.
    for (const status of ["ready", "error"] as const) {
      const view = deriveReasoningView(
        parts([{ type: "reasoning", text: "", state: "streaming" }]),
        status
      )
      expect(view.phase).toBe("complete")
      expect(view.isStreaming).toBe(false)
      expect(view.isOpaque).toBe(true)
    }
  })
})

describe("deriveAssistantActivityModel chronology", () => {
  it("preserves reasoning/tool/search execution order and attaches sources to the search", () => {
    const view = viewOf(
      [
        { type: "reasoning", text: "**Planning**\nFirst step", state: "done" },
        {
          type: "tool-python",
          toolCallId: "code-1",
          state: "output-available",
          input: { command: "print(1)" },
          output: "1",
        },
        {
          type: "tool-web_search",
          toolCallId: "search-1",
          state: "output-available",
          input: { query: "pixel accurate activity panels" },
          output: {},
        },
        {
          type: "source-url",
          sourceId: "source-1",
          url: "https://example.com/activity",
          title: "Activity reference",
        },
        { type: "reasoning", text: "**Reviewing**\nLast step", state: "done" },
      ],
      "ready",
      { reasoningDurationMs: 4200, workDurationMs: 4800 }
    )

    const activity = deriveAssistantActivityModel(view, { kind: "settled" })
    expect(activity?.entries.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: "reasoning-0-0", kind: "reasoning" },
      { id: "tool-code-1", kind: "tool" },
      { id: "tool-search-1", kind: "search" },
      { id: "reasoning-4-0", kind: "reasoning" },
    ])
    const searchEntry = activity?.entries[2]
    expect(
      searchEntry?.kind === "search"
        ? searchEntry.sources.map((source) => source.sourceId)
        : undefined
    ).toEqual(["source-1"])
    expect(activity?.completion).toMatchObject({
      title: "Worked for 4s",
      detail: "Done",
    })
  })

  it("keeps tool identity stable while streaming state enriches in place", () => {
    const running = viewOf(
      [
        {
          type: "tool-python",
          toolCallId: "call-1",
          state: "input-available",
          input: { command: "print(1)" },
        },
      ],
      "streaming"
    )
    const complete = viewOf(
      [
        {
          type: "tool-python",
          toolCallId: "call-1",
          state: "output-available",
          input: { command: "print(1)" },
          output: "1",
        },
      ],
      "ready"
    )

    const runningModel = deriveAssistantActivityModel(running, {
      kind: "tooling",
      toolNames: ["python"],
    })
    const completeModel = deriveAssistantActivityModel(complete, {
      kind: "settled",
    })
    expect(runningModel?.entries[0]).toMatchObject({
      id: "tool-call-1",
      status: "running",
      tool: {
        displayName: "Python",
        code: "print(1)",
      },
    })
    expect(completeModel?.entries[0]).toMatchObject({
      id: "tool-call-1",
      status: "complete",
    })
  })

  it("keeps interleaved searches independent across delayed and streamed source updates", () => {
    const view = viewOf(
      [
        {
          type: "tool-web_search",
          toolCallId: "search-a",
          state: "output-available",
          input: { query: "first query" },
          output: {
            sources: [
              {
                url: "https://shared.example/result",
                title: "First search title",
                snippet: "First search snippet",
              },
            ],
          },
        },
        {
          type: "reasoning",
          text: "**Comparing**\nInterleaved",
          state: "done",
        },
        {
          type: "tool-web_search",
          toolCallId: "search-b",
          state: "output-available",
          input: {},
          output: {
            action: { query: "second query" },
            sources: [
              {
                url: "https://shared.example/result",
                title: "Second search title",
              },
              {
                url: "https://second.example/result",
                title: "Second unique result",
              },
            ],
          },
        },
        {
          type: "source-url",
          sourceId: "delayed-a",
          url: "https://first.example/delayed",
          title: "Delayed first result",
          toolCallId: "search-a",
        },
        {
          type: "source-url",
          sourceId: "nearest-b",
          url: "https://second.example/nearest",
          title: "Nearest second result",
        },
      ],
      "ready"
    )

    const activity = deriveAssistantActivityModel(view, { kind: "settled" })
    const searches = activity?.entries.filter(
      (entry) => entry.kind === "search"
    )
    expect(searches?.map((entry) => entry.id)).toEqual([
      "tool-search-a",
      "tool-search-b",
    ])
    expect(searches?.map((entry) => entry.title)).toEqual([
      "Searching for first query",
      "Searching for second query",
    ])
    expect(searches?.[0]?.sources?.map((source) => source.url)).toEqual([
      "https://shared.example/result",
      "https://first.example/delayed",
    ])
    expect(searches?.[0]?.sources?.[0]).toMatchObject({
      title: "First search title",
      description: "First search snippet",
    })
    expect(searches?.[1]?.sources?.map((source) => source.url)).toEqual([
      "https://shared.example/result",
      "https://second.example/result",
      "https://second.example/nearest",
    ])
    // Turn-level gallery dedupes duplicate URLs while per-search context does not leak.
    expect(activity?.sourceResults.map((source) => source.url)).toEqual([
      "https://shared.example/result",
      "https://second.example/result",
      "https://first.example/delayed",
      "https://second.example/nearest",
    ])
  })

  it("enriches a partial search call at the same stable row id", () => {
    const partial = deriveAssistantActivityModel(
      viewOf([
        {
          type: "tool-web_search",
          toolCallId: "search-stream",
          state: "input-streaming",
          input: { query: "activity" },
        },
      ]),
      { kind: "tooling", toolNames: ["web_search"] }
    )
    const enriched = deriveAssistantActivityModel(
      viewOf(
        [
          {
            type: "tool-web_search",
            toolCallId: "search-stream",
            state: "output-available",
            input: { query: "activity timeline" },
            output: {
              sources: [{ url: "https://example.com/activity" }],
            },
          },
        ],
        "ready"
      ),
      { kind: "settled" }
    )

    expect(partial?.entries[0]).toMatchObject({
      id: "tool-search-stream",
      status: "running",
    })
    expect(enriched?.entries[0]).toMatchObject({
      id: "tool-search-stream",
      status: "complete",
      title: "Searching for activity timeline",
    })
    const enrichedSearch = enriched?.entries[0]
    expect(
      enrichedSearch?.kind === "search" ? enrichedSearch.sources : undefined
    ).toHaveLength(1)
  })

  it("presents browse actions as page reads, never bare tool rows", () => {
    const activity = deriveAssistantActivityModel(
      viewOf(
        [
          {
            type: "tool-web_search",
            toolCallId: "browse-1",
            state: "output-available",
            input: {},
            output: {
              action: {
                type: "findInPage",
                url: "https://apnews.com/",
                pattern: "Latest",
              },
            },
          },
        ],
        "ready"
      ),
      { kind: "settled" }
    )
    expect(activity?.entries[0]).toMatchObject({
      id: "tool-browse-1",
      kind: "search",
      title: "Read apnews.com",
      detail: "Finding “Latest”",
      status: "complete",
    })
    const browse = activity?.entries[0]
    expect(
      browse?.kind === "search" ? browse.sources.map((s) => s.url) : undefined
    ).toEqual(["https://apnews.com/"])
  })

  it("marks only the incrementally streaming reasoning part as running", () => {
    const view = viewOf(
      [
        { type: "reasoning", text: "**Planned**\nDone", state: "done" },
        {
          type: "reasoning",
          text: "**Checking**\nStill working",
          state: "streaming",
        },
      ],
      "streaming"
    )

    const activity = deriveAssistantActivityModel(view, {
      kind: "thinking",
      visibility: "visible",
    })
    expect(activity?.entries.map((entry) => entry.status)).toEqual([
      "complete",
      "running",
    ])
    expect(activity?.entries.map((entry) => entry.id)).toEqual([
      "reasoning-0-0",
      "reasoning-1-0",
    ])
  })

  it("exposes an approval id only while the approval turn is live", () => {
    const approvalParts = [
      {
        type: "tool-delete_file",
        toolCallId: "call-1",
        state: "approval-requested",
        input: { path: "/tmp/a" },
        approval: { id: "approval-1" },
      },
    ]

    const activity = deriveAssistantActivityModel(
      viewOf(approvalParts, "streaming"),
      { kind: "awaiting-approval" }
    )
    expect(activity?.entries[0]).toMatchObject({
      status: "approval",
      tool: { approvalId: "approval-1" },
    })

    const settled = deriveAssistantActivityModel(
      viewOf(approvalParts, "ready"),
      { kind: "settled" }
    )
    expect(settled?.entries[0]?.status).toBe("stopped")
    expect(settled?.entries[0]).not.toHaveProperty("tool.approvalId")
  })
})

describe("deriveAssistantTurnView", () => {
  it("derives text, tools, sources, and identity in one pass", () => {
    const message = {
      parts: parts([
        { type: "text", text: "Answer " },
        { type: "text", text: "continued" },
        {
          type: "tool-search",
          toolCallId: "t1",
          state: "output-available",
          input: { query: "q" },
          output: { summary: "s" },
        },
        {
          type: "source-url",
          sourceId: "s1",
          url: "https://example.com",
          title: "Example",
        },
      ]),
      metadata: { serverMessageId: "server-1" },
    }

    const view = deriveAssistantTurnView(message, "ready")
    expect(view.text).toBe("Answer continued")
    expect(view.toolParts).toHaveLength(1)
    expect(view.sources.map((s) => s.url)).toEqual(["https://example.com"])
    expect(view.serverMessageId).toBe("server-1")
    expect(view.metadata).toBe(message.metadata)
    expect(view.toolRenderSignature).toContain("search")
  })

  it("dedupes sources by URL, keeping the first occurrence", () => {
    // Providers cite the same URL across parts/steps. The view is the single
    // derivation for every consumer (gallery rows, "Sources · N", trigger
    // counts), so one URL must appear once — with its first title.
    const message = {
      parts: parts([
        {
          type: "source-url",
          sourceId: "s1",
          url: "https://releasebot.io/a",
          title: "Releasebot",
        },
        {
          type: "source-url",
          sourceId: "s2",
          url: "https://releasebot.io/a",
          title: "Releasebot (duplicate)",
        },
        {
          type: "source-url",
          sourceId: "s3",
          url: "https://other.dev/b",
          title: "Other",
        },
      ]),
    }

    const view = deriveAssistantTurnView(message, "ready")
    expect(view.sources.map((s) => s.url)).toEqual([
      "https://releasebot.io/a",
      "https://other.dev/b",
    ])
    expect(view.sources[0].title).toBe("Releasebot")
  })

  it("preserves search-result snippets for the Activity sources gallery", () => {
    const view = deriveAssistantTurnView(
      {
        parts: parts([
          {
            type: "tool-web_search",
            toolCallId: "search-1",
            state: "output-available",
            input: { query: "accessible timelines" },
            output: [
              {
                url: "https://example.com/activity",
                title: "Activity reference",
                snippet: "A concise result description for the source card.",
              },
            ],
          },
        ]),
      },
      "ready"
    )

    expect(view.sources[0]).toMatchObject({
      title: "Activity reference",
      description: "A concise result description for the source card.",
    })
  })

  it("observes in-place part mutation across derivations (no memoization)", () => {
    const shared = parts([
      {
        type: "tool-search",
        toolCallId: "t1",
        state: "input-streaming",
        input: { query: "a" },
      },
    ])
    const message = { parts: shared }

    const before = deriveAssistantTurnView(message, "streaming")
    ;(shared as unknown as Array<{ input: { query: string } }>)[0].input.query =
      "ab"
    const after = deriveAssistantTurnView(message, "streaming")

    expect(before.toolRenderSignature).not.toBe(after.toolRenderSignature)
  })
})

describe("assistantTurnViewsEqual memo contract", () => {
  const base = () =>
    deriveAssistantTurnView(
      {
        parts: parts([{ type: "reasoning", text: "a", state: "streaming" }]),
        metadata: undefined,
      },
      "streaming"
    )

  it("detects reasoning and source updates rendered by inline work", () => {
    const a = base()
    const b = deriveAssistantTurnView(
      {
        parts: parts([
          { type: "reasoning", text: "a longer delta", state: "streaming" },
          {
            type: "source-url",
            sourceId: "s1",
            url: "https://example.com",
            title: "Example",
          },
        ]),
        metadata: undefined,
      },
      "streaming"
    )
    expect(assistantTurnViewsEqual(a, b)).toBe(false)
  })

  it("differs on a reasoning phase transition", () => {
    const a = base()
    const b = deriveAssistantTurnView(
      {
        parts: parts([{ type: "reasoning", text: "a", state: "done" }]),
        metadata: undefined,
      },
      "ready"
    )
    expect(assistantTurnViewsEqual(a, b)).toBe(false)
  })

  it("differs on tool signature and metadata identity changes", () => {
    const a = base()
    const withTool = deriveAssistantTurnView(
      {
        parts: parts([
          { type: "reasoning", text: "a", state: "streaming" },
          {
            type: "tool-search",
            toolCallId: "t1",
            state: "input-streaming",
            input: { query: "q" },
          },
        ]),
        metadata: undefined,
      },
      "streaming"
    )
    expect(assistantTurnViewsEqual(a, withTool)).toBe(false)

    const withMetadata = deriveAssistantTurnView(
      {
        parts: parts([{ type: "reasoning", text: "a", state: "streaming" }]),
        metadata: { serverMessageId: "server-1" },
      },
      "streaming"
    )
    expect(assistantTurnViewsEqual(a, withMetadata)).toBe(false)
  })
})

describe("closed activity entry algebra (compile-time)", () => {
  it("makes illegal entries unrepresentable", () => {
    // Runtime no-op: the assertions are the @ts-expect-error probes below —
    // each line fails the suite via typecheck if the closure ever loosens.
    const probes: ReadonlyArray<AssistantActivityTimelineEntry | undefined> = [
      // @ts-expect-error a reasoning row has no failure vocabulary
      { id: "r", kind: "reasoning", title: "t", status: "error" },
      // @ts-expect-error a search row owns its sources
      { id: "s", kind: "search", title: "t", status: "complete" },
      // @ts-expect-error a tool row carries its tool detail
      { id: "t", kind: "tool", title: "t", status: "running" },
      {
        id: "t",
        kind: "tool",
        title: "t",
        status: "approval",
        // @ts-expect-error an approval row must carry the id its buttons submit
        tool: { toolName: "x", displayName: "X" },
      },
    ]
    const model: AssistantActivityModel = {
      entries: [
        {
          id: "completion",
          // @ts-expect-error the completion row lives on the model, not in entries
          kind: "completion",
          title: "t",
          detail: "Done",
          status: "complete",
        },
      ],
      sourceResults: [],
      imageResults: [],
    }
    expect(probes.length + model.entries.length).toBeGreaterThan(0)
  })
})

const liveCtx = { status: "streaming" as const, isLast: true }

function viewOf(
  rawParts: unknown,
  status: "streaming" | "ready" | "submitted" | "error" = "streaming",
  metadata?: unknown
) {
  return deriveAssistantTurnView({ parts: parts(rawParts), metadata }, status)
}

describe("deriveAssistantTurnPhase", () => {
  it("is thinking for a bare live stream with nothing else signaled", () => {
    const phase = deriveAssistantTurnPhase(viewOf([]), liveCtx)
    expect(phase).toEqual({ kind: "thinking", visibility: "opaque" })
  })

  it("keeps Thinking for whitespace-only text without changing the rendered text", () => {
    const view = viewOf([{ type: "text", text: " \n" }])
    const phase = deriveAssistantTurnPhase(view, liveCtx)

    expect(view.text).toBe(" \n")
    expect(phase).toEqual({ kind: "thinking", visibility: "opaque" })
    expect(deriveAssistantActivityPresentation(view, phase)).toMatchObject({
      kind: "live-status",
      label: "Thinking",
    })
  })

  it("is thinking(opaque) while opaque reasoning streams — the dots+Thinking regression", () => {
    const phase = deriveAssistantTurnPhase(
      viewOf([{ type: "reasoning", text: "", state: "streaming" }]),
      liveCtx
    )
    expect(phase).toEqual({ kind: "thinking", visibility: "opaque" })
  })

  it("is thinking(visible) while reasoning streams visible text", () => {
    const phase = deriveAssistantTurnPhase(
      viewOf([{ type: "reasoning", text: "let me think", state: "streaming" }]),
      liveCtx
    )
    expect(phase).toEqual({ kind: "thinking", visibility: "visible" })
  })

  it("ranks an in-flight tool above streaming reasoning", () => {
    const phase = deriveAssistantTurnPhase(
      viewOf([
        { type: "reasoning", text: "…", state: "streaming" },
        {
          type: "tool-web_search",
          toolCallId: "t1",
          state: "input-streaming",
          input: {},
        },
      ]),
      liveCtx
    )
    expect(phase).toEqual({ kind: "tooling", toolNames: ["web_search"] })
  })

  it("ranks image generation above other in-flight tools", () => {
    const phase = deriveAssistantTurnPhase(
      viewOf([
        {
          type: "tool-web_search",
          toolCallId: "t1",
          state: "input-available",
          input: {},
        },
        {
          type: "tool-imageGeneration",
          toolCallId: "t2",
          state: "input-available",
          input: {},
        },
      ]),
      liveCtx
    )
    expect(phase).toEqual({ kind: "generating-image" })
  })

  it("is awaiting-approval for an approval-requested part, not tooling", () => {
    const phase = deriveAssistantTurnPhase(
      viewOf([
        {
          type: "tool-web_search",
          toolCallId: "t1",
          state: "approval-requested",
          input: {},
          approval: { id: "a1" },
        },
      ]),
      liveCtx
    )
    expect(phase).toEqual({ kind: "awaiting-approval" })
  })

  it("is awaiting-approval when the durable status pauses the turn", () => {
    const phase = deriveAssistantTurnPhase(viewOf([], "ready"), {
      status: "awaiting_approval",
      isLast: true,
    })
    expect(phase).toEqual({ kind: "awaiting-approval" })
  })

  it("counts an approved approval response as in-flight, but not a denied one", () => {
    const approved = deriveAssistantTurnPhase(
      viewOf([
        {
          type: "tool-web_search",
          toolCallId: "t1",
          state: "approval-responded",
          input: {},
          approval: { id: "a1", approved: true },
        },
      ]),
      liveCtx
    )
    expect(approved).toEqual({ kind: "tooling", toolNames: ["web_search"] })

    const denied = deriveAssistantTurnPhase(
      viewOf([
        {
          type: "tool-web_search",
          toolCallId: "t1",
          state: "approval-responded",
          input: {},
          approval: { id: "a1", approved: false },
        },
      ]),
      liveCtx
    )
    expect(denied.kind).toBe("thinking")
  })

  it("responds only after answer text, remaining thinking between completed work steps", () => {
    expect(
      deriveAssistantTurnPhase(viewOf([{ type: "text", text: "Hi" }]), liveCtx)
        .kind
    ).toBe("responding")
    // A finished summary does not imply an answer has started.
    expect(
      deriveAssistantTurnPhase(
        viewOf([{ type: "reasoning", text: "", state: "done" }]),
        liveCtx
      ).kind
    ).toBe("thinking")
    expect(
      deriveAssistantTurnPhase(
        viewOf([
          {
            type: "tool-web_search",
            toolCallId: "t1",
            state: "output-available",
            input: {},
            output: {},
          },
        ]),
        liveCtx
      ).kind
    ).toBe("thinking")
  })

  it("is submitted pre-stream", () => {
    const phase = deriveAssistantTurnPhase(viewOf([], "submitted"), {
      status: "submitted",
      isLast: true,
    })
    expect(phase).toEqual({ kind: "submitted" })
  })

  it("settles non-last turns regardless of frozen in-progress part states", () => {
    const phase = deriveAssistantTurnPhase(
      viewOf(
        [
          { type: "reasoning", text: "", state: "streaming" },
          {
            type: "tool-web_search",
            toolCallId: "t1",
            state: "input-available",
            input: {},
          },
        ],
        "ready"
      ),
      { status: "streaming", isLast: false }
    )
    expect(phase).toEqual({ kind: "settled" })
  })

  it("settles the last turn the moment the client stream ends — Stop mid-tool-call", () => {
    for (const status of [
      "ready",
      "error",
      "aborted",
      "failed",
      "completed",
    ] as AssistantTurnRenderStatus[]) {
      const phase = deriveAssistantTurnPhase(
        viewOf(
          [
            {
              type: "tool-web_search",
              toolCallId: "t1",
              state: "input-available",
              input: {},
            },
          ],
          "ready"
        ),
        { status, isLast: true }
      )
      expect(phase).toEqual({ kind: "settled" })
    }
  })
})

describe("deriveAssistantActivityPresentation", () => {
  it("uses the latest active chronological entry for live disclosure copy", () => {
    const view = viewOf([
      {
        type: "tool-python",
        toolCallId: "tool-1",
        state: "input-available",
        input: { description: "Checking local data" },
      },
      {
        type: "tool-web_search",
        toolCallId: "search-1",
        state: "input-available",
        input: { query: "weather today" },
      },
    ])

    expect(
      deriveAssistantActivityPresentation(view, {
        kind: "tooling",
        toolNames: ["python", "web_search"],
      })
    ).toMatchObject({
      kind: "disclosure",
      label: "Searching for weather today",
      motion: "shimmer",
    })
  })

  it("keeps a completed search while the next search supplies the live title", () => {
    const view = viewOf([
      {
        type: "tool-web_search",
        toolCallId: "search-1",
        state: "output-available",
        input: { query: "New York weather" },
        output: {},
      },
      {
        type: "tool-web_search",
        toolCallId: "search-2",
        state: "input-available",
        input: { query: "London weather" },
      },
    ])
    const presentation = deriveAssistantActivityPresentation(view, {
      kind: "tooling",
      toolNames: ["web_search"],
    })

    expect(presentation).toMatchObject({
      kind: "disclosure",
      label: "Searching for London weather",
      activity: {
        entries: [
          { title: "Searching for New York weather", status: "complete" },
          { title: "Searching for London weather", status: "running" },
        ],
      },
    })
  })

  it("uses an ordinary tool action as the live title", () => {
    const view = viewOf([
      {
        type: "tool-python",
        toolCallId: "tool-1",
        state: "input-available",
        input: { description: "Calculating the comparison" },
      },
    ])

    expect(
      deriveAssistantActivityPresentation(view, {
        kind: "tooling",
        toolNames: ["python"],
      })
    ).toMatchObject({
      kind: "disclosure",
      label: "Calculating the comparison",
    })
  })

  it("keeps the image entry and live title on the Generating image fallback", () => {
    const view = viewOf([
      {
        type: "tool-imageGeneration",
        toolCallId: "image-1",
        state: "input-available",
        input: {},
      },
    ])
    const presentation = deriveAssistantActivityPresentation(view, {
      kind: "generating-image",
    })

    expect(presentation).toMatchObject({
      kind: "disclosure",
      label: "Generating image",
      activity: {
        entries: [
          { kind: "image", title: "Generating image", status: "running" },
        ],
      },
    })
  })

  it("uses approval entry copy without shimmer", () => {
    const view = viewOf([
      {
        type: "tool-delete_file",
        toolCallId: "tool-1",
        state: "approval-requested",
        input: {},
        approval: { id: "approval-1" },
      },
    ])

    expect(
      deriveAssistantActivityPresentation(view, {
        kind: "awaiting-approval",
      })
    ).toMatchObject({
      kind: "disclosure",
      label: "Review Delete File",
      motion: "none",
    })
  })

  it("lets approval status beat search classification for motion", () => {
    const view = viewOf([
      {
        type: "tool-web_search",
        toolCallId: "search-1",
        state: "approval-requested",
        input: { query: "sensitive query" },
        approval: { id: "approval-1" },
      },
    ])

    expect(
      deriveAssistantActivityPresentation(view, {
        kind: "awaiting-approval",
      })
    ).toMatchObject({
      kind: "disclosure",
      label: "Searching for sensitive query",
      motion: "none",
    })
  })

  it("keeps a stale running implied search as the active label", () => {
    const view = viewOf([
      {
        type: "source-url",
        sourceId: "source-1",
        url: "https://example.com",
        title: "Example",
      },
      {
        type: "tool-python",
        toolCallId: "tool-1",
        state: "output-available",
        input: { description: "Checking the result" },
        output: {},
      },
    ])

    expect(
      deriveAssistantActivityPresentation(view, {
        kind: "thinking",
        visibility: "opaque",
      })
    ).toMatchObject({
      kind: "disclosure",
      label: "Searching the web",
    })
  })

  it("uses the active reasoning title for visible reasoning", () => {
    const view = viewOf([
      {
        type: "reasoning",
        text: "**Comparing sources**\nReviewing the results",
        state: "streaming",
      },
    ])

    expect(
      deriveAssistantActivityPresentation(view, {
        kind: "thinking",
        visibility: "visible",
      })
    ).toMatchObject({
      kind: "disclosure",
      label: "Comparing sources",
      motion: "shimmer",
    })
  })

  it.each([
    [undefined, "none", undefined],
    [999, "passive", "Thought"],
    [1000, "passive", "Thought for 1s"],
    [1999, "passive", "Thought for 1s"],
    [2000, "passive", "Thought for 2s"],
  ] as const)(
    "normalizes opaque duration %s to %s",
    (durationMs, kind, label) => {
      const view = viewOf(
        [{ type: "reasoning", text: "   ", state: "done" }],
        "ready",
        durationMs === undefined
          ? undefined
          : { reasoningDurationMs: durationMs }
      )
      const presentation = deriveAssistantActivityPresentation(view, {
        kind: "settled",
      })
      expect(presentation.kind).toBe(kind)
      if (label && presentation.kind === "passive") {
        expect(presentation.label).toBe(label)
      }
    }
  )

  it("keeps visible sub-second reasoning inspectable without a duration", () => {
    const view = viewOf(
      [{ type: "reasoning", text: "Visible reasoning", state: "done" }],
      "ready",
      { reasoningDurationMs: 1 }
    )
    const presentation = deriveAssistantActivityPresentation(view, {
      kind: "settled",
    })
    expect(presentation.kind).toBe("disclosure")
    if (presentation.kind === "disclosure") {
      expect(presentation.label).toBe("Thought")
      expect(presentation.durationSeconds).toBeUndefined()
      expect(presentation.activity.entries.map((entry) => entry.kind)).toEqual([
        "reasoning",
      ])
      expect(presentation.activity.completion).toMatchObject({
        title: "Thought",
        status: "complete",
      })
    }
  })

  it("uses Thinking for submitted and content-empty live turns", () => {
    const emptyView = viewOf([])
    for (const phase of [
      { kind: "submitted" } as const,
      { kind: "thinking", visibility: "opaque" } as const,
    ]) {
      expect(
        deriveAssistantActivityPresentation(emptyView, phase)
      ).toMatchObject({
        kind: "live-status",
        label: "Thinking",
      })
    }
  })

  it("uses one timed disclosure for mixed non-reasoning activity", () => {
    const view = viewOf(
      [
        { type: "reasoning", text: "", state: "done" },
        {
          type: "tool-web_search",
          toolCallId: "t1",
          state: "output-available",
          input: {},
          output: {},
        },
      ],
      "ready",
      { reasoningDurationMs: 436, workDurationMs: 4600 }
    )
    const presentation = deriveAssistantActivityPresentation(view, {
      kind: "settled",
    })
    expect(presentation).toMatchObject({
      kind: "disclosure",
      label: "Worked for 4s",
      durationSeconds: 4,
      activity: {
        completion: {
          title: "Worked for 4s",
        },
      },
    })
  })

  it("uses total work for tool activity without displayable reasoning", () => {
    const view = viewOf(
      [
        {
          type: "tool-web_search",
          toolCallId: "search-only",
          state: "output-available",
          input: { query: "provider-neutral timing" },
          output: {},
        },
      ],
      "ready",
      { workDurationMs: 7300 }
    )

    expect(
      deriveAssistantActivityPresentation(view, { kind: "settled" })
    ).toMatchObject({
      kind: "disclosure",
      label: "Worked for 7s",
      durationSeconds: 7,
    })
  })

  it.each([
    ["failed", "Run failed", "error"],
    ["aborted", "Generation stopped", "stopped"],
  ] as const)(
    "retains work-duration evidence for %s tool turns",
    (status, completionTitle, completionStatus) => {
      const view = viewOf(
        [
          {
            type: "tool-web_search",
            toolCallId: `${status}-search`,
            state: status === "failed" ? "output-error" : "input-available",
            input: { query: "terminal timing" },
            ...(status === "failed" ? { errorText: "failed" } : {}),
          },
        ],
        "ready",
        { workDurationMs: 5300 }
      )
      const presentation = deriveAssistantActivityPresentation(
        view,
        { kind: "settled" },
        { status }
      )
      expect(presentation).toMatchObject({
        kind: "disclosure",
        label: "Worked for 5s",
        durationSeconds: 5,
        activity: {
          completion: {
            title: completionTitle,
            status: completionStatus,
          },
        },
      })
    }
  )

  it("keeps OpenAI-style multi-second reasoning labeled as thought", () => {
    const view = viewOf(
      [{ type: "reasoning", text: "Analyzing", state: "done" }],
      "ready",
      { reasoningDurationMs: 25_500, workDurationMs: 28_000 }
    )

    expect(
      deriveAssistantActivityPresentation(view, { kind: "settled" })
    ).toMatchObject({
      kind: "disclosure",
      label: "Thought for 25s",
      durationSeconds: 25,
    })
  })

  it("normalizes tool error copy and canonical display names upstream", () => {
    const view = viewOf(
      [
        {
          type: "tool-github_create_issue",
          toolCallId: "t1",
          state: "output-available",
          input: {},
          output: { isError: true },
        },
      ],
      "ready"
    )
    const presentation = deriveAssistantActivityPresentation(view, {
      kind: "settled",
    })

    expect(presentation).toMatchObject({
      kind: "disclosure",
      activity: {
        entries: [
          {
            id: "tool-t1",
            kind: "tool",
            title: "Github Create Issue failed",
            detail: "Tool reported an error",
            status: "error",
          },
        ],
        completion: {
          id: "completion",
          kind: "completion",
          title: "Run failed",
          status: "error",
        },
      },
    })
  })

  it("does not report a user-denied tool as a failed run", () => {
    const view = viewOf(
      [
        {
          type: "tool-ask_question",
          toolCallId: "tool-denied",
          state: "output-denied",
          input: { question: "What does streamText do?" },
          approval: {
            id: "approval-1",
            approved: false,
            reason: "Denied by user",
          },
        },
        {
          type: "text",
          text: "That call was denied, so here is a best-effort answer.",
        },
      ],
      "ready"
    )
    const presentation = deriveAssistantActivityPresentation(view, {
      kind: "settled",
    })

    expect(presentation).toMatchObject({
      kind: "disclosure",
      activity: {
        entries: [
          {
            id: "tool-tool-denied",
            kind: "tool",
            status: "denied",
            detail: "Denied by user",
          },
        ],
        completion: { kind: "completion", status: "complete", detail: "Done" },
      },
    })
  })

  it("keeps completion present while the answer is responding", () => {
    const view = viewOf([
      {
        type: "tool-python",
        toolCallId: "tool-1",
        state: "output-available",
        input: { description: "Checking the result" },
        output: {},
      },
      { type: "text", text: "The result is ready." },
    ])
    const presentation = deriveAssistantActivityPresentation(view, {
      kind: "responding",
    })

    expect(presentation).toMatchObject({
      kind: "disclosure",
      label: "Activity",
      motion: "none",
      activity: {
        completion: {
          kind: "completion",
          title: "Finished",
          detail: "Done",
          status: "complete",
        },
      },
    })
  })
})
