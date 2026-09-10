/**
 * Turn evidence — the single interpreter of raw AI SDK message-part knowledge
 * for the presentation fold (see CONTEXT.md "Turn evidence"). Everything the
 * Assistant turn phase ladder and the Assistant activity presentation need to
 * know about raw parts crosses this seam exactly once: tool lifecycle state
 * semantics, tool classification, search-query recovery, and source
 * provenance/attribution. Renderers and derivations never spell a raw
 * `part.state` string or a tool-name set again.
 *
 * Invariants:
 *  - Pure and derived per call in O(parts). The AI SDK mutates part objects in
 *    place during streaming, so nothing here may be memoized by parts
 *    reference.
 *  - Liveness-free facts. No input to `deriveTurnEvidence` encodes chat
 *    status, `isLast`, or durable status; the phase ladder computes liveness
 *    FROM these facts. `resolveEntryStatus` is the one place a liveness
 *    verdict meets lifecycle semantics — consumers supply the settled bit,
 *    never the mapping.
 *  - Stable identity: exactly one timeline item per toolCallId, positioned at
 *    first appearance. Repeated parts for the same call update facts in place
 *    (last part wins) and accumulate sources — a streaming update can enrich
 *    a row but never move or duplicate it.
 */
import type { DynamicToolUIPart, ToolUIPart, UIMessage } from "ai"
import { getToolName, isToolUIPart } from "ai"
import {
  dedupeSources,
  getPartSources,
  getSources,
  type AssistantSourceResult,
} from "./sources"

/**
 * One tool-call part in either SDK shape. Static tools (`tool-${name}` types,
 * known at development time) and dynamic tools (`dynamic-tool` — every MCP
 * tool) share the same state machine; only the name's location differs. The
 * evidence walk MUST accept both: MCP calls stream/persist as `dynamic-tool`,
 * and dropping them severs the approval-controls path (the Activity panel is
 * the only surface carrying Approve/Deny).
 */
export type ToolEvidenceUIPart = ToolUIPart | DynamicToolUIPart

/** Both tool-part shapes; the seam consumers use instead of the static guard. */
export function isToolEvidencePart(
  part: UIMessage["parts"][number]
): part is ToolEvidenceUIPart {
  return isToolUIPart(part)
}

/** Tool name across both shapes (`toolName` field vs `tool-${name}` type). */
export function getToolEvidenceName(part: ToolEvidenceUIPart): string {
  return getToolName(part)
}

export type SearchImageResult = {
  title: string
  imageUrl: string
  sourceUrl: string
}

/** The single declaration of tool-name classification. */
export type ToolClassification =
  "search" | "image-generation" | "image-search" | "generic"

const TOOL_CLASSIFICATIONS: Record<string, ToolClassification> = {
  web_search: "search",
  google_search: "search",
  imageGeneration: "image-generation",
  image_generation: "image-generation",
  imageSearch: "image-search",
}

export function classifyToolName(toolName: string): ToolClassification {
  return TOOL_CLASSIFICATIONS[toolName] ?? "generic"
}

/**
 * Liveness-free lifecycle of one tool call. Precedence (first match) is the
 * error-before-approval order the Activity presentation established:
 * `output-available` with `output.isError === true` reads as errored even
 * though the transport-level call succeeded. An approved approval response is
 * in flight — the tool is about to execute. `reason`/`message` carry only
 * provider-supplied text; fallback copy is presentation, not evidence.
 */
export type ToolLifecycle =
  | {
      kind: "in-flight"
      via: "input-streaming" | "input-available" | "approval-approved"
    }
  | { kind: "awaiting-approval"; approvalId: string }
  | {
      kind: "denied"
      via: "output-denied" | "approval-responded"
      reason: string | undefined
    }
  | {
      kind: "errored"
      via: "output-error" | "output-reported"
      message: string | undefined
    }
  | { kind: "succeeded" }

function isErrorOutput(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    "isError" in output &&
    (output as { isError?: unknown }).isError === true
  )
}

