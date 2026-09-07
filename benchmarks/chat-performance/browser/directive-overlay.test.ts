import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { validateDirectiveOverlay } from "./directive-overlay"

const head = readFileSync("app/api/chat/deterministic-provider.ts", "utf8")
const base = head.replace(
  String.raw`  // The rich composer serializes literal brackets with Markdown escapes.
  const match = DIRECTIVE_PATTERN.exec(text.replace(/\\(\[|\])/g, "$1"))`,
  "  const match = DIRECTIVE_PATTERN.exec(text)"
)

describe("deterministic directive compatibility overlay", () => {
  it("permits the decoder change and identical providers", () => {
    expect(base).not.toBe(head)
    expect(validateDirectiveOverlay(base, head)).toBe(true)
    expect(validateDirectiveOverlay(head, head)).toBe(false)
  })
  it("rejects output, timing, and environment-gate changes", () => {
    for (const changed of [
      head.replace("buildMarkdownPayload()", '"different fixture"'),
      head.replace("chunksPerSecond > 1000", "chunksPerSecond > 2000"),
      head.replace('process.env.CHAT_PERF_DETERMINISTIC_PROVIDER === "1"', "true"),
    ]) expect(() => validateDirectiveOverlay(base, changed)).toThrow()
  })
})
