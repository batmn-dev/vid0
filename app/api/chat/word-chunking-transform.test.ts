import type { TextStreamPart, ToolSet } from "ai"
import { describe, expect, it, vi } from "vitest"
import {
  createWordChunkingTransform,
  isWordChunkingEligible,
  splitIntoWordChunks,
} from "./word-chunking-transform"

type Part = TextStreamPart<ToolSet>

function makeTransform() {
  return createWordChunkingTransform<ToolSet>()({
    tools: {},
    stopStream: () => undefined,
  })
}

/** Write all parts, close, and collect every output with arrival times. */
async function run(parts: Part[]) {
  const transform = makeTransform()
  const writer = transform.writable.getWriter()
  const outputs: { part: Part; atMs: number }[] = []
  const start = Date.now()
  const readAll = (async () => {
    const reader = transform.readable.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      outputs.push({ part: value, atMs: Date.now() - start })
    }
  })()
  for (const part of parts) await writer.write(part)
  await writer.close()
  await readAll
  return outputs
}

const textDelta = (
  text: string,
  id = "t1"
): Extract<Part, { type: "text-delta" }> => ({
  type: "text-delta",
  id,
  text,
})

describe("splitIntoWordChunks", () => {
  it("splits on whitespace with concatenation identity", () => {
    const text = "one  two\nthree,   four. "
    const chunks = splitIntoWordChunks(text)
    expect(chunks.join("")).toBe(text)
    expect(chunks.length).toBeGreaterThan(3)
  })
})

describe("isWordChunkingEligible", () => {
  it("enables only the provider/model pairs measured through this app", () => {
    expect(
      isWordChunkingEligible({
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
      })
    ).toBe(true)

    expect(
      isWordChunkingEligible({ provider: "google", model: "gemini-3.5-flash" })
    ).toBe(true)
    expect(
      isWordChunkingEligible({ provider: "google", model: "gemini-3.1-pro-preview" })
    ).toBe(false)
    expect(
      isWordChunkingEligible({ provider: "openrouter", model: "gemini-3.5-flash" })
    ).toBe(false)

    expect(
      isWordChunkingEligible({
        provider: "anthropic",
        model: "claude-sonnet-5",
      })
    ).toBe(false)
    expect(
      isWordChunkingEligible({
        provider: "openrouter",
        model: "openrouter:anthropic/claude-haiku-4.5",
      })
    ).toBe(false)
    expect(
      isWordChunkingEligible({ provider: "openai", model: "gpt-5-mini" })
    ).toBe(false)
  })
})

