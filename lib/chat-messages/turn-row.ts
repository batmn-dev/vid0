import {
  assistantTurnViewsEqual,
  type AssistantTurnView,
} from "./assistant-turn"
import type { MessageBranchInfo } from "./branch"
import type { DurableMessageStatus } from "./durable-contract"

export type TurnRowAttachment = {
  name: string
  contentType: string
  url: string
}

type BaseTurnRowModel = {
  id: string
  text: string
  className?: string
  isDurableChat?: boolean
}

export type AssistantTurnRowModel = BaseTurnRowModel & {
  kind: "assistant"
  view: AssistantTurnView
  isLast?: boolean
  retryModelId?: string
  retryDisabled?: boolean
  status?: DurableMessageStatus | "ready" | "error"
  finishReason?: string
}

export type UserTurnRowModel = BaseTurnRowModel & {
  kind: "user"
  isEditing: boolean
  attachments?: TurnRowAttachment[]
  branch?: MessageBranchInfo
}

export type UnsupportedTurnRowModel = BaseTurnRowModel & {
  kind: "unsupported"
}

export type TurnRowModel =
  | AssistantTurnRowModel
  | UserTurnRowModel
  | UnsupportedTurnRowModel

function branchesEqual(
  previous: MessageBranchInfo | undefined,
  next: MessageBranchInfo | undefined
): boolean {
  if (previous === next) return true
  if (!previous || !next) return false
  if (
    previous.messageId !== next.messageId ||
    previous.currentIndex !== next.currentIndex ||
    previous.total !== next.total ||
    previous.siblings.length !== next.siblings.length
  ) {
    return false
  }

  return previous.siblings.every(
    (sibling, index) =>
      sibling.messageId === next.siblings[index]?.messageId
  )
}

function attachmentsEqual(
  previous: TurnRowAttachment[] | undefined,
  next: TurnRowAttachment[] | undefined
): boolean {
  if (previous === next) return true
  if ((previous?.length ?? 0) !== (next?.length ?? 0)) return false
  if (!previous || !next) return true

  return previous.every((attachment, index) => {
    const candidate = next[index]
    return (
      attachment.url === candidate?.url &&
      attachment.name === candidate.name &&
      attachment.contentType === candidate.contentType
    )
  })
}

/**
 * Content equality for the facts rendered by one Chat turn row. Conversation
 * derives fresh models because AI SDK parts can mutate in place; this function
 * is therefore the row's memo contract, including inline work evidence.
 */
export function turnRowModelsEqual(
  previous: TurnRowModel,
  next: TurnRowModel
): boolean {
  if (previous === next) return true
  if (previous.kind !== next.kind) return false
  if (
    previous.id !== next.id ||
    previous.text !== next.text ||
    previous.className !== next.className ||
    previous.isDurableChat !== next.isDurableChat
  ) {
    return false
  }

  if (previous.kind === "assistant" && next.kind === "assistant") {
    return (
      assistantTurnViewsEqual(previous.view, next.view) &&
      previous.isLast === next.isLast &&
      previous.retryModelId === next.retryModelId &&
      previous.retryDisabled === next.retryDisabled &&
      previous.status === next.status &&
      previous.finishReason === next.finishReason
    )
  }

  if (previous.kind === "user" && next.kind === "user") {
    return (
      previous.isEditing === next.isEditing &&
      attachmentsEqual(previous.attachments, next.attachments) &&
      branchesEqual(previous.branch, next.branch)
    )
  }

  return true
}
