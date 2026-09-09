/** @vitest-environment jsdom */
import {
  deriveAssistantTurnPhase,
  deriveAssistantTurnView,
} from "@/lib/chat-messages/assistant-turn"
import type { UIMessage } from "ai"
import React, { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { AssistantInlineWork } from "./assistant-inline-work"

vi.mock("@/components/ui/message", () => ({
  MessageContent: ({
    children,
    streaming,
    animateStreaming,
  }: {
    children: React.ReactNode
    streaming: boolean
    animateStreaming: boolean
  }) => (
    <div data-streaming={streaming} data-animate-streaming={animateStreaming}>
      {children}
    </div>
  ),
}))
vi.mock("@/components/ui/favicon", () => ({
  Favicon: ({ url }: { url: string }) =>
    React.createElement("img", { src: url, alt: "" }),
}))
beforeAll(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
})
const container = document.createElement("div")
let root = createRoot(container)
afterEach(() => {
  act(() => root.unmount())
  vi.useRealTimers()
  root = createRoot(container)
})
const commentary: UIMessage["parts"][number] = {
  type: "text",
  text: "Checking the news.",
  state: "done",
  providerMetadata: { openai: { phase: "commentary" } },
}
const search: UIMessage["parts"][number] = {
  type: "tool-web_search",
  toolCallId: "search",
  state: "output-available",
  input: { query: "news" },
  output: {
    sources: Array.from({ length: 10 }, (_, index) => ({
      url: `https://source${index}.example`,
      title: `Source ${index}`,
    })),
  },
}
const final: UIMessage["parts"][number] = {
  type: "text",
  text: "Answer.",
  state: "streaming",
  providerMetadata: { openai: { phase: "final_answer" } },
}
async function render(
  parts: UIMessage["parts"],
  duration = 36000,
  isReplaying = false
) {
  const view = deriveAssistantTurnView({ parts }, "streaming")
  await act(async () => {
    root.render(
      <AssistantInlineWork
        view={view}
        phase={deriveAssistantTurnPhase(view, {
          status: "streaming",
          isLast: true,
        })}
        status="streaming"
        workDurationMs={duration}
        isReplaying={isReplaying}
      />
    )
  })
}
function button(text: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (node) =>
      (node.getAttribute("aria-label") ?? node.textContent) === text &&
      !node.closest('[aria-hidden="true"]')
  )!
}
function visibleContent() {
  const copy = container.cloneNode(true) as HTMLDivElement
  copy.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove())
  return copy
}
async function click(text: string) {
  await act(async () => {
    button(text).click()
  })
}

