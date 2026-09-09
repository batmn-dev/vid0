import { formatDuration, toCompletedDurationSeconds } from "../format-duration"
import {
  deriveAssistantActivityPresentation,
  type AssistantActivityTimelineEntry,
} from "./assistant-activity"
import type {
  AssistantTurnPhase,
  AssistantTurnRenderStatus,
  AssistantTurnView,
} from "./assistant-turn"
import { getMessageProvider } from "./metadata"

export type InlineWorkItem =
  | { kind: "commentary"; id: string; text: string; streaming: boolean }
  | {
      kind: "reasoning"
      id: string
      text: string
      streaming: boolean
      compactTitle?: string
    }
  | { kind: "status"; id: string; title: string }
  /** Opens the Activity panel for raw reasoning kept out of inline prose. */
  | { kind: "activity-link"; id: string; title: string }
  | Exclude<AssistantActivityTimelineEntry, { kind: "reasoning" }>

export type InlineWorkActiveTail = {
  item: Exclude<InlineWorkItem, { kind: "commentary" | "reasoning" }>
  contentKey: string
  isReasoningTitle: boolean
}

export type AssistantInlineWorkPresentation = {
  items: InlineWorkItem[]
  mode: "live" | "complete"
  label: string
  activeTail?: InlineWorkActiveTail
  hasWork: boolean
}