function getToolLifecycle(part: ToolEvidenceUIPart): ToolLifecycle {
  if (part.state === "output-error") {
    return {
      kind: "errored",
      via: "output-error",
      message: part.errorText || undefined,
    }
  }
  if (part.state === "output-available" && isErrorOutput(part.output)) {
    return { kind: "errored", via: "output-reported", message: undefined }
  }
  if (part.state === "approval-requested") {
    return { kind: "awaiting-approval", approvalId: part.approval.id }
  }
  if (part.state === "output-denied") {
    return {
      kind: "denied",
      via: "output-denied",
      reason: part.approval.reason,
    }
  }
  if (part.state === "approval-responded") {
    return part.approval.approved
      ? { kind: "in-flight", via: "approval-approved" }
      : { kind: "denied", via: "approval-responded", reason: undefined }
  }
  if (part.state === "output-available") return { kind: "succeeded" }
  if (part.state === "input-streaming") {
    return { kind: "in-flight", via: "input-streaming" }
  }
  // input-available, plus any future SDK state: work is (or may be) pending.
  return { kind: "in-flight", via: "input-available" }
}

export type ReasoningEvidence = {
  kind: "reasoning"
  /** Original part-array index — the stable id seed for presentation rows. */
  partIndex: number
  text: string
  /**
   * The literal raw part state — a fact, not a status. A part frozen in
   * "streaming" by an abort keeps this true; `resolveEntryStatus` gates it
   * with the caller's settled verdict.
   */
  isStreamingPart: boolean
}

export type ToolCallEvidence = {
  kind: "tool"
  /** `tool-${toolCallId}` — the presentation row id, stable across updates. */
  id: string
  toolCallId: string
  toolName: string
  classification: ToolClassification
  lifecycle: ToolLifecycle
  /** Raw input passthrough for presentation copy; never interpreted here. */
  input: unknown
  /** Present exactly for search-classified calls: what the call actually did. */
  webActivity: WebActivityAction | undefined
  /**
   * Sources this call owns: its own tool-output sources plus standalone
   * source-url parts attributed to it. Search classification only; deduped
   * per call, never across calls — the same URL may legitimately belong to
   * two searches.
   */
  sources: readonly AssistantSourceResult[]
}

/** Standalone sources with no producer id and no preceding search to join. */
export type ImpliedSearchEvidence = {
  kind: "implied-search"
  /** `search-sources-${partIndex}` of the source-url part that opened it. */
  id: string
  sources: readonly AssistantSourceResult[]
}

export type TurnEvidenceItem =
  ReasoningEvidence | ToolCallEvidence | ImpliedSearchEvidence

/**
 * Explicit provider text phase (ADR-0041, C1). Only the OpenAI Responses
 * adapter labels text parts today (`providerMetadata.openai.phase`); every
 * other provider's text is unphased and falls to the C3 tool-order rule.
 * This is the ONE reader — the client projection, the server work-summary
 * tracker, and the replay prefix guard all call it; nothing else spells a
 * provider namespace.
 */
export type TextPhase = "commentary" | "final_answer"

export function readTextPhase(part: {
  type: string
  providerMetadata?: Record<string, Record<string, unknown> | undefined>
}): TextPhase | undefined {
  const phase = part.providerMetadata?.openai?.phase
  return phase === "commentary" || phase === "final_answer" ? phase : undefined
}

/**
 * Reasoning-part visibility (ADR-0041, C2). `opaque` covers Anthropic
 * omitted/redacted blocks (signature only), OpenRouter encrypted details, and
 * OpenAI items whose summary was empty. Opaque parts still count as observed
 * activity (timer, "Thinking") but never produce a Reasoning section or
 * inline narrative.
 */
export type ReasoningVisibility = "visible" | "opaque"

export function readReasoningVisibility(part: {
  text: string
}): ReasoningVisibility {
  return part.text.trim().length > 0 ? "visible" : "opaque"
}

export type TextEvidence = {
  id: string
  text: string
  phase: TextPhase | undefined
  isStreaming: boolean
  /** Number of activity items preceding this text in canonical part order. */
  activityOffset: number
}

export type TurnEvidence = {
  textBlocks: readonly TextEvidence[]
  /** Chronological, ordered by first appearance in part order. */
  timeline: readonly TurnEvidenceItem[]
  /** Turn-level deduped sources — identical to `getSources(parts)`. */
  sources: readonly AssistantSourceResult[]
  /** Aggregated image-search results across image-search tool outputs. */
  searchImageResults: readonly SearchImageResult[]
}

export type ResolvedEntryStatus =
  "running" | "complete" | "approval" | "error" | "denied" | "stopped"

/**
 * The one place liveness meets lifecycle: part states freeze in place on
 * stop/abort/error, so an in-flight lifecycle on a settled turn reads
 * "stopped" and a frozen streaming reasoning part reads "complete".
 * Errored/denied/succeeded are settled-invariant. Awaiting approval is still
 * actionable work, so a frozen approval request on a settled turn reads
 * "stopped" instead of exposing a stale action.
 *
 * The overloads narrow per item kind so consumers inherit each variant's
 * legal status subset from this algebra instead of casting.
 */
