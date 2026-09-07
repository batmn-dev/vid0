import type { SelectedRunProjection } from "@/convex/messages"
import { useDeadlineReached, usePeriodicClock } from "@/hooks/use-clock"
import {
  resolveGenerationPresentation,
  type GenerationPresentation,
  type LocalTransportStatus,
} from "@/lib/chat-runs/run-presentation"
import { noteChatPerfStopIntent } from "@/lib/observability/chat-performance-client"
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react"

const PRESENTATION_TICK_MS = 5_000
const DEFERRED_STOP_TIMEOUT_MS = 30_000

type DeferredStop = {
  chatId: string
  priorRunId: string | null
  expiresAt: number
  localStopIssued: boolean
}

type ControllerState = {
  chatId: string | null
  localStreamStartedAtMs: number | null
  pendingStopRunId: string | null
  deferredStop: DeferredStop | null
}

type GenerationPresentationControllerArgs = {
  chatId: string | null
  /** Durable (signed-in) chats stop through the run; guests stop locally. */
  isAuthenticated: boolean
  localStatus: LocalTransportStatus
  isSubmitting: boolean
  localAssistantMessageId: string | null
  localReplayRunId?: string | null
  selectedRun: SelectedRunProjection | null
  isConnected: boolean
  stopLocal: () => void | Promise<void>
  stopDurable: (runId: string) => Promise<void>
  onDurableStopError: (error: unknown) => void
  streamTimeoutMs: number
  onLocalStreamTimeout: () => void
}

export type GenerationPresentationController = {
  presentation: GenerationPresentation
  stop: () => Promise<void>
  resetLocalStopIntent: () => void
  noteLocalDispatch: () => void
  noteLocalTransportSettled: () => void
  consumeLocalStopIntent: () => boolean
}

function initialControllerState(chatId: string | null): ControllerState {
  return {
    chatId,
    localStreamStartedAtMs: null,
    pendingStopRunId: null,
    deferredStop: null,
  }
}

/**
 * Owns the client-only control state around the pure presentation resolver:
 * local dispatch identity, one exact deferred Stop intent, the in-flight Stop
 * id, wall-clock freshness, and the two external convergence commands.
 *
 * Dispatch timestamps are event-owned (the Chat turn controller announces the
 * dispatch) rather than mirrored from transport status. Timers subscribe as
 * external stores. The single layout synchronization below is reserved for
 * external facts that arrive independently of a user event: a Convex run
 * projection can satisfy a deferred Stop or terminalize a locally attached
 * transport.
 */
