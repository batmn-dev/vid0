/** @vitest-environment jsdom */

// Rendered-DOM equivalence for the ADR-0016 corpus. Block-record equality
// alone cannot prove rendered parity.
//
// For EVERY equivalence-corpus fixture, the same source is rendered two
// ways: STREAMED (one mount fed growing prefixes through the incremental
// fast path) and CONTROL (a fresh mount of the same prefix, whose initial
// parse is the authoritative full parse). Their normalized DOM must be
// identical at sampled mid-stream prefixes and at settlement — visible
// text, links/URL transforms, tables, code, math, and custom component
// output included, since all of it is in the innerHTML. Table/code copy
// outputs read from this same DOM (table copy walks table.innerText; code
// copy receives the block's text), so DOM equality covers them.
//
// A StrictMode pass streams fixtures under <StrictMode> and must produce
// the same settled DOM as the plain control — the projection advances
// through render-phase state adjustment, which StrictMode double-invokes.

import { buildMarkdownPayload } from "@/benchmarks/chat-performance/fixtures"
import {
  EQUIVALENCE_FIXTURES,
  seededPrefixOffsets,
} from "@/lib/markdown/markdown-equivalence-corpus"
import React, { act, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { Processor } from "unified"
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

const parseSource = vi.hoisted(() => vi.fn())
const canonicalParser = vi.hoisted(() => ({ enabled: false }))
vi.mock("@/lib/markdown/remark-parsed-block", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/markdown/remark-parsed-block")>()
  return {
    ...original,
    remarkParsedBlock: function (
      this: Processor,
      ...args: Parameters<typeof original.remarkParsedBlock>
    ) {
      if (!canonicalParser.enabled)
        return original.remarkParsedBlock.apply(this, args)
    },
  }
})
vi.mock("react-markdown", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-markdown")>()
  function countParses(this: Processor) {
    const parser = this.parser!
    this.parser = (source, file) => {
      parseSource(source)
      return parser(source, file)
    }
  }
  return {
    ...original,
    default: function (props: Parameters<typeof original.default>[0]) {
      return original.default({
        ...props,
        remarkPlugins: [countParses, ...(props.remarkPlugins ?? [])],
      })
    },
  }
})

vi.mock("@/lib/markdown/shiki-client", () => ({
  highlightCode: vi.fn(
    async (args: { code: string; language?: string; theme: string }) =>
      `<pre class="shiki" data-lang="${args.language ?? "text"}"><code>${args.code
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")}</code></pre>`
  ),
}))

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}))

// base-ui and useId generate per-mount ids; they differ between mounts
// regardless of the projection path.
function normalize(html: string): string {
  return (
    html
      .replace(/base-ui-[_a-z0-9-]+/g, "base-ui-x")
      .replace(/«[^»]*»/g, "«id»")
      .replace(/:r[0-9a-z]+:/g, ":rid:")
      // React leaves an empty style attribute behind when an in-place update
      // sets and then clears inline styles; a fresh mount never has it.
      .replace(/ style=""/g, "")
  )
}

type Mount = {
  host: HTMLDivElement
  root: Root
  render: (markdown: string, streaming: boolean) => void
  unmount: () => void
}

function mount(
  strict = false,
  canonical = false,
  customComponents = false
): Mount {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const root = createRoot(host)
  const render = (markdown: string, streaming: boolean) => {
    const tree = (
      <Markdown
        id="equiv"
        streaming={streaming}
        components={customComponents ? {} : undefined}
      >
        {markdown}
      </Markdown>
    )
    canonicalParser.enabled = canonical
    try {
      act(() => {
        root.render(strict ? <StrictMode>{tree}</StrictMode> : tree)
      })
    } finally {
      canonicalParser.enabled = false
    }
  }
  return {
    host,
    root,
    render,
    unmount: () => {
      act(() => {
        root.unmount()
      })
      host.remove()
    },
  }
}

async function flushHighlights() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

