import { mergeStreamMetadata } from "@/lib/chat-messages/metadata"
import { readTextPhase } from "@/lib/chat-messages/turn-evidence"
import { Chat } from "@ai-sdk/react"
import {
  isToolUIPart,
  readUIMessageStream,
  type ChatInit,
  type UIMessage,
  type UIMessageChunk,
} from "ai"
import {
  retainedChatStreamFrameSchema,
  type RetainedChatStreamFrame,
} from "./protocol"

type Selection = Extract<RetainedChatStreamFrame, { type: "selection" }>

function containsValue(
  next: unknown,
  previous: unknown,
  partialInput = false
): boolean {
  if (previous === undefined || Object.is(next, previous)) return true
  if (partialInput && typeof previous === "string" && typeof next === "string")
    return next.startsWith(previous)
  if (
    !previous ||
    !next ||
    typeof previous !== "object" ||
    typeof next !== "object"
  )
    return false
  if (Array.isArray(previous) !== Array.isArray(next)) return false
  return Object.entries(previous).every(([key, value]) =>
    containsValue((next as Record<string, unknown>)[key], value, partialInput)
  )
}

const toolProgress = {
  "input-streaming": 0,
  "input-available": 1,
  "approval-requested": 2,
  "approval-responded": 3,
  "output-available": 4,
  "output-error": 4,
  "output-denied": 4,
} as const

function hasVisiblePrefix(next: UIMessage, previous: UIMessage | undefined) {
  if (!previous) return true
  const previousParts = previous.parts.filter(
    (part) => part.type !== "step-start"
  )
  const nextParts = next.parts.filter((part) => part.type !== "step-start")
  // Legacy checkpoints have only aggregated strings. SDK checkpoints retain
  // state/metadata and require ordered boundaries, including text phase.
  if (
    previousParts.length <= 2 &&
    previousParts.every(
      (part) => (part.type === "text" || part.type === "reasoning") &&
        part.state === undefined && part.providerMetadata === undefined
    ) &&
    new Set(previousParts.map((part) => part.type)).size === previousParts.length
  ) {
    return (["text", "reasoning"] as const).every((type) => {
      const before = previousParts
        .flatMap((part) => (part.type === type ? [part.text] : []))
        .join("")
      const after = nextParts
        .flatMap((part) => (part.type === type ? [part.text] : []))
        .join("")
      return after.startsWith(before)
    })
  }
  return previousParts.every((part, index) => {
    const candidate = nextParts[index]
    if (!candidate || candidate.type !== part.type) return false
    if (part.type === "text" || part.type === "reasoning") {
      if (!("text" in candidate) || !candidate.text.startsWith(part.text))
        return false
      // Phase changes move text between work and answer. Opaque metadata,
      // such as encrypted reasoning, can legitimately be replaced at the end.
      const phase = part.type === "text" ? readTextPhase(part) : undefined
      return phase === undefined || readTextPhase(candidate) === phase
    }
    if (isToolUIPart(part) && isToolUIPart(candidate)) {
      if (part.toolCallId !== candidate.toolCallId) return false
      const progress = toolProgress[candidate.state] - toolProgress[part.state]
      if (progress < 0 || (progress === 0 && candidate.state !== part.state))
        return false
      // Partial tool inputs may change shape as their JSON becomes complete.
      if (part.state === "input-streaming" && progress > 0) return true
      if (part.state === "output-available" && part.preliminary) {
        const { output: _output, preliminary: _preliminary, ...stable } = part
        return containsValue(candidate, stable)
      }
      const { state: _state, ...visible } = part
      return containsValue(candidate, visible, part.state === "input-streaming")
    }
    return containsValue(candidate, part)
  })
}

