import { presentChatStreamError } from "@/app/components/chat/public-chat-error"
import { useChatEdit } from "@/app/components/chat/use-chat-edit"
import { toast } from "@/components/ui/toast"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import {
  extractTextFromMessageParts,
  MAX_STOP_OBSERVED_TEXT_CHARS,
} from "@/convex/domain/message_facts"
import { isEmptyAssistantMessage } from "@/convex/domain/message_visibility"
import { getOrCreateGuestUserId } from "@/lib/api"
import { markApprovalResolvedLocally } from "@/lib/chat-runs/approval-auto-send-gate"
import { useChats } from "@/lib/chat-store/chats/provider"
import {
  createOptimisticMessageId,
  GUEST_CHAT_STORAGE_KEY,
} from "@/lib/chat-store/identity"
import { useMessages } from "@/lib/chat-store/messages/provider"
import {
  isSelectedPathDivergent,
  projectSelectedPath,
} from "@/lib/chat-store/turns/selected-path"
import {
  createChatTurnController,
  type ChatTurnMessage,
  type EnsureChatForTurnArgs,
  type EnsuredTurnChat,
  type RegenerationTurnOverrides,
  type StagedAttachmentReference,
} from "@/lib/chat-turn/chat-turn-controller"
import { CHAT_TURN_EXECUTION_BUDGET } from "@/lib/chat-turn/execution-budget"
import { buildChatTurnRequestBody } from "@/lib/chat-turn/turn-plans"
import { routePersistsChatMessages } from "@/lib/chat-turn/turn-store"
import { attachStagedFilesToChat } from "@/lib/file-handling"
import { isChatPerfClientEnabled } from "@/lib/observability/chat-performance"
import {
  beginChatPerfTurn,
  clearArmedChatPerfHeader,
  deriveChatPerfTurnFacts,
  useChatTurnPerfMarks,
} from "@/lib/observability/chat-performance-client"
import { useChatResponsivenessMarks } from "@/lib/observability/chat-responsiveness"
import { API_ROUTE_CHAT } from "@/lib/routes"
import type { UserProfile } from "@/lib/user/types"
import type { UIMessage } from "@ai-sdk/react"
import { useConvex, useConvexConnectionState, useMutation } from "convex/react"
import { useSearchParams } from "next/navigation"
import {
  useCallback,
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useTurnContext } from "./turn-context"
import {
  useCommitDetachableChatStream,
  useDetachableChatStream,
  type ChatStreamFinishEvent,
} from "./use-detachable-chat-stream"
import { useFrameAlignedChat } from "./use-frame-aligned-chat"
import { useGenerationPresentationController } from "./use-generation-presentation-controller"

/** One send-type Chat turn's inputs, assembled by the Composer. */
export type ChatTurnPayload = {
  text: string
  files: File[]
  attachments: StagedAttachmentReference[]
}

/**
 * Hard time budget for one generation's client stream. Attached streams get it
 * from the stuck-stream guard; detached streams get the same budget from the
 * per-binding watchdog, so an orphaned stream can never run (or spend)
 * unbounded even if server settlement degrades. Budget-derived: sits above the
 * route's maxDuration so the client never cuts a stream the server can still
 * legitimately be running.
 */
const STREAM_TIMEOUT_MS = CHAT_TURN_EXECUTION_BUDGET.clientStreamWatchdogMs

type UseChatCoreProps = {
  initialMessages: UIMessage[]
  /** Cache a local-only message. Pass overrideChatId for detached guest turns. */
  cacheAndAddMessage: (
    message: UIMessage,
    overrideChatId?: string
  ) => void | Promise<void>
  chatId: string | null
  user: UserProfile | null
  isChatAdmissionReady: boolean
  checkLimitsAndNotify: (uid: string) => Promise<boolean>
  ensureChatExists: (
    args: EnsureChatForTurnArgs
  ) => Promise<EnsuredTurnChat | null>
  /** First-turn identity commands (ADR-0033), owned by useChatOperations. */
  firstTurn: { begin: () => string; rollback: () => void }
  bumpChat: (chatId: string) => void
  /** Imperative bridge to the Composer's display, for ?prompt= hydration. */
  setComposerText?: (text: string) => void
}