export function resolveEntryStatus(
  item: ReasoningEvidence | ImpliedSearchEvidence,
  settled: boolean
): "running" | "complete"
export function resolveEntryStatus(
  item: ToolCallEvidence,
  settled: boolean
): ResolvedEntryStatus
export function resolveEntryStatus(
  item: TurnEvidenceItem,
  settled: boolean
): ResolvedEntryStatus
export function resolveEntryStatus(
  item: TurnEvidenceItem,
  settled: boolean
): ResolvedEntryStatus {
  switch (item.kind) {
    case "reasoning":
      return item.isStreamingPart && !settled ? "running" : "complete"
    case "implied-search":
      return settled ? "complete" : "running"
    case "tool":
      switch (item.lifecycle.kind) {
        case "errored":
          return "error"
        case "awaiting-approval":
          return settled ? "stopped" : "approval"
        case "denied":
          return "denied"
        case "succeeded":
          return "complete"
        case "in-flight":
          return settled ? "stopped" : "running"
      }
  }
}

function trimmedQuery(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("query" in value)) {
    return undefined
  }
  const query = (value as { query?: unknown }).query
  return typeof query === "string" && query.trim() ? query.trim() : undefined
}

function recoverSearchQuery(part: ToolEvidenceUIPart): string | undefined {
  const input = "input" in part ? trimmedQuery(part.input) : undefined
  if (input) return input
  if (part.state !== "output-available") return undefined
  const output = part.output
  if (typeof output !== "object" || output === null) return undefined
  return trimmedQuery((output as { action?: unknown }).action)
}

/**
 * What one web-activity call actually did. Providers (observed: OpenAI native
 * web search) emit one tool call per action, discriminated by
 * `output.action.type` — a "search" call may really be a page read. A call
 * with no action data (streaming, or providers without an action shape)
 * defaults to `searched` with plain query recovery, preserving the pre-action
 * behavior byte-for-byte. Unrecognized action types degrade to `unknown`
 * rather than impersonating a search.
 */
export type WebActivityAction =
  | {
      kind: "searched"
      query: string | undefined
      queries: readonly string[] | undefined
    }
  | { kind: "opened-page"; url: string }
  | { kind: "found-in-page"; url: string; pattern: string | undefined }
  | { kind: "unknown" }

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim() !== ""
  )
  return strings.length > 0 ? strings : undefined
}

function interpretWebActivity(part: ToolEvidenceUIPart): WebActivityAction {
  const output = part.state === "output-available" ? part.output : undefined
  const action =
    typeof output === "object" && output !== null && !Array.isArray(output)
      ? (output as { action?: unknown }).action
      : undefined
  if (typeof action !== "object" || action === null) {
    return {
      kind: "searched",
      query: recoverSearchQuery(part),
      queries: undefined,
    }
  }
  const record = action as Record<string, unknown>
  const url = nonEmptyString(record.url)
  // Tolerate provider spelling drift: the wire has shown camelCase; the
  // OpenAI API documents snake_case. An action with NO type at all is a
  // search when a query is recoverable (the pre-action provider shapes);
  // `unknown` is reserved for a present-but-unrecognized type.
  switch (record.type) {
    case "search":
    case undefined:
      return {
        kind: "searched",
        query: recoverSearchQuery(part),
        queries: stringArray(record.queries),
      }
    case "openPage":
    case "open_page":
      return url ? { kind: "opened-page", url } : { kind: "unknown" }
    case "findInPage":
    case "find_in_page":
      return url
        ? {
            kind: "found-in-page",
            url,
            pattern: nonEmptyString(record.pattern),
          }
        : { kind: "unknown" }
    default:
      return { kind: "unknown" }
  }
}

function collectSearchImageResults(
  part: ToolEvidenceUIPart,
  into: SearchImageResult[]
): void {
  if (part.state !== "output-available") return
  const output = part.output as {
    content?: Array<{ type: string; results?: SearchImageResult[] }>
  }
  if (output?.content?.[0]?.type !== "images") return
  into.push(...(output.content[0].results ?? []))
}

