/**
 * Assistant turn view — the single pure derivation of everything renderers
 * need from one assistant message. See CONTEXT.md "Assistant turn view".
 *
 * Before this module, "is this message thinking?", "which sources?", and
 * "which tool parts?" were re-derived from raw `parts`/`metadata` at three
 * sites (the message row, the activity trigger, and the activity panel), two
 * of which bypassed the Message metadata module. The trigger and the panel
 * could disagree on screen because they read the same facts through different
 * paths.
 *
 * Invariants:
 *  - Pure and derived PER RENDER. The AI SDK mutates part objects in place
 *    during streaming without changing array/object references, so this
 *    derivation must never be memoized by `parts` or message reference.
 *  - ONE evidence walk per view. `view.evidence` is the Turn evidence produced
 *    by that walk; the phase ladder and the activity presentation read it and
 *    never re-derive from `orderedParts`, so a live row costs one O(parts)
 *    pass per render, not one per consumer.
 *  - All metadata reads go through the Message metadata module's readers
 *    (ADR-0002) — never `metadata as Record<string, unknown>`.
 *  - `assistantTurnViewsEqual` snapshots all inline facts, including source,
 *    reasoning and provider phase deltas. Canonical text remains available to
 *    copy/share and provider history while inlineContent separates commentary.
 */
import type { UIMessage } from "ai"
import type { DurableMessageStatus } from "./durable-contract"
import {
  getReasoningDurationMs,
  getServerMessageId,
  getWorkDurationMs,
  getWorkSummaryDurationMs,
} from "./metadata"
import { extractTextFromMessageParts, getToolRenderSignature } from "./parts"
import type { AssistantSourceResult } from "./sources"
import {
  deriveTurnEvidence,
  isToolEvidencePart,
  type TextEvidence,
  type ToolCallEvidence,
  type ToolEvidenceUIPart,
  type TurnEvidence,
} from "./turn-evidence"
import type { SearchImageResult } from "./turn-evidence"

export type { SearchImageResult } from "./turn-evidence"

export type AssistantInlineContent = {
  answerText: string
  hasFinalAnswer: boolean
  commentary: ReadonlyArray<TextEvidence>
}

/**
 * Raw tool input is already covered by toolRenderSignature, so it is dropped
 * before serializing. A shallow map keeps JSON.stringify on its native fast
 * path; a replacer callback costs a call per property on every render.
 */
function inlineRenderSignatureFor(evidence: TurnEvidence): string {
  return JSON.stringify({
    ...evidence,
    timeline: evidence.timeline.map((item) =>
      item.kind === "tool" ? { ...item, input: undefined } : item
    ),
  })
}

function deriveInlineContent(evidence: TurnEvidence): AssistantInlineContent {
  const commentary: TextEvidence[] = []
  let answerText = ""
  let hasFinalAnswer = false
  const lastToolOffset = evidence.timeline.findLastIndex(
    (item) => item.kind === "tool"
  )
  for (const block of evidence.textBlocks) {
    // A later tool is concrete evidence of an intermediate unphased response.
    // Uncertain text remains answer content; explicit provider phase always wins.
    const isCommentary =
      block.phase === "commentary" ||
      (block.phase === undefined && block.activityOffset <= lastToolOffset)
    if (isCommentary) commentary.push(block)
    else {
      answerText += block.text
      hasFinalAnswer ||=
        block.phase === "final_answer" || block.text.trim().length > 0
    }
  }
  return { answerText, hasFinalAnswer, commentary }
}

type ChatStatus = "streaming" | "ready" | "submitted" | "error"

export type ReasoningView = {
  phase: "idle" | "thinking" | "complete"
  /** Concatenated reasoning text across reasoning parts. */
  text: string
  /** Ordered reasoning blocks whose original text contains visible content. */
  displayableBlocks: ReadonlyArray<{ text: string }>
  /** Any reasoning part or durable duration was observed, visible or opaque. */
  hasObservedActivity: boolean
  /**
   * True only while a reasoning part is LITERALLY streaming (raw part state)
   * — deliberately not derived from `phase`. `phase` may infer "thinking"
   * from chat status for state-less stored parts, which is right for the
   * panel's completion inference but must not make a HISTORICAL row's trigger
   * shimmer "Thinking" whenever some other turn streams.
   */
  isStreaming: boolean
  /** Reasoning happened but produced no visible text (opaque providers). */
  isOpaque: boolean
  /** Server-persisted duration, read via the metadata module. */
  persistedDurationMs: number | undefined
}

export const IDLE_REASONING_VIEW: ReasoningView = {
  phase: "idle",
  text: "",
  displayableBlocks: [],
  hasObservedActivity: false,
  isStreaming: false,
  isOpaque: false,
  persistedDurationMs: undefined,
}

