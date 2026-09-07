/** @vitest-environment jsdom */

// Terminal-block stability through the full Markdown pipeline.
//
// The stability rule under test — a code block is `growing` iff it is the
// TERMINAL parsed block AND the message is live (`streaming` prop) — is
// classified in markdown.tsx and consumed by CodeBlockCode, whose growing
// blocks stay plain while stable blocks highlight immediately. Shiki is mocked, so
// highlight calls are exact; there is deliberately no fence parser, so an
// unclosed terminal fence settles the moment the message does.

import * as growingBlockTail from "@/lib/markdown/growing-block-tail"
import * as streamingDecay from "@/lib/markdown/streaming-decay-overlay"
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
import { Markdown } from "./markdown"

const shikiMock = vi.hoisted(() => {
  const escapeHtml = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const highlightCode = vi.fn(
    async (args: { code: string; language?: string; theme: string }) =>
      `<pre class="shiki" data-lang="${args.language ?? "text"}"><code>${escapeHtml(args.code)}</code></pre>`
  )
  return { highlightCode }
})

vi.mock("@/lib/markdown/shiki-client", () => ({
  highlightCode: shikiMock.highlightCode,
}))

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}))

describe("Markdown terminal-block stability", () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null
  const writeText = vi.fn()

  beforeAll(() => {
    ;(
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "Date",
      ],
    })
  })

  afterEach(() => {
    const mountedRoot = root
    if (mountedRoot) {
      act(() => {
        mountedRoot.unmount()
      })
    }
    container?.remove()
    container = null
    root = null
    vi.useRealTimers()
  })

  function mount(markdown: string, streaming: boolean, animateStreaming = true) {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    const render = (
      nextMarkdown: string,
      nextStreaming: boolean,
      nextAnimateStreaming = true
    ) => {
      act(() => {
        root?.render(
          <Markdown
            id="stability"
            streaming={nextStreaming}
            animateStreaming={nextAnimateStreaming}
          >
            {nextMarkdown}
          </Markdown>
        )
      })
    }
    render(markdown, streaming, animateStreaming)
    return { rerender: render }
  }

  it("keeps replay readable and clears live decay when switching back to replay", () => {
    const observe = vi.spyOn(streamingDecay, "observeStreamingDecay")
    const settle = vi.spyOn(streamingDecay, "settleStreamingDecay")
    try {
      const { rerender } = mount("Retained", true, false)
      rerender("Retained history", true, false)
      expect(container?.textContent).toBe("Retained history")
      expect(observe).not.toHaveBeenCalled()

      rerender("Retained history and live", true)
      expect(observe).toHaveBeenCalled()
      observe.mockClear()
      settle.mockClear()

      rerender("Retained history and live", true, false)
      expect(observe).not.toHaveBeenCalled()
      expect(settle).toHaveBeenCalled()
      expect(container?.textContent).toBe("Retained history and live")
    } finally {
      observe.mockRestore()
      settle.mockRestore()
    }
  })

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  // Two fences; the second is unclosed and terminal, with a longer outer
  // fence so inner triple backticks stay literal text while growing.
  const firstFence = 'const first = "done"'
  const growingTail = "const second = 1\n``` inner backticks ```"
  const multiFenceStreaming =
    "Intro prose.\n\n" +
    "```ts\n" +
    firstFence +
    "\n```\n\n" +
    "Some prose between fences.\n\n" +
    "````ts\n" +
    growingTail

  it("never requests Shiki for a no-code conversation", async () => {
    const view = mount("STREAM-START\n\nPlain prose only.", true)
    await advance(1000)
    view.rerender(
      "STREAM-START\n\nPlain prose only, still growing.\n\nSTREAM-END",
      false
    )
    await advance(1000)
    expect(shikiMock.highlightCode).not.toHaveBeenCalled()
  })

  it("highlights stable code immediately and leaves growing code plain through pauses", async () => {
    const view = mount(multiFenceStreaming, true)
    await advance(10)
    // The completed first fence is stable and immediate; the growing terminal
    // fence remains plain while the message is live.
    expect(shikiMock.highlightCode).toHaveBeenCalledTimes(1)
    expect(shikiMock.highlightCode).toHaveBeenCalledWith(
      expect.objectContaining({ code: `${firstFence}\n`, language: "ts" })
    )

    // The growing fence's raw tail — inner backticks included — flows through
    // as literal text.
    const codeBlocks = container?.querySelectorAll(".markdown-code-block")
    expect(codeBlocks?.length).toBe(2)
    expect(codeBlocks?.[1]?.querySelector("pre code")?.textContent).toContain(
      "``` inner backticks ```"
    )

    // Neither another delta nor a long pause highlights the growing block.
    // The stable first fence remains memoized.
    const grown = multiFenceStreaming + "\nconst third = 3"
    view.rerender(grown, true)
    expect(shikiMock.highlightCode).toHaveBeenCalledTimes(1)
    await advance(1000)
    expect(shikiMock.highlightCode).toHaveBeenCalledTimes(1)
    expect(codeBlocks?.[1]?.querySelector("pre code")?.textContent).toContain(
      "const third = 3"
    )
  })

  it("settling the message (finish, Stop, or error) highlights the unclosed terminal fence", async () => {
    const view = mount(multiFenceStreaming, true)
    await advance(10)
    expect(shikiMock.highlightCode).toHaveBeenCalledTimes(1)

    // Message settles with the fence still unclosed (Stop/error partial
    // output): the terminal block becomes stable and highlights its final
    // tuple immediately — no throttle window involved.
    view.rerender(multiFenceStreaming, false)
    await advance(10)
    expect(shikiMock.highlightCode).toHaveBeenCalledTimes(2)
    expect(shikiMock.highlightCode).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: `${growingTail}\n`, language: "ts" })
    )
    const codeBlocks = container?.querySelectorAll(".markdown-code-block")
    expect(codeBlocks?.[1]?.querySelector("pre.shiki")).not.toBeNull()
  })

  it("a fence becomes non-terminal when prose streams after it and highlights immediately", async () => {
    const unclosed = "```ts\nconst tail = 1"
    const view = mount(unclosed, true)
    await advance(10)
    expect(shikiMock.highlightCode).not.toHaveBeenCalled()

    // The fence closes and prose follows: the code block is no longer the
    // terminal block, so it re-highlights its settled content immediately —
    // no throttle window involved.
    view.rerender("```ts\nconst tail = 1\n```\n\nMore prose.", true)
    await advance(10)
    expect(shikiMock.highlightCode).toHaveBeenCalledTimes(1)
    expect(shikiMock.highlightCode).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: "const tail = 1\n", language: "ts" })
    )
  })

  it("streaming growth re-renders only the terminal block subtree", () => {
    // A paragraph-render counter stands in for React Profiler commit
    // attribution: each <p> render is one block-subtree render.
    const renderedParagraphs: string[] = []
    const CountingP = ({
      children,
      node: _,
      ...props
    }: React.ComponentPropsWithoutRef<"p"> & { node?: unknown }) => {
      renderedParagraphs.push("p")
      return <p {...props}>{children}</p>
    }
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    const render = (markdown: string) => {
      act(() => {
        root?.render(
          <Markdown id="confine" streaming components={{ p: CountingP }}>
            {markdown}
          </Markdown>
        )
      })
    }
    const settledPrefix = "First paragraph.\n\nSecond paragraph.\n\n"
    render(settledPrefix + "Growing tail")
    expect(renderedParagraphs.length).toBe(3)

    // Append-only growth touches only the terminal block: the two settled
    // blocks must memo-bail — exactly one paragraph (the terminal block)
    // re-renders per commit.
    renderedParagraphs.length = 0
    render(settledPrefix + "Growing tail with more")
    expect(renderedParagraphs.length).toBe(1)
    renderedParagraphs.length = 0
    render(settledPrefix + "Growing tail with more words")
    expect(renderedParagraphs.length).toBe(1)
  })

  it("prepares the growing tail once per appended source update", () => {
    const view = mount("Stable paragraph.\n\nGrowing tail", true)
    const stableParagraph = container?.querySelector("p")
    const mend = vi.spyOn(growingBlockTail, "mendGrowingBlockTail")
    try {
      view.rerender("Stable paragraph.\n\nGrowing tail with **more**", true)
      expect(mend).toHaveBeenCalledExactlyOnceWith("Growing tail with **more**")
      expect(container?.querySelector("p")).toBe(stableParagraph)
      expect(container?.querySelector("strong")?.textContent).toBe("more")
    } finally {
      mend.mockRestore()
    }
  })

  it("non-prefix corrections reset block identity (remount) while appends preserve DOM nodes", () => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    const render = (markdown: string) => {
      act(() => {
        root?.render(
          <Markdown id="reset" streaming>
            {markdown}
          </Markdown>
        )
      })
    }

    render("Stable first paragraph.\n\nGrowing tail")
    const firstParagraphBefore = container.querySelector("p")
    expect(firstParagraphBefore?.textContent).toBe("Stable first paragraph.")

    // Append-only growth: the settled block's DOM node is REUSED (same
    // identity, memo bailout), never recreated.
    render("Stable first paragraph.\n\nGrowing tail with more words")
    expect(container.querySelector("p")).toBe(firstParagraphBefore)

    // Non-prefix correction (regeneration/branch divergence): identities
    // reset, so the DOM remounts — no stale node, no duplicated content.
    render("Regenerated different answer.\n\nOther tail")
    const firstParagraphAfter = container.querySelector("p")
    expect(firstParagraphAfter?.textContent).toBe(
      "Regenerated different answer."
    )
    expect(firstParagraphAfter).not.toBe(firstParagraphBefore)
    expect(container.textContent).not.toContain("Stable first paragraph.")
  })

  it("renders byte-identically after streaming settles vs a fresh settled mount", async () => {
    const markdown =
      "Some **bold** prose with `inline code`.\n\n```ts\nconst x = 1\n```\n\nTail paragraph."
    const mountInto = () => {
      const host = document.createElement("div")
      document.body.appendChild(host)
      const hostRoot = createRoot(host)
      const render = (streaming: boolean) => {
        act(() => {
          hostRoot.render(
            <Markdown id="parity" streaming={streaming}>
              {markdown}
            </Markdown>
          )
        })
      }
      return { host, hostRoot, render }
    }

    // One tree streams and settles; the control mounts already settled.
    // Their settled DOM must match byte-for-byte.
    const streamed = mountInto()
    streamed.render(true)
    streamed.render(false)
    const control = mountInto()
    control.render(false)
    await advance(1000)
    // base-ui autogenerates per-instance tooltip ids; they differ between
    // mounts regardless of the streaming path — normalize before comparing.
    const normalize = (html: string) =>
      html.replace(/base-ui-[_a-z0-9]+/g, "base-ui-x")
    expect(normalize(streamed.host.innerHTML)).toBe(
      normalize(control.host.innerHTML)
    )

    act(() => {
      streamed.hostRoot.unmount()
      control.hostRoot.unmount()
    })
    streamed.host.remove()
    control.host.remove()
  })

  it("copy during growth writes the raw code, and hostile code stays inert text", async () => {
    const hostile = '<script>alert("xss")</script>'
    mount("```ts\n" + hostile, true)
    await advance(10)

    // Escaped everywhere — never a live element, before or after highlight.
    expect(container?.querySelector("script")).toBeNull()
    const copyButton = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy"]'
    )
    expect(copyButton).not.toBeNull()
    act(() => {
      copyButton?.click()
    })
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0][0]).toContain(hostile)
  })

  // Growing single-block shapes: lists always retain one authoritative
  // semantic root; an open fence renders directly and lands on the pipeline's
  // structure at settle.

  function orderedItems(from: number, to: number) {
    return Array.from(
      { length: to - from + 1 },
      (_, i) =>
        `${from + i}. Item sentence number ${from + i} concerning harbors and tides.`
    ).join("\n")
  }

  it("keeps one semantic ordered-list root during growth and settlement", async () => {
    const view = mount(orderedItems(1, 120) + "\n", true)
    await advance(10)

    expect(container?.querySelectorAll("ol")).toHaveLength(1)
    expect(container?.querySelectorAll("li")).toHaveLength(120)

    view.rerender(orderedItems(1, 200) + "\n", true)
    await advance(10)

    expect(container?.querySelectorAll("ol")).toHaveLength(1)
    expect(container?.querySelectorAll("li")).toHaveLength(200)

    view.rerender(orderedItems(1, 200) + "\n", false)
    await advance(10)
    expect(container?.querySelectorAll("ol")).toHaveLength(1)
    expect(container?.querySelectorAll("li")).toHaveLength(200)
  })

  it("keeps repeated markers in one sequential CommonMark list", async () => {
    const repeated =
      Array.from(
        { length: 128 },
        (_, i) =>
          `1. Item sentence number ${i + 1} concerning harbors and tides.`
      ).join("\n") + "\n"
    const view = mount(repeated, true)
    await advance(10)

    expect(container?.querySelectorAll("ol")).toHaveLength(1)
    expect(container?.querySelectorAll("li")).toHaveLength(128)

    const withPartialTail = `${repeated}1. Still-streaming repeated marker`
    view.rerender(withPartialTail, true)
    await advance(10)
    expect(container?.querySelectorAll("ol")).toHaveLength(1)
    expect(container?.querySelectorAll("li")).toHaveLength(129)

    view.rerender(withPartialTail, false)
    await advance(10)
    expect(container?.querySelectorAll("ol")).toHaveLength(1)
    expect(container?.querySelectorAll("li")).toHaveLength(129)
  })

  it("preserves non-1 starts, looseness, tasks, and nesting in one root", async () => {
    const zeroStarted =
      Array.from(
        { length: 40 },
        (_, i) => `${i}. Zero-started item ${i} concerning harbors and tides.`
      ).join("\n") + "\n"
    const view = mount(zeroStarted, true)
    await advance(10)
    expect(container?.querySelectorAll("ol")).toHaveLength(1)
    expect(container?.querySelector("ol")?.getAttribute("start")).toBe("0")

    const loose = `${orderedItems(5, 6)}\n\n${orderedItems(7, 40)}\n`
    view.rerender(loose, true)
    await advance(10)
    const looseList = container?.querySelector("ol")
    expect(container?.querySelectorAll("ol")).toHaveLength(1)
    expect(looseList?.getAttribute("start")).toBe("5")
    for (const item of looseList?.querySelectorAll(":scope > li") ?? []) {
      expect(item.firstElementChild?.tagName).toBe("P")
    }
    const tasks = "- [ ] open\n- [x] done\n  - nested child\n"
    view.rerender(tasks, true)
    await advance(10)
    const markdownRoot = container?.firstElementChild
    const topLevelLists = Array.from(markdownRoot?.children ?? []).filter(
      (element) => element.tagName === "UL"
    )
    expect(topLevelLists).toHaveLength(1)
    expect(topLevelLists[0]?.classList).toContain("contains-task-list")
    expect(topLevelLists[0]?.querySelectorAll(":scope > li > ul")).toHaveLength(
      1
    )
  })

  it("renders a growing open fence directly and keeps its structure at settle", async () => {
    const lines = Array.from(
      { length: 30 },
      (_, i) => `const line${i} = ${i}`
    ).join("\n")
    const view = mount("```ts\n" + lines, true)
    await advance(10)

    const block = container?.querySelector(".markdown-code-block")
    expect(block).not.toBeNull()
    expect(block?.className).toContain("language-ts")
    expect(block?.textContent).toContain("TypeScript")
    expect(block?.textContent).toContain("const line29 = 29")

    // Growth updates the code text in place.
    view.rerender("```ts\n" + lines + "\nconst extra = 99", true)
    await advance(10)
    expect(container?.querySelector(".markdown-code-block")).toBe(block)
    expect(
      container?.querySelector(".markdown-code-block")?.textContent
    ).toContain("const extra = 99")

    // Closing the fence and settling lands on the normal pipeline's DOM:
    // same wrapper classes, same header label, full code highlighted.
    view.rerender("```ts\n" + lines + "\nconst extra = 99\n```\n", false)
    await advance(1000)
    const settledBlock = container?.querySelector(".markdown-code-block")
    expect(settledBlock).not.toBeNull()
    expect(settledBlock?.className).toContain("language-ts")
    expect(settledBlock?.textContent).toContain("TypeScript")
    const highlighted = shikiMock.highlightCode.mock.calls.map(
      (call) => call[0].code
    )
    expect(highlighted.some((code) => code.includes("const extra = 99"))).toBe(
      true
    )
  })

  it.each([
    { language: "c++", label: "C++", code: "int main() { return 0; }" },
    { language: "c#", label: "C#", code: 'Console.WriteLine("hi");' },
  ])(
    "keeps $language identical while growing and settled",
    async ({ language, label, code }) => {
      const view = mount(`\`\`\`${language}\n${code}`, true)
      await advance(10)

      const growingBlock = container?.querySelector(".markdown-code-block")
      expect(growingBlock?.className).toContain(`language-${language}`)
      expect(growingBlock?.textContent).toContain(label)
      await advance(1000)
      expect(shikiMock.highlightCode).not.toHaveBeenCalled()

      view.rerender(`\`\`\`${language}\n${code}\n\`\`\`\n`, false)
      await advance(10)
      const settledBlock = container?.querySelector(".markdown-code-block")
      expect(settledBlock?.className).toContain(`language-${language}`)
      expect(settledBlock?.textContent).toContain(label)
      expect(shikiMock.highlightCode).toHaveBeenLastCalledWith(
        expect.objectContaining({ language })
      )
    }
  )

  // Pins tail mending at the component seam. These fail if markdown.tsx stops
  // routing the growing terminal block through mendGrowingBlockTail; the tests in
  // growing-block-tail.test.ts cannot see that wiring.
  it("mends the growing terminal block and restores canonical bytes at settlement", async () => {
    const view = mount("Prose intro.\n\nselecting the right **Apache Fl", true)
    await advance(10)
    // Mid-stream the unclosed strong is COMPLETED: bold "Apache Fl", no raw
    // delimiters painted.
    expect(container?.querySelector("strong")?.textContent).toBe("Apache Fl")
    expect(container?.textContent).not.toContain("**")

    // Stop mid-construct: the settled render shows the exact canonical
    // bytes — the raw delimiters are settled content, not a transient.
    view.rerender("Prose intro.\n\nselecting the right **Apache Fl", false)
    await advance(10)
    expect(container?.querySelector("strong")).toBeNull()
    expect(container?.textContent).toContain("**Apache Fl")
  })

  it("gates an unproven growing table (newline-terminated header) until its delimiter row proves it", async () => {
    const view = mount("Results:\n\n| A | B |\n", true)
    await advance(10)
    // The pipe-led candidate is clipped from the render — no raw pipes, no
    // premature table.
    expect(container?.textContent).toContain("Results:")
    expect(container?.textContent).not.toContain("|")
    expect(container?.querySelector("table")).toBeNull()

    view.rerender("Results:\n\n| A | B |\n|---|---|\n| a1 | b1 |", true)
    await advance(10)
    const table = container?.querySelector("table")
    expect(table).not.toBeNull()
    expect(table?.textContent).toContain("a1")
  })

  it("streams consecutive pipe-led shell pipeline prose without gating it", async () => {
    mount(
      'curl https://api.example.com/items\n| jq ".items[]"\n| sort\n',
      true
    )
    await advance(10)

    expect(container?.textContent).toContain('curl https://api.example.com/items')
    expect(container?.textContent).toContain('| jq ".items[]"')
    expect(container?.textContent).toContain("| sort")
    expect(container?.querySelector("table")).toBeNull()
  })
})