/**
 * The single chronological walk. Provenance rules, verbatim from the
 * Activity presentation this module deepens:
 *  1. A search call owns the sources found in its own tool output.
 *  2. A standalone source-url part attaches by explicit producer id first —
 *     including sources that arrive before their producing call appears
 *     (buffered internally, attached at the call's timeline position).
 *     Explicit attribution targets search calls only; an id whose search
 *     never appears stays out of the timeline but in turn-level `sources`.
 *  3. Otherwise it attaches to the nearest preceding search in part order —
 *     never backward across a newer search.
 *  4. Otherwise it opens the implied-search item, which absorbs later
 *     orphans until a real search appears.
 *  5. Dedupe is per-item and turn-level only, keeping the earliest URL and
 *     enriching missing metadata — never global before association.
 */
export function deriveTurnEvidence(
  parts: UIMessage["parts"] | undefined
): TurnEvidence {
  const timeline: TurnEvidenceItem[] = []
  const textBlocks: TextEvidence[] = []
  const toolItemIndexes = new Map<string, number>()
  const searchItemIndexes = new Map<string, number>()
  const pendingSources = new Map<string, AssistantSourceResult[]>()
  const searchImageResults: SearchImageResult[] = []
  let latestSearchIndex: number | undefined

  const mergeItemSources = (
    itemIndex: number,
    sources: readonly AssistantSourceResult[]
  ) => {
    if (sources.length === 0) return
    const item = timeline[itemIndex] as ToolCallEvidence | ImpliedSearchEvidence
    item.sources = dedupeSources([...item.sources, ...sources])
  }

  ;(parts ?? []).forEach((part, partIndex) => {
    if (part.type === "text") {
      textBlocks.push({
        id: `text-${partIndex}`,
        text: part.text,
        phase: readTextPhase(part),
        isStreaming: part.state === "streaming",
        activityOffset: timeline.length,
      })
      return
    }
    if (part.type === "reasoning") {
      timeline.push({
        kind: "reasoning",
        partIndex,
        text: part.text,
        isStreamingPart: (part as { state?: string }).state === "streaming",
      })
      return
    }

    if (part.type === "source-url") {
      const [source] = getPartSources(part)
      if (!source) return
      const explicitIndex = source.toolCallId
        ? searchItemIndexes.get(source.toolCallId)
        : undefined
      if (explicitIndex !== undefined) {
        mergeItemSources(explicitIndex, [source])
      } else if (source.toolCallId) {
        pendingSources.set(source.toolCallId, [
          ...(pendingSources.get(source.toolCallId) ?? []),
          source,
        ])
      } else if (latestSearchIndex === undefined) {
        latestSearchIndex = timeline.length
        timeline.push({
          kind: "implied-search",
          id: `search-sources-${partIndex}`,
          sources: [source],
        })
      } else {
        mergeItemSources(latestSearchIndex, [source])
      }
      return
    }

    if (!isToolEvidencePart(part)) return
    const toolName = getToolEvidenceName(part)
    const classification = classifyToolName(toolName)
    if (classification === "image-search") {
      collectSearchImageResults(part, searchImageResults)
    }
    const item: ToolCallEvidence = {
      kind: "tool",
      id: `tool-${part.toolCallId}`,
      toolCallId: part.toolCallId,
      toolName,
      classification,
      lifecycle: getToolLifecycle(part),
      input: "input" in part ? part.input : undefined,
      webActivity:
        classification === "search" ? interpretWebActivity(part) : undefined,
      sources: classification === "search" ? getPartSources(part) : [],
    }
    const existingIndex = toolItemIndexes.get(part.toolCallId)
    const itemIndex = existingIndex ?? timeline.length
    if (existingIndex === undefined) {
      toolItemIndexes.set(part.toolCallId, itemIndex)
      timeline.push(item)
    } else {
      item.sources = dedupeSources([
        ...(timeline[existingIndex] as ToolCallEvidence).sources,
        ...item.sources,
      ])
      timeline[existingIndex] = item
    }
    if (classification === "search") {
      // Explicit producer ids attach wherever they point — provider-declared
      // provenance beats category, so a citation tied to a page read belongs
      // on it. The nearest-preceding FALLBACK below narrows to searched
      // actions only: heuristic attribution must never guess that a browse
      // produced a citation.
      searchItemIndexes.set(part.toolCallId, itemIndex)
      mergeItemSources(itemIndex, pendingSources.get(part.toolCallId) ?? [])
      pendingSources.delete(part.toolCallId)
      if (item.webActivity?.kind === "searched") {
        latestSearchIndex = itemIndex
      }
    }
  })

  return {
    textBlocks,
    timeline,
    sources: getSources(parts ?? []),
    searchImageResults,
  }
}
