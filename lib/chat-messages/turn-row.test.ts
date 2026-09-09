import { describe, expect, it } from "vitest"
import { deriveAssistantTurnView } from "./assistant-turn"
import { turnRowModelsEqual, type TurnRowModel } from "./turn-row"

describe("turnRowModelsEqual", () => {
  it("compares rendered user attachment and branch facts", () => {
    const base: TurnRowModel = {
      kind: "user",
      id: "user-1",
      text: "hello",
      isEditing: false,
      attachments: [{ name: "a.txt", contentType: "text/plain", url: "/a" }],
      branch: {
        messageId: "user-1",
        currentIndex: 0,
        total: 2,
        siblings: [{ messageId: "user-1" }, { messageId: "user-2" }],
      },
    }

    expect(turnRowModelsEqual(base, structuredClone(base))).toBe(true)
    expect(
      turnRowModelsEqual(base, {
        ...structuredClone(base),
        isEditing: true,
      })
    ).toBe(false)
    expect(
      turnRowModelsEqual(base, {
        ...structuredClone(base),
        attachments: [{ name: "b.txt", contentType: "text/plain", url: "/a" }],
      })
    ).toBe(false)
    expect(
      turnRowModelsEqual(base, {
        ...structuredClone(base),
        branch: {
          ...base.branch!,
          siblings: [{ messageId: "user-1" }, { messageId: "user-3" }],
        },
      })
    ).toBe(false)
  })

  it("invalidates the row when its inline reasoning changes", () => {
    const first: TurnRowModel = {
      kind: "assistant",
      id: "assistant-1",
      text: "",
      status: "streaming",
      view: deriveAssistantTurnView(
        { parts: [{ type: "reasoning", text: "one" }] as never },
        "streaming"
      ),
    }
    const next: TurnRowModel = {
      ...first,
      view: deriveAssistantTurnView(
        { parts: [{ type: "reasoning", text: "two" }] as never },
        "streaming"
      ),
    }

    expect(turnRowModelsEqual(first, next)).toBe(false)
  })

  it("compares every assistant row fact and rejects kind changes", () => {
    const assistant: TurnRowModel = {
      kind: "assistant",
      id: "assistant-1",
      text: "hello",
      status: "ready",
      isLast: true,
      retryModelId: "gpt-5.4",
      retryDisabled: false,
      finishReason: "stop",
      view: deriveAssistantTurnView({ parts: [] }, "ready"),
    }

    expect(turnRowModelsEqual(assistant, structuredClone(assistant))).toBe(true)

    for (const changed of [
      { ...assistant, status: "error" as const },
      { ...assistant, isLast: false },
      { ...assistant, retryModelId: "claude-sonnet-4-6" },
      { ...assistant, retryDisabled: true },
      { ...assistant, finishReason: "length" },
    ]) {
      expect(turnRowModelsEqual(assistant, changed)).toBe(false)
    }

    expect(
      turnRowModelsEqual(assistant, {
        kind: "unsupported",
        id: assistant.id,
        text: assistant.text,
      })
    ).toBe(false)
  })

  it("compares unsupported rows by their shared rendered facts", () => {
    const unsupported: TurnRowModel = {
      kind: "unsupported",
      id: "system-1",
      text: "context",
      className: "hidden",
      isDurableChat: true,
    }

    expect(turnRowModelsEqual(unsupported, structuredClone(unsupported))).toBe(
      true
    )
    expect(
      turnRowModelsEqual(unsupported, { ...unsupported, text: "changed" })
    ).toBe(false)
  })
})
