/** @vitest-environment jsdom */
import {
  deriveAssistantTurnView,
  type AssistantTurnView,
} from "@/lib/chat-messages/assistant-turn"
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
  ActivityPanelStoreProvider,
  createActivityPanelStore,
  type ActivityPanelStore,
} from "./activity/activity-panel-store"
import { MessageAssistant } from "./message-assistant"

const responsive = vi.hoisted(() => ({ isMobile: false }))
const preferenceState = vi.hoisted(() => ({ showGenerationStats: false }))

vi.mock("@/hooks/use-breakpoint", () => ({
  useBreakpoint: () => responsive.isMobile,
}))

vi.mock("@/lib/user-preference-store/provider", () => ({
  useUserPreferences: () => ({
    preferences: {
      showToolInvocations: false,
      showGenerationStats: preferenceState.showGenerationStats,
    },
  }),
}))

beforeAll(async () => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  // MessageContent loads Markdown via next/dynamic; preload it so the dynamic
  // import resolves before the render flush. Otherwise the markdown chunk lands
  // after the test's microtask and the rendered answer content is missing — a
  // fragility previously masked by an incidental static import of markdown
  // through reasoning.tsx (decoupled when formatDuration moved to lib).
  await import("@/components/ui/markdown")
})

type ChatStatus = "streaming" | "ready" | "submitted" | "error"

function makeView(
  parts: UIMessage["parts"],
  status: ChatStatus,
  metadata?: unknown
): AssistantTurnView {
  return deriveAssistantTurnView({ parts, metadata }, status)
}

/** Test store preconfigured like Chat's sync effect would leave it. */
function makeStore({
  panelTurnId,
  defaultTurnId,
  defaultDurationMs,
  open = false,
}: {
  panelTurnId?: string
  defaultTurnId?: string
  defaultDurationMs?: number
  open?: boolean
}): ActivityPanelStore {
  const store = createActivityPanelStore()
  store.setDerivedActivity({
    panelTurnId,
    defaultTurnId: defaultTurnId ?? panelTurnId,
    defaultDurationMs,
    defaultReasoningDurationMs: defaultDurationMs,
  })
  if (open) store.setOpen(true)
  return store
}