export type AssistantTurnView = {
  /**
   * Original message-part order, retained as the normalized chronology seam.
   * Activity presentation derives from this array once; renderers must not
   * rebuild ordering from the type-specific projections below.
   */
  orderedParts: UIMessage["parts"]
  /**
   * The Turn evidence timeline from this view's single parts walk. Phase and
   * activity derive from it; components never read it (raw facts stay behind
   * presentation — see CONTEXT.md "Turn evidence").
   */
  evidence: TurnEvidence
  inlineContent: AssistantInlineContent
  /** Immutable snapshot of the inline facts, including in-place SDK updates. */
  inlineRenderSignature: string
  /** Ordered text content across all text parts. */
  text: string
  /**
   * Static and dynamic tool evidence parts, for phase detection and
   * non-timeline result rendering.
   */
  toolParts: ToolEvidenceUIPart[]
  /** Immutable snapshot of rendered tool input/output for memo comparison. */
  toolRenderSignature: string
  /** Normalized sources across source-url parts and tool outputs. */
  sources: AssistantSourceResult[]
  /** Image-search results extracted from tool outputs. */
  searchImageResults: SearchImageResult[]
  reasoning: ReasoningView
  /** Server-persisted provider-stream lifecycle duration. */
  persistedWorkDurationMs: number | undefined
  persistedWorkSummaryDurationMs?: number
  /** Durable identity, read via the metadata module. */
  serverMessageId: string | undefined
  /**
   * The message's metadata reference. The metadata writers preserve reference
   * identity on no-op (ADR-0002), so identity comparison of this field is a
   * meaningful change signal (durable status, persisted duration, tool display
   * metadata all arrive as a new metadata object).
   */
  metadata: unknown
}

type MessageLike = { parts?: UIMessage["parts"]; metadata?: unknown }

/** The live timer stays in use-reasoning-phase; this view remains pure. */
export function deriveReasoningView(
  parts: UIMessage["parts"] | undefined,
  status: ChatStatus,
  metadata?: unknown
): ReasoningView {
  const reasoningParts = parts?.filter((p) => p.type === "reasoning") ?? []
  const persistedDurationMs = getReasoningDurationMs(metadata)

  // A persisted duration is durable evidence that reasoning happened even
  // when the stored parts carry no reasoning part (the persist layer drops
  // empty opaque reasoning). Without this, a turn that read "Thought for Ns"
  // while settling would lose its trigger the moment the durable snapshot is
  // adopted — the same turn rendering two different settled states.
  if (reasoningParts.length === 0 && persistedDurationMs !== undefined) {
    return {
      phase: "complete",
      text: "",
      displayableBlocks: [],
      hasObservedActivity: true,
      isStreaming: false,
      isOpaque: true,
      persistedDurationMs,
    }
  }

  let phase: ReasoningView["phase"] = "idle"
  let text = ""

  // A raw "streaming" part state only means "thinking" while the chat status
  // itself is live. An abort/stop/error freezes part states in place without a
  // terminal transition, so a stuck "streaming" part on a settled turn must
  // read as complete — otherwise the trigger shimmers and the panel timer
  // ticks forever after Stop.
  const isLiveStatus = status === "streaming" || status === "submitted"
  const isAnyStreaming =
    isLiveStatus &&
    reasoningParts.some((p) => (p as { state?: string }).state === "streaming")

  if (reasoningParts.length > 0) {
    const joined = reasoningParts.map((p) => p.text).join("\n\n")

    if (isAnyStreaming) {
      phase = "thinking"
      text = joined
    } else {
      const isAnyDone = reasoningParts.some(
        (p) => (p as { state?: string }).state === "done"
      )

      if (isAnyDone || status === "ready" || status === "error") {
        phase = "complete"
        text = joined
      } else if (joined.trim()) {
        phase = "complete"
        text = joined
      } else {
        phase = "thinking"
        text = ""
      }
    }
  }

  return {
    phase,
    text,
    displayableBlocks: reasoningParts
      .filter((part) => part.text.trim().length > 0)
      .map((part) => ({ text: part.text })),
    hasObservedActivity:
      reasoningParts.length > 0 || persistedDurationMs !== undefined,
    isStreaming: isAnyStreaming,
    isOpaque: phase !== "idle" && !text.trim(),
    persistedDurationMs,
  }
}

export function deriveAssistantTurnView(
  message: MessageLike,
  status: ChatStatus
): AssistantTurnView {
  const parts = message.parts
  const toolParts =
    parts?.filter((part): part is ToolEvidenceUIPart =>
      isToolEvidencePart(part)
    ) ?? []
  const evidence = deriveTurnEvidence(parts)

  return {
    orderedParts: parts ?? [],
    evidence,
    inlineContent: deriveInlineContent(evidence),
    inlineRenderSignature: inlineRenderSignatureFor(evidence),
    text: extractTextFromMessageParts(parts),
    toolParts,
    toolRenderSignature: getToolRenderSignature(parts),
    sources: [...evidence.sources],
    searchImageResults: [...evidence.searchImageResults],
    reasoning: deriveReasoningView(parts, status, message.metadata),
    persistedWorkDurationMs: getWorkDurationMs(message.metadata),
    persistedWorkSummaryDurationMs: getWorkSummaryDurationMs(message.metadata),
    serverMessageId: getServerMessageId(message.metadata),
    metadata: message.metadata,
  }
}

