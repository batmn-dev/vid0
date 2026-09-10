import type { StreamTextTransform, TextStreamPart, ToolSet } from "ai"

/**
 * Inline reasoning-tag lift at the server stream seam (ADR-0041, C6).
 *
 * Some providers (Perplexity `sonar-reasoning-pro`) put their reasoning
 * inside the answer text as a literal `<think>…</think>` section. This
 * transform turns that section into ordinary `reasoning-start/delta/end`
 * parts so the durable tracker, the retained stream, and the browser all see
 * the same canonical parts a phased provider would emit, and so persisted
 * `content` never carries the tag text.
 *
 * Invariants:
 *
 * - Text and reasoning only. Every other part passes through in order.
 * - Part order matches reading order. A `text-start` is withheld until the
 *   first answer character, and a `<think>` that opens after answer text
 *   closes that text part and opens a new one (`<id>-<n>`) after the
 *   reasoning, so the UI message never renders answer text above the
 *   reasoning that preceded it.
 * - Tags may split across deltas. At most `"</think>".length - 1` characters
 *   are held back while a partial tag is pending; everything else streams
 *   immediately (ADR-0016). Whitespace glued to a tag is part of the tag.
 * - An unterminated `<think>` closes at `text-end`/`finish`; a partial tag
 *   at the end is emitted as the literal text it was.
 * - Abort aware. After the execution signal fires no text or reasoning is
 *   emitted, but the SDK's `abort` terminal (enqueued upstream of every
 *   experimental_transform) is still forwarded so `toUIMessageStream` sees
 *   `isAborted` and the durable settlement takes the abort path.
 */

export type InlineReasoningTag = "think"

const TAGS: Record<InlineReasoningTag, { open: string; close: string }> = {
  think: { open: "<think>", close: "</think>" },
}

type TextStartPart = Extract<TextStreamPart<ToolSet>, { type: "text-start" }>

/** Longest suffix of `text` that is a proper prefix of `tag`. */
function partialTagSuffixLength(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1)
  for (let length = max; length > 0; length--) {
    if (tag.startsWith(text.slice(text.length - length))) return length
  }
  return 0
}

