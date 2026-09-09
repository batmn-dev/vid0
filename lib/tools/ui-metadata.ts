import type { GenerationStats } from "@/lib/chat-messages/generation-stats"
import type { ModelReasoningEffort } from "@/lib/models/types"
import type { ResolvedToolMetadata } from "./metadata-resolver"

export type ToolInvocationDisplayMetadata = Pick<
  ResolvedToolMetadata,
  | "displayName"
  | "source"
  | "serviceName"
  | "icon"
  | "estimatedCostPer1k"
  | "readOnly"
  | "destructive"
  | "idempotent"
  | "openWorld"
>

export type ToolInvocationMetadataByName = Record<
  string,
  ToolInvocationDisplayMetadata
>

export type ToolInvocationMetadataByCallId = Record<
  string,
  ToolInvocationDisplayMetadata
>

export type ToolInvocationStreamMetadata = {
  reasoningDurationMs?: number
  /** Applied per-turn reasoning effort (ADR-0026), stamped at stream start. */
  reasoningEffort?: ModelReasoningEffort
  /** Applied total generation allowance (ADR-0028), including reasoning. */
  generationBudget?: number
  /**
   * Cumulative active assistant generation time across provider-stream segments
   * for this assistant turn. Each segment runs from provider-stream start
   * through its terminal generation signal; approval continuations add to the
   * persisted prior total without counting the approval wait. Also excludes
   * request preparation, persistence, analytics, and resource cleanup.
   */
  workDurationMs?: number
  /** Observed work before the provider's explicit final-answer boundary. */
  workSummaryDurationMs?: number
  /** Generation stats (ADR-0030), stamped at finish from SDK step performance. */
  generationStats?: GenerationStats
  toolMetadataByName?: ToolInvocationMetadataByName
  toolMetadataByCallId?: ToolInvocationMetadataByCallId
}

function titleCaseSegment(value: string): string {
  if (!value) return ""
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export function humanizeToolName(name: string): string {
  const normalized = name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()

  if (!normalized) return "Tool"
  return normalized
    .split(/\s+/)
    .map((segment) => titleCaseSegment(segment))
    .join(" ")
}

export function toToolInvocationDisplayMetadata(
  metadata: ResolvedToolMetadata
): ToolInvocationDisplayMetadata {
  return {
    displayName: metadata.displayName,
    source: metadata.source,
    serviceName: metadata.serviceName,
    icon: metadata.icon,
    estimatedCostPer1k: metadata.estimatedCostPer1k,
    readOnly: metadata.readOnly,
    destructive: metadata.destructive,
    idempotent: metadata.idempotent,
    openWorld: metadata.openWorld,
  }
}

export function buildStartToolInvocationStreamMetadata(
  toolMetadataByName: ToolInvocationMetadataByName
): ToolInvocationStreamMetadata {
  if (Object.keys(toolMetadataByName).length === 0) return {}
  return { toolMetadataByName }
}

export function buildFinishToolInvocationStreamMetadata(options: {
  toolMetadataByCallId: ToolInvocationMetadataByCallId
  reasoningDurationMs: number | null
  workDurationMs: number
  workSummaryDurationMs?: number
  generationStats?: GenerationStats
}): ToolInvocationStreamMetadata {
  const metadata: ToolInvocationStreamMetadata = {}
  if (Object.keys(options.toolMetadataByCallId).length > 0) {
    metadata.toolMetadataByCallId = options.toolMetadataByCallId
  }
  if (options.reasoningDurationMs !== null) {
    metadata.reasoningDurationMs = options.reasoningDurationMs
  }
  metadata.workDurationMs = options.workDurationMs
  if (options.workSummaryDurationMs !== undefined) {
    metadata.workSummaryDurationMs = options.workSummaryDurationMs
  }
  if (options.generationStats) {
    metadata.generationStats = options.generationStats
  }
  return metadata
}

export function resolveToolInvocationMetadata(options: {
  toolName: string
  toolCallId: string
  streamMetadata?: ToolInvocationStreamMetadata
}): ToolInvocationDisplayMetadata | undefined {
  const byCallId = options.streamMetadata?.toolMetadataByCallId
  if (byCallId?.[options.toolCallId]) {
    return byCallId[options.toolCallId]
  }
  const byName = options.streamMetadata?.toolMetadataByName
  return byName?.[options.toolName]
}
