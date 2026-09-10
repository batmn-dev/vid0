import type { UIMessage } from "ai"
import { describe, expect, it } from "vitest"
import { openaiAdapter } from "../openai"
import * as fixtures from "./fixtures"

const context = {
  targetModelId: "gpt-5.2",
  hasTools: true,
}

describe("openaiAdapter", () => {
  it("keeps complete atomic triple and strips provider metadata", async () => {
    const result = await openaiAdapter.adaptMessages(
      [fixtures.singleProviderExecutedTool],
      context
    )
    const toolPart = result.messages[0].parts.find(
      (part) => part.type === "tool-web_search"
    )

    expect(toolPart).toBeDefined()
    expect(
      "callProviderMetadata" in (toolPart as Record<string, unknown>)
    ).toBe(false)
    expect(result.stats.providerIdsStripped).toBe(1)
    expect(
      result.warnings.find((w) => w.code === "provider_ids_stripped")?.detail
    ).toBe("Stripped callProviderMetadata from tool-web_search")
  })

  it("reports the metadata carriers stripped from every message role", async () => {
    const messages = [
      {
        id: "user-provider-metadata",
        role: "user",
        parts: [
          {
            type: "text",
            text: "user content",
            providerMetadata: { openai: { itemId: "msg_user" } },
          },
        ],
      },
      {
        id: "assistant-provider-metadata",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "assistant content",
            providerMetadata: { openai: { itemId: "msg_assistant" } },
          },
        ],
      },
      {
        id: "assistant-both-metadata-carriers",
        role: "assistant",
        parts: [
          {
            type: "text",
            text: "assistant content with both carriers",
            callProviderMetadata: { openai: { responseId: "resp_1" } },
            providerMetadata: { openai: { itemId: "msg_both" } },
          },
        ],
      },
    ] as unknown as UIMessage[]

    const result = await openaiAdapter.adaptMessages(messages, context)

    expect(result.stats.providerIdsStripped).toBe(3)
    expect(
      result.messages
        .flatMap((message) => message.parts)
        .every((part) => {
          const record = part as Record<string, unknown>
          return (
            !("callProviderMetadata" in record) &&
            !("providerMetadata" in record)
          )
        })
    ).toBe(true)
    expect(
      result.warnings
        .filter((warning) => warning.code === "provider_ids_stripped")
        .map((warning) => ({
          messageIndex: warning.messageIndex,
          detail: warning.detail,
        }))
    ).toEqual([
      {
        messageIndex: 0,
        detail: "Stripped providerMetadata from text",
      },
      {
        messageIndex: 1,
        detail: "Stripped providerMetadata from text",
      },
      {
        messageIndex: 2,
        detail: "Stripped callProviderMetadata and providerMetadata from text",
      },
    ])
  })

  it("drops incomplete atomic block without required reasoning", async () => {
    const orphanedToolAssistant = {
      id: "msg-openai-orphan-1",
      role: "assistant",
      parts: [
        {
          type: "tool-web_search",
          state: "output-available",
          toolCallId: "tc_orphan_1",
        },
        { type: "text", text: "orphan tool call" },
      ],
    } as unknown as UIMessage

    const result = await openaiAdapter.adaptMessages(
      [orphanedToolAssistant],
      context
    )

    expect(result.messages[0].parts).toEqual([{ type: "text", text: "" }])
    expect(result.stats.partsDropped["tool-web_search"]).toBe(1)
    expect(
      result.warnings.some((w) => w.code === "incomplete_triple_dropped")
    ).toBe(true)
  })

  it("keeps parallel calls in the same block", async () => {
    const result = await openaiAdapter.adaptMessages(
      [fixtures.parallelToolCalls],
      context
    )
    const toolParts = result.messages[0].parts.filter((part) =>
      part.type.startsWith("tool-")
    )

    expect(toolParts).toHaveLength(2)
    expect(result.stats.partsPreserved["tool-web_search"]).toBe(1)
    expect(result.warnings).toHaveLength(0)
  })

  it("preserves providerExecuted on kept tool parts", async () => {
    const result = await openaiAdapter.adaptMessages(
      [fixtures.singleProviderExecutedTool],
      context
    )
    const toolPart = result.messages[0].parts.find(
      (part) => part.type === "tool-web_search"
    ) as {
      providerExecuted?: unknown
    }

    expect(toolPart.providerExecuted).toBe(true)
    expect(result.stats.partsTransformed["tool-web_search"]).toBe(1)
    expect(
      result.warnings.some((w) => w.code === "provider_ids_stripped")
    ).toBe(true)
  })

  it("drops block containing non-final tool state", async () => {
    const result = await openaiAdapter.adaptMessages(
      [fixtures.incompleteAbortedTool],
      context
    )

    expect(result.messages[0].parts).toEqual([{ type: "text", text: "" }])
    expect(result.stats.partsDropped["tool-exa_search"]).toBe(1)
    expect(
      result.warnings.some((w) => w.code === "non_final_state_dropped")
    ).toBe(true)
  })

  it("keeps output-error tool states as final", async () => {
    const result = await openaiAdapter.adaptMessages(
      [fixtures.failedToolCall],
      context
    )
    const toolPart = result.messages[0].parts.find(
      (part) => part.type === "tool-exa_search"
    ) as {
      state?: unknown
    }

    expect(toolPart?.state).toBe("output-error")
    expect(result.stats.partsPreserved["tool-exa_search"]).toBe(1)
    expect(result.warnings).toHaveLength(0)
  })

  it("uses semantic fallback splitting when step-start is missing", async () => {
    const semanticFallbackMessage = {
      id: "msg-openai-semantic-1",
      role: "assistant",
      parts: [
        { type: "reasoning", reasoning: "first step", state: "done" },
        {
          type: "tool-web_search",
          state: "output-available",
          toolCallId: "tc_sem_1",
        },
        { type: "text", text: "first complete step" },
        { type: "reasoning", reasoning: "second step", state: "done" },
        { type: "text", text: "second complete step" },
      ],
    } as unknown as UIMessage

    const result = await openaiAdapter.adaptMessages(
      [semanticFallbackMessage],
      context
    )

    expect(result.messages[0].parts.map((part) => part.type)).toEqual([
      "reasoning",
      "tool-web_search",
      "text",
      "reasoning",
      "text",
    ])
    expect(result.stats.totalPartsAdapted).toBe(5)
    expect(result.warnings).toHaveLength(0)
  })

  it("drops orphaned web_search_call in batman regression shape", async () => {
    const batmanWithOrphan = fixtures.batmanProductionBug.map(
      (message, index) => {
        if (index !== 1) return message
        return {
          ...message,
          parts: message.parts.filter(
            (part) => part.type !== "reasoning" && part.type !== "step-start"
          ),
        }
      }
    ) as unknown as UIMessage[]

    const result = await openaiAdapter.adaptMessages(batmanWithOrphan, context)
    const assistant = result.messages.find(
      (message) => message.role === "assistant"
    )

    expect(
      assistant?.parts.some((part) => part.type === "tool-web_search")
    ).toBe(false)
    expect(result.stats.partsDropped["tool-web_search"]).toBeGreaterThanOrEqual(
      1
    )
    expect(
      result.warnings.some((w) => w.code === "incomplete_triple_dropped")
    ).toBe(true)
  })

  it("drops step-start artifacts for assistant messages", async () => {
    const result = await openaiAdapter.adaptMessages(
      [fixtures.singleSdkToolComplete],
      context
    )

    expect(
      result.messages[0].parts.some((part) => part.type === "step-start")
    ).toBe(false)
    expect(result.stats.partsDropped["step-start"]).toBe(1)
    expect(result.warnings).toHaveLength(0)
  })

  it("keeps non-assistant messages while stripping tool metadata if present", async () => {
    const userWithToolMetadata = {
      id: "msg-user-with-tool",
      role: "user",
      parts: [
        { type: "text", text: "hello" },
        {
          type: "tool-web_search",
          state: "output-available",
          toolCallId: "tc_user_1",
          callProviderMetadata: { openai: { responseId: "msg_x" } },
        },
      ],
    } as unknown as UIMessage

    const result = await openaiAdapter.adaptMessages(
      [userWithToolMetadata],
      context
    )
    const toolPart = result.messages[0].parts.find(
      (part) => part.type === "tool-web_search"
    )

    expect(
      "callProviderMetadata" in (toolPart as Record<string, unknown>)
    ).toBe(false)
    expect(result.stats.providerIdsStripped).toBe(1)
    expect(
      result.warnings.some((w) => w.code === "provider_ids_stripped")
    ).toBe(true)
  })

  it("keeps text phase while stripping item ids and reasoning metadata (ADR-0041)", async () => {
    const result = await openaiAdapter.adaptMessages(
      [
      {
        id: "assistant-1",
        role: "assistant",
        metadata: { provider: "openai" },
        parts: [
          {
            type: "reasoning",
            text: "",
            providerMetadata: { openai: { itemId: "rs_1" } },
          },
          {
            type: "text",
            text: "Looking.",
            providerMetadata: { openai: { itemId: "msg_1", phase: "commentary" } },
          },
          {
            type: "text",
            text: "Answer.",
            providerMetadata: { openai: { phase: "final_answer" } },
          },
        ],
      },
      ] as unknown as UIMessage[],
      context
    )
    const [message] = result.messages
    const records = message.parts as Array<{ providerMetadata?: unknown }>
    expect(records.map((part) => part.providerMetadata)).toEqual([
      undefined,
      { openai: { phase: "commentary" } },
      { openai: { phase: "final_answer" } },
    ])
    // The phase-only part had nothing to strip and is reported as preserved.
    expect(result.stats.providerIdsStripped).toBe(2)
  })
})
