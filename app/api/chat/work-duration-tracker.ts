import { readTextPhase } from "@/lib/chat-messages/turn-evidence"
import type { TextStreamPart, ToolSet } from "ai"

export type WorkDurationTracker = {
  close: () => void
  getDurationMs: () => number
}

/**
 * Continuous assistant-work accounting for one provider-stream segment.
 *
 * The clock starts immediately before provider consumption and stops at the
 * first terminal generation signal. `initialDurationMs` carries prior active
 * work across an approval pause without counting the human wait between
 * provider streams.
 */
export function createWorkDurationTracker(options?: {
  initialDurationMs?: number
  now?: () => number
}): WorkDurationTracker {
  const now = options?.now ?? Date.now
  const initialDurationMs = Math.max(0, options?.initialDurationMs ?? 0)
  const startedAtMs = now()
  let stoppedAtMs: number | undefined

  return {
    close() {
      if (stoppedAtMs === undefined) stoppedAtMs = now()
    },
    getDurationMs() {
      const endMs = stoppedAtMs ?? now()
      return initialDurationMs + Math.max(0, endMs - startedAtMs)
    },
  }
}

/**
 * Pre-answer display timing is separate from total generation accounting.
 *
 * `workSummaryDurationMs` freezes at, in precedence order (ADR-0041, C5):
 *  1. the recorded `text-start` time of the first explicit `final_answer`
 *     block (OpenAI Responses phase, read through Turn evidence);
 *  2. otherwise, once the stream ends, the recorded `text-start` time of the
 *     first non-empty text part that began after the turn's last tool
 *     activity — or, for turns without tool calls, after provider-supplied
 *     sources (implied search) — provider-neutral, derived from SDK part
 *     order, never from text;
 *  3. otherwise absent (never fabricated; legacy records stay absent).
 *
 * Rule 2 stays private until `resolveAtEnd()` because "last tool" is only
 * known once the stream ends (finish OR abort: Stop after answer onset keeps
 * its value); publishing a tentative value mid-stream would persist a wrong
 * number if another tool call followed. Sources never reset a candidate, the
 * same way they never make text commentary (C3).
 */
export function createWorkSummaryDurationTracker(
  getWorkDurationMs: () => number
) {
  const textStarts = new Map<string, number>()
  let durationMs: number | undefined
  let sawActivity = false
  let candidate: { id: string; startedAtMs: number; hasText: boolean } | undefined

  const freeze = (id: string) => {
    durationMs = textStarts.get(id) ?? getWorkDurationMs()
    textStarts.clear()
    candidate = undefined
  }

  return {
    observe(part: TextStreamPart<ToolSet>) {
      if (durationMs !== undefined) return
      switch (part.type) {
        case "tool-input-start":
        case "tool-call":
        case "tool-result":
        case "tool-error":
          sawActivity = true
          candidate = undefined
          return
        case "source":
          // Implied search: pre-answer work only while no answer has begun.
          if (candidate === undefined) sawActivity = true
          return
        case "text-start": {
          if (!textStarts.has(part.id)) {
            textStarts.set(part.id, getWorkDurationMs())
          }
          if (readTextPhase(part) === "final_answer") {
            freeze(part.id)
          } else if (sawActivity && candidate === undefined) {
            candidate = {
              id: part.id,
              startedAtMs: textStarts.get(part.id) ?? getWorkDurationMs(),
              hasText: false,
            }
          }
          return
        }
        case "text-delta":
          if (candidate?.id === part.id && part.text.length > 0) {
            candidate.hasText = true
          }
          return
        case "text-end":
          if (readTextPhase(part) === "final_answer") {
            freeze(part.id)
            return
          }
          textStarts.delete(part.id)
          if (candidate?.id === part.id && !candidate.hasText) {
            candidate = undefined
          }
          return
        default:
          return
      }
    },
    /** Apply rule 2 once the turn's part order is complete (finish or abort). */
    resolveAtEnd() {
      if (durationMs === undefined && candidate?.hasText) {
        durationMs = candidate.startedAtMs
        candidate = undefined
      }
      return durationMs
    },
    getDurationMs: () => durationMs,
    /**
     * Rule 2's tentative onset while the stream is open. Checkpoints persist
     * it under a private key the UI never reads, so a terminal reached
     * elsewhere (the user's Stop mutation) can promote it; a later tool call
     * clears it here and, through the next checkpoint, there.
     */
    getCandidateMs: () =>
      durationMs === undefined && candidate?.hasText
        ? candidate.startedAtMs
        : undefined,
  }
}
