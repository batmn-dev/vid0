"use client"

import {
  deriveAssistantActivityPresentation,
  type AssistantActivityModel,
} from "@/lib/chat-messages/assistant-activity"
import {
  deriveAssistantTurnPhase,
  deriveAssistantTurnView,
  hasRenderableEvidence,
  IDLE_REASONING_VIEW,
  type AssistantTurnRenderStatus,
  type AssistantTurnView,
} from "@/lib/chat-messages/assistant-turn"
import { getServerMessageId } from "@/lib/chat-messages/metadata"
import type { UIMessage } from "@ai-sdk/react"
import {
  useAssistantWorkDuration,
  useReasoningPhase,
} from "./use-reasoning-phase"

type ChatStatus = "streaming" | "ready" | "submitted" | "error"

const DURABLE_RENDER_STATUSES = new Set<AssistantTurnRenderStatus>([
  "submitted",
  "streaming",
  "ready",
  "error",
  "aborted",
  "failed",
  "completed",
  "awaiting_approval",
])

function messageRenderStatus(message: UIMessage | undefined) {
  const candidate = (message as { status?: unknown } | undefined)?.status
  return typeof candidate === "string" &&
    DURABLE_RENDER_STATUSES.has(candidate as AssistantTurnRenderStatus)
    ? (candidate as AssistantTurnRenderStatus)
    : "ready"
}

export const PENDING_ACTIVITY_TURN_ID = "__pending_activity_turn__"

/** Data the selector hands to `<ActivityPanel>` via `panelProps`. */
export type ActivityPanelProps = {
  activity: AssistantActivityModel | undefined
  durationSeconds: number | undefined
  turnKey: string | undefined
  followLatest: boolean
}

export type UseActivityPanelResult = {
  /** The generation-following turn id: pending placeholder or last assistant. */
  defaultActivityTurnId: string | undefined
  /** The turn whose content is currently projected into the panel. */
  panelActivityTurnId: string | undefined
  /** Current-session total work duration for the generation-following turn. */
  defaultActivityDurationMs: number | undefined
  /** Current-session reasoning-only duration for the default turn. */
  defaultReasoningDurationMs: number | undefined
  /** True while a generation is in flight (covers the pre-stream submitted state). */
  isGenerationActive: boolean
  /** False when an explicit selection no longer resolves to a rendered turn
   * (branch switch, local delete) — Chat's signal to drop the stale selection
   * from the store instead of letting it linger and resurrect later. */
  selectedTurnPresent: boolean
  /** Whether the selected/default turn has at least one inspectable section. */
  panelCanOpen: boolean
  panelProps: ActivityPanelProps
}

export type ActivityPanelTarget = {
  defaultActivityTurnId: string | undefined
  panelActivityTurnId: string | undefined
  defaultMessage: UIMessage | undefined
  /** `defaultMessage`'s view — the live turn's view when generation is active,
   * so the panel never walks parts the resolver already walked. */
  defaultView: AssistantTurnView | undefined
  panelMessage: UIMessage | undefined
  isGenerationActive: boolean
  isPendingActivityTurn: boolean
  /**
   * The message the live work clock anchors to: the default turn once it has
   * renderable evidence, or the pending assistant message from the moment
   * the stream's `start` chunk created it. Anchoring to arrival rather than
   * to the first renderable part keeps the live "Worked for Ns" estimate on
   * the server clock's origin (ADR-0041): a turn whose first renderable part
   * arrives late (no reasoning, slow first tool) otherwise reads seconds
   * short of its settled value.
   */
  workClockMessage: UIMessage | undefined
  /** False when `selectedActivityTurnId` matched no rendered turn (the panel
   * silently fell back to the default). Vacuously true with no selection. */
  selectedTurnPresent: boolean
}

export function selectExplicitActivityTurnOnOpen({
  requestedTurnId,
  defaultActivityTurnId,
}: {
  requestedTurnId: string
  defaultActivityTurnId: string | undefined
}): string | undefined {
  return requestedTurnId === defaultActivityTurnId ? undefined : requestedTurnId
}

/**
 * True while a generation is in flight (covers the pre-stream submitted state).
 * Shared by `useActivityPanel` and `Conversation` so the gate can't drift. (A
 * third, private copy lives in `chat-turn.ts`, out of this module's scope.)
 */
export function isGenerationActive(
  status: ChatStatus,
  isSubmitting: boolean
): boolean {
  return isSubmitting || status === "submitted" || status === "streaming"
}

/**
 * The last message's standing while this client's generation is active — one
 * derivation shared by `Conversation` (the pending row and the live row) and
 * the Activity panel (its default target), so the pending gate can't drift
 * and the live turn's parts are walked once per render, not once per caller.
 *
 * The pending row owns the pre-content handoff, even after persistence adopts
 * the real assistant id. A durable assistant shell can arrive before the local
 * stream publishes its first renderable part; handing the row over at identity
 * adoption would briefly replace the 32px Thinking slot with an empty turn.
 */