export function useGenerationPresentationController({
  chatId,
  isAuthenticated,
  localStatus,
  isSubmitting,
  localAssistantMessageId,
  localReplayRunId,
  selectedRun,
  isConnected,
  stopLocal,
  stopDurable,
  onDurableStopError,
  streamTimeoutMs,
  onLocalStreamTimeout,
}: GenerationPresentationControllerArgs): GenerationPresentationController {
  const [state, setState] = useState<ControllerState>(() =>
    initialControllerState(chatId)
  )
  const activeState =
    state.chatId === chatId ? state : initialControllerState(chatId)

  const deferredDeadline = activeState.deferredStop?.expiresAt ?? null
  const deferredDeadlineReached = useDeadlineReached(deferredDeadline)
  const fallbackStreamDeadline = useMemo(
    () => (localStatus === "streaming" ? Date.now() + streamTimeoutMs : null),
    [localStatus, streamTimeoutMs]
  )
  const streamDeadline =
    localStatus === "streaming"
      ? activeState.localStreamStartedAtMs === null
        ? fallbackStreamDeadline
        : activeState.localStreamStartedAtMs + streamTimeoutMs
      : null
  const streamDeadlineReached = useDeadlineReached(streamDeadline)
  const runCouldGoStale =
    selectedRun !== null &&
    (selectedRun.status === "running" ||
      selectedRun.status === "streaming" ||
      selectedRun.status === "awaiting_approval")
  const presentationNow = usePeriodicClock(
    runCouldGoStale,
    PRESENTATION_TICK_MS
  )

  const presentation = useMemo(
    () =>
      resolveGenerationPresentation({
        localStatus,
        isSubmitting,
        localAssistantMessageId,
        localReplayRunId,
        selectedRun,
        pendingStopRunId: activeState.pendingStopRunId,
        deferredStopPending: activeState.deferredStop !== null,
        localStreamStartedAtMs: activeState.localStreamStartedAtMs,
        isConnected,
        now: presentationNow,
      }),
    [
      localStatus,
      isSubmitting,
      localAssistantMessageId,
      localReplayRunId,
      selectedRun,
      activeState.pendingStopRunId,
      activeState.deferredStop,
      activeState.localStreamStartedAtMs,
      isConnected,
      presentationNow,
    ]
  )

  // Event-owned, one-shot command fact. React state is deliberately not used:
  // stopLocal() can synchronously reject the in-flight acceptance waiter before
  // a state update renders, and the Chat turn controller must classify that
  // rejection in the same command turn.
  const localStopIntentRef = useRef(false)

  const resetLocalStopIntent = useCallback(() => {
    localStopIntentRef.current = false
  }, [])

  const noteLocalDispatch = useCallback(() => {
    localStopIntentRef.current = false
    const startedAt = Date.now()
    setState((current) => ({
      ...(current.chatId === chatId ? current : initialControllerState(chatId)),
      localStreamStartedAtMs: startedAt,
    }))
  }, [chatId])

  const noteLocalTransportSettled = useCallback(() => {
    setState((current) =>
      current.chatId === chatId
        ? { ...current, localStreamStartedAtMs: null }
        : current
    )
  }, [chatId])

  const consumeLocalStopIntent = useCallback(() => {
    const requested = localStopIntentRef.current
    localStopIntentRef.current = false
    return requested
  }, [])

  const fireDurableStop = useCallback(
    async (runId: string) => {
      setState((current) => ({
        ...(current.chatId === chatId
          ? current
          : initialControllerState(chatId)),
        pendingStopRunId: runId,
      }))
      try {
        await stopDurable(runId)
      } catch (error) {
        onDurableStopError(error)
      } finally {
        setState((current) =>
          current.chatId === chatId && current.pendingStopRunId === runId
            ? { ...current, pendingStopRunId: null }
            : current
        )
      }
    },
    [chatId, onDurableStopError, stopDurable]
  )

  const stop = useCallback(async () => {
    // Record Stop before persistence branching or deferred-stop work.
    noteChatPerfStopIntent()
    localStopIntentRef.current = true
    if (!chatId || !isAuthenticated) {
      void stopLocal()
      return
    }

    if (
      selectedRun?.status === "completed" &&
      localReplayRunId === selectedRun.runId
    ) {
      void stopLocal()
      return
    }

    const targetRunId = presentation.stopTargetRunId
    if (targetRunId) {
      // Capture the prefix before abort, then freeze delivery without waiting
      // for the durable transaction's round trip.
      const pendingStop = fireDurableStop(targetRunId)
      void stopLocal()
      await pendingStop
      return
    }

    // `streaming` is the SDK's post-acceptance boundary: the transport has
    // returned a response and written the first stream update. We can stop the
    // local reader immediately without risking the pre-response durable
    // handoff. While still `submitted`, wait for the exact run projection
    // before cutting the request.
    const localStopIssued = localStatus === "streaming"
    setState((current) => ({
      ...(current.chatId === chatId ? current : initialControllerState(chatId)),
      deferredStop: {
        chatId,
        priorRunId: selectedRun?.runId ?? null,
        expiresAt: Date.now() + DEFERRED_STOP_TIMEOUT_MS,
        localStopIssued,
      },
    }))
    if (localStopIssued) void stopLocal()
  }, [
    chatId,
    isAuthenticated,
    fireDurableStop,
    localStatus,
    localReplayRunId,
    presentation.stopTargetRunId,
    selectedRun,
    stopLocal,
  ])

  const firedDeferredStopRef = useRef<string | null>(null)
  const stoppedLocalProjectionRef = useRef<string | null>(null)
  const timedOutStreamRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    if (state.chatId !== chatId) {
      firedDeferredStopRef.current = null
      stoppedLocalProjectionRef.current = null
      timedOutStreamRef.current = null
      setState(initialControllerState(chatId))
      return
    }

    const deferredStop = state.deferredStop
    if (deferredStop && deferredDeadlineReached) {
      setState((current) =>
        current.chatId === chatId ? { ...current, deferredStop: null } : current
      )
    } else if (
      deferredStop &&
      selectedRun !== null &&
      selectedRun.runId !== deferredStop.priorRunId
    ) {
      const commandKey = `${deferredStop.chatId}:${selectedRun.runId}`
      setState((current) =>
        current.chatId === chatId ? { ...current, deferredStop: null } : current
      )
      if (
        firedDeferredStopRef.current !== commandKey &&
        selectedRun.status !== "completed" &&
        selectedRun.status !== "aborted" &&
        selectedRun.status !== "failed"
      ) {
        firedDeferredStopRef.current = commandKey
        void fireDurableStop(selectedRun.runId)
        // The exact run now proves the durable handoff. Capture happens above,
        // and local delivery freezes before the mutation returns.
        if (!deferredStop.localStopIssued) void stopLocal()
      }
    }

    if (presentation.shouldStopLocalStream && selectedRun) {
      const projectionKey = `${selectedRun.runId}:${selectedRun.status}:${selectedRun.terminalReason ?? ""}`
      if (stoppedLocalProjectionRef.current !== projectionKey) {
        stoppedLocalProjectionRef.current = projectionKey
        void stopLocal()
      }
    } else if (!presentation.shouldStopLocalStream) {
      stoppedLocalProjectionRef.current = null
    }

    if (
      streamDeadlineReached &&
      streamDeadline !== null &&
      timedOutStreamRef.current !== streamDeadline
    ) {
      timedOutStreamRef.current = streamDeadline
      void stopLocal()
      onLocalStreamTimeout()
    } else if (streamDeadline === null) {
      timedOutStreamRef.current = null
    }
  }, [
    chatId,
    deferredDeadlineReached,
    fireDurableStop,
    onLocalStreamTimeout,
    presentation.shouldStopLocalStream,
    selectedRun,
    state.chatId,
    state.deferredStop,
    streamDeadline,
    streamDeadlineReached,
    stopLocal,
  ])

  return {
    presentation,
    stop,
    resetLocalStopIntent,
    noteLocalDispatch,
    noteLocalTransportSettled,
    consumeLocalStopIntent,
  }
}
