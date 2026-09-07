/** @vitest-environment jsdom */

// CodeBlockCode streaming rendering (ADR-0016 "Lazy Shiki").
//
// The lazy highlighter SERVICE (lib/markdown/shiki-client.ts) is mocked at
// the module seam so highlight CALL COUNTS and inputs are exact and module
// loading can be deferred; timers and Date are fake, so provider pauses are
// a deterministic virtual-clock fact. Language normalization lives inside
// the service (tested in lib/markdown/shiki-client.test.ts) — the component
// passes the fenced language through verbatim.

import { buildCodePayload } from "@/benchmarks/chat-performance/fixtures"
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
import { CodeBlockCode } from "./code-block"

const shikiClientMock = vi.hoisted(() => {
  const escapeHtml = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const render = (code: string, language: string | undefined, theme: string) =>
    `<pre class="shiki" data-lang="${language ?? "text"}" data-theme="${theme}"><code>${escapeHtml(code)}</code></pre>`
  const state = {
    /** When true, highlight promises stay pending until manually resolved. */
    defer: false,
    pending: [] as Array<() => void>,
  }
  const highlightCode = vi.fn(
    (args: {
      code: string
      language?: string
      theme: string
      signal?: AbortSignal
    }) => {
      const html = render(args.code, args.language, args.theme)
      if (state.defer) {
        return new Promise<string>((resolve) => {
          state.pending.push(() => resolve(html))
        })
      }
      return Promise.resolve(html)
    }
  )
  return { state, highlightCode }
})

vi.mock("@/lib/markdown/shiki-client", () => ({
  highlightCode: shikiClientMock.highlightCode,
}))

const themeMock = vi.hoisted(() => ({ resolvedTheme: "light" as string }))

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: themeMock.resolvedTheme }),
}))