export type ActiveAssistantTurn =
  /** No generation is active on this client. */
  | { kind: "none" }
  /** Generation is active and nothing renderable exists yet: the pending
   * placeholder row owns the slot. */
  | { kind: "pending" }
  /** Generation is active and the last message is a renderable assistant
   * turn; `view` is its Assistant turn view for this render. */
  | { kind: "live"; message: UIMessage; view: AssistantTurnView }

export function resolveActiveAssistantTurn({
  messages,
  status,
  isSubmitting,
}: {
  messages: UIMessage[]
  status: ChatStatus
  isSubmitting: boolean
}): ActiveAssistantTurn {
  if (!isGenerationActive(status, isSubmitting)) return { kind: "none" }

  const lastMessage = messages[messages.length - 1]
  if (lastMessage?.role === "user") return { kind: "pending" }
  if (lastMessage?.role !== "assistant") return { kind: "none" }

  const view = deriveAssistantTurnView(lastMessage, status)
  const durableStatus = messageRenderStatus(lastMessage)
  const durableLive =
    durableStatus === "ready" ||
    durableStatus === "submitted" ||
    durableStatus === "streaming"
  if (durableLive && !hasRenderableEvidence(view)) return { kind: "pending" }

  return { kind: "live", message: lastMessage, view }
}

function getActivityTurnId(message: UIMessage | undefined): string | undefined {
  if (!message) return undefined

  return message.id ?? getServerMessageId(message.metadata)
}

function matchesActivityTurn(
  message: UIMessage | undefined,
  turnId: string | undefined
): boolean {
  if (!message || turnId === undefined) return false

  return (
    message.id === turnId || getServerMessageId(message.metadata) === turnId
  )
}

function findAssistantTurn(
  messages: UIMessage[],
  turnId: string | undefined
): UIMessage | undefined {
  if (turnId === undefined) return undefined

  return messages.find(
    (message) =>
      message.role === "assistant" && matchesActivityTurn(message, turnId)
  )
}

function findLastAssistantTurn(messages: UIMessage[]): UIMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i]
  }

  return undefined
}

export function selectActivityPanelTarget({
  messages,
  status,
  isSubmitting,
  selectedActivityTurnId,
}: {
  messages: UIMessage[]
  status: ChatStatus
  isSubmitting: boolean
  selectedActivityTurnId?: string
}): ActivityPanelTarget {
  const generationActive = isGenerationActive(status, isSubmitting)
  const activeTurn = resolveActiveAssistantTurn({
    messages,
    status,
    isSubmitting,
  })
  const hasPendingAssistantTurn = activeTurn.kind === "pending"

  // Before the first renderable part, assistant identity adoption is not a
  // visual handoff: the generation-following default remains the placeholder.
  const defaultMessage = hasPendingAssistantTurn
    ? undefined
    : findLastAssistantTurn(messages)
  const defaultActivityTurnId = hasPendingAssistantTurn
    ? PENDING_ACTIVITY_TURN_ID
    : getActivityTurnId(defaultMessage)

  const selectedPendingTurn =
    hasPendingAssistantTurn &&
    selectedActivityTurnId === PENDING_ACTIVITY_TURN_ID
  const selectedMessage = selectedPendingTurn
    ? undefined
    : findAssistantTurn(messages, selectedActivityTurnId)

  const panelActivityTurnId = selectedPendingTurn
    ? PENDING_ACTIVITY_TURN_ID
    : (getActivityTurnId(selectedMessage) ?? defaultActivityTurnId)

  const defaultView = !defaultMessage
    ? undefined
    : activeTurn.kind === "live" && activeTurn.message === defaultMessage
      ? activeTurn.view
      : deriveAssistantTurnView(defaultMessage, status)
  const lastMessage = messages[messages.length - 1]
  const workClockMessage =
    defaultMessage ??
    (hasPendingAssistantTurn && lastMessage?.role === "assistant"
      ? lastMessage
      : undefined)

  return {
    defaultActivityTurnId,
    panelActivityTurnId,
    defaultMessage,
    defaultView,
    panelMessage: selectedMessage ?? defaultMessage,
    isGenerationActive: generationActive,
    isPendingActivityTurn: panelActivityTurnId === PENDING_ACTIVITY_TURN_ID,
    workClockMessage,
    selectedTurnPresent:
      selectedActivityTurnId === undefined ||
      selectedPendingTurn ||
      selectedMessage !== undefined,
  }
}

