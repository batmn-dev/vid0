/** @vitest-environment jsdom */
import { preloadMarkdown } from "@/components/ui/lazy-markdown"
import { deriveAssistantTurnView } from "@/lib/chat-messages/assistant-turn"
import { reconcileSelectedPath } from "@/lib/chat-store/turns/selected-path"
import type { ChatTurnMessage } from "@/lib/chat-turn/turn-plans"
import type { UIMessage } from "ai"
import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest"
import {
  ActivityPanelStoreProvider,
  createActivityPanelStore,
} from "./activity/activity-panel-store"
import { MessageAssistant } from "./message-assistant"

vi.mock("@/hooks/use-breakpoint", () => ({ useBreakpoint: () => false }))
vi.mock("motion/react", () => ({ useReducedMotion: () => true }))
vi.mock("@/lib/user-preference-store/provider", () => ({
  useUserPreferences: () => ({
    preferences: { showToolInvocations: false, showGenerationStats: false },
  }),
}))

let container: HTMLDivElement
let root: Root

beforeAll(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true
  await preloadMarkdown()
})

beforeEach(() => {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const scenarios: { name: string; work: UIMessage["parts"] }[] = [
  {
    name: "reasoning followed by a story",
    work: [{ type: "reasoning", text: "Plan the story.", state: "done" }],
  },
  {
    name: "commentary and a tool followed by an answer",
    work: [
      {
        type: "text",
        text: "I will check the archive.",
        state: "done",
        providerMetadata: { openai: { phase: "commentary" } },
      },
      {
        type: "tool-web_search",
        toolCallId: "search-1",
        state: "output-available",
        input: { query: "Gotham archive" },
        output: { results: [] },
      },
    ],
  },
]

it.each(scenarios)("preserves answer DOM through settlement: $name", async ({ work }) => {
  const store = createActivityPanelStore()
  const initial = "## Gotham\n\nBatman crossed the **silent** roof.\n\nBelow him, "
  const answer = `${initial}the city waited.\n\nHe followed the light.`
  const textPart: Extract<UIMessage["parts"][number], { type: "text" }> = {
    type: "text",
    text: initial,
    state: "streaming",
    providerMetadata: { openai: { phase: "final_answer" } },
  }
  const live: ChatTurnMessage = {
    id: "assistant-settlement",
    role: "assistant",
    parts: [...work, textPart],
    metadata: { provider: "openai" },
  }
  const render = async (message: ChatTurnMessage, status: "streaming" | "ready") => {
    const view = deriveAssistantTurnView(message, status)
    await act(async () => {
      root.render(
        <ActivityPanelStoreProvider store={store}>
          <MessageAssistant
            view={view}
            messageId={message.id}
            status={status}
            isLast
            finishReason={status === "ready" ? "stop" : undefined}
          >
            {view.text}
          </MessageAssistant>
        </ActivityPanelStoreProvider>
      )
    })
    return view
  }

  await render(live, "streaming")
  const markdown = container.querySelector(".text-message .markdown")
  expect(markdown).not.toBeNull()
  const heading = markdown?.querySelector("h2")
  const paragraph = markdown?.querySelector("p")
  const strong = paragraph?.querySelector("strong")
  expect(heading?.textContent).toBe("Gotham")
  expect(strong?.textContent).toBe("silent")

  const assertPreserved = () => {
    expect(container.querySelector(".text-message .markdown")).toBe(markdown)
    expect(markdown?.querySelector("h2")).toBe(heading)
    expect(markdown?.querySelector("p")).toBe(paragraph)
    expect(paragraph?.querySelector("strong")).toBe(strong)
    expect(markdown?.textContent).toBe(
      "GothamBatman crossed the silent roof.Below him, the city waited.He followed the light."
    )
  }

  // SDK parts mutate in place; text-end precedes the message's status change.
  textPart.text = answer
  expect((await render(live, "streaming")).inlineContent.answerText).toBe(answer)
  assertPreserved()
  textPart.state = "done"
  await render(live, "streaming")
  assertPreserved()
  await render(live, "ready")
  assertPreserved()

  const server: ChatTurnMessage = {
    ...live,
    status: "completed",
    metadata: { provider: "openai", serverMessageId: live.id },
    parts: [
      ...structuredClone(work),
      {
        ...structuredClone(textPart),
        providerMetadata: { openai: { phase: "final_answer", annotations: [] } },
      },
    ],
  }
  const adopted = reconcileSelectedPath([live], [server])[0]
  expect(adopted.parts).toBe(server.parts)
  expect((await render(adopted, "ready")).inlineContent.answerText).toBe(answer)
  assertPreserved()
})