/** Rebuild history silently; publish the restored answer and then live chunks. */
export async function consumeRetainedResponse(
  body: ReadableStream<Uint8Array>,
  publish: (message: UIMessage) => void,
  signal: AbortSignal,
  onSelection?: (selection: Selection) => void,
  onCaughtUp?: () => void
) {
  let input: WritableStreamDefaultWriter<UIMessageChunk> | undefined
  let consume: Promise<void> | undefined
  let ended = false
  let caughtUp = false
  let restored: UIMessage | undefined
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener("abort", cancel, { once: true })
  let pending = ""
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = pending.indexOf("\n")) >= 0) {
        if (signal.aborted) break
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (!line.trim()) continue
        const frame = await retainedChatStreamFrameSchema.parseAsync(
          JSON.parse(line)
        )
        if (frame.type === "selection") {
          onSelection?.(frame)
        } else if (frame.type === "base") {
          if (input) throw new Error("Repeated stream base")
          restored = frame.message
          const pipe = new TransformStream<UIMessageChunk, UIMessageChunk>()
          input = pipe.writable.getWriter()
          consume = (async () => {
            for await (const message of readUIMessageStream({
              message: frame.message,
              stream: pipe.readable,
              terminateOnError: true,
            })) {
              if (signal.aborted) break
              restored = message
              if (caughtUp) publish(message)
            }
          })()
          // Attach rejection immediately, including while the reader is waiting.
          void consume.catch(() => {})
        } else if (frame.type === "chunk") {
          if (!input) throw new Error("Missing stream base")
          // Convex owns generation errors; only transport/reducer failures retry.
          if (frame.chunk.type === "error") continue
          await input.write(frame.chunk)
        } else if (frame.type === "caught-up") {
          if (!input) throw new Error("Missing stream base")
          if (restored && !signal.aborted) publish(restored)
          caughtUp = true
          onCaughtUp?.()
        } else if (frame.type === "end") {
          ended = true
        } else {
          throw new Error("Stream replay unavailable")
        }
      }
    }
    if (!ended && !signal.aborted)
      throw new Error("Stream connection interrupted")
  } finally {
    signal.removeEventListener("abort", cancel)
    await reader.cancel().catch(() => {})
    await input?.close().catch(() => {})
    await consume
  }
}

/** Receiving an existing run never invokes send, tool callbacks, or auto-approval. */
export class ResumableChat extends Chat<UIMessage> {
  private observer: AbortController | null = null
  private seenRunId: string | null = null
  private nativeRunId: string | null = null
  private discoveredChatId: string | null = null
  private historicalAssistantId: string | null = null

  constructor(options: ChatInit<UIMessage>) {
    super(options)
    const sendMessage = this.sendMessage
    this.sendMessage = (...args) => {
      this.detachObserver()
      return sendMessage(...args)
    }
    const regenerate = this.regenerate
    this.regenerate = (...args) => {
      this.detachObserver()
      return regenerate(...args)
    }
    const stopRequest = this.stop
    this.stop = async () => {
      this.seenRunId = this.nativeRunId ?? this.seenRunId
      this.disconnectObserver()
      await stopRequest()
    }
  }

  get replayRunId() {
    return this.observer ? this.seenRunId : null
  }

  get replayingMessageId() {
    return this.observer ? this.historicalAssistantId : null
  }

  private disconnectObserver() {
    if (!this.observer) return
    this.observer.abort()
    this.observer = null
    this.historicalAssistantId = null
    this.setStatus({ status: "ready" })
  }

  detachObserver() {
    if (!this.observer) return
    this.disconnectObserver()
    this.seenRunId = null
    this.discoveredChatId = null
  }