/**
 * useActivityPanel — the single, chat-owned selector for the Activity panel.
 * Called once by `Chat` after `useChatCore` returns the
 * already-projected selected path; it does NOT recompute `projectSelectedPath`.
 *
 * The default target follows the latest generation/pending assistant. An
 * explicit selected turn, when still present in the rendered path, overrides
 * that default so historical Activity panel content stays addressable while new
 * messages stream. Individual `MessageAssistant` instances never call this hook
 * — rows reach the panel through the activity panel store seam
 * (activity/activity-panel-store.tsx), which Chat syncs with this selector's
 * output.
 */
export function useActivityPanel({
  messages,
  status,
  isSubmitting,
  isApprovalPaused,
  selectedActivityTurnId,
}: {
  messages: UIMessage[]
  status: ChatStatus
  isSubmitting: boolean
  /** Canonical run-presentation pause, independent of local transport lag. */
  isApprovalPaused: boolean
  selectedActivityTurnId?: string
}): UseActivityPanelResult {
  const {
    defaultActivityTurnId,
    panelActivityTurnId,
    defaultMessage,
    defaultView,
    panelMessage,
    isGenerationActive: generationActive,
    isPendingActivityTurn,
    workClockMessage,
    selectedTurnPresent,
  } = selectActivityPanelTarget({
    messages,
    status,
    isSubmitting,
    selectedActivityTurnId,
  })

  // The work timer belongs to the generation-following default turn, not
  // the currently selected panel turn. A historical panel selection must not
  // pause timing for the live row; this single timer feeds both the default row
  // and the panel whenever the panel follows that row.
  const isPanelDefaultTurn =
    panelActivityTurnId !== undefined &&
    panelActivityTurnId === defaultActivityTurnId

  // One derivation for the panel target — the same Assistant turn view the
  // message row derives, so the trigger and the panel can never disagree.
  const panelView = isPanelDefaultTurn
    ? defaultView
    : panelMessage
      ? deriveAssistantTurnView(panelMessage, "ready")
      : undefined

  const defaultWorkDuration = useAssistantWorkDuration({
    persistedWorkDurationMs: defaultView?.persistedWorkDurationMs,
    // Runs from the assistant message's arrival (see `workClockMessage`), so
    // the pending placeholder and the live turn share one clock.
    isActive: Boolean(workClockMessage) && generationActive,
    // The run-presentation resolver owns approval liveness. Local transport
    // can remain streaming after the durable run pauses, and the durable
    // message can retain awaiting_approval briefly after continuation.
    isPaused: Boolean(defaultMessage) && isApprovalPaused,
    // Turn identity for the timer: a new generation or branch default must
    // restart from zero and never inherit the previous turn's frozen duration.
    // Keyed by the assistant message, not the pending sentinel, so the clock
    // survives the pending→live handoff of the same message.
    turnKey: getActivityTurnId(workClockMessage),
  })
  const defaultReasoningDuration = useReasoningPhase({
    reasoning: defaultView?.reasoning ?? IDLE_REASONING_VIEW,
    isLast: Boolean(defaultMessage),
    turnKey: defaultActivityTurnId,
  })

  const panelStatus: AssistantTurnRenderStatus =
    isPanelDefaultTurn && generationActive
      ? status
      : messageRenderStatus(panelMessage)
  const panelPhase = panelView
    ? deriveAssistantTurnPhase(panelView, {
        status: panelStatus,
        isLast: isPanelDefaultTurn,
      })
    : ({ kind: "submitted" } as const)
  const panelWorkDurationMs = isPanelDefaultTurn
    ? defaultWorkDuration.durationMs
    : panelView?.persistedWorkDurationMs
  const presentation = panelView
    ? deriveAssistantActivityPresentation(panelView, panelPhase, {
        workDurationMs: panelWorkDurationMs,
        reasoningDurationMs: isPanelDefaultTurn
          ? defaultReasoningDuration.durationMs
          : panelView?.reasoning.persistedDurationMs,
        status: panelStatus,
      })
    : undefined
  const panelCanOpen = presentation?.kind === "disclosure"

  const panelProps: ActivityPanelProps = isPendingActivityTurn
    ? {
        activity: undefined,
        durationSeconds: undefined,
        turnKey: panelActivityTurnId,
        followLatest: false,
      }
    : {
        activity:
          presentation?.kind === "disclosure"
            ? presentation.activity
            : undefined,
        durationSeconds:
          presentation?.kind === "disclosure"
            ? presentation.durationSeconds
            : undefined,
        turnKey: panelActivityTurnId,
        followLatest: isPanelDefaultTurn && generationActive,
      }

  return {
    defaultActivityTurnId,
    panelActivityTurnId,
    defaultActivityDurationMs: defaultWorkDuration.durationMs,
    defaultReasoningDurationMs: defaultReasoningDuration.durationMs,
    isGenerationActive: generationActive,
    selectedTurnPresent,
    panelCanOpen,
    panelProps,
  }
}
