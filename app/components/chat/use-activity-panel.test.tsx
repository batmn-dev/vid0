/** @vitest-environment jsdom */
import type { UIMessage } from "@ai-sdk/react"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import {
  PENDING_ACTIVITY_TURN_ID,
  selectExplicitActivityTurnOnOpen,
  useActivityPanel,
  type UseActivityPanelResult,
} from "./use-activity-panel"

type Status = "streaming" | "ready" | "submitted" | "error"

function Harness(props: {
  messages: UIMessage[]
  status: Status
  isSubmitting: boolean
  isApprovalPaused?: boolean
  selectedActivityTurnId?: string
  onResult: (result: UseActivityPanelResult) => void
}) {
  const { onResult, isApprovalPaused = false, ...params } = props
  const result = useActivityPanel({ ...params, isApprovalPaused })
  React.useEffect(() => {
    onResult(result)
  })
  return null
}

function assistant(
  id: string,
  opts: {
    durationMs?: number
    omitReasoningState?: boolean
    reasoningState?: string
    reasoningText?: string
    sourceUrl?: string
    serverMessageId?: string
    messageStatus?: "aborted" | "failed" | "completed" | "awaiting_approval"
  } = {}
): UIMessage {
  const reasoningPart: { type: "reasoning"; text: string; state?: string } = {
    type: "reasoning",
    text: opts.reasoningText ?? "r",
  }
  if (!opts.omitReasoningState) {
    reasoningPart.state = opts.reasoningState ?? "done"
  }

  const parts: unknown[] = [reasoningPart]
  if (opts.sourceUrl) {
    parts.push({
      type: "source-url",
      sourceId: `${id}-s`,
      url: opts.sourceUrl,
      title: "t",
    })
  }
  return {
    id,
    role: "assistant",
    parts,
    status: opts.messageStatus,
    metadata:
      opts.durationMs !== undefined || opts.serverMessageId !== undefined
          ? {
            reasoningDurationMs: opts.durationMs,
            workDurationMs: opts.durationMs,
            serverMessageId: opts.serverMessageId,
          }
        : undefined,
  } as unknown as UIMessage
}

function user(id: string): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text: "q" }],
  } as unknown as UIMessage
}

beforeAll(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
})

