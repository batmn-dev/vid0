import {
  buildCodePayload,
  buildCodeStressPayload,
  buildLongMarkdownPayload,
  buildManyShortBlocksPayload,
  buildMarkdownPayload,
  buildShortProsePayload,
} from "@/benchmarks/chat-performance/fixtures"
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider"
import { MockLanguageModelV4 } from "ai/test"

/**
 * Replays benchmark payloads as a deterministic provider stream through the
 * REAL turn pipeline — prepare, streamText, word-chunking/lifecycle
 * transforms, UI-message conversion, durable snapshots, rendering, and
 * persistence all run unchanged; only the model call is synthetic.
 *
 * Activation is server-environment-only: `CHAT_PERF_DETERMINISTIC_PROVIDER=1`
 * must be set on the process (a launch decision for a local/perf server).
 * The client-visible directive below chooses WHICH deterministic scenario
 * runs, but has no effect whatsoever unless the environment gate is on — a
 * production client cannot activate this through any header or message.
 *
 * Directive grammar, scanned from the trailing user message's text:
 *   [[perf:<scenario>:<chunksPerSecond>:<shape>]]
 * e.g. [[perf:mixed-markdown:30:fixed]]. Unknown/malformed directives are
 * ignored (the turn runs against the real provider), so a perf environment
 * remains usable for ordinary chats.
 *
 * Scenarios: text-only | mixed-markdown | code-block | partial-error |
 * stop-during-text (streams like text-only; the harness issues the Stop) |
 * short-prose | long-markdown | many-blocks | code-stress.
 * Shapes: fixed (even cadence) | bursty (10-chunk bursts at burst-period
 * gaps) | slab (~4 KB merged slabs at their accumulated cadence time) |
 * paused (fixed cadence split into segments separated by long zero-delta
 * gaps — the run stays live with NO content flowing, so the only durable
 * writes in a gap are run-doc bookkeeping like heartbeats: the event class
 * behind tool waits and approval pauses in real conversations).
 */

export const DETERMINISTIC_PERF_SCENARIOS = [
  "text-only",
  "mixed-markdown",
  "code-block",
  "partial-error",
  "stop-during-text",
  "short-prose",
  "long-markdown",
  "many-blocks",
  "code-stress",
] as const

export type DeterministicPerfScenario =
  (typeof DETERMINISTIC_PERF_SCENARIOS)[number]

export type DeterministicDeliveryShape = "fixed" | "bursty" | "slab" | "paused"

export type DeterministicPerfDirective = {
  scenario: DeterministicPerfScenario
  chunksPerSecond: number
  shape: DeterministicDeliveryShape
}

const DIRECTIVE_PATTERN =
  /\[\[perf:([a-z-]+):(\d{1,4}):(fixed|bursty|slab|paused)\]\]/

export function isDeterministicPerfProviderEnabled(): boolean {
  return process.env.CHAT_PERF_DETERMINISTIC_PROVIDER === "1"
}

type DirectiveSourceMessage = {
  role: string
  parts?: ReadonlyArray<{ type: string; text?: string }>
}

/**
 * Parses the directive from the TRAILING user message only (a directive in
 * history must not hijack a later ordinary turn). Returns null unless the
 * environment gate is on and the directive is well-formed.
 */
