import {
  deriveAssistantTurnView,
  type AssistantTurnView,
} from "@/lib/chat-messages/assistant-turn"
import { resolveTurnBranch } from "@/lib/chat-messages/branch"
import {
  isDurableMessageStatus,
  type DurableMessageStatus,
} from "@/lib/chat-messages/durable-contract"
import { getFinishReason } from "@/lib/chat-messages/metadata"
import { extractTextFromMessageParts } from "@/lib/chat-messages/parts"
import type { TurnRowModel } from "@/lib/chat-messages/turn-row"
import type {
  EditTurnResult,
  RegenerationTurnOverrides,
} from "@/lib/chat-turn/chat-turn-controller"
import { cn } from "@/lib/utils"
import { UIMessage as MessageType } from "@ai-sdk/react"
import {
  Fragment,
  useCallback,
  useState,
  type ReactNode,
} from "react"
import {
  ConversationTimestamp,
  deriveConversationTimestampHeaders,
} from "./conversation-timestamp"
import { Message } from "./message"
import {
  THREAD_GUTTER_VARS,
  THREAD_MAXWIDTH_VARS,
  TURN_SCROLL_MARGIN_BOTTOM,
} from "./thread-bounds"
import {
  ThreadScrollEdge,
  useConversationTurnObservation,
  useSubmitTurnScrollRef,
  type TurnIntersectionObserver,
} from "./thread-scroll"
import type { ThreadScrollTarget } from "./thread-scroll-target"
import {
  isGenerationActive,
  PENDING_ACTIVITY_TURN_ID,
  resolveActiveAssistantTurn,
} from "./use-activity-panel"

type MessageRenderStatus = DurableMessageStatus | "ready" | "error"

type ConversationMessage = MessageType & {
  createdAt?: Date
}

function isMessageRenderStatus(value: unknown): value is MessageRenderStatus {
  return value === "ready" || value === "error" || isDurableMessageStatus(value)
}

// v6 helper: Extract text content from all text parts in order.
// Tool-enabled responses can interleave multiple assistant text parts across
// steps; using only the first part makes responses appear truncated.
function getMessageText(message: MessageType): string {
  return extractTextFromMessageParts(message.parts)
}

// Extract file attachments from parts array (user rows; assistant rows render
// no attachments)
function getMessageAttachments(
  message: MessageType
): Array<{ name: string; contentType: string; url: string }> | undefined {
  const fileParts = message.parts?.filter((p) => p.type === "file")
  if (!fileParts || fileParts.length === 0) return undefined
  return fileParts.map((p) => ({
    name: (p as { filename?: string }).filename || "file",
    contentType:
      (p as { mediaType?: string }).mediaType || "application/octet-stream",
    url: (p as { url?: string }).url || "",
  }))
}

/**
 * TurnRow — the stable section wrapper shared by mapped messages and the
 * pending-assistant placeholder. Pending and real assistant content reconcile
 * through this same DOM node; only its data identity and contents update.
 *
 * The section itself carries the turn identity and center observation; extra
 * virtualization wrappers would disturb touch momentum.
 */