export function createInlineReasoningTagTransform<TOOLS extends ToolSet>(
  tag: InlineReasoningTag,
  abortSignal?: AbortSignal
): StreamTextTransform<TOOLS> {
  const { open, close } = TAGS[tag]
  return () => {
    let cancelled = false
    // The provider text part currently being rewritten (one at a time).
    let source: TextStartPart | undefined
    let mode: "text" | "reasoning" = "text"
    let buffer = ""
    // Skip whitespace immediately following a tag boundary.
    let skipLeadingWhitespace = false
    let textSegment = 0
    let textOpenId: string | undefined
    let reasoningCount = 0
    let reasoningOpenId: string | undefined

    const handleAbort = () => {
      cancelled = true
      buffer = ""
    }
    if (abortSignal?.aborted) handleAbort()
    else abortSignal?.addEventListener("abort", handleAbort, { once: true })

    const emitText = (
      controller: TransformStreamDefaultController<TextStreamPart<TOOLS>>,
      text: string
    ) => {
      if (skipLeadingWhitespace) {
        text = text.replace(/^\s+/, "")
        if (text.length === 0) return
        skipLeadingWhitespace = false
      }
      if (text.length === 0 || !source) return
      if (textOpenId === undefined) {
        textOpenId =
          textSegment === 0 ? source.id : `${source.id}-${textSegment}`
        textSegment++
        controller.enqueue({ ...source, id: textOpenId } as TextStreamPart<TOOLS>)
      }
      controller.enqueue({
        type: "text-delta",
        id: textOpenId,
        text,
      } as TextStreamPart<TOOLS>)
    }

    const closeText = (
      controller: TransformStreamDefaultController<TextStreamPart<TOOLS>>,
      providerMetadata?: TextStartPart["providerMetadata"]
    ) => {
      if (textOpenId === undefined) return
      controller.enqueue({
        type: "text-end",
        id: textOpenId,
        ...(providerMetadata !== undefined ? { providerMetadata } : {}),
      } as TextStreamPart<TOOLS>)
      textOpenId = undefined
    }

    const emitReasoning = (
      controller: TransformStreamDefaultController<TextStreamPart<TOOLS>>,
      text: string
    ) => {
      if (skipLeadingWhitespace) {
        text = text.replace(/^\s+/, "")
        if (text.length === 0) return
        skipLeadingWhitespace = false
      }
      if (text.length === 0) return
      if (reasoningOpenId === undefined) {
        reasoningOpenId = `${tag}-${++reasoningCount}`
        controller.enqueue({
          type: "reasoning-start",
          id: reasoningOpenId,
        } as TextStreamPart<TOOLS>)
      }
      controller.enqueue({
        type: "reasoning-delta",
        id: reasoningOpenId,
        text,
      } as TextStreamPart<TOOLS>)
    }

    const closeReasoning = (
      controller: TransformStreamDefaultController<TextStreamPart<TOOLS>>
    ) => {
      if (reasoningOpenId === undefined) return
      controller.enqueue({
        type: "reasoning-end",
        id: reasoningOpenId,
      } as TextStreamPart<TOOLS>)
      reasoningOpenId = undefined
    }

    /** Drain everything that cannot still be a partial tag. */
    const process = (
      controller: TransformStreamDefaultController<TextStreamPart<TOOLS>>
    ) => {
      for (;;) {
        if (mode === "text") {
          const at = buffer.indexOf(open)
          if (at >= 0) {
            emitText(controller, buffer.slice(0, at))
            buffer = buffer.slice(at + open.length)
            closeText(controller)
            mode = "reasoning"
            skipLeadingWhitespace = true
            // An empty reasoning section still opens the part: the tag
            // itself is the provider's signal that reasoning happened.
            reasoningOpenId = `${tag}-${++reasoningCount}`
            controller.enqueue({
              type: "reasoning-start",
              id: reasoningOpenId,
            } as TextStreamPart<TOOLS>)
            continue
          }
          const hold = partialTagSuffixLength(buffer, open)
          emitText(controller, buffer.slice(0, buffer.length - hold))
          buffer = buffer.slice(buffer.length - hold)
          return
        }
        const at = buffer.indexOf(close)
        if (at >= 0) {
          emitReasoning(controller, buffer.slice(0, at))
          buffer = buffer.slice(at + close.length)
          closeReasoning(controller)
          mode = "text"
          skipLeadingWhitespace = true
          continue
        }
        const hold = partialTagSuffixLength(buffer, close)
        emitReasoning(controller, buffer.slice(0, buffer.length - hold))
        buffer = buffer.slice(buffer.length - hold)
        return
      }
    }

    /** End of the provider text part: held bytes are literal, sections close. */
    const finishSource = (
      controller: TransformStreamDefaultController<TextStreamPart<TOOLS>>,
      providerMetadata?: TextStartPart["providerMetadata"]
    ) => {
      if (!source) return
      if (mode === "reasoning") {
        emitReasoning(controller, buffer)
        closeReasoning(controller)
        mode = "text"
      } else {
        emitText(controller, buffer)
      }
      buffer = ""
      skipLeadingWhitespace = false
      closeText(controller, providerMetadata)
      source = undefined
      textSegment = 0
    }

    return new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      transform(part, controller) {
        if (part.type === "abort") {
          // The SDK enqueues its abort terminal upstream of this transform;
          // it must reach toUIMessageStream (onEnd.isAborted) after cancel.
          // Open parts stay frozen exactly like the SDK's own abort path
          // (no synthesized reasoning-end/text-end): the app's contract reads
          // frozen part states through the settled verdict.
          buffer = ""
          controller.enqueue(part)
          return
        }
        if (cancelled) return
        switch (part.type) {
          case "text-start":
            finishSource(controller)
            source = part as TextStartPart
            return
          case "text-delta":
            if (!source || part.id !== source.id) {
              controller.enqueue(part)
              return
            }
            buffer += part.text
            process(controller)
            return
          case "text-end":
            if (!source || part.id !== source.id) {
              controller.enqueue(part)
              return
            }
            finishSource(controller, part.providerMetadata)
            return
          case "finish-step":
          case "finish":
          case "error":
            finishSource(controller)
            controller.enqueue(part)
            return
          default:
            controller.enqueue(part)
        }
      },
      flush(controller) {
        abortSignal?.removeEventListener("abort", handleAbort)
        if (cancelled) return
        finishSource(controller)
      },
    })
  }
}