describe("useActivityPanel ownership", () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null
  let latest: UseActivityPanelResult | null = null

  beforeEach(() => {
    latest = null
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    const rootToUnmount = root
    if (rootToUnmount) {
      act(() => {
        rootToUnmount.unmount()
      })
    }
    container?.remove()
    root = null
    container = null
  })

  function render(props: {
    messages: UIMessage[]
    status: Status
    isSubmitting: boolean
    isApprovalPaused?: boolean
    selectedActivityTurnId?: string
  }) {
    act(() => {
      root?.render(
        <Harness
          {...props}
          onResult={(result) => {
            latest = result
          }}
        />
      )
    })
  }

  function projectedSourceUrls(): string[] {
    return (
      latest!.panelProps.activity?.sourceResults.map((source) => source.url) ??
      []
    )
  }

  it("owns the last assistant in the rendered path and follows a branch switch (id + duration + sources)", () => {
    render({
      messages: [
        user("u1"),
        assistant("a2", { durationMs: 4000, sourceUrl: "https://a.com" }),
      ],
      status: "ready",
      isSubmitting: false,
    })
    expect(latest!.defaultActivityTurnId).toBe("a2")
    expect(latest!.panelActivityTurnId).toBe("a2")
    expect(latest!.panelProps.turnKey).toBe("a2")
    expect(latest!.panelProps.followLatest).toBe(false)
    expect(latest!.panelProps.durationSeconds).toBe(4)
    expect(projectedSourceUrls()).toContain("https://a.com")

    // Branch switch / regenerate: the projected path now ends with a different
    // assistant turn — ownership and its persisted state must follow.
    render({
      messages: [
        user("u1"),
        assistant("a9", { durationMs: 9000, sourceUrl: "https://b.com" }),
      ],
      status: "ready",
      isSubmitting: false,
    })
    expect(latest!.defaultActivityTurnId).toBe("a9")
    expect(latest!.panelActivityTurnId).toBe("a9")
    expect(latest!.panelProps.turnKey).toBe("a9")
    expect(latest!.panelProps.durationSeconds).toBe(9)
    expect(projectedSourceUrls()).toContain("https://b.com")
    expect(latest!.selectedTurnPresent).toBe(true)

    // An explicit selection referencing the branch that left the rendered
    // path: the panel falls back to the default and reports the selection
    // stale, so Chat can drop it from the store instead of letting it
    // resurrect on a later branch switch.
    render({
      messages: [
        user("u1"),
        assistant("a9", { durationMs: 9000, sourceUrl: "https://b.com" }),
      ],
      status: "ready",
      isSubmitting: false,
      selectedActivityTurnId: "a2",
    })
    expect(latest!.panelActivityTurnId).toBe("a9")
    expect(latest!.panelProps.turnKey).toBe("a9")
    expect(latest!.selectedTurnPresent).toBe(false)
  })

  it("projects an explicit historical assistant turn instead of the pending default", () => {
    render({
      messages: [
        user("u1"),
        assistant("a1", { durationMs: 4000, sourceUrl: "https://a.com" }),
        user("u2"),
      ],
      status: "submitted",
      isSubmitting: true,
      selectedActivityTurnId: "a1",
    })

    expect(latest!.defaultActivityTurnId).toBe(PENDING_ACTIVITY_TURN_ID)
    expect(latest!.panelActivityTurnId).toBe("a1")
    expect(latest!.panelProps.followLatest).toBe(false)
    expect(latest!.isGenerationActive).toBe(true)
    expect(latest!.panelProps.durationSeconds).toBe(4)
    expect(projectedSourceUrls()).toContain("https://a.com")
    expect(latest!.panelCanOpen).toBe(true)
  })

  it("keeps an explicit historical opaque reasoning panel complete while a newer assistant streams", () => {
    render({
      messages: [
        user("u1"),
        assistant("a1", {
          omitReasoningState: true,
          reasoningText: "",
        }),
        user("u2"),
        assistant("a2", { reasoningState: "streaming" }),
      ],
      status: "streaming",
      isSubmitting: false,
      selectedActivityTurnId: "a1",
    })

    expect(latest!.defaultActivityTurnId).toBe("a2")
    expect(latest!.panelActivityTurnId).toBe("a1")
    expect(latest!.panelProps.followLatest).toBe(false)
    expect(latest!.panelProps.activity).toBeUndefined()
    expect(latest!.panelCanOpen).toBe(false)
  })

  it("keeps one timing value for mixed search activity", () => {
    render({
      messages: [
        user("u1"),
        assistant("a1", {
          durationMs: 1600,
          reasoningText: "",
          sourceUrl: "https://example.com",
        }),
      ],
      status: "ready",
      isSubmitting: false,
    })

    expect(latest!.panelCanOpen).toBe(true)
    expect(latest!.panelProps.activity?.completion?.title).toBe("Worked for 1s")
    expect(latest!.panelProps.durationSeconds).toBe(1)
  })

  it("keeps a historical stopped turn terminal while a newer turn streams", () => {
    render({
      messages: [
        user("u1"),
        assistant("a1", {
          messageStatus: "aborted",
          reasoningText: "**Checking state**\nThe run stopped here.",
        }),
        user("u2"),
        assistant("a2", { reasoningState: "streaming" }),
      ],
      status: "streaming",
      isSubmitting: false,
      selectedActivityTurnId: "a1",
    })

    expect(latest!.panelActivityTurnId).toBe("a1")
    expect(latest!.panelProps.activity?.completion).toMatchObject({
      kind: "completion",
      title: "Generation stopped",
      status: "stopped",
    })
    expect(latest!.panelProps.followLatest).toBe(false)
  })

  it("keeps a default-opened panel following the next pending generation", () => {
    render({
      messages: [
        user("u1"),
        assistant("a1", { durationMs: 4000, sourceUrl: "https://a.com" }),
      ],
      status: "ready",
      isSubmitting: false,
    })

    const selectedActivityTurnId = selectExplicitActivityTurnOnOpen({
      requestedTurnId: "a1",
      defaultActivityTurnId: latest!.defaultActivityTurnId,
    })
    expect(selectedActivityTurnId).toBeUndefined()

    render({
      messages: [
        user("u1"),
        assistant("a1", { durationMs: 4000, sourceUrl: "https://a.com" }),
        user("u2"),
      ],
      status: "submitted",
      isSubmitting: true,
      selectedActivityTurnId,
    })

    expect(latest!.defaultActivityTurnId).toBe(PENDING_ACTIVITY_TURN_ID)
    expect(latest!.panelActivityTurnId).toBe(PENDING_ACTIVITY_TURN_ID)
    expect(latest!.panelProps.activity).toBeUndefined()
    expect(latest!.panelProps.turnKey).toBe(PENDING_ACTIVITY_TURN_ID)
    expect(latest!.panelProps.followLatest).toBe(false)
    expect(latest!.panelCanOpen).toBe(false)
  })

  it("keeps a historical-opened panel pinned while the next generation is pending", () => {
    render({
      messages: [
        user("u1"),
        assistant("a1", { durationMs: 4000, sourceUrl: "https://a.com" }),
        user("u2"),
        assistant("a2", { durationMs: 9000, sourceUrl: "https://b.com" }),
      ],
      status: "ready",
      isSubmitting: false,
    })

    const selectedActivityTurnId = selectExplicitActivityTurnOnOpen({
      requestedTurnId: "a1",
      defaultActivityTurnId: latest!.defaultActivityTurnId,
    })
    expect(selectedActivityTurnId).toBe("a1")

    render({
      messages: [
        user("u1"),
        assistant("a1", { durationMs: 4000, sourceUrl: "https://a.com" }),
        user("u2"),
        assistant("a2", { durationMs: 9000, sourceUrl: "https://b.com" }),
        user("u3"),
      ],
      status: "submitted",
      isSubmitting: true,
      selectedActivityTurnId,
    })

    expect(latest!.defaultActivityTurnId).toBe(PENDING_ACTIVITY_TURN_ID)
    expect(latest!.panelActivityTurnId).toBe("a1")
    expect(latest!.panelProps.followLatest).toBe(false)
    expect(latest!.panelProps.durationSeconds).toBe(4)
    expect(projectedSourceUrls()).toContain("https://a.com")
  })

  it("keeps timing the live default while a historical panel is selected", () => {
    vi.useFakeTimers()
    try {
      render({
        messages: [
          user("u1"),
          assistant("a1", {
            durationMs: 4000,
            sourceUrl: "https://history.example",
          }),
          user("u2"),
          assistant("a2", {
            reasoningState: "streaming",
            reasoningText: "",
          }),
        ],
        status: "streaming",
        isSubmitting: false,
        selectedActivityTurnId: "a1",
      })

      act(() => {
        vi.advanceTimersByTime(2000)
      })

      expect(latest!.panelActivityTurnId).toBe("a1")
      expect(latest!.panelProps.durationSeconds).toBe(4)
      expect(latest!.defaultActivityTurnId).toBe("a2")
      expect(latest!.defaultActivityDurationMs).toBe(2000)
    } finally {
      const rootToUnmount = root
      if (rootToUnmount) {
        act(() => {
          rootToUnmount.unmount()
        })
      }
      root = null
      vi.useRealTimers()
    }
  })

  it("pauses approval wait while transport streams and resumes from the resolved run state", () => {
    vi.useFakeTimers()
    try {
      render({
        messages: [
          user("u1"),
          assistant("a1", {
            reasoningState: "streaming",
            reasoningText: "",
          }),
        ],
        status: "streaming",
        isSubmitting: false,
      })
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(latest!.defaultActivityDurationMs).toBe(2000)

      render({
        messages: [
          user("u1"),
          assistant("a1", {
            durationMs: 2000,
            messageStatus: "awaiting_approval",
          }),
        ],
        status: "streaming",
        isSubmitting: false,
        isApprovalPaused: true,
      })
      act(() => {
        vi.advanceTimersByTime(10_000)
      })
      expect(latest!.defaultActivityDurationMs).toBe(2000)

      // The durable message can retain awaiting_approval for a projection
      // frame after continuation; the canonical presentation has resumed.
      render({
        messages: [
          user("u1"),
          assistant("a1", {
            durationMs: 2000,
            messageStatus: "awaiting_approval",
          }),
        ],
        status: "streaming",
        isSubmitting: false,
        isApprovalPaused: false,
      })
      act(() => {
        vi.advanceTimersByTime(3000)
      })
      expect(latest!.defaultActivityDurationMs).toBe(5000)
    } finally {
      const rootToUnmount = root
      if (rootToUnmount) {
        act(() => {
          rootToUnmount.unmount()
        })
      }
      root = null
      vi.useRealTimers()
    }
  })

  it("matches an explicit selected turn by server id and normalizes to the rendered message id", () => {
    render({
      messages: [
        user("u1"),
        assistant("client-a1", {
          durationMs: 3000,
          serverMessageId: "server-a1",
          sourceUrl: "https://server-id.example",
        }),
      ],
      status: "ready",
      isSubmitting: false,
      selectedActivityTurnId: "server-a1",
    })

    expect(latest!.defaultActivityTurnId).toBe("client-a1")
    expect(latest!.panelActivityTurnId).toBe("client-a1")
    expect(latest!.panelProps.turnKey).toBe("client-a1")
    expect(latest!.panelProps.followLatest).toBe(false)
    expect(latest!.panelProps.durationSeconds).toBe(3)
    expect(projectedSourceUrls()).toContain("https://server-id.example")
  })

  it("owns the pending assistant turn for submitted user-tail state", () => {
    render({
      messages: [user("u1"), assistant("a1"), user("u2")],
      status: "submitted",
      isSubmitting: true,
    })

    expect(latest!.defaultActivityTurnId).toBe(PENDING_ACTIVITY_TURN_ID)
    expect(latest!.panelActivityTurnId).toBe(PENDING_ACTIVITY_TURN_ID)
    expect(latest!.isGenerationActive).toBe(true)
    expect(latest!.panelProps.activity).toBeUndefined()
    expect(latest!.panelProps.followLatest).toBe(false)
    expect(latest!.panelCanOpen).toBe(false)
  })

  it("owns the pending assistant turn during submit preflight before status flips", () => {
    render({
      messages: [user("u1"), assistant("a1"), user("u2")],
      status: "ready",
      isSubmitting: true,
    })

    expect(latest!.defaultActivityTurnId).toBe(PENDING_ACTIVITY_TURN_ID)
    expect(latest!.panelActivityTurnId).toBe(PENDING_ACTIVITY_TURN_ID)
    expect(latest!.isGenerationActive).toBe(true)
    expect(latest!.panelProps.activity).toBeUndefined()
    expect(latest!.panelProps.followLatest).toBe(false)
    expect(latest!.panelCanOpen).toBe(false)
  })

  it("keeps the pending target until an adopted assistant has renderable evidence", () => {
    const emptyAssistant = {
      id: "a2",
      role: "assistant",
      parts: [],
    } as unknown as UIMessage

    render({
      messages: [user("u1"), assistant("a1"), user("u2"), emptyAssistant],
      status: "ready",
      isSubmitting: true,
    })

    expect(latest!.defaultActivityTurnId).toBe(PENDING_ACTIVITY_TURN_ID)
    expect(latest!.panelActivityTurnId).toBe(PENDING_ACTIVITY_TURN_ID)
    expect(latest!.panelCanOpen).toBe(false)

    render({
      messages: [
        user("u1"),
        assistant("a1"),
        user("u2"),
        {
          ...emptyAssistant,
          parts: [{ type: "text", text: "First response text" }],
        },
      ],
      status: "streaming",
      isSubmitting: false,
    })

    expect(latest!.defaultActivityTurnId).toBe("a2")
    expect(latest!.panelActivityTurnId).toBe("a2")
  })

  it("runs the work clock from the pending assistant's arrival and keeps it across the pending→live handoff", () => {
    vi.useFakeTimers()
    try {
      const shell = {
        id: "a2",
        role: "assistant",
        parts: [],
      } as unknown as UIMessage
      const history = [user("u1"), assistant("a1"), user("u2")]

      // Start chunk created the shell: no renderable evidence, clock running.
      render({
        messages: [...history, shell],
        status: "streaming",
        isSubmitting: false,
      })
      expect(latest!.defaultActivityTurnId).toBe(PENDING_ACTIVITY_TURN_ID)
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(latest!.defaultActivityDurationMs).toBe(2000)

      // First renderable part: same message, so the clock continues.
      render({
        messages: [
          ...history,
          { ...shell, parts: [{ type: "text", text: "First" }] },
        ],
        status: "streaming",
        isSubmitting: false,
      })
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(latest!.defaultActivityTurnId).toBe("a2")
      expect(latest!.defaultActivityDurationMs).toBe(3000)

      // A regenerated turn is a new assistant message: the clock restarts.
      render({
        messages: [...history, { ...shell, id: "a3" }],
        status: "streaming",
        isSubmitting: false,
      })
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(latest!.defaultActivityDurationMs).toBe(1000)
    } finally {
      const rootToUnmount = root
      if (rootToUnmount) {
        act(() => {
          rootToUnmount.unmount()
        })
      }
      root = null
      vi.useRealTimers()
    }
  })

  it("follows only the default streaming turn and changes its turn key", () => {
    render({
      messages: [
        user("u1"),
        assistant("a1", {
          reasoningState: "streaming",
          reasoningText: "**Checking**\nFirst turn",
        }),
      ],
      status: "streaming",
      isSubmitting: false,
    })

    expect(latest!.panelActivityTurnId).toBe("a1")
    expect(latest!.panelProps).toMatchObject({
      turnKey: "a1",
      followLatest: true,
    })

    render({
      messages: [
        user("u1"),
        assistant("a1"),
        user("u2"),
        assistant("a2", {
          reasoningState: "streaming",
          reasoningText: "**Checking**\nSecond turn",
        }),
      ],
      status: "streaming",
      isSubmitting: false,
    })

    expect(latest!.panelActivityTurnId).toBe("a2")
    expect(latest!.panelProps).toMatchObject({
      turnKey: "a2",
      followLatest: true,
    })
  })

  it.each(["failed", "awaiting_approval"] as const)(
    "never follows an explicitly selected historical %s turn",
    (messageStatus) => {
      render({
        messages: [
          user("u1"),
          assistant("a1", {
            messageStatus,
            reasoningText: "**Historical work**\nSaved detail",
          }),
          user("u2"),
          assistant("a2", {
            reasoningState: "streaming",
            reasoningText: "**Live work**\nStill running",
          }),
        ],
        status: "streaming",
        isSubmitting: false,
        selectedActivityTurnId: "a1",
      })

      expect(latest!.panelActivityTurnId).toBe("a1")
      expect(latest!.panelProps.turnKey).toBe("a1")
      expect(latest!.panelProps.followLatest).toBe(false)
    }
  )
})
