import { describe, expect, it } from "vitest"
import { projectPersistedMessageMetadata } from "./messageMetadata"

// The validator <-> client-type drift guard lives in a root test
// (lib/chat-messages/metadata.test.ts) so Convex's own tsc, which typechecks the
// convex/ tree without the "@/" path alias, does not choke on the client import.

const display = {
  displayName: "Web Search",
  source: "builtin" as const,
  serviceName: "openai",
  icon: "search" as const,
  estimatedCostPer1k: 5,
  readOnly: true,
}

describe("projectPersistedMessageMetadata", () => {
  it("returns undefined for an empty, missing, or non-record blob", () => {
    expect(projectPersistedMessageMetadata(undefined)).toBeUndefined()
    expect(projectPersistedMessageMetadata({})).toBeUndefined()
    expect(projectPersistedMessageMetadata("nope")).toBeUndefined()
    expect(projectPersistedMessageMetadata([1, 2])).toBeUndefined()
  })

  it("keeps the known stream keys", () => {
    const result = projectPersistedMessageMetadata({
      reasoningDurationMs: 1200,
      workDurationMs: 5200,
      workSummaryDurationMs: 3100,
      generationBudget: 16_384,
      generationStats: {
        timeToFirstTokenMs: 420.5,
        outputStreamMs: 4223,
        outputTokens: 146,
        providerToolCalls: 1,
        // Malformed values drop individually; the rest of the record survives.
        reasoningTokens: 1.5,
        stepCount: -1,
      },
      toolMetadataByName: { web_search: display },
      toolMetadataByCallId: { call_1: display },
    })
    expect(result).toEqual({
      reasoningDurationMs: 1200,
      workDurationMs: 5200,
      workSummaryDurationMs: 3100,
      generationBudget: 16_384,
      generationStats: {
        timeToFirstTokenMs: 420.5,
        outputStreamMs: 4223,
        outputTokens: 146,
        providerToolCalls: 1,
      },
      toolMetadataByName: { web_search: display },
      toolMetadataByCallId: { call_1: display },
    })
  })

  it("drops unknown top-level keys the SDK might attach", () => {
    const result = projectPersistedMessageMetadata({
      reasoningDurationMs: 1,
      sdkInternal: { secret: true },
    })
    expect(result).toEqual({ reasoningDurationMs: 1 })
  })

  it("drops invalid durations without overwriting unrelated metadata", () => {
    expect(
      projectPersistedMessageMetadata({
        reasoningDurationMs: -1,
        workDurationMs: Number.NaN,
        workSummaryDurationMs: Number.POSITIVE_INFINITY,
        toolMetadataByName: { web_search: display },
      })
    ).toEqual({ toolMetadataByName: { web_search: display } })
  })

  it("drops a display entry with an unknown tool source", () => {
    const result = projectPersistedMessageMetadata({
      toolMetadataByName: {
        good: display,
        bad: { ...display, source: "rogue" },
      },
    })
    expect(result?.toolMetadataByName).toEqual({ good: display })
  })

  it("omits an invalid icon but keeps the entry", () => {
    const result = projectPersistedMessageMetadata({
      toolMetadataByName: { t: { ...display, icon: "spaceship" } },
    })
    expect(result?.toolMetadataByName?.t).toEqual({
      displayName: "Web Search",
      source: "builtin",
      serviceName: "openai",
      estimatedCostPer1k: 5,
      readOnly: true,
    })
  })

  it("returns undefined when every display entry is invalid", () => {
    const result = projectPersistedMessageMetadata({
      toolMetadataByName: { bad: { displayName: 5 } },
    })
    expect(result).toBeUndefined()
  })

  it("drops poison display keys without mutating the projected record prototype", () => {
    const result = projectPersistedMessageMetadata({
      toolMetadataByName: JSON.parse(
        `{
          "__proto__": {
            "displayName": "Web Search",
            "source": "builtin",
            "serviceName": "openai"
          },
          "constructor": {
            "displayName": "Web Search",
            "source": "builtin",
            "serviceName": "openai"
          },
          "prototype": {
            "displayName": "Web Search",
            "source": "builtin",
            "serviceName": "openai"
          },
          "good": {
            "displayName": "Web Search",
            "source": "builtin",
            "serviceName": "openai",
            "icon": "search",
            "estimatedCostPer1k": 5,
            "readOnly": true
          }
        }`
      ),
    })

    const record = result?.toolMetadataByName
    expect(record).toBeDefined()
    if (!record) throw new Error("expected projected metadata record")
    expect(Object.getPrototypeOf(record)).toBeNull()
    expect(record).toEqual({ good: display })
    expect("__proto__" in record).toBe(false)
    expect("constructor" in record).toBe(false)
    expect("prototype" in record).toBe(false)
  })
})