function TurnRow({
  className,
  dataTurn,
  dataTurnId,
  dataTestId,
  beforeTurn,
  centerIntersectionObserver,
  isEditing = false,
  hasDisplayableContent = true,
  onCenterIntersectionChange,
  scrollOnSubmit = false,
  verticalPadding = "none",
  children,
}: {
  className: string
  dataTurn: string
  dataTurnId: string
  dataTestId?: string
  beforeTurn?: ReactNode
  centerIntersectionObserver: TurnIntersectionObserver
  isEditing?: boolean
  hasDisplayableContent?: boolean
  onCenterIntersectionChange?: (turnId: string, intersecting: boolean) => void
  scrollOnSubmit?: boolean
  verticalPadding?: "none" | "first" | "large" | "last"
  children: ReactNode
}) {
  const submitScrollRef = useSubmitTurnScrollRef(scrollOnSubmit)
  const eagerSectionRef = useCallback(
    (section: HTMLElement | null) => {
      const submitCleanup = submitScrollRef(section)
      const centerCleanup =
        section && onCenterIntersectionChange
          ? centerIntersectionObserver.observe(section, (intersecting) =>
              onCenterIntersectionChange(dataTurnId, intersecting)
            )
          : undefined
      return () => {
        submitCleanup?.()
        if (centerCleanup) {
          centerCleanup()
          onCenterIntersectionChange?.(dataTurnId, false)
        }
      }
    },
    [
      centerIntersectionObserver,
      dataTurnId,
      onCenterIntersectionChange,
      submitScrollRef,
    ]
  )
  if (!hasDisplayableContent) return null

  return (
    <>
      {beforeTurn}
      {/* Markdown blocks retain the measured containment optimization.
          Enabling whole-turn containment at settlement substitutes a fallback
          height before the browser measures it, clamping the reader's scroll. */}
      <section
        ref={eagerSectionRef}
        className={cn(
          "text-foreground w-full focus:outline-none",
          className
        )}
        data-turn-id-container={dataTurnId}
        data-turn={dataTurn}
        data-turn-id={dataTurnId}
        data-testid={dataTestId}
        dir="auto"
      >
        <h4 className="sr-only select-none">
          {dataTurn === "user" ? "You said:" : "Assistant said:"}
        </h4>
        <div
          className={cn(
            `mx-auto my-auto px-[var(--thread-content-margin,1rem)] text-base ${THREAD_GUTTER_VARS}`,
            verticalPadding === "first" && "pt-3",
            verticalPadding === "large" && "pt-12",
            verticalPadding === "last" && "pb-8"
          )}
        >
          <div
            data-conversation-screenshot-content=""
            className={cn(
              "group/turn-messages relative mx-auto flex w-full max-w-[var(--thread-content-max-width,40rem)] min-w-0 flex-1 flex-col focus-visible:outline-hidden",
              THREAD_MAXWIDTH_VARS,
              dataTurn === "assistant" && "agent-turn",
              dataTurn === "user" && isEditing && "mb-10"
            )}
          >
            {children}
          </div>
          {dataTurn === "assistant" ? (
            <div
              data-conversation-screenshot-content=""
              className={`mx-auto max-w-[var(--thread-content-max-width,40rem)] flex-1 ${THREAD_MAXWIDTH_VARS}`}
            >
              <div />
            </div>
          ) : null}
        </div>
      </section>
    </>
  )
}

type ConversationRenderRow =
  | { kind: "root"; key: "client-created-root" }
  | {
      kind: "message"
      key: string
      message: ConversationMessage
      index: number
    }
  | { kind: "pending"; key: string; index: number }

function assistantTurnRowKey(userMessageId: string): string {
  return `assistant-turn:${userMessageId}`
}

function messageTurnRowKey(
  messages: ConversationMessage[],
  index: number
): string {
  const message = messages[index]
  const previousMessage = messages[index - 1]

  if (message.role === "assistant" && previousMessage?.role === "user") {
    return assistantTurnRowKey(previousMessage.id)
  }

  return `message:${message.id}`
}

function messageTurnRowId(
  messages: ConversationMessage[],
  index: number
): string {
  const message = messages[index]
  return message.role === "assistant"
    ? messageTurnRowKey(messages, index)
    : message.id
}

function renderRowTurnId(row: ConversationRenderRow): string {
  return row.kind === "root" || row.kind === "pending"
    ? row.key
    : row.message.role === "assistant"
      ? row.key
      : row.message.id
}

type ConversationProps = {
  messages: ConversationMessage[]
  replayingMessageId?: string | null
  /** Stable observation time for one render; injectable by deterministic
   * lifecycle tests without mocking the global clock. */
  now?: Date
  status?: "streaming" | "ready" | "submitted" | "error"
  isSubmitting?: boolean
  /** Scopes the scroll lifecycle (load restore, pinning) to one conversation. */
  chatId?: string | null
  /** True when this conversation was started in this session — the scroll
   * position came from send-time pinning, so the load restore must not run. */
  hasSentFirstMessage?: boolean
  onEdit: (
    id: string,
    newText: string
  ) => Promise<EditTurnResult | void> | EditTurnResult | void
  onReload: (messageId: string, overrides?: RegenerationTurnOverrides) => void
  retryModelId?: string
  onQuote?: (text: string, messageId: string) => void
  onSelectBranch?: (messageId: string) => void
  isDurableChat?: boolean
  lastFinishReason?: string
  /** Message deep-link value from the route. The two final-turn sentinels
   * target the final assistant turn rather than a particular message node. */
  scrollToMessageId?: string | null
  /** Optional table-of-contents (center-band) observer state. */
  onCenterIntersectionChange?: (turnId: string, intersecting: boolean) => void
}