describe("streamed vs authoritative rendered DOM (full corpus)", () => {
  beforeAll(() => {
    ;(
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
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
    vi.useRealTimers()
  })

  it("reuses slab syntax without changing canonical DOM or completed block identity", async () => {
    const source = buildMarkdownPayload()
    const reused = mount()
    const canonical = mount(false, true)
    let firstParagraph: Element | null = null
    for (const end of [4096, 8192, source.length]) {
      const prefix = source.slice(0, end)
      reused.render(prefix, true)
      canonical.render(prefix, true)
      await flushHighlights()
      expect(normalize(reused.host.innerHTML)).toBe(
        normalize(canonical.host.innerHTML)
      )
      firstParagraph ??= reused.host.querySelector("p")
      expect(reused.host.querySelector("p")).toBe(firstParagraph)
    }
    reused.render(source, false)
    canonical.render(source, false)
    await flushHighlights()
    expect(normalize(reused.host.innerHTML)).toBe(
      normalize(canonical.host.innerHTML)
    )
    expect(reused.host.querySelector("p")).toBe(firstParagraph)
    reused.unmount()
    canonical.unmount()
  })

  it("skips only the eligible second parses and retains the growing and custom-component paths", () => {
    const source = "# Heading\n\nA **strong** paragraph.\n\nGrowing tail"
    parseSource.mockClear()
    const reused = mount()
    reused.render(source, true)
    expect(parseSource.mock.calls.map(([text]) => text)).toEqual([
      "Growing tail",
    ])
    reused.render(source, false)
    expect(parseSource.mock.calls.map(([text]) => text)).toEqual([
      "Growing tail",
    ])
    reused.unmount()

    parseSource.mockClear()
    const canonical = mount(false, false, true)
    canonical.render(source, false)
    expect(parseSource).toHaveBeenCalledTimes(3)
    canonical.unmount()
  })

  it("refreshes a reused block when consumer components change", () => {
    const host = document.createElement("div")
    document.body.append(host)
    const root = createRoot(host)
    const First = () => <p>First override</p>
    const Second = () => <p>Second override</p>
    const render = (p?: typeof First) =>
      act(() => {
        root.render(
          <Markdown components={p ? { p } : undefined}>Stable source</Markdown>
        )
      })
    render()
    expect(host.textContent).toBe("Stable source")
    render(First)
    expect(host.textContent).toBe("First override")
    render(Second)
    expect(host.textContent).toBe("Second override")
    act(() => root.unmount())
    host.remove()
  })

  for (const fixture of EQUIVALENCE_FIXTURES) {
    it(`renders identically streamed and fresh at every sampled prefix: ${fixture.name}`, async () => {
      const offsets = seededPrefixOffsets(fixture.source.length, 7)
      // Compare DOM at every 4th prefix plus the final one; every prefix
      // still streams through the incremental path in between.
      const sampled = new Set(
        offsets
          .filter((_, i) => i % 4 === 3)
          .concat(offsets[offsets.length - 1]!)
      )

      const streamed = mount()
      for (const offset of offsets) {
        const prefix = fixture.source.slice(0, offset)
        streamed.render(prefix, true)
        if (!sampled.has(offset)) continue
        await flushHighlights()

        const control = mount(false, true)
        control.render(prefix, true)
        await flushHighlights()
        expect(
          normalize(streamed.host.innerHTML),
          `${fixture.name} mid-stream DOM diverged @${offset}`
        ).toBe(normalize(control.host.innerHTML))
        control.unmount()
      }

      // Settlement: streamed-then-settled vs fresh settled mount.
      streamed.render(fixture.source, false)
      await flushHighlights()
      const settledControl = mount(false, true)
      settledControl.render(fixture.source, false)
      await flushHighlights()
      expect(
        normalize(streamed.host.innerHTML),
        `${fixture.name} settled DOM diverged`
      ).toBe(normalize(settledControl.host.innerHTML))

      settledControl.unmount()
      streamed.unmount()
    })
  }

  it("StrictMode streaming settles to the same DOM as the plain control", async () => {
    for (const fixture of EQUIVALENCE_FIXTURES.slice(0, 6)) {
      const strict = mount(true)
      for (const offset of seededPrefixOffsets(fixture.source.length, 3, 48)) {
        strict.render(fixture.source.slice(0, offset), true)
      }
      strict.render(fixture.source, false)
      await flushHighlights()

      const control = mount(false, true)
      control.render(fixture.source, false)
      await flushHighlights()
      expect(
        normalize(strict.host.innerHTML),
        `${fixture.name} StrictMode DOM diverged`
      ).toBe(normalize(control.host.innerHTML))
      control.unmount()
      strict.unmount()
    }
  })

  it("rapid identity changes reset cleanly to each identity's own content", () => {
    const host = document.createElement("div")
    document.body.appendChild(host)
    const root = createRoot(host)
    const render = (id: string, text: string) => {
      act(() => {
        root.render(
          <Markdown id={id} streaming>
            {text}
          </Markdown>
        )
      })
    }
    render("a", "Message A paragraph one.\n\nGrowing A")
    render("b", "Totally different B content")
    render("a", "Message A paragraph one.\n\nGrowing A more")
    expect(host.textContent).toContain("Growing A more")
    expect(host.textContent).not.toContain("different B")
    act(() => {
      root.unmount()
    })
    host.remove()
  })
})
