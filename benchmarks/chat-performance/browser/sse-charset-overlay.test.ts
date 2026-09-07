import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { applySseCharsetOverlay } from "./sse-charset-overlay"

const header = '      headers: { "content-type": "text/event-stream; charset=utf-8" },\n'
const head = readFileSync("app/api/chat/chat-turn-runtime.ts", "utf8")

describe("SSE charset compatibility overlay", () => {
  it("adds only the header and preserves unrelated baseline code", () => {
    expect(head).toContain(header)
    const base = head.replace(header, "")
    expect(applySseCharsetOverlay(base)).toEqual({ source: head, applied: true })
    expect(applySseCharsetOverlay(head)).toEqual({ source: head, applied: false })
    const unrelated = "// baseline-only implementation\n"
    expect(applySseCharsetOverlay(unrelated + base).source).toBe(unrelated + head)
  })

  it("rejects unknown or ambiguous response construction", () => {
    for (const source of ["", head.replace("charset=utf-8", "charset=ascii"),
      head.replace(header, "").repeat(2)]) {
      expect(() => applySseCharsetOverlay(source)).toThrow()
    }
  })
})