describe("MessageAssistant activity trigger", () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  beforeEach(() => {
    responsive.isMobile = false
    preferenceState.showGenerationStats = false
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  it.each(["ready", "aborted"] as const)(
    "retains copy for commentary-only %s turns",
    (status) => {
      const view = makeView(
        [
          {
            type: "text",
            text: "I found an initial lead.",
            state: "done",
            providerMetadata: { openai: { phase: "commentary" } },
          },
        ],
        "ready"
      )
      act(() => {
        root?.render(
          <ActivityPanelStoreProvider store={makeStore({})}>
            <MessageAssistant
              view={view}
              messageId="assistant-1"
              status={status}
              isLast
            >
              {view.text}
            </MessageAssistant>
          </ActivityPanelStoreProvider>
        )
      })
      expect(
        container?.querySelector('button[aria-label="Copy response"]')
      ).not.toBeNull()
    }
  )

  it("renders the generation stats line on settled turns behind the preference", () => {
    const store = makeStore({ panelTurnId: "assistant-1" })
    const parts = [{ type: "text", text: "Answer" }] as UIMessage["parts"]
    const metadata = {
      generationStats: {
        timeToFirstTokenMs: 420,
        outputStreamMs: 4223,
        outputTokens: 146,
      },
    }
    const renderRow = () =>
      act(() => {
        root?.render(
          <ActivityPanelStoreProvider store={store} panelId="activity-panel">
            <MessageAssistant
              messageId="assistant-1"
              view={makeView(parts, "ready", metadata)}
              status="ready"
              finishReason="stop"
            >
              Answer
            </MessageAssistant>
          </ActivityPanelStoreProvider>
        )
      })

    renderRow()
    expect(
      container?.querySelector('[data-testid="generation-stats"]')
    ).toBeNull()

    preferenceState.showGenerationStats = true
    renderRow()
    expect(
      container?.querySelector('[data-testid="generation-stats"]')?.textContent
    ).toBe("34.6 tok/s · 146 tokens · 0.42 s to first output")
  })

  it("renders the generation stats line on a settled tool-only turn without text actions", () => {
    preferenceState.showGenerationStats = true
    const store = makeStore({ panelTurnId: "assistant-1" })
    const parts = [
      {
        type: "tool-web_search",
        toolCallId: "call-1",
        state: "output-available",
        input: { query: "q" },
        output: { content: [] },
      },
    ] as unknown as UIMessage["parts"]
    const metadata = { generationStats: { outputTokens: 12 } }

    act(() => {
      root?.render(
        <ActivityPanelStoreProvider store={store} panelId="activity-panel">
          <MessageAssistant
            messageId="assistant-1"
            view={makeView(parts, "ready", metadata)}
            status="ready"
            copyToClipboard={() => {}}
          >
            {""}
          </MessageAssistant>
        </ActivityPanelStoreProvider>
      )
    })

    expect(
      container?.querySelector('[data-testid="generation-stats"]')?.textContent
    ).toBe("12 tokens")
    expect(
      container?.querySelector('button[aria-label="Copy response"]')
    ).toBeNull()
  })

  it("mounts no footer when the settled stats derive to nothing renderable", () => {
    preferenceState.showGenerationStats = true
    const store = makeStore({ panelTurnId: "assistant-1" })
    const parts = [
      {
        type: "tool-web_search",
        toolCallId: "call-1",
        state: "output-available",
        input: { query: "q" },
        output: { content: [] },
      },
    ] as unknown as UIMessage["parts"]
    // Parses to a non-empty object, but the view has no rate, tokens, or
    // time to first output to show.
    const metadata = { generationStats: { inputTokens: 900 } }

    act(() => {
      root?.render(
        <ActivityPanelStoreProvider store={store} panelId="activity-panel">
          <MessageAssistant
            messageId="assistant-1"
            view={makeView(parts, "ready", metadata)}
            status="ready"
            copyToClipboard={() => {}}
          >
            {""}
          </MessageAssistant>
        </ActivityPanelStoreProvider>
      )
    })

    expect(
      container?.querySelector('[aria-label="Response actions"]')
    ).toBeNull()
  })

  it("focuses a newly completed final response on mobile without scrolling", () => {
    responsive.isMobile = true
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
    const store = makeStore({ panelTurnId: "assistant-1" })
    const parts = [{ type: "text", text: "Answer" }] as UIMessage["parts"]

    act(() => {
      root?.render(
        <ActivityPanelStoreProvider store={store} panelId="activity-panel">
          <MessageAssistant
            messageId="assistant-1"
            view={makeView(parts, "ready")}
            isLast
            status="ready"
            finishReason="length"
          >
            Answer
          </MessageAssistant>
        </ActivityPanelStoreProvider>
      )
    })

    expect(
      container?.querySelector("[data-turn-start-message]")?.textContent
    ).toContain("Response may be incomplete")
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
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

  it("renders completed opaque reasoning as passive timing", () => {
    const store = makeStore({ panelTurnId: "assistant-1" })
    const parts = [
      { type: "reasoning", text: "", state: "done" },
    ] as unknown as UIMessage["parts"]

    act(() => {
      root?.render(
        <ActivityPanelStoreProvider store={store} panelId="activity-panel">
          <MessageAssistant
            messageId="assistant-1"
            view={makeView(parts, "ready", { reasoningDurationMs: 2000 })}
            status="ready"
          >
            {""}
          </MessageAssistant>
        </ActivityPanelStoreProvider>
      )
    })

    expect(container?.textContent).toContain("Thought for 2s")
    expect(container?.querySelector("button[aria-expanded]")).toBeNull()
    expect(store.getState().open).toBe(false)
  })

  it("preserves the current-session duration while finish metadata hydrates", () => {
    const store = makeStore({
      panelTurnId: "assistant-1",
      defaultDurationMs: 2100,
    })
    const parts = [
      { type: "reasoning", text: "", state: "done" },
    ] as unknown as UIMessage["parts"]

    act(() => {
      root?.render(
        <ActivityPanelStoreProvider store={store} panelId="activity-panel">
          <MessageAssistant
            messageId="assistant-1"
            view={makeView(parts, "ready")}
            status="ready"
            isLast
          >
            {""}
          </MessageAssistant>
        </ActivityPanelStoreProvider>
      )
    })

    expect(container?.textContent).toContain("Thought for 2s")
    expect(container?.querySelector("button[aria-expanded]")).toBeNull()
  })

  it("omits completed opaque sub-second reasoning duration", () => {
    const store = makeStore({ panelTurnId: "assistant-1" })
    const parts = [
      { type: "reasoning", text: "", state: "done" },
    ] as unknown as UIMessage["parts"]

    act(() => {
      root?.render(
        <ActivityPanelStoreProvider store={store} panelId="activity-panel">
          <MessageAssistant
            messageId="assistant-1"
            view={makeView(parts, "ready", { reasoningDurationMs: 999 })}
            status="ready"
          >
            {""}
          </MessageAssistant>
        </ActivityPanelStoreProvider>
      )
    })

    expect(container?.textContent).toContain("Thought")
    expect(container?.textContent).not.toContain("<1s")
    expect(container?.querySelector("button[aria-expanded]")).toBeNull()
  })

  it("shows only passive Thinking while opaque reasoning streams", () => {
    const store = makeStore({ panelTurnId: "assistant-1" })
    const parts = [
      { type: "reasoning", text: "", state: "streaming" },
    ] as unknown as UIMessage["parts"]

    act(() => {
      root?.render(
        <ActivityPanelStoreProvider store={store} panelId="activity-panel">
          <MessageAssistant
            messageId="assistant-1"
            view={makeView(parts, "streaming")}
            status="streaming"
            isLast
          >
            {""}
          </MessageAssistant>
        </ActivityPanelStoreProvider>
      )
    })

    expect(container?.textContent).toContain("Thinking")
    expect(container?.querySelector("button[aria-expanded]")).toBeNull()
    expect(container?.textContent).not.toContain("Generating")
  })

  it("keeps inline work independent of the activity panel", () => {
    const parts = [
      { type: "reasoning", text: "reasoning", state: "done" },
    ] as unknown as UIMessage["parts"]

    act(() => {
      root?.render(
        <MessageAssistant
          messageId="assistant-1"
          view={makeView(parts, "ready")}
          status="ready"
        >
          {"Answer"}
        </MessageAssistant>
      )
    })

    expect(
      container?.querySelector('button[aria-controls="activity-panel"]')
    ).toBeNull()
  })

  it("renders the sources badge on a settled grounded turn and opens the panel at Sources", async () => {
    const store = makeStore({ panelTurnId: "assistant-1" })
    // Four sources across three unique hosts — the favicon cluster dedupes by
    // host (reference behavior) while the full deduped list stays panel-owned.
    const parts = [
      { type: "source-url", sourceId: "s1", url: "https://a.example/one" },
      { type: "source-url", sourceId: "s2", url: "https://a.example/two" },
      { type: "source-url", sourceId: "s3", url: "https://b.example/three" },
      { type: "source-url", sourceId: "s4", url: "https://c.example/four" },
    ] as unknown as UIMessage["parts"]

    await act(async () => {
      root?.render(
        <ActivityPanelStoreProvider store={store} panelId="activity-panel">
          <MessageAssistant
            messageId="assistant-1"
            copied={false}
            copyToClipboard={() => {}}
            view={makeView(parts, "ready")}
            status="ready"
          >
            {"Grounded answer"}
          </MessageAssistant>
        </ActivityPanelStoreProvider>
      )
    })

    const badge = container?.querySelector(
      'button[aria-label="Sources"]'
    ) as HTMLButtonElement | null
    expect(badge).toBeTruthy()
    expect(badge?.textContent).toContain("Sources")
    expect(badge?.getAttribute("aria-controls")).toBe("activity-panel")
    expect(badge?.getAttribute("aria-expanded")).toBe("false")
    // Cluster caps at the first 3 unique hosts: a.example once, b, c.
    expect(badge?.querySelectorAll('[data-slot="avatar"]')).toHaveLength(3)

    act(() => {
      badge?.click()
    })

    expect(store.getState().open).toBe(true)
    expect(store.getState().panelTurnId).toBe("assistant-1")
    expect(store.getState().openSection).toBe("sources")
  })

  it("renders no sources badge without sources, and none while the turn is live", async () => {
    const store = makeStore({ panelTurnId: "assistant-1" })

    await act(async () => {
      root?.render(
        <ActivityPanelStoreProvider store={store} panelId="activity-panel">
          <MessageAssistant
            messageId="assistant-1"
            copied={false}
            copyToClipboard={() => {}}
            view={makeView([], "ready")}
            status="ready"
          >
            {"Plain answer"}
          </MessageAssistant>
        </ActivityPanelStoreProvider>
      )
    })

    // Settled turn without sources: actions row renders, badge does not.
    expect(
      container?.querySelector('button[aria-label="Copy response"]')
    ).toBeTruthy()
    expect(container?.querySelector('button[aria-label="Sources"]')).toBeNull()

    const sourcedParts = [
      { type: "source-url", sourceId: "s1", url: "https://a.example/one" },
    ] as unknown as UIMessage["parts"]

    await act(async () => {
      root?.render(
        <ActivityPanelStoreProvider store={store} panelId="activity-panel">
          <MessageAssistant
            messageId="assistant-1"
            copied={false}
            copyToClipboard={() => {}}
            view={makeView(sourcedParts, "streaming")}
            status="streaming"
            isLast
          >
            {"Streaming answer"}
          </MessageAssistant>
        </ActivityPanelStoreProvider>
      )
    })

    // Live turn: sources exist but the badge waits for the settle (the appear
    // timing the row memo's sources exclusion relies on).
    expect(container?.querySelector('button[aria-label="Sources"]')).toBeNull()
  })

  it("offers Copy Response only when the text is not still active or paused", async () => {
    const store = makeStore({ panelTurnId: "assistant-1" })
    const hasFooterSlot = () => {
      return Boolean(container?.querySelector(".min-h-\\[46px\\]"))
    }
    const renderStatus = async (
      status:
        | "submitted"
        | "streaming"
        | "awaiting_approval"
        | "ready"
        | "aborted"
        | "failed"
    ) => {
      await act(async () => {
        root?.render(
          <ActivityPanelStoreProvider store={store} panelId="activity-panel">
            <MessageAssistant
              messageId="assistant-1"
              copied={false}
              copyToClipboard={() => {}}
              isLast
              view={makeView(
                [{ type: "text", text: "Partial or complete answer" }],
                status === "streaming" ? "streaming" : "ready"
              )}
              status={status}
            >
              {"Partial or complete answer"}
            </MessageAssistant>
          </ActivityPanelStoreProvider>
        )
        await Promise.resolve()
      })
    }

    for (const status of [
      "submitted",
      "streaming",
      "awaiting_approval",
    ] as const) {
      await renderStatus(status)
      expect(
        container?.querySelector('button[aria-label="Copy response"]')
      ).toBeNull()
      expect(hasFooterSlot()).toBe(false)
    }

    for (const status of ["ready", "aborted", "failed"] as const) {
      await renderStatus(status)
      expect(
        container?.querySelector('button[aria-label="Copy response"]')
      ).toBeTruthy()
      expect(hasFooterSlot()).toBe(true)
    }
  })

  it("leaves headings to the turn owner and matches focus/action semantics", () => {
    const store = makeStore({ panelTurnId: "assistant-current" })

    act(() => {
      root?.render(
        <ActivityPanelStoreProvider store={store} panelId="activity-panel">
          <MessageAssistant
            messageId="assistant-historical"
            copied={false}
            copyToClipboard={() => {}}
            view={makeView(
              [{ type: "text", text: "Historical answer" }],
              "ready"
            )}
            status="ready"
          >
            {"Historical answer"}
          </MessageAssistant>
          <MessageAssistant
            messageId="assistant-current"
            copied={false}
            copyToClipboard={() => {}}
            isLast
            view={makeView([{ type: "text", text: "Current answer" }], "ready")}
            status="ready"
          >
            {"Current answer"}
          </MessageAssistant>
        </ActivityPanelStoreProvider>
      )
    })

    const assistants = Array.from(
      container?.querySelectorAll<HTMLElement>(
        '[data-message-author-role="assistant"]'
      ) ?? []
    )
    const actionGroups = Array.from(
      container?.querySelectorAll<HTMLElement>(
        '[role="group"][aria-label="Response actions"]'
      ) ?? []
    )

    expect(assistants).toHaveLength(2)
    expect(assistants[0]?.getAttribute("tabindex")).toBeNull()
    expect(assistants[1]?.getAttribute("tabindex")).toBe("0")
    expect(container?.querySelector("h4")).toBeNull()
    expect(actionGroups).toHaveLength(2)
    expect(
      actionGroups.every((group) => group.getAttribute("tabindex") === "-1")
    ).toBe(true)
  })

  it("renders a durable output-length warning on a settled row", async () => {
    const store = makeStore({ panelTurnId: "assistant-1" })

    await act(async () => {
      root?.render(
        <ActivityPanelStoreProvider store={store} panelId="activity-panel">
          <MessageAssistant
            messageId="assistant-1"
            view={makeView(
              [{ type: "text", text: "Truncated answer" }],
              "ready"
            )}
            status="completed"
            finishReason="length"
          >
            {"Truncated answer"}
          </MessageAssistant>
        </ActivityPanelStoreProvider>
      )
    })

    expect(container?.textContent).toContain(
      "Response may be incomplete due to output length limits."
    )
  })

  it("names the model the retry action will use", async () => {
    const store = makeStore({ panelTurnId: "assistant-1" })

    await act(async () => {
      root?.render(
        <ActivityPanelStoreProvider store={store} panelId="activity-panel">
          <MessageAssistant
            messageId="assistant-1"
            isDurableChat
            onReload={() => {}}
            retryModelId="gpt-5.5"
            view={makeView([], "ready")}
            status="ready"
          >
            {"Assistant answer"}
          </MessageAssistant>
        </ActivityPanelStoreProvider>
      )
    })

    const retry = container?.querySelector(
      'button[aria-label="Try again with GPT-5.5"]'
    ) as HTMLButtonElement | null

    expect(retry).toBeTruthy()

    await act(async () => {
      retry?.focus()
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain("Try again...")
    expect(document.body.textContent).toContain("Using GPT-5.5")
  })

  it("keeps retry visible with an explanation while another response is active", async () => {
    const store = makeStore({ panelTurnId: "assistant-1" })
    const onReload = vi.fn()

    await act(async () => {
      root?.render(
        <ActivityPanelStoreProvider store={store} panelId="activity-panel">
          <MessageAssistant
            messageId="assistant-1"
            isDurableChat
            onReload={onReload}
            retryDisabled
            retryModelId="gpt-5.5"
            view={makeView([], "ready")}
            status="ready"
          >
            {"Assistant answer"}
          </MessageAssistant>
        </ActivityPanelStoreProvider>
      )
    })

    const retry = container?.querySelector(
      'button[aria-label="Try again with GPT-5.5"]'
    ) as HTMLButtonElement | null

    expect(retry).toBeTruthy()
    expect(retry?.getAttribute("aria-disabled")).toBe("true")

    act(() => {
      retry?.click()
    })
    expect(onReload).not.toHaveBeenCalled()

    await act(async () => {
      retry?.focus()
      await Promise.resolve()
    })
    expect(document.body.textContent).toContain(
      "Wait for the current response to finish."
    )
  })

  it("renders full canonical text on non-last and settled rows", async () => {
    const store = makeStore({ panelTurnId: "assistant-1" })
    await act(async () => {
      root?.render(
        <ActivityPanelStoreProvider store={store} panelId="activity-panel">
          <MessageAssistant
            messageId="assistant-1"
            view={makeView([], "ready")}
            status="ready"
          >
            {"A settled answer with **markdown** in it."}
          </MessageAssistant>
        </ActivityPanelStoreProvider>
      )
    })

    expect(container?.textContent).toContain(
      "A settled answer with markdown in it."
    )
  })

  it("replaces live work with its summary and answer in the same update", async () => {
    const commentary = {
      type: "text",
      text: "Checking",
      state: "streaming",
      providerMetadata: { openai: { phase: "commentary" } },
    } satisfies UIMessage["parts"][number]
    const renderParts = async (parts: UIMessage["parts"]) => {
      const view = makeView(parts, "streaming", {
        provider: "openai",
        workSummaryDurationMs: 36000,
      })
      await act(async () => {
        root?.render(
          <MessageAssistant
            messageId="handoff"
            view={view}
            status="streaming"
            isLast
          >
            {view.text}
          </MessageAssistant>
        )
      })
    }
    await renderParts([commentary])
    expect(
      container?.querySelector(".inline-work-narrative")?.textContent
    ).toBe("Checking")
    await renderParts([
      { ...commentary, text: "Checking is complete.", state: "done" },
      {
        type: "text",
        text: "The answer starts now.",
        state: "streaming",
        providerMetadata: { openai: { phase: "final_answer" } },
      },
    ])
    expect(container?.querySelector("[data-inline-work-live]")).toBeNull()
    expect(container?.querySelector(".inline-work-narrative")).toBeNull()
    expect(container?.querySelector(".text-message")?.textContent).toBe(
      "The answer starts now."
    )
    const summary = Array.from(
      container?.querySelectorAll("button") ?? []
    ).find((button) => button.textContent === "Worked for 36s")
    expect(summary).toBeTruthy()
    await act(async () => summary?.click())
    expect(
      container?.querySelector(".inline-work-narrative")?.textContent
    ).toBe("Checking is complete.")
  })

  it("keeps a Retry control on an aborted turn whose only preserved content is a tool card", async () => {
    const store = makeStore({ panelTurnId: "assistant-1" })
    const onReload = vi.fn()
    // Tool output preserved, no text: the text footer (which hosts regenerate)
    // never renders, so the aborted banner must host Retry itself.
    const parts = [
      {
        type: "tool-web_search",
        toolCallId: "call-1",
        state: "output-available",
        input: { query: "q" },
        output: { content: [] },
      },
    ] as unknown as UIMessage["parts"]

    await act(async () => {
      root?.render(
        <ActivityPanelStoreProvider store={store} panelId="activity-panel">
          <MessageAssistant
            messageId="assistant-1"
            view={makeView(parts, "ready")}
            status="aborted"
            isDurableChat
            onReload={onReload}
          >
            {""}
          </MessageAssistant>
        </ActivityPanelStoreProvider>
      )
    })

    const retry = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Retry"
    )
    expect(retry).toBeTruthy()
    expect(container?.textContent).toContain(
      "Generation stopped. Partial response preserved."
    )

    act(() => {
      retry?.click()
    })
    expect(onReload).toHaveBeenCalledWith("assistant-1")
  })

  it("offers an explicit shorter-budget retry for an affordability failure", async () => {
    const store = makeStore({ panelTurnId: "assistant-1" })
    const onReload = vi.fn()

    await act(async () => {
      root?.render(
        <ActivityPanelStoreProvider store={store} panelId="activity-panel">
          <MessageAssistant
            messageId="assistant-1"
            view={makeView([], "ready", {
              durableError: "OpenRouter could not afford the Auto allowance.",
              errorRecovery: "retry_with_shorter_generation_budget",
            })}
            status="failed"
            isDurableChat
            onReload={onReload}
          >
            {""}
          </MessageAssistant>
        </ActivityPanelStoreProvider>
      )
    })

    const retry = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Retry with 16K budget"
    )
    expect(retry).toBeTruthy()
    act(() => retry?.click())
    expect(onReload).toHaveBeenCalledWith("assistant-1", {
      generationBudget: 16_384,
    })
  })
})