describe("inline work disclosure", () => {
  it("advances favicons every 1500ms, stops at the last, and resumes for new sources", async () => {
    vi.useFakeTimers()
    const parts = (count: number): UIMessage["parts"] => [
      commentary,
      {
        type: "tool-web_search",
        toolCallId: "running-search",
        state: "input-available",
        input: {},
      },
      ...Array.from(
        { length: count },
        (_, index): UIMessage["parts"][number] => ({
          type: "source-url",
          sourceId: `source-${index}`,
          url: `https://source${index}.example`,
          providerMetadata: { openai: { toolCallId: "running-search" } },
        })
      ),
    ]
    const source = () =>
      container
        .querySelector(
          "[data-inline-work-active-row] [data-inline-work-transition]:not([aria-hidden]) img"
        )
        ?.getAttribute("src")
    const advance = async (ms: number) => {
      await act(async () => {
        vi.advanceTimersByTime(ms)
      })
    }
    await render(parts(2))
    expect(source()).toBe("https://source0.example")
    await advance(1499)
    expect(source()).toBe("https://source0.example")
    await advance(1)
    expect(source()).toBe("https://source1.example")
    await advance(9000)
    expect(source()).toBe("https://source1.example")
    await render(parts(3))
    expect(source()).toBe("https://source1.example")
    await advance(1500)
    expect(source()).toBe("https://source2.example")
    await render(parts(2))
    expect(source()).toBe("https://source1.example")
    await render(parts(3))
    expect(source()).toBe("https://source1.example")
    await advance(1500)
    expect(source()).toBe("https://source2.example")
  })

  it("uses the native thinking marker for either undersized favicon dimension", async () => {
    for (const [width, height] of [
      [64, 16],
      [16, 64],
    ]) {
      await render([
        commentary,
        {
          type: "tool-web_search",
          toolCallId: "search",
          state: "output-available",
          input: {},
          output: {
            sources: [{ url: `https://source-${width}.example` }],
          },
        },
      ])
      const trigger = button("Searched 1 website")
      const image = trigger.querySelector("img")!
      Object.defineProperties(image, {
        naturalWidth: { value: 20, configurable: true },
        naturalHeight: { value: 20, configurable: true },
      })
      await act(async () => {
        image.dispatchEvent(new Event("load"))
      })
      expect(trigger.querySelector("img")).toBe(image)
      Object.defineProperties(image, {
        naturalWidth: { value: width },
        naturalHeight: { value: height },
      })
      await act(async () => {
        image.dispatchEvent(new Event("load"))
      })
      expect(trigger.querySelector("img")).toBeNull()
      expect(trigger.querySelector("svg")).not.toBeNull()
    }
  })

  it("enters the history tail once, then keeps it mounted across search and a growing compact title", async () => {
    await render([])
    const initial = container.querySelector("[data-inline-work-active-row]")
    expect(initial).not.toBeNull()
    const running: UIMessage["parts"][number] = {
      type: "tool-web_search",
      toolCallId: "search",
      state: "input-available",
      input: {},
    }
    await render([commentary, running])
    const tail = container.querySelector("[data-inline-work-active-row]")
    expect(tail).not.toBe(initial)
    expect(tail?.textContent).toContain("Searching the web")
    await render([commentary, search])
    expect(container.querySelector("[data-inline-work-active-row]")).toBe(tail)
    expect(button("Searched 10 websites")).toBeTruthy()
    const summary: UIMessage["parts"][number] = {
      type: "reasoning",
      text: "**Comparing results**",
      state: "streaming",
    }
    await render([commentary, search, summary])
    expect(container.querySelector("[data-inline-work-active-row]")).toBe(tail)
    expect(button("Searched 10 websites")).toBeUndefined()
    const activeContent = tail?.querySelector(
      "[data-inline-work-transition]:not([aria-hidden])"
    )
    summary.text = "**Comparing results and dates**"
    await render([commentary, search, summary])
    expect(
      tail?.querySelector("[data-inline-work-transition]:not([aria-hidden])")
    ).toBe(activeContent)
    expect(activeContent?.textContent).toBe("Comparing results and dates")
    await render([commentary, search, summary, final])
    expect(container.querySelector("[data-inline-work-active-row]")).toBeNull()
    expect(visibleContent().textContent).toBe("Worked for 36s")
    expect(button("Searched 10 websites")).toBeUndefined()
    await click("Worked for 36s")
    expect(container.textContent).not.toContain(summary.text)
    expect(button("Searched 10 websites")).toBeTruthy()
  })

  it("streams supplied reasoning immediately between searches and keeps Thinking during partial commentary", async () => {
    const first: UIMessage["parts"][number] = {
      type: "reasoning",
      text: "Checking",
      state: "streaming",
    }
    await render([first])
    const narratives = () =>
      Array.from(container.querySelectorAll('[data-streaming="true"]')).filter(
        (node) => !node.closest('[aria-hidden="true"]')
      )
    expect(narratives()[0]?.textContent).toBe("Checking")
    const firstTree = narratives()[0]
    expect(firstTree?.getAttribute("data-animate-streaming")).toBe("false")
    first.text += " sources."
    await render([first, search])
    expect(narratives()[0]).toBe(firstTree)
    expect(container.querySelectorAll('[data-streaming="true"]')).toHaveLength(
      1
    )
    expect(narratives()[0]?.textContent).toBe(first.text)
    expect(button("Searched 10 websites")).toBeTruthy()
    expect(container.textContent).toContain("Thinking")
    expect(container.textContent).not.toContain("Worked")
    const second: UIMessage["parts"][number] = {
      type: "reasoning",
      text: "Comparing",
      state: "streaming",
    }
    await render([first, search, second])
    expect(narratives()[1]?.textContent).toBe("Comparing")
    second.text += " the dates."
    const parts = [
      first,
      search,
      second,
      { ...search, toolCallId: "second-search" },
    ]
    await render(parts)
    expect(container.textContent).toMatch(
      /Checking sources\..*Searched 10 websites.*Comparing the dates\..*Searched 10 websites.*Thinking/
    )
    await render([...parts, final])
    expect(visibleContent().textContent).toBe("Worked for 36s")
    await click("Worked for 36s")
    expect(container.textContent).toContain(second.text)
    expect(visibleContent().querySelector('[data-streaming="true"]')).toBeNull()
    await render([{ ...commentary, state: "streaming" }])
    expect(container.textContent).toContain("Checking the news.Thinking")
  })

  it("replaces Thinking with live narrative, freezes before answer completion, and resets nested source expansion", async () => {
    await render([])
    expect(container.textContent).toBe("Thinking")
    await render([commentary, search])
    expect(container.textContent).toContain("Checking the news.")
    expect(button("Searched 10 websites")).toBeTruthy()
    await render([commentary, search, final])
    expect(visibleContent().textContent).toBe("Worked for 36s")
    await render([commentary, search, final], 48000)
    expect(visibleContent().textContent).toBe("Worked for 36s")
    await click("Worked for 36s")
    expect(container.textContent).toContain("Checking the news.")
    await click("Searched 10 websites")
    expect(container.querySelectorAll("a")).toHaveLength(7)
    await click("3 more")
    expect(container.querySelectorAll("a")).toHaveLength(10)
    await click("Show less")
    expect(container.querySelectorAll("a")).toHaveLength(7)
    await click("Worked for 36s")
    await click("Worked for 36s")
    expect(button("Searched 10 websites").getAttribute("aria-expanded")).toBe(
      "false"
    )
  })

  it("retains the final reasoning delta in history when work ends immediately", async () => {
    const thought = {
      type: "reasoning",
      text: "Comparing",
      state: "streaming",
    } satisfies UIMessage["parts"][number]
    await render([thought, search])
    await render([
      { ...thought, text: "Comparing the final dates.", state: "done" },
      search,
      final,
    ])
    expect(container.querySelector("[data-inline-work-live]")).toBeNull()
    expect(visibleContent().textContent).toBe("Worked for 36s")
    await click("Worked for 36s")
    expect(visibleContent().textContent).toContain("Comparing the final dates.")
    expect(visibleContent().querySelector('[data-streaming="true"]')).toBeNull()
  })
})