export function parseDeterministicPerfDirective(
  messages: ReadonlyArray<DirectiveSourceMessage>
): DeterministicPerfDirective | null {
  if (!isDeterministicPerfProviderEnabled()) return null
  const trailing = messages.at(-1)
  if (!trailing || trailing.role !== "user") return null
  const text = (trailing.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
  // The rich composer serializes literal brackets with Markdown escapes.
  const match = DIRECTIVE_PATTERN.exec(text.replace(/\\(\[|\])/g, "$1"))
  if (!match) return null
  const scenario = match[1] as DeterministicPerfScenario
  if (!DETERMINISTIC_PERF_SCENARIOS.includes(scenario)) return null
  const chunksPerSecond = Number(match[2])
  if (chunksPerSecond < 1 || chunksPerSecond > 1000) return null
  return {
    scenario,
    chunksPerSecond,
    shape: match[3] as DeterministicDeliveryShape,
  }
}

/** The scenario's full assistant text — the harness's correctness oracle. */
export function deterministicScenarioText(
  scenario: DeterministicPerfScenario
): { reasoning: string; text: string; terminal: "finish" | "error" } {
  switch (scenario) {
    case "text-only":
    case "stop-during-text":
      return { reasoning: "", text: buildMarkdownPayload(), terminal: "finish" }
    case "mixed-markdown":
      return {
        reasoning: "Considering structure before answering. ".repeat(6),
        text: buildMarkdownPayload(),
        terminal: "finish",
      }
    case "code-block":
      return {
        reasoning: "",
        text: `Here is the generated module:\n\n\`\`\`ts\n${buildCodePayload()}\n\`\`\`\n\nDone.\n`,
        terminal: "finish",
      }
    case "partial-error": {
      const markdown = buildMarkdownPayload()
      return {
        reasoning: "",
        text: markdown.slice(0, Math.floor(markdown.length / 3)),
        terminal: "error",
      }
    }
    case "short-prose":
      return { reasoning: "", text: buildShortProsePayload(), terminal: "finish" }
    case "long-markdown":
      return {
        reasoning: "",
        text: buildLongMarkdownPayload(),
        terminal: "finish",
      }
    case "many-blocks":
      return {
        reasoning: "",
        text: buildManyShortBlocksPayload(),
        terminal: "finish",
      }
    case "code-stress":
      return {
        reasoning: "",
        text: `\`\`\`ts\n${buildCodeStressPayload()}\n\`\`\`\n`,
        terminal: "finish",
      }
  }
}

const DELTA_SIZE = 40
const BURST_SIZE = 10
const SLAB_TARGET_BYTES = 4096
// Paused shape: the text streams as PAUSE_SEGMENTS fixed-cadence segments
// with a PAUSE_GAP_MS silent gap before each segment after the first. Gaps
// are provider silence, not cadence: the durable run stays live (heartbeats,
// lease renewal) while the snapshot tracker — content-versioned — writes
// nothing at all.
const PAUSE_SEGMENTS = 4
const PAUSE_GAP_MS = 20_000

const STEP_USAGE = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

type TimedPart = { delayMs: number; part: LanguageModelV4StreamPart }

function chunkString(payload: string, size: number): string[] {
  const chunks: string[] = []
  for (let offset = 0; offset < payload.length; offset += size) {
    chunks.push(payload.slice(offset, offset + size))
  }
  return chunks
}

/**
 * Builds the timed provider-part script for a directive. Deterministic by
 * construction: identical directives yield identical part sequences and
 * identical delay schedules (wall-clock jitter at delivery is the transport's
 * own, exactly as with a real provider).
 */
export function buildDeterministicPartScript(
  directive: DeterministicPerfDirective
): TimedPart[] {
  const { reasoning, text, terminal } = deterministicScenarioText(
    directive.scenario
  )
  const intervalMs = 1000 / directive.chunksPerSecond

  // Delivery shape: merge deltas (slab) or regroup delays (bursty) over the
  // fixed-cadence baseline.
  const textDeltas =
    directive.shape === "slab"
      ? chunkString(text, SLAB_TARGET_BYTES)
      : chunkString(text, DELTA_SIZE)
  const reasoningDeltas = chunkString(reasoning, DELTA_SIZE)

  // Baseline cadence indices count SOURCE deltas so a slab arrives when its
  // last constituent delta would have (a slab is late content, not early).
  const sourceDeltasPerText =
    directive.shape === "slab" ? SLAB_TARGET_BYTES / DELTA_SIZE : 1

  const parts: TimedPart[] = []
  let cadenceIndex = 0
  let emittedInBurst = 0
  const pushTimed = (
    part: LanguageModelV4StreamPart,
    sourceDeltas: number,
    extraDelayMs = 0
  ) => {
    const previousAt = Math.round(cadenceIndex * intervalMs)
    cadenceIndex += sourceDeltas
    let delayMs = Math.round(cadenceIndex * intervalMs) - previousAt
    if (directive.shape === "bursty") {
      emittedInBurst += 1
      if (emittedInBurst < BURST_SIZE) delayMs = 0
      else {
        delayMs = Math.round(BURST_SIZE * intervalMs)
        emittedInBurst = 0
      }
    }
    parts.push({ delayMs: delayMs + extraDelayMs, part })
  }

  parts.push({ delayMs: 0, part: { type: "stream-start", warnings: [] } })
  if (reasoningDeltas.length > 0) {
    parts.push({ delayMs: 0, part: { type: "reasoning-start", id: "r1" } })
    for (const delta of reasoningDeltas) {
      pushTimed({ type: "reasoning-delta", id: "r1", delta }, 1)
    }
    parts.push({ delayMs: 0, part: { type: "reasoning-end", id: "r1" } })
  }
  parts.push({ delayMs: 0, part: { type: "text-start", id: "t1" } })
  const pausedSegmentLength =
    directive.shape === "paused"
      ? Math.ceil(textDeltas.length / PAUSE_SEGMENTS)
      : 0
  for (const [index, delta] of textDeltas.entries()) {
    const startsPausedSegment =
      pausedSegmentLength > 0 && index > 0 && index % pausedSegmentLength === 0
    pushTimed(
      { type: "text-delta", id: "t1", delta },
      sourceDeltasPerText,
      startsPausedSegment ? PAUSE_GAP_MS : 0
    )
  }
  if (terminal === "error") {
    parts.push({
      delayMs: 0,
      part: { type: "error", error: new Error("provider_stream_interrupted") },
    })
    return parts
  }
  parts.push({ delayMs: 0, part: { type: "text-end", id: "t1" } })
  parts.push({
    delayMs: 0,
    part: {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: STEP_USAGE,
    },
  })
  return parts
}

function scriptedStream(
  script: TimedPart[]
): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream<LanguageModelV4StreamPart>({
    async start(controller) {
      try {
        for (const { delayMs, part } of script) {
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs))
          }
          controller.enqueue(part)
        }
        controller.close()
      } catch {
        // Consumer cancelled (Stop/disconnect) — nothing to clean up.
      }
    },
  })
}

/** The scripted chat model for one directive. */
export function createDeterministicChatModel(
  directive: DeterministicPerfDirective
) {
  return new MockLanguageModelV4({
    modelId: `chat-perf-deterministic/${directive.scenario}`,
    doStream: async () => ({
      stream: scriptedStream(buildDeterministicPartScript(directive)),
    }),
  })
}

/**
 * Instant fixed-output title model: keeps deterministic turns free of any
 * real provider call (and of title-latency noise) in perf environments.
 */
export function createDeterministicTitleModel() {
  return new MockLanguageModelV4({
    modelId: "chat-perf-deterministic/title",
    doStream: async () => ({
      stream: scriptedStream([
        { delayMs: 0, part: { type: "stream-start", warnings: [] } },
        { delayMs: 0, part: { type: "text-start", id: "t1" } },
        {
          delayMs: 0,
          part: { type: "text-delta", id: "t1", delta: "Perf scenario" },
        },
        { delayMs: 0, part: { type: "text-end", id: "t1" } },
        {
          delayMs: 0,
          part: {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: STEP_USAGE,
          },
        },
      ]),
    }),
  })
}