  syncRun(
    run: {
      chatId: string
      runId: string
      assistantMessageId: string
      status: string
    } | null,
    initialMessages: UIMessage[],
    conversation?: {
      chatId: string | null
      isAuthenticated: boolean
      isLoading: boolean
      isSubmitting?: boolean
    }
  ) {
    const live = run && ["queued", "running", "streaming"].includes(run.status)
    if (this.observer) {
      // Let successful completion drain its bounded replay. Stop, branch
      // changes and authoritative removal still disconnect immediately.
      if (
        run &&
        (this.seenRunId === null || run.runId === this.seenRunId) &&
        (live || run.status === "completed")
      ) {
        this.seenRunId = run.runId
        return
      }
      if (!run && conversation?.isLoading) return
      this.detachObserver()
    }
    if (conversation?.isSubmitting) return
    const discover =
      !run &&
      conversation?.isAuthenticated &&
      conversation.isLoading &&
      conversation.chatId &&
      this.discoveredChatId !== conversation.chatId
    if (!live && !discover) return
    if (this.status === "submitted" || this.status === "streaming") {
      this.nativeRunId = run?.runId ?? this.nativeRunId
      return
    }
    if (run && this.seenRunId === run.runId) return
    this.seenRunId = run?.runId ?? null
    const chatId = run?.chatId ?? conversation?.chatId
    if (!chatId) return
    this.discoveredChatId = chatId
    const controller = new AbortController()
    this.observer = controller
    if (
      run &&
      !this.messages.some((message) => message.id === run.assistantMessageId)
    )
      this.messages = initialMessages
    void this.receive(
      {
        chatId,
        runId: run?.runId,
        assistantMessageId: run?.assistantMessageId,
      },
      controller
    )
  }

  private async receive(
    run: { chatId: string; runId?: string; assistantMessageId?: string },
    controller: AbortController
  ) {
    const { signal } = controller
    let failures = 0
    this.nativeRunId = null
    try {
      while (!signal.aborted) {
        try {
          const response = await fetch(
            `/api/chat/${encodeURIComponent(run.chatId)}/stream${run.runId ? `?runId=${encodeURIComponent(run.runId)}` : ""}`,
            { signal, cache: "no-store" }
          )
          if ([204, 401, 403, 404].includes(response.status)) return
          if (!response.ok || !response.body)
            throw new Error("Stream temporarily unavailable")
          let restoredCheckpoint = false
          await consumeRetainedResponse(
            response.body,
            (message) => {
              if (signal.aborted || message.id !== run.assistantMessageId)
                return
              const index = this.messages.findIndex(
                (item) => item.id === message.id
              )
              const previous = this.messages[index]
              if (!restoredCheckpoint && !hasVisiblePrefix(message, previous))
                return
              // Once this reader reaches the checkpoint, its ordered SDK
              // updates own mutable tool/data parts until the next reconnect.
              restoredCheckpoint = true
              failures = 0
              this.setStatus({ status: "streaming" })
              const messages = [...this.messages]
              const merged = {
                ...previous,
                ...message,
                metadata: mergeStreamMetadata(
                  previous?.metadata,
                  message.metadata
                ),
              }
              if (index < 0) messages.push(merged)
              else messages[index] = merged
              this.messages = messages
            },
            signal,
            (selection) => {
              if (signal.aborted) return
              if (
                (run.runId && run.runId !== selection.runId) ||
                (this.seenRunId && this.seenRunId !== selection.runId)
              )
                throw new Error("Stream selection changed")
              run.runId = selection.runId
              run.assistantMessageId = selection.assistantMessageId
              this.seenRunId = selection.runId
              this.historicalAssistantId = selection.assistantMessageId
              const visible = this.messages.find(
                (message) => message.id === selection.assistantMessageId
              )
              // Subscription hydration can win the discovery request. Never
              // erase a checkpoint the new document has already displayed.
              this.setStatus({ status: "streaming" })
              if (!visible?.parts.length) {
                this.messages = selection.messages
              }
            },
            () => {
              if (signal.aborted || this.historicalAssistantId === null) return
              this.historicalAssistantId = null
              // Publish the phase transition even if no live delta follows.
              this.messages = [...this.messages]
            }
          )
          return
        } catch {
          if (signal.aborted) return
          // Checkpoints stay visible while the replay service is unavailable.
          this.setStatus({ status: "ready" })
          // A permanently missing log falls back instead of polling all turn.
          if (++failures >= 5) return
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer)
              signal.removeEventListener("abort", finish)
              resolve()
            }
            const timer = setTimeout(
              finish,
              Math.min(750 * 2 ** (failures - 1), 5000)
            )
            signal.addEventListener("abort", finish, { once: true })
          })
        }
      }
    } finally {
      if (this.observer === controller) {
        this.observer = null
        this.historicalAssistantId = null
        this.setStatus({ status: "ready" })
      }
    }
  }
}