/** Omit the provider's leading summary-heading convention from inline prose. */
function inlineReasoningBody(text: string, streaming: boolean): string {
  const start = text.replace(/^(?:[ \t]*\r?\n)+/, "")
  const heading = start.match(
    /^(?:#{1,6}[ \t]+[^\n]+|\*\*[^*\n]+\*\*)[ \t]*(?:\r?\n|$)/
  )
  if (heading)
    return start.slice(heading[0].length).replace(/^(?:[ \t]*\r?\n)+/, "")
  // A split opening heading must not flash before its body arrives.
  if (
    streaming &&
    (start === "*" ||
      /^\*\*[^*\n]*\*?$/.test(start) ||
      /^#{1,6}(?:[ \t][^\n]*)?$/.test(start))
  )
    return ""
  return text
}

/** Join text and the existing normalized activity without reinterpreting tools. */
export function deriveAssistantInlineWork(
  view: AssistantTurnView,
  phase: AssistantTurnPhase,
  options?: {
    workDurationMs?: number
    reasoningDurationMs?: number
    status?: AssistantTurnRenderStatus
  }
): AssistantInlineWorkPresentation {
  const presentation = deriveAssistantActivityPresentation(view, phase, options)
  const activity =
    presentation.kind === "disclosure" ? presentation.activity : undefined
  const items: Exclude<InlineWorkItem, { kind: "status" }>[] = []
  const { commentary, hasFinalAnswer } = view.inlineContent
  let textIndex = 0
  let activityIndex = 0
  for (let offset = 0; offset <= view.evidence.timeline.length; offset++) {
    while (commentary[textIndex]?.activityOffset === offset) {
      const block = commentary[textIndex++]
      if (block.text.trim())
        items.push({
          kind: "commentary",
          id: block.id,
          text: block.text,
          streaming: block.isStreaming,
        })
    }
    const evidence = view.evidence.timeline[offset]
    if (!evidence) continue
    const entries: AssistantActivityTimelineEntry[] = []
    while (activity?.entries[activityIndex]) {
      const entry = activity.entries[activityIndex]
      const matches =
        evidence.kind === "reasoning"
          ? entry.id.startsWith(`reasoning-${evidence.partIndex}-`)
          : entry.id === evidence.id
      if (!matches) break
      entries.push(entry)
      activityIndex++
    }
    if (evidence.kind === "reasoning") {
      // OpenAI progress is commentary; raw summaries remain in Activity, so a
      // settled summary keeps one inline row that reaches the panel.
      if (getMessageProvider(view.metadata) === "openai") {
        if (entries.length > 0 && !evidence.isStreamingPart)
          items.push({
            kind: "activity-link",
            id: `reasoning-${evidence.partIndex}`,
            title: "Reasoning",
          })
      } else if (evidence.text.trim()) {
        // A standalone heading can replace the last search's live summary.
        // Its body streams independently of the provider's leading heading.
        const heading = evidence.text.trim().match(/^\*\*([^*\n]+)\*\*$/)?.[1]
        items.push({
          kind: "reasoning",
          id: `reasoning-${evidence.partIndex}`,
          text: inlineReasoningBody(evidence.text, evidence.isStreamingPart),
          streaming: evidence.isStreamingPart,
          compactTitle:
            commentary.length > 0 && items.at(-1)?.kind === "search"
              ? heading
              : undefined,
        })
      }
      continue
    }
    items.push(
      ...entries
        .filter((entry) => entry.kind !== "reasoning")
        .map((entry) => {
          if (
            entry.kind !== "search" ||
            (evidence.kind === "tool" &&
              evidence.webActivity?.kind !== "searched")
          )
            return entry
          const count = entry.sources.length
          return {
            ...entry,
            title:
              count > 0 &&
              (entry.status === "running" || entry.status === "complete")
                ? `${entry.status === "running" ? "Searching" : "Searched"} ${count} ${count === 1 ? "website" : "websites"}`
                : entry.status === "running" &&
                    evidence.kind === "tool" &&
                    evidence.webActivity?.kind === "searched" &&
                    !evidence.webActivity.query
                  ? "Searching the web"
                  : entry.title.replace(/^Searching for /, "Searching "),
          }
        })
    )
  }
  // Reasoning-only turns keep the existing panel trigger instead of a history.
  if (items.every((item) => item.kind === "activity-link")) items.length = 0
  const live =
    phase.kind !== "settled" &&
    (!hasFinalAnswer ||
      !view.inlineContent.answerText.trim() ||
      phase.kind === "awaiting-approval")
  const hasWork = items.length > 0 || view.reasoning.hasObservedActivity
  const reasoningOnly =
    commentary.length === 0 && items.every((item) => item.kind === "reasoning")
  const duration = toCompletedDurationSeconds(
    reasoningOnly
      ? (options?.reasoningDurationMs ?? view.reasoning.persistedDurationMs)
      : (view.persistedWorkSummaryDurationMs ??
          options?.workDurationMs ??
          (!hasFinalAnswer ? view.persistedWorkDurationMs : undefined))
  )
  const verb = reasoningOnly ? "Thought" : "Worked"
  const label =
    duration !== undefined && duration > 0
      ? `${verb} for ${formatDuration(duration)}`
      : verb
  const last = items.at(-1)
  const displayItems: InlineWorkItem[] = [...items]
  let activeTail: InlineWorkActiveTail | undefined
  if (live) {
    // The active row keeps one identity while completed work joins history.
    const activeIndex = displayItems.findLastIndex(
      (item) =>
        item.kind !== "commentary" &&
        item.kind !== "reasoning" &&
        item.kind !== "status" &&
        item.kind !== "activity-link" &&
        (item.status === "running" || item.status === "approval")
    )
    const active = displayItems[activeIndex]
    if (active && active.kind !== "commentary" && active.kind !== "reasoning") {
      displayItems.splice(activeIndex, 1)
      activeTail = {
        item: active,
        contentKey: `${active.id}:${active.kind === "search" ? active.status : active.title}`,
        isReasoningTitle: false,
      }
    } else if (last?.kind === "reasoning" && last.compactTitle) {
      // This supplied heading occupies the active slot only while it is last.
      // Later work restores the completed search without a standalone heading.
      displayItems.pop()
      const previous = displayItems.at(-1)
      if (previous?.kind === "search" && previous.status === "complete") {
        displayItems.pop()
      }
      activeTail = {
        item: { kind: "status", id: last.id, title: last.compactTitle },
        contentKey: "reasoning-title",
        isReasoningTitle: true,
      }
    } else {
      const title =
        !(hasFinalAnswer && !view.inlineContent.answerText.trim()) &&
        phase.kind !== "thinking" &&
        (presentation.kind === "disclosure" ||
          presentation.kind === "live-status")
          ? presentation.label
          : "Thinking"
      activeTail = {
        item: { kind: "status", id: "thinking", title },
        contentKey: `thinking:${title}`,
        isReasoningTitle: false,
      }
    }
  }
  return {
    items: displayItems.filter(
      (item) => item.kind !== "reasoning" || item.text.trim().length > 0
    ),
    mode: live ? "live" : "complete",
    label,
    activeTail,
    hasWork,
  }
}
