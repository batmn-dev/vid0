import type { StreamTextTransform, TextStreamPart, ToolSet } from "ai"

type TextDeltaPart = Extract<TextStreamPart<ToolSet>, { type: "text-delta" }>

/**
 * Adaptive text smoothing at the server stream seam.
 *
 * Provider chunk boundaries are transport artifacts: one provider may send a
 * word at a time while another sends a paragraph slab, and even fine-looking
 * providers can burst many small deltas in one network read. This transform
 * reconstructs word-like chunks across delta boundaries, then drains them at
 * a rate derived from observed arrival throughput and current queue pressure.
 *
 * Invariants:
 *
 * - Text only. Non-text parts retain their order behind preceding text.
 * - One canonical stream. The transformed bytes are what onChunk, persistence,
 *   and the client all observe.
 * - Bounded lag. Queue pressure accelerates the drain so the oldest text is
 *   never intentionally held more than MAX_BUFFERED_MS.
 * - Abort aware. Cancellation clears partial text, queued parts, and the
 *   active timer before emitting the explicit abort terminal.
 */

const MIN_REVEAL_RATE_CHARS_PER_MS = 0.3
const ARRIVAL_RATE_HEADROOM = 1.1
const ARRIVAL_RATE_WINDOW_MS = 1000
const MIN_WORD_DELAY_MS = 5
const MAX_WORD_DELAY_MS = 80
const MAX_BUFFERED_MS = 400
const MAX_PARTIAL_WORD_WAIT_MS = 80
const MAX_PARTIAL_WORD_CHARS = 64

const MEASURED_WORD_CHUNKING_TARGETS = [
  {
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
  },
  {
    provider: "google",
    model: "gemini-3.5-flash",
  },
] as const

const wordSegmenter = new Intl.Segmenter(undefined, {
  granularity: "word",
})

/**
 * Keep server-side smoothing evidence-gated. Adding a target requires a trace
 * through this app that demonstrates coarse provider deltas after the
 * frame-aligned client path (ADR-0016).
 */
export function isWordChunkingEligible(options: {
  provider: string
  model: string
}): boolean {
  return MEASURED_WORD_CHUNKING_TARGETS.some(
    (target) =>
      target.provider === options.provider && target.model === options.model
  )
}

/** Split into whitespace-attached word chunks; concatenation is identity. */
export function splitIntoWordChunks(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [text]
}

function extractCompleteWordChunks(text: string): {
  chunks: string[]
  remainder: string
} {
  if (text.length === 0) return { chunks: [], remainder: "" }

  const segments = [...wordSegmenter.segment(text)]
  const endsAtBoundary = /[\s\p{P}\p{S}]$/u.test(text)
  const finalSegment = segments.at(-1)
  const safeEnd =
    !endsAtBoundary && finalSegment?.isWordLike
      ? finalSegment.index
      : text.length

  if (safeEnd === 0) return { chunks: [], remainder: text }

  const chunks: string[] = []
  let currentChunk = ""
  let currentChunkHasWord = false
  for (const segment of segments) {
    if (segment.index >= safeEnd) break
    const segmentText = segment.segment.slice(0, safeEnd - segment.index)
    if (segment.isWordLike && currentChunkHasWord) {
      chunks.push(currentChunk)
      currentChunk = ""
      currentChunkHasWord = false
    }
    currentChunk += segmentText
    currentChunkHasWord ||= segment.isWordLike === true
  }
  if (currentChunk.length > 0) chunks.push(currentChunk)

  return {
    chunks,
    remainder: text.slice(safeEnd),
  }
}

