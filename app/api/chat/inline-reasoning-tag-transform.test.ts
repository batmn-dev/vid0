import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { streamText, type TextStreamPart, type ToolSet } from "ai"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import { describe, expect, it } from "vitest"
import { createInlineReasoningTagTransform } from "./inline-reasoning-tag-transform"

type Part = TextStreamPart<ToolSet>

async function run(parts: Part[], abortSignal?: AbortSignal, abortAfter?: number) {
  const transform = createInlineReasoningTagTransform<ToolSet>(
    "think",
    abortSignal
  )({ tools: {}, stopStream: () => undefined })
  const writer = transform.writable.getWriter()
  const outputs: Part[] = []
  const readAll = (async () => {
    const reader = transform.readable.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      outputs.push(value)
    }
  })()
  for (const [index, part] of parts.entries()) {
    if (abortAfter !== undefined && index === abortAfter && abortSignal) {
      ;(abortSignal as AbortSignal & { abort?: () => void }).abort?.()
    }
    await writer.write(part)
  }
  await writer.close()
  await readAll
  return outputs
}

const start = (id = "0"): Part => ({ type: "text-start", id })
const delta = (text: string, id = "0"): Part => ({ type: "text-delta", id, text })
const end = (id = "0"): Part => ({ type: "text-end", id })

/** Concatenate text by part kind and id, in emission order. */
function summarize(outputs: Part[]) {
  const seq: string[] = []
  const text = new Map<string, string>()
  const reasoning = new Map<string, string>()
  for (const part of outputs) {
    if (part.type === "text-start" || part.type === "reasoning-start") {
      seq.push(`${part.type}:${part.id}`)
    } else if (part.type === "text-end" || part.type === "reasoning-end") {
      seq.push(`${part.type}:${part.id}`)
    } else if (part.type === "text-delta") {
      text.set(part.id, (text.get(part.id) ?? "") + part.text)
    } else if (part.type === "reasoning-delta") {
      reasoning.set(part.id, (reasoning.get(part.id) ?? "") + part.text)
    } else {
      seq.push(part.type)
    }
  }
  return { seq, text: Object.fromEntries(text), reasoning: Object.fromEntries(reasoning) }
}

describe("createInlineReasoningTagTransform", () => {
  it("lifts a think section split across deltas into reasoning parts before the answer", async () => {
    const outputs = await run([
      start(),
      delta("<thi"),
      delta("nk>\nLet me reason"),
      delta(" about it.\n</th"),
      delta("ink>\n\nThe answer is **42**."),
      end(),
    ])
    expect(summarize(outputs)).toEqual({
      seq: ["reasoning-start:think-1", "reasoning-end:think-1", "text-start:0", "text-end:0"],
      reasoning: { "think-1": "Let me reason about it.\n" },
      text: { "0": "The answer is **42**." },
    })
  })

  it("holds back only a partial tag prefix and streams everything else immediately", async () => {
    const outputs = await run([start(), delta("Plain text <"), delta("b> not a tag"), end()])
    expect(summarize(outputs).text).toEqual({ "0": "Plain text <b> not a tag" })
    // The "<" arrives only once the next delta proves it is not a tag.
    const texts = outputs.filter((p) => p.type === "text-delta").map((p) => (p as { text: string }).text)
    expect(texts).toEqual(["Plain text ", "<b> not a tag"])
  })

  it("closes an unterminated think section at text-end and keeps a trailing partial tag literal", async () => {
    const outputs = await run([start(), delta("<think>reasoning only </thi"), end()])
    expect(summarize(outputs)).toEqual({
      seq: ["reasoning-start:think-1", "reasoning-end:think-1"],
      reasoning: { "think-1": "reasoning only </thi" },
      text: {},
    })
  })

  it("is the identity for text without tags, ids and metadata included", async () => {
    const parts: Part[] = [
      { type: "text-start", id: "0", providerMetadata: { perplexity: { a: 1 } } },
      delta("Hello "),
      delta("world"),
      { type: "text-end", id: "0", providerMetadata: { perplexity: { b: 2 } } },
      { type: "finish-step", finishReason: "stop", rawFinishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, response: { id: "r", timestamp: new Date(0), modelId: "m" }, providerMetadata: undefined } as unknown as Part,
    ]
    const outputs = await run(parts)
    expect(outputs).toEqual(parts)
  })

  it("splits the text part when reasoning opens after answer text, keeping reading order", async () => {
    const outputs = await run([
      start(),
      delta("Intro. <think>hmm</think> Outro."),
      end(),
    ])
    expect(summarize(outputs)).toEqual({
      seq: [
        "text-start:0",
        "text-end:0",
        "reasoning-start:think-1",
        "reasoning-end:think-1",
        "text-start:0-1",
        "text-end:0-1",
      ],
      reasoning: { "think-1": "hmm" },
      text: { "0": "Intro. ", "0-1": "Outro." },
    })
  })

  it("keeps the SDK abort terminal on the wire when execution stops mid-reasoning (real streamText pipeline)", async () => {
    const execution = new AbortController()
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream<LanguageModelV4StreamPart>({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "0" },
            { type: "text-delta", id: "0", delta: "<think>" },
            ...Array.from({ length: 6 }, (_, i): LanguageModelV4StreamPart => ({
              type: "text-delta",
              id: "0",
              delta: `r${i} `,
            })),
            { type: "text-delta", id: "0", delta: "</think>answer" },
            { type: "text-end", id: "0" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              },
            },
          ],
          chunkDelayInMs: 20,
        }),
      }),
    })
    const result = streamText({
      model,
      prompt: "q",
      abortSignal: execution.signal,
      experimental_transform: createInlineReasoningTagTransform("think", execution.signal),
    })
    let endEvent: { isAborted: boolean } | undefined
    const types: string[] = []
    for await (const chunk of result.toUIMessageStream({
      onEnd: (event) => {
        endEvent = { isAborted: event.isAborted }
      },
    })) {
      types.push(chunk.type)
      if (chunk.type === "reasoning-delta" && chunk.id.startsWith("think")) {
        execution.abort()
      }
    }
    // The SDK enqueues its abort part UPSTREAM of experimental_transform; a
    // transform that swallows it leaves toUIMessageStream's onEnd with
    // isAborted=false, so Stop would settle as a non-aborted turn.
    expect(types).toContain("reasoning-delta")
    expect(types.at(-1)).toBe("abort")
    expect(endEvent).toEqual({ isAborted: true })
  })

  it("stops emitting after the execution signal aborts mid-tag", async () => {
    const controller = new AbortController()
    const outputs = await run(
      [start(), delta("<think>partial reas"), delta("oning</think>answer"), end()],
      Object.assign(controller.signal, { abort: () => controller.abort() }),
      1
    )
    expect(outputs).toEqual([])
  })
})