describe("CodeBlockCode streaming rendering", () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  beforeAll(() => {
    ;(
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })

  beforeEach(() => {
    vi.clearAllMocks()
    themeMock.resolvedTheme = "light"
    shikiClientMock.state.defer = false
    shikiClientMock.state.pending.length = 0
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

  type CodeProps = { code: string; language?: string; growing?: boolean }

  function mount(props: CodeProps) {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root?.render(<CodeBlockCode {...props} />)
    })
    return {
      rerender: (nextProps: CodeProps) => {
        act(() => {
          root?.render(<CodeBlockCode {...nextProps} />)
        })
      },
      unmount: () => {
        act(() => {
          root?.unmount()
        })
        root = null
      },
    }
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  const highlightedEl = () => container?.querySelector("pre.shiki")
  const plainText = () => container?.querySelector("pre code")?.textContent

  it("discards a stale async completion by generation token (deferred module load)", async () => {
    shikiClientMock.state.defer = true

    const view = mount({ code: "const a = 1", language: "ts", growing: false })
    await advance(0)
    expect(shikiClientMock.highlightCode).toHaveBeenCalledTimes(1)
    const staleSignal = shikiClientMock.highlightCode.mock.calls[0][0].signal
    expect(staleSignal?.aborted).toBe(false)

    // Code A's highlight is in flight, blocked on module loading.
    view.rerender({
      code: "const a = 1\nconst b = 2",
      language: "ts",
      growing: false,
    })
    expect(staleSignal?.aborted).toBe(true)
    // The newer canonical tuple is immediately visible as plain escaped code;
    // the older highlighted tuple is never shown while B waits.
    expect(highlightedEl()).toBeNull()
    expect(plainText()).toBe("const a = 1\nconst b = 2")

    await advance(0)
    expect(shikiClientMock.highlightCode).toHaveBeenCalledTimes(2)
    expect(shikiClientMock.highlightCode).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: "const a = 1\nconst b = 2" })
    )

    // Resolve NEWEST first, stale generation LAST: the late stale completion
    // must not overwrite the newer code's highlight.
    await act(async () => {
      const pending = [...shikiClientMock.state.pending].reverse()
      shikiClientMock.state.pending.length = 0
      shikiClientMock.state.defer = false
      for (const resolve of pending) resolve()
    })
    expect(highlightedEl()?.textContent).toBe("const a = 1\nconst b = 2")
    const currentSignal = shikiClientMock.highlightCode.mock.calls[1][0].signal
    expect(currentSignal?.aborted).toBe(false)
    view.unmount()
    expect(currentSignal?.aborted).toBe(true)
  })

  it.each([50, 180, 250])("keeps code plain across %sms deltas and highlights once at settlement", async (intervalMs) => {
    const payload = buildCodePayload(400)
    const lines = payload.split("\n")
    const deltaCount = 40
    const step = Math.ceil(lines.length / deltaCount)
    const growthStates = Array.from({ length: deltaCount }, (_, i) =>
      lines.slice(0, Math.min(lines.length, (i + 1) * step)).join("\n")
    )

    const view = mount({
      code: growthStates[0],
      language: "typescript",
      growing: true,
    })
    for (const state of growthStates.slice(1)) {
      await advance(intervalMs)
      view.rerender({ code: state, language: "typescript", growing: true })
      expect(shikiClientMock.highlightCode).not.toHaveBeenCalled()
      expect(plainText()).toBe(state)
    }
    await advance(2000)
    expect(shikiClientMock.highlightCode).not.toHaveBeenCalled()
    expect(plainText()).toBe(payload)

    // Settle: exactly one final highlight of the full tuple; the rendered
    // text matches the complete payload byte-for-byte.
    view.rerender({ code: payload, language: "typescript", growing: false })
    await advance(10)
    expect(shikiClientMock.highlightCode).toHaveBeenCalledTimes(1)
    expect(highlightedEl()?.textContent).toBe(payload)
  })

  it("hostile code is inert escaped text on the pre-highlight plain path and after highlighting", async () => {
    shikiClientMock.state.defer = true
    const hostile = "<script>alert(1)</script>"

    mount({ code: hostile, language: "ts", growing: false })
    // The plain fallback shows React-escaped text, never a live element.
    expect(plainText()).toBe(hostile)
    expect(container?.querySelector("script")).toBeNull()
    await advance(0)

    await act(async () => {
      const pending = [...shikiClientMock.state.pending]
      shikiClientMock.state.pending.length = 0
      shikiClientMock.state.defer = false
      for (const resolve of pending) resolve()
    })
    expect(highlightedEl()).not.toBeNull()
    expect(container?.querySelector("script")).toBeNull()
    expect(highlightedEl()?.textContent).toBe(hostile)
  })

  it("settling (block becomes non-terminal or the message settles) highlights the final tuple and goes quiet", async () => {
    const view = mount({
      code: "const done = true",
      language: "ts",
      growing: true,
    })
    await advance(10)
    expect(shikiClientMock.highlightCode).not.toHaveBeenCalled()

    view.rerender({ code: "const done = true", language: "ts", growing: false })
    await advance(10)
    expect(shikiClientMock.highlightCode).toHaveBeenCalledTimes(1)
    expect(highlightedEl()?.textContent).toBe("const done = true")

    // No stray timers keep firing afterwards.
    await advance(1000)
    expect(shikiClientMock.highlightCode).toHaveBeenCalledTimes(1)
  })

  it("invalidates highlighted output on theme and language changes", async () => {
    const view = mount({ code: "const t = 1", language: "ts", growing: false })
    await advance(10)
    expect(shikiClientMock.highlightCode).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: "const t = 1", theme: "github-light" })
    )

    shikiClientMock.state.defer = true
    themeMock.resolvedTheme = "dark"
    view.rerender({ code: "const t = 1", language: "ts", growing: false })
    // The light-theme HTML is obsolete immediately; canonical code remains.
    expect(highlightedEl()).toBeNull()
    expect(plainText()).toBe("const t = 1")
    expect(shikiClientMock.highlightCode).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: "const t = 1", theme: "github-dark" })
    )

    view.rerender({ code: "const t = 1", language: "js", growing: false })
    expect(highlightedEl()).toBeNull()
    expect(plainText()).toBe("const t = 1")
    expect(shikiClientMock.highlightCode).toHaveBeenLastCalledWith(
      expect.objectContaining({ language: "js", theme: "github-dark" })
    )

    await act(async () => {
      const pending = [...shikiClientMock.state.pending]
      shikiClientMock.state.pending.length = 0
      shikiClientMock.state.defer = false
      for (const resolve of pending) resolve()
    })
    expect(highlightedEl()?.getAttribute("data-theme")).toBe("github-dark")
    expect(highlightedEl()?.getAttribute("data-lang")).toBe("js")
  })

  it("keeps the plain fallback when the service rejects, then retries on input change", async () => {
    shikiClientMock.highlightCode.mockImplementationOnce(() =>
      Promise.reject(new Error("chunk load failed"))
    )
    const view = mount({ code: "const f = 1", language: "ts", growing: false })
    await advance(10)
    // Rejected load: plain escaped path stays, no crash.
    expect(highlightedEl()).toBeFalsy()
    expect(plainText()).toBe("const f = 1")

    // The next tuple change retries and succeeds.
    view.rerender({ code: "const f = 2", language: "ts", growing: false })
    await advance(10)
    expect(highlightedEl()?.textContent).toBe("const f = 2")
  })

  it("renders plain code when a highlighted block resumes growing", async () => {
    const view = mount({ code: "const a = 1", language: "ts", growing: false })
    await advance(0)
    expect(highlightedEl()).not.toBeNull()

    view.rerender({ code: "const a = 1", language: "ts", growing: true })
    expect(highlightedEl()).toBeNull()
    expect(plainText()).toBe("const a = 1")
    await advance(1000)
    expect(shikiClientMock.highlightCode).toHaveBeenCalledTimes(1)
  })
})