function resolveConversationScrollTarget(
  messages: ConversationMessage[],
  scrollToMessageId: string | null | undefined
): ThreadScrollTarget | null {
  if (!scrollToMessageId) return null

  if (
    scrollToMessageId === "finalAgentTurn" ||
    scrollToMessageId === "finalAgentTurnStart"
  ) {
    let index = messages.length - 1
    while (index >= 0 && messages[index]?.role !== "assistant") index -= 1
    if (index === -1) return null
    return { turnId: messageTurnRowId(messages, index) }
  }

  const index = messages.findIndex(
    (message) => message.id === scrollToMessageId
  )
  if (index === -1) return null
  return {
    turnId: messageTurnRowId(messages, index),
    messageId: scrollToMessageId,
  }
}

/** The pending placeholder's view: no parts yet, generation submitted. Module
 * constant so its metadata identity is stable across renders (memo-friendly). */
const PENDING_TURN_VIEW: AssistantTurnView = deriveAssistantTurnView(
  { parts: [] },
  "submitted"
)

export function Conversation({
  messages,
  replayingMessageId = null,
  now = new Date(),
  status = "ready",
  isSubmitting = false,
  chatId = null,
  hasSentFirstMessage = false,
  onEdit,
  onReload,
  retryModelId,
  onQuote,
  onSelectBranch,
  isDurableChat,
  lastFinishReason,
  scrollToMessageId,
  onCenterIntersectionChange,
}: ConversationProps) {
  // Chat stays mounted across route commits (ADR-0013), so the open editor is
  // scoped to the chat it was opened in and dropped at the chat boundary
  // (render-time reset, same idiom as turn-context's effort store).
  const [editingState, setEditingState] = useState<{
    chatId: string | null
    messageId: string
  } | null>(null)
  if (editingState !== null && editingState.chatId !== chatId) {
    setEditingState(null)
  }
  const editingMessageId = editingState?.messageId ?? null
  const scrollTarget = resolveConversationScrollTarget(
    messages,
    scrollToMessageId
  )
  const observation = useConversationTurnObservation()
  const generationActive = isGenerationActive(status, isSubmitting)
  const lastMessage = messages[messages.length - 1]
  const previousMessage = messages[messages.length - 2]
  const [submittedTurn, setSubmittedTurn] = useState<{
    chatId: string | null
    turnId: string | null
  }>({ chatId, turnId: null })
  const keepsSubmittedTurn =
    submittedTurn.chatId === chatId ||
    // First-send route adoption retains the same optimistic user identity.
    (submittedTurn.chatId === null &&
      submittedTurn.turnId !== null &&
      messages.some(
        (message) =>
          message.role === "user" && message.id === submittedTurn.turnId
      ))
  // Only local submission arms placement. A retained GET also streams, but
  // must preserve the reader's position throughout replay and live updates.
  const submitScrollTurnId =
    status === "submitted" || isSubmitting
      ? lastMessage?.role === "user"
        ? lastMessage.id
        : lastMessage?.role === "assistant" && previousMessage?.role === "user"
          ? previousMessage.id
          : null
      : generationActive && keepsSubmittedTurn
        ? submittedTurn.turnId
        : null
  if (
    submittedTurn.chatId !== chatId ||
    submittedTurn.turnId !== submitScrollTurnId
  )
    setSubmittedTurn({ chatId, turnId: submitScrollTurnId })
  const handleEditingChange = useCallback(
    (messageId: string, isEditing: boolean) => {
      setEditingState((current) =>
        isEditing
          ? { chatId, messageId }
          : current?.messageId === messageId
            ? null
            : current
      )
    },
    [chatId]
  )
  if (!messages || messages.length === 0)
    return <div className="w-full flex-1"></div>

  const activeTurn = resolveActiveAssistantTurn({
    messages,
    status,
    isSubmitting,
  })
  const hasPendingAssistantTurn = activeTurn.kind === "pending"
  // Persistence can insert the real assistant shell before its first stream
  // part. Keep that empty shell out of the rendered path so the pending row
  // remains the single 32px owner until content can replace it atomically.
  const renderedMessages =
    hasPendingAssistantTurn && lastMessage?.role === "assistant"
      ? messages.slice(0, -1)
      : messages
  const timestampHeaders = deriveConversationTimestampHeaders(
    renderedMessages,
    now
  )
  const renderRows: ConversationRenderRow[] = [
    { kind: "root", key: "client-created-root" },
    ...renderedMessages.map((message, index) => ({
      kind: "message" as const,
      key: messageTurnRowKey(renderedMessages, index),
      message,
      index,
    })),
  ]
  if (hasPendingAssistantTurn) {
    const activeUserMessage =
      lastMessage?.role === "user"
        ? lastMessage
        : lastMessage?.role === "assistant" && previousMessage?.role === "user"
          ? previousMessage
          : undefined

    renderRows.push({
      kind: "pending",
      key: assistantTurnRowKey(
        activeUserMessage?.id ?? PENDING_ACTIVITY_TURN_ID
      ),
      index: renderedMessages.length,
    })
  }

  return (
    <div className="relative -mb-(--composer-overlap-px) flex w-full grow basis-auto flex-col pb-(--composer-overlap-px) [--composer-overlap-px:28px]">
      <div className="keyboard-open:pb-[calc(var(--composer-height,100px)+var(--screen-keyboard-height,0))] flex w-full grow flex-col text-sm">
        <span ref={observation.markerRef} style={{ display: "none" }} />
        {renderRows.map((row) => {
          const rowTurnId = renderRowTurnId(row)
          if (row.kind === "root") {
            return (
              <TurnRow
                key={row.key}
                className=""
                dataTurn="assistant"
                dataTurnId={rowTurnId}
                centerIntersectionObserver={
                  observation.centerIntersectionObserver
                }
                hasDisplayableContent={false}
              >
                {null}
              </TurnRow>
            )
          }
          if (row.kind === "pending") {
            return (
              <Fragment key={row.key}>
                <TurnRow
                  key="turn"
                  className={cn(
                    "scroll-mt-[calc(var(--header-height)+min(200px,max(70px,20svh)))]",
                    TURN_SCROLL_MARGIN_BOTTOM
                  )}
                  dataTurn="assistant"
                  dataTurnId={rowTurnId}
                  dataTestId={`conversation-turn-${row.index + 1}`}
                  centerIntersectionObserver={
                    observation.centerIntersectionObserver
                  }
                  onCenterIntersectionChange={onCenterIntersectionChange}
                  verticalPadding="last"
                >
                  <Message
                    model={{
                      kind: "assistant",
                      id: PENDING_ACTIVITY_TURN_ID,
                      text: "",
                      isLast: true,
                      view: PENDING_TURN_VIEW,
                      retryModelId,
                      status: "submitted",
                      isDurableChat,
                    }}
                    onEdit={onEdit}
                    onReload={undefined}
                    onSelectBranch={onSelectBranch}
                    onQuote={onQuote}
                  />
                </TurnRow>
              </Fragment>
            )
          }

          const { message, index } = row
          const isLast =
            index === renderedMessages.length - 1 &&
            !hasPendingAssistantTurn &&
            status !== "submitted"
          // Only the last turn reserves the 32px tail.
          const isLastTurnRow =
            index === renderedMessages.length - 1 && !hasPendingAssistantTurn
          const isAssistant = message.role === "assistant"
          const isUser = message.role === "user"

          // Branch nav always anchors on the user message (the turn): show the
          // user's own edit branch, or — when the prompt itself wasn't edited —
          // the response's regenerate branch. Assistant messages never render the
          // control; selecting a response sibling still works because the branch
          // descriptor carries the assistant sibling ids.
          const turnBranch = resolveTurnBranch(
            message,
            renderedMessages[index + 1]
          )
          const durableStatus = (message as { status?: string }).status
          // Durable status wins only when it asserts a settled/paused OUTCOME
          // (aborted/failed/awaiting_approval). Durable LIVE statuses
          // (submitted/streaming) are deliberately ignored: after a Stop or a
          // dropped stream the server run can lag its terminal transition, and
          // adopting its stale "streaming" here resurrected live loaders on a
          // turn whose stream this client already knows is over. The client's
          // own stream status is authoritative for liveness on the last turn;
          // older turns always render settled.
          const messageStatus: MessageRenderStatus =
            isMessageRenderStatus(durableStatus) &&
            (durableStatus === "aborted" ||
              durableStatus === "failed" ||
              durableStatus === "awaiting_approval")
              ? durableStatus
              : isLast
                ? status
                : "ready"

          let rowModel: TurnRowModel
          if (message.role === "assistant") {
            // The single per-render derivation of everything the assistant row
            // renders (see CONTEXT.md "Assistant turn view"). Derived fresh each
            // render — the AI SDK mutates part objects in place during streaming,
            // so this must never be memoized by message reference. The live
            // row reuses the view the active-turn resolver derived this render.
            const view =
              activeTurn.kind === "live" && activeTurn.message === message
                ? activeTurn.view
                : deriveAssistantTurnView(message, isLast ? status : "ready")

            rowModel = {
              kind: "assistant",
              id: message.id,
              text: view.text,
              view,
              isLast,
              retryModelId,
              retryDisabled: generationActive,
              status: messageStatus,
              isDurableChat,
              finishReason:
                getFinishReason(message.metadata) ??
                (isLast ? lastFinishReason : undefined),
            }
          } else if (message.role === "user") {
            rowModel = {
              kind: "user",
              id: message.id,
              text: getMessageText(message),
              isEditing: editingMessageId === message.id,
              attachments: getMessageAttachments(message),
              branch: turnBranch,
              isDurableChat,
            }
          } else {
            rowModel = {
              kind: "unsupported",
              id: message.id,
              text: getMessageText(message),
              isDurableChat,
            }
          }

          const messageContent = (
            <Message
              model={rowModel}
              isReplaying={message.id === replayingMessageId}
              onEdit={onEdit}
              onEditingChange={handleEditingChange}
              onReload={onReload}
              onSelectBranch={onSelectBranch}
              onQuote={onQuote}
            />
          )

          const timestampHeader = timestampHeaders[index]

          return (
            <Fragment key={row.key}>
              <TurnRow
                key="turn"
                className={cn(
                  TURN_SCROLL_MARGIN_BOTTOM,
                  isUser &&
                    "scroll-mt-[var(--sticky-padding-top,var(--spacing-app-header))]",
                  isAssistant &&
                    "scroll-mt-[calc(var(--header-height)+min(200px,max(70px,20svh)))]"
                )}
                dataTurn={message.role}
                dataTurnId={rowTurnId}
                dataTestId={`conversation-turn-${index + 1}`}
                isEditing={rowModel.kind === "user" && rowModel.isEditing}
                centerIntersectionObserver={
                  observation.centerIntersectionObserver
                }
                onCenterIntersectionChange={onCenterIntersectionChange}
                beforeTurn={
                  timestampHeader ? (
                    <ConversationTimestamp header={timestampHeader} now={now} />
                  ) : undefined
                }
                scrollOnSubmit={isUser && message.id === submitScrollTurnId}
                verticalPadding={
                  index === 0
                    ? "first"
                    : isUser
                      ? "large"
                      : isLastTurnRow
                        ? "last"
                        : "none"
                }
              >
                {messageContent}
              </TurnRow>
            </Fragment>
          )
        })}
        <ThreadScrollEdge
          chatId={chatId}
          streamActive={generationActive}
          hydrated={messages.length > 0}
          contentRevision={`${messages.length}:${messages.at(-1)?.id ?? ""}`}
          freshChat={hasSentFirstMessage}
          scrollTarget={scrollTarget}
          deepLink={scrollToMessageId != null}
        />
      </div>
    </div>
  )
}