/**
 * True when any of the turn's visible thread content survived: text, tool
 * cards, or image results. The aborted/failed banners' "Partial response
 * preserved." claim must hold only when this is true — reasoning alone is
 * work history rather than response content, so a stop that
 * lands mid-thinking reads as a bare "Generation stopped."
 */
export function hasPreservedResponseContent(view: AssistantTurnView): boolean {
  return (
    view.text.length > 0 ||
    view.toolParts.length > 0 ||
    view.searchImageResults.length > 0
  )
}

/**
 * True once the turn has anything a row can render — text, tool cards,
 * sources, image results, or observed reasoning activity. Until then the
 * pending placeholder row owns the slot (see `resolveActiveAssistantTurn`).
 */
export function hasRenderableEvidence(view: AssistantTurnView): boolean {
  return (
    view.text.trim().length > 0 ||
    view.toolParts.length > 0 ||
    view.sources.length > 0 ||
    view.searchImageResults.length > 0 ||
    view.reasoning.hasObservedActivity
  )
}

/** Fresh immutable signatures catch in-place SDK mutations in inline work. */
export function assistantTurnViewsEqual(
  a: AssistantTurnView | undefined,
  b: AssistantTurnView | undefined
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.toolRenderSignature === b.toolRenderSignature &&
    a.inlineRenderSignature === b.inlineRenderSignature &&
    a.reasoning.phase === b.reasoning.phase &&
    a.metadata === b.metadata &&
    a.serverMessageId === b.serverMessageId
  )
}

/**
 * The canonical Assistant turn phase — the single answer to "what is this
 * turn doing right now?", derived once per row render. Every loading/progress
 * affordance on the row (activity trigger, loaders, tool chips, panel timer)
 * is a PRESENTATION of this value; none re-derives its own gate from raw
 * parts/status, so only one indicator can be active.
 *
 * Discriminated union, not booleans: the kinds are mutually exclusive by
 * construction (a first-match ladder), so a new capability adds a kind or a
 * presentation — it cannot add a second simultaneous indicator.
 */
export type AssistantTurnPhase =
  | { kind: "submitted" }
  | { kind: "thinking"; visibility: "visible" | "opaque" }
  | { kind: "generating-image" }
  | { kind: "tooling"; toolNames: string[] }
  | { kind: "awaiting-approval" }
  | { kind: "responding" }
  | { kind: "settled" }

/**
 * The row render status the phase ladder consumes: the client stream status
 * for the turn this client owns, plus the durable settled/paused sub-states
 * adopted from the server (aborted/failed/awaiting_approval). Durable LIVE
 * statuses (submitted/streaming) are deliberately not trusted here — after a
 * Stop or a dropped stream the server-side run can lag its terminal
 * transition by up to a minute, and the row must settle on the client's
 * verdict immediately.
 */
export type AssistantTurnRenderStatus = ChatStatus | DurableMessageStatus

/**
 * Derive the canonical turn phase. A first-match ladder over one liveness
 * fact: only the last turn, while THIS client's stream is submitted/streaming,
 * is ever in a live phase. Everything else — historical rows, stopped or
 * errored streams, turns another session may still be running — is settled,
 * so raw in-progress part states frozen by an abort can never keep a live
 * indicator on screen.
 */
export function deriveAssistantTurnPhase(
  view: AssistantTurnView,
  {
    status,
    isLast,
  }: {
    status: AssistantTurnRenderStatus
    isLast: boolean
  }
): AssistantTurnPhase {
  // A durable approval pause is authoritative wherever it appears.
  if (status === "awaiting_approval") return { kind: "awaiting-approval" }

  const isLive = isLast && (status === "submitted" || status === "streaming")
  if (!isLive) return { kind: "settled" }

  if (status === "submitted") return { kind: "submitted" }

  // Reads the view's evidence (one walk per view, never re-derived here).
  // Approval exclusions live in the lifecycle algebra: awaiting-approval is a
  // pause and denied will never run, so neither is in flight; an approved
  // response is — the tool is about to execute.
  const toolCalls = view.evidence.timeline.filter(
    (item): item is ToolCallEvidence => item.kind === "tool"
  )
  if (toolCalls.some((call) => call.lifecycle.kind === "awaiting-approval")) {
    return { kind: "awaiting-approval" }
  }

  const inFlightCalls = toolCalls.filter(
    (call) => call.lifecycle.kind === "in-flight"
  )
  if (
    inFlightCalls.some((call) => call.classification === "image-generation")
  ) {
    return { kind: "generating-image" }
  }
  if (inFlightCalls.length > 0) {
    return {
      kind: "tooling",
      toolNames: Array.from(
        new Set(inFlightCalls.map((call) => call.toolName))
      ),
    }
  }

  if (view.inlineContent.hasFinalAnswer) return { kind: "responding" }

  if (view.reasoning.phase === "thinking") {
    return {
      kind: "thinking",
      visibility: view.reasoning.isOpaque ? "opaque" : "visible",
    }
  }

  // A completed tool or summary can precede more work in the same stream.
  // Only answer evidence above establishes the responding boundary.
  return { kind: "thinking", visibility: "opaque" }
}