describe("createWordChunkingTransform", () => {
  it("passes word-granular deltas through untouched and in order", async () => {
    const parts = [textDelta("Hello "), textDelta("world.")]
    const outputs = await run(parts)
    expect(outputs.map((o) => o.part)).toEqual(parts)
  })

  it("reconstructs word chunks across arbitrary provider delta boundaries", async () => {
    const outputs = await run([
      textDelta("Hel"),
      textDelta("lo "),
      textDelta("wor"),
      textDelta("ld."),
    ])
    expect(outputs.map(({ part }) => (part as { text: string }).text)).toEqual([
      "Hello ",
      "world.",
    ])
  })

  it("preserves empty metadata deltas between held text and terminal parts", async () => {
    const signature: Part = {
      ...textDelta(""),
      providerMetadata: { google: { thoughtSignature: "test-signature" } },
    }
    const end: Part = { type: "text-end", id: "t1" }
    const parts = [textDelta("Hello"), signature, end]
    const outputs = await run(parts)

    expect(outputs.map(({ part }) => part)).toEqual(parts)
    expect(outputs[1].part).toBe(signature)
  })

  it("preserves incoming metadata when its text completes a held word", async () => {
    const signature: Part = {
      ...textDelta("lo "),
      providerMetadata: { google: { thoughtSignature: "test-signature" } },
    }
    const end: Part = { type: "text-end", id: "t1" }
    const parts = [textDelta("Hel"), signature, textDelta("world."), end]
    const outputs = await run(parts)

    expect(outputs.map(({ part }) => part)).toEqual(parts)
    expect(
      outputs
        .flatMap(({ part }) => part.type === "text-delta" ? [part.text] : [])
        .join("")
    ).toBe("Hello world.")
  })

  it("flushes an unfinished word within the partial-word holdback budget", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const transform = makeTransform()
      const writer = transform.writable.getWriter()
      const reader = transform.readable.getReader()
      let delivered = false
      const firstRead = reader.read().then((result) => {
        delivered = true
        return result
      })

      await writer.write(textDelta("Hello"))
      await vi.advanceTimersByTimeAsync(79)
      expect(delivered).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await expect(firstRead).resolves.toMatchObject({
        done: false,
        value: { type: "text-delta", id: "t1", text: "Hello" },
      })

      await writer.close()
      await expect(reader.read()).resolves.toEqual({
        done: true,
        value: undefined,
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("restarts the holdback deadline per held word, not per timer cycle", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const transform = makeTransform()
      const writer = transform.writable.getWriter()
      const reader = transform.readable.getReader()
      const texts: string[] = []
      const pump = (async () => {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return
          texts.push((value as { text: string }).text)
        }
      })()

      // Leading-space token cadence: each delta completes the previous word
      // and starts holding a new one.
      await writer.write(textDelta("The"))
      await vi.advanceTimersByTimeAsync(30)
      await writer.write(textDelta(" quick"))
      await vi.advanceTimersByTimeAsync(30)
      await writer.write(textDelta(" brown"))

      // "brown" arrived at t=60, so its deadline is t=140. A timer surviving
      // from t=0 would flush it mid-cycle at t=80 after only 20 ms of hold.
      await vi.advanceTimersByTimeAsync(79)
      expect(texts).toEqual(["The ", "quick "])
      await vi.advanceTimersByTimeAsync(1)
      expect(texts).toEqual(["The ", "quick ", "brown"])

      await writer.close()
      await pump
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("uses word segmentation for text without spaces", async () => {
    const text = "你好世界，欢迎回来。"
    const outputs = await run([textDelta(text)])
    expect(
      outputs.map(({ part }) => (part as { text: string }).text).join("")
    ).toBe(text)
    expect(outputs.length).toBeGreaterThan(2)
  })

  it("paces a burst made entirely of small provider deltas", async () => {
    const parts = Array.from({ length: 80 }, () => textDelta("word "))
    const outputs = await run(parts)
    expect(
      outputs.map(({ part }) => (part as { text: string }).text).join("")
    ).toBe("word ".repeat(parts.length))
    expect(outputs[outputs.length - 1].atMs).toBeGreaterThan(150)
    expect(outputs[outputs.length - 1].atMs).toBeLessThan(500)
  })

  it("splits an oversized slab into word deltas with exact content and identity fields", async () => {
    const slab =
      "The quick brown fox jumps over the lazy dog while the moon rises slowly."
    const outputs = await run([textDelta(slab, "block-9")])
    const texts = outputs.map((o) => (o.part as { text: string }).text)
    expect(texts.join("")).toBe(slab)
    expect(outputs.length).toBeGreaterThan(5)
    for (const { part } of outputs) {
      expect(part.type).toBe("text-delta")
      expect((part as { id: string }).id).toBe("block-9")
    }
  })

  it("leaves oversized non-text parts (reasoning deltas) untouched", async () => {
    const reasoning = {
      type: "reasoning-delta",
      id: "r1",
      text: "x".repeat(500),
    } as Part
    const outputs = await run([reasoning])
    expect(outputs).toHaveLength(1)
    expect(outputs[0].part).toBe(reasoning)
  })

  it("preserves part order: a tool part never overtakes a draining slab", async () => {
    const slabText = "alpha beta gamma delta epsilon zeta eta theta iota kappa"
    const toolPart = { type: "tool-call", toolCallId: "c1" } as unknown as Part
    const outputs = await run([textDelta(slabText), toolPart])
    expect(outputs[outputs.length - 1].part).toBe(toolPart)
    const texts = outputs
      .slice(0, -1)
      .map((o) => (o.part as { text: string }).text)
    expect(texts.join("")).toBe(slabText)
  })

  it("bounds total added latency below one spread budget even for large slabs", async () => {
    // A same-instant slab must drain within the queue-lag budget plus slack —
    // the bounded-lag guarantee, not a fixed per-word tax.
    const slab = textDelta(Array.from({ length: 120 }, () => "word").join(" "))
    const outputs = await run([slab])
    expect(outputs.length).toBeGreaterThan(100)
    const lastAt = outputs[outputs.length - 1].atMs
    expect(lastAt).toBeGreaterThan(150)
    expect(lastAt).toBeLessThan(500)
  })

  it("applies the pacing floor once to a buffered burst, not once per slab", async () => {
    const slab = "alpha beta gamma delta epsilon"
    const toolPart = { type: "tool-call", toolCallId: "c1" } as unknown as Part
    const parts = [
      ...Array.from({ length: 100 }, (_, index) =>
        textDelta(slab, `block-${index}`)
      ),
      toolPart,
    ]

    const outputs = await run(parts)
    const toolOutput = outputs[outputs.length - 1]
    expect(toolOutput.part).toBe(toolPart)
    expect(toolOutput.atMs).toBeLessThan(500)
    expect(
      outputs
        .slice(0, -1)
        .map(({ part }) => (part as { text: string }).text)
        .join("")
    ).toBe(slab.repeat(100))
  })

  it("stops emitting promptly when the stream is cancelled mid-slab", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const transform = makeTransform()
      const writer = transform.writable.getWriter()
      const reader = transform.readable.getReader()
      const slab = textDelta(
        // Few enough chunks for adaptive pacing to schedule a sleep.
        Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ")
      )
      void writer.write(textDelta("tiny "))
      await reader.read()
      vi.setSystemTime(120)
      const writePromise = writer.write(slab)
      await reader.read() // first word emitted, transform is sleeping
      await writePromise
      expect(vi.getTimerCount()).toBeGreaterThan(0)

      await reader.cancel()
      const closePromise = writer.close().catch(() => undefined)
      await vi.advanceTimersByTimeAsync(0)

      expect(vi.getTimerCount()).toBe(0)
      await expect(closePromise).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it("drops the queued suffix and clears pacing when execution aborts", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const execution = new AbortController()
      const transform = createWordChunkingTransform<ToolSet>(execution.signal)({
        tools: {},
        stopStream: () => undefined,
      })
      const writer = transform.writable.getWriter()
      const reader = transform.readable.getReader()
      const slab = textDelta(
        Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ")
      )

      const writePromise = writer.write(slab)
      const first = await reader.read()
      await writePromise
      expect(first.value).toMatchObject({ type: "text-delta", text: "w0 " })
      expect(vi.getTimerCount()).toBeGreaterThan(0)

      execution.abort(new Error("run stopped"))
      await vi.advanceTimersByTimeAsync(0)
      await writer.close().catch(() => undefined)

      expect(vi.getTimerCount()).toBe(0)
      await expect(reader.read()).resolves.toEqual({
        done: false,
        value: { type: "abort", reason: "stream aborted" },
      })
      await expect(reader.read()).resolves.toEqual({
        done: true,
        value: undefined,
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