export function useChatCore({
  initialMessages,
  cacheAndAddMessage,
  chatId,
  user,
  isChatAdmissionReady,
  checkLimitsAndNotify,
  ensureChatExists,
  firstTurn,
  bumpChat,
  setComposerText,
}: UseChatCoreProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const approveToolCall = useMutation(api.chatRuntime.approveToolCall)
  const denyToolCall = useMutation(api.chatRuntime.denyToolCall)
  const convex = useConvex()

  // The Turn context — model/search/system-prompt inputs read at run time by
  // the turn runners (adapters.getTurnSnapshot), reactive here only where a
  // render depends on them. See CONTEXT.md "Turn context".
  const {
    getTurnSnapshot,
    isAuthenticated,
    systemPrompt,
    isHydrated: turnContextHydrated,
  } = useTurnContext()

  // Mutable guard prevents concurrent sends (state updates are batched and can lag).
  const [isSendingStore] = useState(() => {
    let isSending = false

    return {
      get: () => isSending,
      set: (value: boolean) => {
        isSending = value
      },
    }
  })

  // Deferred edit persistence: stores the edited user message so onFinish can
  // persist it AFTER the stream completes, avoiding provider state mutations
  // during the same React batch as sendMessage/setMessages.
  const [pendingEditStore] = useState(() => {
    let pendingEdit: {
      message: ChatTurnMessage
      chatId: string
    } | null = null

    return {
      stage: (message: ChatTurnMessage, currentChatId: string) => {
        pendingEdit = {
          message,
          chatId: currentChatId,
        }
      },
      get: () => pendingEdit,
      clear: () => {
        pendingEdit = null
      },
    }
  })

  const [hasDialogAuth, setHasDialogAuth] = useState(false)

  const [lastFinishReasonState, setLastFinishReasonState] = useState<{
    chatId: string | null
    finishReason: string | undefined
  }>(() => ({
    chatId,
    finishReason: undefined,
  }))
  const lastFinishReason =
    lastFinishReasonState.chatId === chatId
      ? lastFinishReasonState.finishReason
      : undefined

  const [sentFirstMessageChatId, setSentFirstMessageChatId] = useState<
    string | null
  >(null)
  const [previousChatIdStore] = useState(() => {
    let previousChatId: string | null = chatId

    return {
      get: () => previousChatId,
      set: (nextChatId: string | null) => {
        previousChatId = nextChatId
      },
    }
  })
  const hasSentFirstMessage =
    chatId !== null && sentFirstMessageChatId === chatId
  const setHasSentFirstMessage = useCallback(
    (hasSent: boolean) => {
      setSentFirstMessageChatId(
        hasSent ? (chatId ?? previousChatIdStore.get()) : null
      )
    },
    [chatId, previousChatIdStore]
  )
  const hydratedChatIdRef = useRef<string | null>(null)
  const setLastFinishReason = useCallback(
    (finishReason: string | undefined) => {
      setLastFinishReasonState({
        chatId: chatId ?? previousChatIdStore.get(),
        finishReason,
      })
    },
    [chatId, previousChatIdStore]
  )

  // Search params handling — ?prompt= hydration and the auto-submit form of a
  // shared prompt link. First turns (home and project surfaces) dispatch
  // through runSendTurn directly and never round-trip through the URL.
  const searchParams = useSearchParams()
  const prompt = searchParams.get("prompt")
  const shouldAutoSubmitPrompt = searchParams.get("autoSubmit") === "1"
  // The reference honors the legacy `?message=` deep-link param alongside
  // `?messageId=` (conv.beauty.js:16928 `has("message") || has("messageId")`;
  // its restore gate at 180547 keys on `!!get("message")`).
  const scrollToMessageId =
    searchParams.get("messageId") ?? searchParams.get("message")

  const { updateTitle, applyGeneratedTitle } = useChats()

  const handleStreamData = useCallback(
    (part: { type: string; data: unknown }) => {
      if (part.type !== "data-chatTitle") return
      if (!part.data || typeof part.data !== "object") return

      const data = part.data as {
        chatId?: unknown
        title?: unknown
        generation?: unknown
      }
      if (
        typeof data.chatId !== "string" ||
        typeof data.title !== "string" ||
        typeof data.generation !== "number"
      ) {
        return
      }

      void applyGeneratedTitle(data.chatId, data.title, data.generation)
    },
    [applyGeneratedTitle]
  )

  const handleError = useCallback((error: Error) => {
    const presentation = presentChatStreamError(error)
    if (presentation.kind === "swallow") {
      // A losing approval-continuation POST (another tab's auto-send won) is
      // swallowed without a failed repaint;
      // this tab simply observes the winner's run through the projection.
      console.warn("Approval continuation conflict (another tab won):", error)
      return
    }
    console.error("Chat error:", error)
    console.error("Error message:", error.message)

    toast({
      title: presentation.title,
      status: "error",
    })
  }, [])

  const handleDurableStopError = useCallback((stopError: unknown) => {
    console.error("Durable stop failed:", stopError)
    toast({ title: "Failed to stop generation", status: "error" })
  }, [])

  const handleLocalStreamTimeout = useCallback(() => {
    toast({
      title: "Response timed out — please try again",
      status: "error",
    })
  }, [])

  // Mounted chat-id transitions detach — the in-place equivalent of a remount.
  // Leaving a mounted chat (browser Back/Forward over the shallow-pushState
  // first-turn flow, e.g. Back to the onboarding surface mid-generation) means
  // the same thing as link navigation, which remounts Chat and deliberately
  // leaves the durable run streaming: the run normally settles server-side
  // (ADR-0011; a degraded settlement leaves the run for the supersede sweep or
  // the per-binding watchdog below) and the sidebar keeps its backend-projected
  // generating status. The layout commit replaces useChat's binding before
  // paint with a fresh Chat seeded from this render's `initialMessages` (empty
  // on the onboarding surface, so showOnboarding holds), while the previous
  // instance keeps consuming its stream detached: its deltas never reach the
  // mounted array and no abort is sent. The Stop
  // button, bound to the current instance, stays the only user-facing abort;
  // a durable run-scoped Stop usable after re-entry is deferred alongside
  // ADR-0011's lease/reaper (see docs/adr/0012).
  //
  // null → chatId does NOT detach: first-turn adoption keeps the binding so
  // the optimistic user row and the already-started stream carry into the
  // durable route.
  //
  // The extracted owner binds each SDK Chat to immutable detach metadata and
  // performs route transitions in one layout-phase commit. useChatCore keeps
  // only orchestration and persistence policy.
  // Wire-contract fields for SDK-initiated dispatches (the approval
  // continuation auto-send carries no per-call body — the transport merges
  // these in). Turn context is read at dispatch time, never from a render-time
  // closure; the transport restores a paused approval's applied effort.
  // Continuations only exist on durable chats.
  const getFallbackTurnBody = useCallback(() => {
    if (!chatId || !isAuthenticated) return null
    const snapshot = getTurnSnapshot()
    return buildChatTurnRequestBody({
      chatId,
      userId: user?.id ?? "",
      selectedModel: snapshot.selectedModel,
      systemPrompt: snapshot.systemPrompt,
      enableSearch: snapshot.enableSearch,
      reasoningEffort: snapshot.reasoningEffort,
    })
  }, [chatId, isAuthenticated, getTurnSnapshot, user?.id])

  const detachableStream = useDetachableChatStream({
    chatId,
    isAuthenticated,
    initialMessages,
    streamTimeoutMs: STREAM_TIMEOUT_MS,
    api: API_ROUTE_CHAT,
    getFallbackTurnBody,
  })

  const {
    messages,
    sendMessage,
    regenerate,
    status,
    error,
    stop,
    setMessages,
    addToolApprovalResponse,
    // Canonical AI SDK state updates per stream part; React observes the
    // latest snapshot once per paint, with synchronous non-streaming and
    // terminal publication.
  } = useFrameAlignedChat({ chat: detachableStream.chat })

  // The local stream's assistant identity: durable runs stream the durable
  // assistantMessageId as the SDK message id, so this match is exact. Known
  // only once streaming begins — never inferred from "last run in chat".
  const localAssistantMessageId = useMemo(() => {
    if (status !== "streaming") return null
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === "assistant") return messages[index].id
    }
    return null
  }, [messages, status])

  // Turn marks: every input below is derived only when the
  // build-time instrumentation flag is on; the hook is a no-op otherwise.
  const chatPerfTurnFacts = useMemo(() => {
    if (!isChatPerfClientEnabled()) {
      return {
        hasVisibleAssistantText: false,
        visibleAssistantTextLength: 0,
        lastUserMessageId: undefined as string | undefined,
      }
    }
    return deriveChatPerfTurnFacts(messages)
  }, [messages])
  useChatTurnPerfMarks({
    status,
    hasVisibleAssistantText: chatPerfTurnFacts.hasVisibleAssistantText,
    visibleAssistantTextLength: chatPerfTurnFacts.visibleAssistantTextLength,
    lastUserMessageId: chatPerfTurnFacts.lastUserMessageId,
  })
  // This is the only long-task/rAF-gap observer; another mount would double-count.
  useChatResponsivenessMarks(status === "streaming")

  const { selectedRun, isLoading: isHistoryLoading } = useMessages()
  // Existing sends carry the rendered path's admission token. Wait for the
  // selected binding, query hydration, and the commit projecting its history.
  const isHistoryReady =
    chatId === null ||
    (detachableStream.commit.chatId === chatId &&
      !isHistoryLoading &&
      (initialMessages.length === 0 || messages.length > 0))
  const isSendReady = isChatAdmissionReady && isHistoryReady
  const connectionState = useConvexConnectionState()
  const stopGenerationRunMutation = useMutation(
    api.chatRuntime.stopGenerationRun
  )
  const stopDurableRun = useCallback(
    async (runId: string) => {
      // Read the canonical SDK snapshot; React may be one frame behind it.
      const message =
        selectedRun?.runId === runId
          ? detachableStream.chat.messages.find(
              (message) =>
                message.role === "assistant" &&
                message.id === selectedRun.assistantMessageId
            )
          : undefined
      const observedText = message
        ? extractTextFromMessageParts(message.parts)
        : ""
      await stopGenerationRunMutation({
        runId: runId as Id<"generationRuns">,
        ...(observedText.length > 0 &&
        observedText.length <= MAX_STOP_OBSERVED_TEXT_CHARS
          ? { observedText }
          : {}),
      })
    },
    [detachableStream.chat, selectedRun, stopGenerationRunMutation]
  )
  const generationPresentation = useGenerationPresentationController({
    chatId,
    isAuthenticated,
    localStatus: status,
    localReplayRunId: detachableStream.chat.replayRunId,
    isSubmitting,
    localAssistantMessageId,
    selectedRun,
    isConnected: connectionState.isWebSocketConnected,
    stopLocal: stop,
    stopDurable: stopDurableRun,
    onDurableStopError: handleDurableStopError,
    streamTimeoutMs: STREAM_TIMEOUT_MS,
    onLocalStreamTimeout: handleLocalStreamTimeout,
  })
  const {
    presentation,
    stop: handleStop,
    resetLocalStopIntent,
    noteLocalDispatch,
    noteLocalTransportSettled,
    consumeLocalStopIntent,
  } = generationPresentation

  const setMessagesRef = useRef(setMessages)
  useEffect(() => {
    setMessagesRef.current = setMessages
  }, [setMessages])

  // Latest live turn array, read by the selected-path projection effect without
  // making it re-run on every streaming delta; and live generation state, read
  // by the edit guard at call time so a stale `submitEdit` closure can't refuse
  // an edit with an outdated status. Synced post-render (refs are not touched
  // during render).
  const messagesRef = useRef(messages)
  const statusRef = useRef(status)
  const isSubmittingRef = useRef(isSubmitting)
  useLayoutEffect(() => {
    messagesRef.current = messages
    statusRef.current = status
    isSubmittingRef.current = isSubmitting
  })
  const getStatus = useCallback(() => statusRef.current, [])
  const getIsSubmitting = useCallback(() => isSubmittingRef.current, [])
  // Call-time read of the live turn array for the edit/regeneration runners.
  // Their plans validate against a specific message's server-adopted state
  // (createdAt cutoff, visible count), and the message rows holding these
  // callbacks are memoized with comparators that ignore callback identity — a
  // render-time `messages` closure goes stale there and dispatches
  // pre-adoption timestamps the server guards reject.
  const getMessages = useCallback(
    () => messagesRef.current as ChatTurnMessage[],
    []
  )

  const updateMessages = useCallback(
    (action: Parameters<typeof setMessages>[0]) => {
      setMessagesRef.current(action)
    },
    []
  )

  const getIsSending = useCallback(() => isSendingStore.get(), [isSendingStore])

  const setIsSending = useCallback(
    (value: boolean) => {
      isSendingStore.set(value)
    },
    [isSendingStore]
  )

  const stagePendingEdit = useCallback(
    (message: ChatTurnMessage, currentChatId: string) => {
      pendingEditStore.stage(message, currentChatId)
    },
    [pendingEditStore]
  )

  const getPendingEdit = useCallback(
    () => pendingEditStore.get(),
    [pendingEditStore]
  )

  const clearPendingEdit = useCallback(() => {
    pendingEditStore.clear()
  }, [pendingEditStore])

  const setPreviousChatId = useCallback(
    (currentChatId: string) => {
      previousChatIdStore.set(currentChatId)
    },
    [previousChatIdStore]
  )

  const chatTurn = createChatTurnController({
    createOptimisticMessageId,
    getTurnSnapshot,
    getCurrentChatId: () => chatId,
    getIsSending,
    setIsSending,
    setIsSubmitting,
    setHasSentFirstMessage,
    setMessages: (action) => setMessages(action),
    // The controller composes its turn store from these internally — this hook
    // never builds or holds the store.
    store: {
      isAuthenticated: () => isAuthenticated,
      updateMessages,
      cacheAndAddMessage,
      updateTitle,
      pendingEdit: {
        stage: stagePendingEdit,
        get: getPendingEdit,
        clear: clearPendingEdit,
      },
      getStoredGuestChatId: () =>
        typeof window !== "undefined"
          ? localStorage.getItem(GUEST_CHAT_STORAGE_KEY)
          : null,
      reportError: (message, error) => console.error(message, error),
    },
    resolveUserId: () => getOrCreateGuestUserId(user),
    checkLimitsAndNotify,
    firstTurn,
    ensureChatExists,
    setPreviousChatId,
    cleanupOptimisticAttachments: () => undefined,
    attachStagedFiles: (currentChatId, attachmentIds) =>
      attachStagedFilesToChat(convex, currentChatId, attachmentIds),
    sendMessage,
    sendMessageAndWaitForAcceptance: (message, options) =>
      detachableStream.sendMessageAndWaitForAcceptance(
        sendMessage,
        message,
        options
      ),
    regenerate,
    resetLocalStopIntent,
    onLocalDispatch: noteLocalDispatch,
    consumeLocalStopIntent,
    toastError: (title) => toast({ title, status: "error" }),
    bumpChat,
    setLastFinishReason,
    reportError: (message, error) => console.error(message, error),
  })

  // Finish handling for the ATTACHED binding — the pre-detach behavior,
  // unchanged: stamp createdAt, then hand the turn to the controller with the
  // mounted surface's identity.
  const handleAttachedFinish = async ({
    message,
    isAbort,
    isDisconnect,
    isError,
    finishReason,
  }: ChatStreamFinishEvent) => {
    noteLocalTransportSettled()
    const messageWithCreatedAt = message as ChatTurnMessage
    const finishedMessageCreatedAt =
      messageWithCreatedAt.createdAt ?? new Date()
    const finishedMessage: ChatTurnMessage = {
      ...message,
      createdAt: finishedMessageCreatedAt,
    }

    setMessages((prev) =>
      prev.map((currentMessage) => {
        const currentWithCreatedAt = currentMessage as ChatTurnMessage
        return currentMessage.id === finishedMessage.id &&
          !currentWithCreatedAt.createdAt
          ? { ...currentMessage, createdAt: finishedMessageCreatedAt }
          : currentMessage
      })
    )

    await chatTurn.finishChatTurn({
      message: finishedMessage,
      isAbort,
      isDisconnect,
      isError,
      finishReason,
      chatId,
      previousChatId: previousChatIdStore.get(),
    })
  }

  // Finish handling for a DETACHED binding — routes to the binding's frozen
  // origin, never to current navigation state. Durable chats are
  // server-persisted (ADR-0011) and get no client copy; guest/local chats
  // persist the (possibly partial) assistant message into the origin chat's
  // IndexedDB cache. Mounted-surface UI state (createdAt stamping in the live
  // array, lastFinishReason, error toasts) is deliberately skipped: it belongs
  // to whatever chat the surface shows now, not to this stream.
  const finishDetachedTurn = async (
    ownerChatId: string | null,
    { message }: ChatStreamFinishEvent
  ) => {
    if (!ownerChatId) return
    const routePersists = routePersistsChatMessages(
      ownerChatId,
      isAuthenticated
    )

    // Only this binding's own pending edit — a newer chat's staged edit must
    // survive an unrelated detached finish untouched.
    const pendingEdit = pendingEditStore.get()
    if (pendingEdit && pendingEdit.chatId === ownerChatId) {
      pendingEditStore.clear()
      if (!routePersists) {
        try {
          await cacheAndAddMessage(pendingEdit.message, ownerChatId)
        } catch (persistError) {
          console.error(
            "Failed to persist pending edit for a detached chat stream:",
            persistError
          )
        }
      }
    }

    if (routePersists) return
    const finishedMessage = message as ChatTurnMessage
    if (isEmptyAssistantMessage(finishedMessage)) return
    try {
      await cacheAndAddMessage(
        finishedMessage.createdAt
          ? finishedMessage
          : { ...finishedMessage, createdAt: new Date() },
        ownerChatId
      )
    } catch (persistError) {
      console.error(
        "Failed to persist a detached chat stream's assistant message:",
        persistError
      )
    }
  }

  useCommitDetachableChatStream({
    stream: detachableStream,
    chatId,
    initialMessages,
    selectedRun,
    isAuthenticated,
    isHistoryLoading,
    isSubmitting,
    handlers: {
      onData: handleStreamData,
      onAttachedFinish: handleAttachedFinish,
      onDetachedFinish: finishDetachedTurn,
      onAttachedError: (streamError) => {
        noteLocalTransportSettled()
        handleError(streamError)
      },
      onDetachedError: (_originChatId, streamError) => {
        // No toast: a detached stream's error has no visible surface here;
        // durable chats surface it through the run's terminal projection.
        console.error("Detached chat stream error:", streamError)
      },
    },
    onChatTransition: (previousChatId, nextChatId) => {
      previousChatIdStore.set(nextChatId)
      if (previousChatId !== null) hydratedChatIdRef.current = null
    },
  })

  const handleToolApproval = useCallback(
    async (approvalId: string, approved: boolean, reason?: string) => {
      try {
        // Pending-only resolution: the mutation returns the canonical decision,
        // so a conflicting second click adopts the
        // winner instead of overwriting it.
        const decision = approved
          ? await approveToolCall({ approvalId, reason })
          : await denyToolCall({ approvalId, reason })

        if (decision.status === "expired") {
          toast({ title: "This approval has expired", status: "error" })
          return
        }
        if (!decision.alreadyResolved) {
          // Only the WINNING tab arms the auto-send continuation (layer 3);
          // a loser renders the canonical outcome and dispatches nothing —
          // the winner's continuation arrives through the projection.
          markApprovalResolvedLocally(approvalId)
          noteLocalDispatch()
        } else {
          toast({
            title: "Already resolved",
            description: "This approval was decided in another tab.",
            status: "info",
          })
        }
        addToolApprovalResponse({
          id: approvalId,
          approved: decision.status === "approved",
          // The CANONICAL reason: a losing click renders the winner's
          // decision, reason included — never its own discarded input.
          reason: decision.reason,
        })
      } catch (error) {
        console.error("Failed to submit tool approval:", error)
        toast({
          title: "Failed to submit tool approval",
          status: "error",
        })
      }
    },
    [addToolApprovalResponse, approveToolCall, denyToolCall, noteLocalDispatch]
  )

  // Hydrate on chat entry, then keep the live turn array projected onto the
  // backend-derived selected path. `initialMessages` is the reactive selected
  // path from the messages provider; for durable chats it is the source of
  // truth for ancestry and branch state. The single projection seam
  // (`projectSelectedPath`) installs it: adopting server ids + branch metadata,
  // preserving in-flight sends, and swapping wholesale on a branch switch.
  useEffect(() => {
    if (!chatId) return

    // Route through the ref, never the raw `setMessages` dep. The AI SDK's
    // `setMessages` is not referentially stable, so depending on it would re-run
    // this effect every render — and a project-then-set cycle becomes an
    // infinite render loop. The ref is the same seam the rest of this hook uses.
    const applyMessages = setMessagesRef.current

    const isNewChat = hydratedChatIdRef.current !== chatId
    if (isNewChat) {
      hydratedChatIdRef.current = chatId
      // A fresh conversation acquires its durable route before the messages
      // query is guaranteed to contain the optimistic user row (or the
      // assistant stream that may already have started). Route first entry
      // through the same selected-path seam as later snapshots so an empty or
      // partial server path cannot erase live turn state during that lag.
      applyMessages((live) => {
        const liveTurn = live as ChatTurnMessage[]
        const serverPath = initialMessages as ChatTurnMessage[]
        // Entry can now happen mid-stream: returning to a generating chat
        // re-adopts its live binding (use-detachable-chat-stream.ts). The
        // identity-matched reconcile stays safe there (parts adoption is
        // monotonic, the lagging snapshot never truncates fresher local
        // text), but a wholesale branch swap would yank the array out from
        // under the SDK's active response — defer divergence to the
        // settle-time projection below, which owns it once status is ready.
        if (
          (status === "streaming" || status === "submitted") &&
          isSelectedPathDivergent(liveTurn, serverPath)
        ) {
          return live
        }
        return projectSelectedPath(liveTurn, serverPath)
      })
      return
    }

    if (!isAuthenticated) {
      // Guest/local chats have no server selected path to project.
      if (initialMessages.length > 0) {
        applyMessages((prev) => (prev.length === 0 ? initialMessages : prev))
      }
      return
    }

    // The AI SDK owns the array mid-stream; project once it settles. "error"
    // is included so a server-rejected edit/regenerate (e.g. the
    // expectedChatVersion guard) re-projects the last good selected path
    // instead of leaving the sliced-out messages vanished until reload.
    if (status !== "ready" && status !== "error") return
    if (initialMessages.length === 0) return

    const next = projectSelectedPath(
      messagesRef.current as ChatTurnMessage[],
      initialMessages as ChatTurnMessage[]
    )
    if (next !== messagesRef.current) {
      applyMessages(next)
    }
  }, [chatId, isAuthenticated, initialMessages, status])

  // Shared prompt links hydrate without auto-submitting.
  useEffect(() => {
    if (prompt && !shouldAutoSubmitPrompt && typeof window !== "undefined") {
      requestAnimationFrame(() => setComposerText?.(prompt))
    }
  }, [prompt, shouldAutoSubmitPrompt, setComposerText])

  // Submit action — one send-type Chat turn from a Composer payload. Returns
  // whether the turn was accepted (dispatched), so the Composer knows whether
  // to clear its persisted draft.
  const submitForCurrentRender = useCallback(
    async ({ text, files, attachments }: ChatTurnPayload): Promise<boolean> => {
      if (!isSendReady) return false
      const submittedFiles = [...files]
      const optimisticAttachments = attachments.flatMap((attachment) =>
        typeof attachment.name === "string" &&
        typeof attachment.contentType === "string" &&
        typeof attachment.url === "string"
          ? [
              {
                name: attachment.name,
                contentType: attachment.contentType,
                url: attachment.url,
              },
            ]
          : []
      )

      // Fresh per-turn correlation id + chat_send_intent mark (no-op unless
      // instrumentation is enabled); the transport consumes the armed header.
      const perfTurnId = beginChatPerfTurn()

      let accepted = false
      try {
        await chatTurn.runSendTurn({
          text,
          messages,
          submittedFiles,
          submittedAttachments: attachments,
          optimisticAttachments,
          chatVersion: messages.length + 1, // current messages + 1 for the new message being sent
          onSuccess: (currentChatId) => {
            accepted = true
            if (messages.length > 0) {
              bumpChat(currentChatId)
            }
          },
        })
      } finally {
        if (!accepted) {
          clearArmedChatPerfHeader(perfTurnId)
        }
      }
      return accepted
    },
    [chatTurn, messages, bumpChat, isSendReady]
  )

  // Stable event identity; each invocation retains its committed turn snapshot.
  const committedSubmitRef = useRef(submitForCurrentRender)
  useInsertionEffect(() => {
    committedSubmitRef.current = submitForCurrentRender
  }, [submitForCurrentRender])
  const submit = useCallback(
    (payload: ChatTurnPayload) => committedSubmitRef.current(payload),
    []
  )

  const autoSubmittedPromptRef = useRef<string | null>(null)
  useEffect(() => {
    if (
      !chatId ||
      !prompt ||
      !shouldAutoSubmitPrompt ||
      typeof window === "undefined"
    ) {
      return
    }

    // Wait for preferences and existing history before consuming the once-
    // guard, so the turn retries with the correct model and selected path.
    if (!turnContextHydrated || !isSendReady) return

    const autoSubmitKey = `${chatId}:${prompt}`
    if (autoSubmittedPromptRef.current === autoSubmitKey) return
    autoSubmittedPromptRef.current = autoSubmitKey

    void (async () => {
      try {
        const accepted = await submit({
          text: prompt,
          files: [],
          attachments: [],
        })
        if (!accepted) {
          autoSubmittedPromptRef.current = null
          return
        }

        const nextUrl = new URL(window.location.href)
        nextUrl.searchParams.delete("prompt")
        nextUrl.searchParams.delete("autoSubmit")
        window.history.replaceState(
          window.history.state,
          "",
          `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`
        )
      } catch {
        autoSubmittedPromptRef.current = null
      }
    })()
  }, [
    chatId,
    prompt,
    shouldAutoSubmitPrompt,
    turnContextHydrated,
    isSendReady,
    submit,
  ])

  const { submitEdit } = useChatEdit({
    chatTurn,
    chatId,
    getMessages,
    getStatus,
    getIsSubmitting,
  })

  // Read live messages because memoized assistant rows retain this callback.
  const handleReload = useCallback(
    async (messageId: string, overrides?: RegenerationTurnOverrides) => {
      const currentMessages = getMessages()
      await chatTurn.runRegenerationTurn({
        chatId,
        messages: currentMessages,
        targetAssistantMessageId: messageId,
        chatVersion: currentMessages.length, // same count since we're regenerating, not adding
        isSubmitting: getIsSubmitting(),
        status: getStatus(),
        ...overrides,
      })
    },
    [chatTurn, chatId, getMessages, getIsSubmitting, getStatus]
  )

  return {
    messages,
    status,
    replayingMessageId: detachableStream.chat.replayingMessageId,
    error,
    // Stop local transport first, then settle the exact run so all tabs converge.
    stop: handleStop,
    presentation,
    setMessages,
    isAuthenticated,
    systemPrompt,
    hasSentFirstMessage,
    setHasSentFirstMessage,

    sendMessage,
    regenerate,

    isSubmitting,
    isSendReady,
    setIsSubmitting,
    hasDialogAuth,
    setHasDialogAuth,
    lastFinishReason,
    scrollToMessageId,

    submit,
    handleReload,
    submitEdit,
    handleToolApproval,
  }
}
