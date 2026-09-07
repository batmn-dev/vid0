import { afterEach, describe, expect, it } from "vitest"
import { createPromptInputDocument, readPromptInputDocument } from "@/components/ui/prompt-input-schema"
import {
  buildDeterministicPartScript,
  DETERMINISTIC_PERF_SCENARIOS,
  deterministicScenarioText,
  parseDeterministicPerfDirective,
} from "./deterministic-provider"

afterEach(() => {
  delete process.env.CHAT_PERF_DETERMINISTIC_PROVIDER
})

const directiveMessage = (text: string) => [
  { role: "user", parts: [{ type: "text" as const, text }] },
]

describe("deterministic perf directive", () => {
  it("is inert without the server environment gate — a client message alone activates nothing", () => {
    expect(
      parseDeterministicPerfDirective(
        directiveMessage("[[perf:text-only:30:fixed]]")
      )
    ).toBeNull()
  })

  it("recognizes a directive after rich-composer serialization", () => {
    const text = readPromptInputDocument(createPromptInputDocument("[[perf:short-prose:100:fixed]]"))
    expect(parseDeterministicPerfDirective(directiveMessage(text))).toBeNull()
    process.env.CHAT_PERF_DETERMINISTIC_PROVIDER = "1"
    expect(parseDeterministicPerfDirective(directiveMessage(text))).toEqual({ scenario: "short-prose", chunksPerSecond: 100, shape: "fixed" })
  })

  it("parses only a well-formed directive on the TRAILING user message", () => {
    process.env.CHAT_PERF_DETERMINISTIC_PROVIDER = "1"
    expect(
      parseDeterministicPerfDirective(
        directiveMessage("[[perf:mixed-markdown:30:bursty]]")
      )
    ).toEqual({ scenario: "mixed-markdown", chunksPerSecond: 30, shape: "bursty" })
    // Directive in history must not hijack a later ordinary turn.
    expect(
      parseDeterministicPerfDirective([
        ...directiveMessage("[[perf:text-only:30:fixed]]"),
        { role: "assistant", parts: [{ type: "text", text: "done" }] },
        ...directiveMessage("an ordinary question"),
      ])
    ).toBeNull()
    for (const malformed of [
      "[[perf:unknown-scenario:30:fixed]]",
      "[[perf:text-only:0:fixed]]",
      "[[perf:text-only:30:sideways]]",
      "perf:text-only:30:fixed",
    ]) {
      expect(parseDeterministicPerfDirective(directiveMessage(malformed))).toBeNull()
    }
  })
})

describe("deterministic part script", () => {
  it("reproduces the scenario text byte-identically under every delivery shape", () => {
    for (const scenario of DETERMINISTIC_PERF_SCENARIOS) {
      const oracle = deterministicScenarioText(scenario)
      for (const shape of ["fixed", "bursty", "slab", "paused"] as const) {
        const script = buildDeterministicPartScript({
          scenario,
          chunksPerSecond: 100,
          shape,
        })
        const text = script
          .map(({ part }) => (part.type === "text-delta" ? part.delta : ""))
          .join("")
        const reasoning = script
          .map(({ part }) =>
            part.type === "reasoning-delta" ? part.delta : ""
          )
          .join("")
        expect(text).toBe(oracle.text)
        expect(reasoning).toBe(oracle.reasoning)
        const last = script.at(-1)?.part
        expect(last?.type).toBe(
          oracle.terminal === "error" ? "error" : "finish"
        )
      }
    }
  })

  it("is deterministic: identical directives yield identical scripts and delays", () => {
    const build = () =>
      buildDeterministicPartScript({
        scenario: "mixed-markdown",
        chunksPerSecond: 30,
        shape: "bursty",
      })
    const a = build()
    const b = build()
    expect(a.map(({ delayMs, part }) => [delayMs, part.type])).toEqual(
      b.map(({ delayMs, part }) => [delayMs, part.type])
    )
  })

  it("paused shape inserts exactly three segment gaps over the fixed cadence", () => {
    const build = (shape: "fixed" | "paused") =>
      buildDeterministicPartScript({
        scenario: "text-only",
        chunksPerSecond: 30,
        shape,
      })
    const totalDelay = (script: ReturnType<typeof build>) =>
      script.reduce((sum, { delayMs }) => sum + delayMs, 0)
    const fixed = build("fixed")
    const paused = build("paused")
    // Same parts in the same order — pauses are silence, not content.
    expect(paused.map(({ part }) => part.type)).toEqual(
      fixed.map(({ part }) => part.type)
    )
    // Four segments → three 20 s gaps on top of the fixed schedule.
    expect(totalDelay(paused) - totalDelay(fixed)).toBe(3 * 20_000)
    expect(
      paused.filter(({ delayMs }) => delayMs >= 20_000)
    ).toHaveLength(3)
  })

  it("keeps total scheduled time at the cadence the directive names", () => {
    const script = buildDeterministicPartScript({
      scenario: "text-only",
      chunksPerSecond: 100,
      shape: "fixed",
    })
    const textDeltas = script.filter(({ part }) => part.type === "text-delta")
    const totalDelay = script.reduce((sum, { delayMs }) => sum + delayMs, 0)
    // ~one delta per 10 ms; rounding keeps this within one interval.
    expect(Math.abs(totalDelay - textDeltas.length * 10)).toBeLessThanOrEqual(10)
  })
})
