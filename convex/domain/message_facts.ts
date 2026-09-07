/** Optional Stop display prefix; larger answers retain the durable checkpoint. */
export const MAX_STOP_OBSERVED_TEXT_CHARS = 128 * 1024

export const DURABLE_MESSAGE_STATUSES = [
  "submitted",
  "streaming",
  "completed",
  "aborted",
  "failed",
  "awaiting_approval",
] as const

export type DurableMessageStatus = (typeof DURABLE_MESSAGE_STATUSES)[number]

export const GENERATION_RUN_STATUSES = [
  "queued",
  "running",
  "streaming",
  "awaiting_approval",
  "completed",
  "aborted",
  "failed",
] as const

export type GenerationRunStatus = (typeof GENERATION_RUN_STATUSES)[number]

const durableMessageStatusSet = new Set<unknown>(DURABLE_MESSAGE_STATUSES)
const generationRunStatusSet = new Set<unknown>(GENERATION_RUN_STATUSES)
const terminalStatusSet = new Set<unknown>(["completed", "aborted", "failed"])
const activeGenerationRunStatusSet = new Set<unknown>([
  "queued",
  "running",
  "streaming",
  "awaiting_approval",
])

export function extractTextFromMessageParts(parts: unknown): string {
  if (!Array.isArray(parts)) return ""

  let text = ""
  for (const part of parts) {
    if (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      text += (part as { text: string }).text
    }
  }

  return text
}

export function isDurableMessageStatus(
  status: unknown
): status is DurableMessageStatus {
  return durableMessageStatusSet.has(status)
}

export function isGenerationRunStatus(
  status: unknown
): status is GenerationRunStatus {
  return generationRunStatusSet.has(status)
}

export function isTerminalMessageStatus(status: unknown): boolean {
  return isDurableMessageStatus(status) && terminalStatusSet.has(status)
}

export function isTerminalGenerationRunStatus(status: unknown): boolean {
  return isGenerationRunStatus(status) && terminalStatusSet.has(status)
}

export function isActiveGenerationRunStatus(status: unknown): boolean {
  return (
    isGenerationRunStatus(status) && activeGenerationRunStatusSet.has(status)
  )
}

export function isAwaitingApprovalStatus(status: unknown): boolean {
  return status === "awaiting_approval"
}
