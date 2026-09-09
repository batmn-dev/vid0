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
