import { describe, expect, it } from "vitest"
import {
  createWorkDurationTracker,
  createWorkSummaryDurationTracker,
} from "./work-duration-tracker"

describe("createWorkDurationTracker", () => {
  it("includes reasoning, tool gaps, and answer generation continuously", () => {
    let now = 0
    const tracker = createWorkDurationTracker({ now: () => now })

    // reasoning 0-436, tool/search 436-3436, reasoning 3436-3900,
    // final text 3900-5200: the work clock intentionally includes all of it.
    now = 5200
    tracker.close()
    expect(tracker.getDurationMs()).toBe(5200)
  })

  it("freezes on every repeated terminal signal", () => {
    let now = 100
    const tracker = createWorkDurationTracker({ now: () => now })
    now = 2100
    tracker.close()
    now = 9000
    tracker.close()
    expect(tracker.getDurationMs()).toBe(2000)
  })

  it("resumes from prior active work without counting an approval wait", () => {
    let now = 20_000
    const resumed = createWorkDurationTracker({
      initialDurationMs: 2400,
      now: () => now,
    })
    now = 23_600
    resumed.close()
    expect(resumed.getDurationMs()).toBe(6000)
  })
})

describe("createWorkSummaryDurationTracker", () => {
  it("freezes only an explicit final-answer boundary without changing total work", () => {
    let now = 0
    const total = createWorkDurationTracker({ now: () => now })
    const summary = createWorkSummaryDurationTracker(total.getDurationMs)
    now = 1000
    summary.observe({
      type: "text-start",
      id: "commentary",
      providerMetadata: {
        openai: { phase: "commentary" },
      },
    })
    now = 3000
    summary.observe({
      type: "text-start",
      id: "final",
      providerMetadata: {
        openai: { phase: "final_answer" },
      },
    })
    now = 8000
    summary.observe({
      type: "text-end",
      id: "final",
      providerMetadata: {
        openai: { phase: "final_answer" },
      },
    })
    total.close()
    expect(summary.getDurationMs()).toBe(3000)
    expect(total.getDurationMs()).toBe(8000)
  })

  it("freezes an unphased tool turn at the first non-empty text after the last tool, only at finish", () => {
    let now = 0
    const summary = createWorkSummaryDurationTracker(() => now)
    // Anthropic-shaped: narration, tool call/result, narration, tool, answer.
    now = 500
    summary.observe({ type: "text-start", id: "t1" })
    summary.observe({ type: "text-delta", id: "t1", text: "Let me search." })
    summary.observe({ type: "text-end", id: "t1" })
    now = 1000
    summary.observe({ type: "tool-call", toolCallId: "c1", toolName: "web_search", input: {} })
    now = 3000
    summary.observe({ type: "tool-result", toolCallId: "c1", toolName: "web_search", input: {}, output: {} })
    now = 3200
    summary.observe({ type: "text-start", id: "t2" })
    summary.observe({ type: "text-delta", id: "t2", text: "One more." })
    summary.observe({ type: "text-end", id: "t2" })
    // The tentative onset is exposed for checkpoints, then cleared by the
    // next tool call (that text just became commentary).
    expect(summary.getCandidateMs()).toBe(3200)
    now = 3500
    summary.observe({ type: "tool-call", toolCallId: "c2", toolName: "web_search", input: {} })
    expect(summary.getCandidateMs()).toBeUndefined()
    now = 6000
    summary.observe({ type: "tool-result", toolCallId: "c2", toolName: "web_search", input: {}, output: {} })
    // An empty placeholder after the last tool is not the answer.
    now = 6100
    summary.observe({ type: "text-start", id: "t3" })
    summary.observe({ type: "text-end", id: "t3" })
    now = 6400
    summary.observe({ type: "text-start", id: "t4" })
    summary.observe({ type: "text-delta", id: "t4", text: "The answer." })
    // Never published before finish: a later tool could still arrive.
    expect(summary.getDurationMs()).toBeUndefined()
    expect(summary.getCandidateMs()).toBe(6400)
    now = 9000
    summary.observe({ type: "text-end", id: "t4" })
    expect(summary.resolveAtEnd()).toBe(6400)
    expect(summary.getDurationMs()).toBe(6400)
    expect(summary.getCandidateMs()).toBeUndefined()
  })

  it("leaves a turn without tools and without an explicit phase absent", () => {
    let now = 100
    const summary = createWorkSummaryDurationTracker(() => now)
    summary.observe({ type: "text-start", id: "t1" })
    summary.observe({ type: "text-delta", id: "t1", text: "Plain answer." })
    now = 900
    summary.observe({ type: "text-end", id: "t1" })
    expect(summary.resolveAtEnd()).toBeUndefined()
  })

  it("treats sources before any answer as implied search, and never lets sources reset an answer", () => {
    let now = 0
    // Perplexity-shaped: sources arrive first, then the single answer.
    const implied = createWorkSummaryDurationTracker(() => now)
    now = 1500
    implied.observe({ type: "source", sourceType: "url", id: "s1", url: "https://a" })
    implied.observe({ type: "source", sourceType: "url", id: "s2", url: "https://b" })
    now = 19500
    implied.observe({ type: "text-start", id: "t1" })
    implied.observe({ type: "text-delta", id: "t1", text: "Trailing zeros come from" })
    now = 25000
    implied.observe({ type: "text-end", id: "t1" })
    expect(implied.getDurationMs()).toBeUndefined()
    expect(implied.resolveAtEnd()).toBe(19500)

    // Anthropic-shaped: citations interleave with the answer after the tool.
    // They never reset the candidate (C3: sources never make text commentary).
    const cited = createWorkSummaryDurationTracker(() => now)
    now = 1000
    cited.observe({ type: "tool-call", toolCallId: "c1", toolName: "web_search", input: {} })
    now = 4000
    cited.observe({ type: "tool-result", toolCallId: "c1", toolName: "web_search", input: {}, output: {} })
    now = 4400
    cited.observe({ type: "text-start", id: "t1" })
    cited.observe({ type: "text-delta", id: "t1", text: "As of today" })
    cited.observe({ type: "text-end", id: "t1" })
    now = 5000
    cited.observe({ type: "source", sourceType: "url", id: "s1", url: "https://a" })
    now = 5100
    cited.observe({ type: "text-start", id: "t2" })
    cited.observe({ type: "text-delta", id: "t2", text: " the release" })
    cited.observe({ type: "text-end", id: "t2" })
    expect(cited.resolveAtEnd()).toBe(4400)

    // Sources that only arrive after an unphased, tool-free answer (Google
    // grounding shape) leave the value absent: nothing preceded the answer.
    const trailing = createWorkSummaryDurationTracker(() => now)
    now = 800
    trailing.observe({ type: "text-start", id: "t1" })
    trailing.observe({ type: "text-delta", id: "t1", text: "Answer." })
    trailing.observe({ type: "text-end", id: "t1" })
    trailing.observe({ type: "source", sourceType: "url", id: "s1", url: "https://a" })
    expect(trailing.resolveAtEnd()).toBeUndefined()
  })

  it("prefers the explicit final_answer boundary over the tool-order fallback", () => {
    let now = 0
    const summary = createWorkSummaryDurationTracker(() => now)
    summary.observe({ type: "tool-call", toolCallId: "c1", toolName: "web_search", input: {} })
    now = 2000
    summary.observe({ type: "text-start", id: "commentary", providerMetadata: { openai: { phase: "commentary" } } })
    summary.observe({ type: "text-delta", id: "commentary", text: "Looking." })
    summary.observe({ type: "text-end", id: "commentary", providerMetadata: { openai: { phase: "commentary" } } })
    now = 4000
    summary.observe({ type: "text-start", id: "final", providerMetadata: { openai: { phase: "final_answer" } } })
    expect(summary.getDurationMs()).toBe(4000)
    expect(summary.resolveAtEnd()).toBe(4000)
  })

  it("uses the start time when phase arrives at text-end and leaves unknown history absent", () => {
    let now = 1000
    const summary = createWorkSummaryDurationTracker(() => now)
    summary.observe({ type: "text-start", id: "unknown" })
    summary.observe({ type: "text-end", id: "unknown" })
    expect(summary.getDurationMs()).toBeUndefined()
    now = 4000
    summary.observe({ type: "text-start", id: "final" })
    now = 9000
    summary.observe({
      type: "text-end",
      id: "final",
      providerMetadata: {
        openai: { phase: "final_answer" },
      },
    })
    expect(summary.getDurationMs()).toBe(4000)
  })
})