export function createWordChunkingTransform<TOOLS extends ToolSet>(
  abortSignal?: AbortSignal
): StreamTextTransform<TOOLS> {
  return () => {
    type PendingPart = {
      part: TextStreamPart<TOOLS>
      arrivedAtMs: number
      textChars: number
    }

    let cancelled = false
    let wake: (() => void) | null = null
    let partialWordTimer: ReturnType<typeof setTimeout> | null = null
    let drainPromise: Promise<void> | null = null
    let abortListenerAttached = false
    let streamController:
      TransformStreamDefaultController<TextStreamPart<TOOLS>> | undefined

    let pendingText = ""
    let pendingTextTemplate: TextDeltaPart | undefined
    let pendingTextArrivedAtMs = 0

    let queuedTextChars = 0
    let estimatedArrivalRate = MIN_REVEAL_RATE_CHARS_PER_MS
    let lastTextArrivalAtMs: number | null = null
    let nextEmitAtMs = 0
    const pending: PendingPart[] = []

    const removeAbortListener = () => {
      if (!abortListenerAttached || !abortSignal) return
      abortSignal.removeEventListener("abort", handleExecutionAbort)
      abortListenerAttached = false
    }

    const clearPartialWordTimer = () => {
      if (partialWordTimer === null) return
      clearTimeout(partialWordTimer)
      partialWordTimer = null
    }

    const clearPending = () => {
      clearPartialWordTimer()
      pending.length = 0
      pendingText = ""
      pendingTextTemplate = undefined
      pendingTextArrivedAtMs = 0
      queuedTextChars = 0
    }

    const cancelDrain = (emitAbort: boolean) => {
      if (cancelled) return
      cancelled = true
      clearPending()
      wake?.()
      removeAbortListener()
      if (emitAbort && streamController) {
        // AI SDK may already have filled its upstream queue while this
        // transform is pacing, leaving no later pull on which its own abort
        // observer can publish. Terminalize the transformed stream explicitly.
        streamController.enqueue({
          type: "abort",
          reason: "stream aborted",
        })
        streamController.terminate()
      }
    }

    const handleExecutionAbort = () => cancelDrain(true)

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = null
          resolve()
        }, ms)
        wake = () => {
          clearTimeout(timer)
          wake = null
          resolve()
        }
      })

    const observeTextArrival = (textChars: number, arrivedAtMs: number) => {
      if (lastTextArrivalAtMs !== null) {
        const elapsedMs = Math.max(1, arrivedAtMs - lastTextArrivalAtMs)
        const instantaneousRate = textChars / elapsedMs
        const weight = 1 - Math.exp(-elapsedMs / ARRIVAL_RATE_WINDOW_MS)
        estimatedArrivalRate +=
          (instantaneousRate - estimatedArrivalRate) * weight
      }
      lastTextArrivalAtMs = arrivedAtMs
    }

    const enqueue = (part: TextStreamPart<TOOLS>, arrivedAtMs: number) => {
      const textChars = part.type === "text-delta" ? part.text.length : 0
      queuedTextChars += textChars
      pending.push({ part, arrivedAtMs, textChars })
    }

    const flushPendingText = () => {
      clearPartialWordTimer()
      if (!pendingTextTemplate || pendingText.length === 0) return
      enqueue(
        { ...pendingTextTemplate, text: pendingText },
        pendingTextArrivedAtMs
      )
      pendingText = ""
      pendingTextTemplate = undefined
      pendingTextArrivedAtMs = 0
    }

    const armPartialWordTimer = () => {
      if (partialWordTimer !== null) return
      partialWordTimer = setTimeout(() => {
        partialWordTimer = null
        if (cancelled) return
        flushPendingText()
        if (streamController) ensureDrain(streamController)
      }, MAX_PARTIAL_WORD_WAIT_MS)
    }

    const appendText = (part: TextDeltaPart, arrivedAtMs: number) => {
      // Metadata belongs to this delta, not an earlier held word's template.
      if (part.providerMetadata !== undefined) {
        flushPendingText()
        if (part.text.length === 0) {
          enqueue(part, arrivedAtMs)
          return
        }
      }
      observeTextArrival(part.text.length, arrivedAtMs)

      if (pendingTextTemplate && pendingTextTemplate.id !== part.id) {
        flushPendingText()
      }
      if (!pendingTextTemplate) {
        pendingTextTemplate = part
        pendingTextArrivedAtMs = arrivedAtMs
      }

      pendingText += part.text
      const { chunks, remainder } = extractCompleteWordChunks(pendingText)
      for (const chunk of chunks) {
        enqueue({ ...pendingTextTemplate, text: chunk }, pendingTextArrivedAtMs)
      }
      pendingText = remainder
      if (chunks.length > 0) {
        // The held word completed and was enqueued above. The remainder (if
        // any) is a NEW word whose first fragment arrived in this delta, so
        // its holdback deadline and lag budget start now — otherwise a timer
        // armed for an earlier word fires mid-cycle and flushes a partial that
        // has barely been held, splitting words that would complete in time.
        clearPartialWordTimer()
        pendingTextArrivedAtMs = arrivedAtMs
      }

      if (pendingText.length >= MAX_PARTIAL_WORD_CHARS) {
        flushPendingText()
      } else if (pendingText.length === 0) {
        clearPartialWordTimer()
        pendingTextTemplate = undefined
        pendingTextArrivedAtMs = 0
      } else {
        // Hold one incomplete word briefly so provider token boundaries do not
        // become presentation boundaries. Fragments of the SAME word never
        // reset the timer, so the deadline cannot be extended indefinitely and
        // time-to-first-visible-text stays bounded even when the provider
        // pauses mid-word.
        armPartialWordTimer()
      }
    }

    const drain = async (
      controller: TransformStreamDefaultController<TextStreamPart<TOOLS>>
    ) => {
      while (!cancelled) {
        const next = pending.shift()
        if (!next) return

        const { part, arrivedAtMs, textChars } = next
        if (part.type !== "text-delta") {
          controller.enqueue(part)
          continue
        }

        const waitMs = Math.max(0, Math.round(nextEmitAtMs - Date.now()))
        if (waitMs > 0) await sleep(waitMs)
        if (cancelled) return

        controller.enqueue(part)
        queuedTextChars -= textChars

        const remainingLagMs = Math.max(
          1,
          arrivedAtMs + MAX_BUFFERED_MS - Date.now()
        )
        const catchUpRate = queuedTextChars / remainingLagMs
        const nextTextChars = pending[0]?.textChars || textChars
        const targetRate = Math.max(
          MIN_REVEAL_RATE_CHARS_PER_MS,
          estimatedArrivalRate * ARRIVAL_RATE_HEADROOM
        )
        const steadyDelayMs = Math.min(
          MAX_WORD_DELAY_MS,
          Math.max(MIN_WORD_DELAY_MS, nextTextChars / targetRate)
        )
        const catchUpDelayMs =
          catchUpRate > 0
            ? nextTextChars / catchUpRate
            : Number.POSITIVE_INFINITY

        nextEmitAtMs = Date.now() + Math.min(steadyDelayMs, catchUpDelayMs)
      }
    }

    const ensureDrain = (
      controller: TransformStreamDefaultController<TextStreamPart<TOOLS>>
    ) => {
      if (drainPromise || cancelled) return
      drainPromise = drain(controller).finally(() => {
        drainPromise = null
        if (pending.length > 0 && !cancelled) ensureDrain(controller)
      })
    }

    // `cancel` is part of the runtime Transformer contract (invoked when the
    // readable side is cancelled) but predates this TS lib's Transformer type.
    const transformer: Transformer<
      TextStreamPart<TOOLS>,
      TextStreamPart<TOOLS>
    > & { cancel: () => void } = {
      start(controller) {
        streamController = controller
        if (!abortSignal) return
        if (abortSignal.aborted) {
          handleExecutionAbort()
          return
        }
        abortSignal.addEventListener("abort", handleExecutionAbort, {
          once: true,
        })
        abortListenerAttached = true
      },

      transform(part, controller) {
        if (cancelled) return
        const arrivedAtMs = Date.now()
        if (part.type === "text-delta") {
          appendText(part, arrivedAtMs)
        } else {
          flushPendingText()
          enqueue(part, arrivedAtMs)
        }
        ensureDrain(controller)
      },

      async flush() {
        try {
          flushPendingText()
          if (streamController) ensureDrain(streamController)
          while (drainPromise) await drainPromise
        } finally {
          removeAbortListener()
        }
      },

      cancel() {
        cancelDrain(false)
      },
    }

    return new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>(
      transformer
    )
  }
}
