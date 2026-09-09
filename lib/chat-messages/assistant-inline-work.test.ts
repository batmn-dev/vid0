import type { UIMessage } from "ai"
import { describe, expect, it } from "vitest"
import { deriveAssistantActivityModel } from "./assistant-activity"
import { deriveAssistantInlineWork } from "./assistant-inline-work"
import {
  assistantTurnViewsEqual,
  deriveAssistantTurnPhase,
  deriveAssistantTurnView,
} from "./assistant-turn"

const text = (
  value: string,
  phase?: "commentary" | "final_answer"
): UIMessage["parts"][number] => ({
  type: "text",
  text: value,
  state: "done",
  providerMetadata: { openai: { ...(phase ? { phase } : {}) } },
})
const search: UIMessage["parts"][number] = {
  type: "tool-web_search",
  toolCallId: "search",
  state: "output-available",
  input: { query: "latest news" },
  output: { sources: [{ url: "https://example.com", title: "Example" }] },
}

function project(
  parts: UIMessage["parts"],
  status: "streaming" | "ready" = "streaming"
) {
  const view = deriveAssistantTurnView({ parts }, status)
  return {
    view,
    work: deriveAssistantInlineWork(
      view,
      deriveAssistantTurnPhase(view, { status, isLast: true })
    ),
  }
}

describe("inline work projection", () => {
  it("keeps OpenAI raw reasoning in Activity while commentary owns inline progress", () => {
    const reasoning = {
      type: "reasoning",
      text: "**Checking dates**\n\nThe sources need verification.",
      state: "done",
    } satisfies UIMessage["parts"][number]
    const parts = [
      reasoning,
      text("Checking the latest sources.", "commentary"),
      search,
      text("Answer", "final_answer"),
    ]
    const view = deriveAssistantTurnView(
      { parts, metadata: { provider: "openai" } },
      "streaming"
    )
    const phase = deriveAssistantTurnPhase(view, {
      status: "streaming",
      isLast: true,
    })
    expect(deriveAssistantInlineWork(view, phase).items).toMatchObject([
      { kind: "activity-link", id: "reasoning-0", title: "Reasoning" },
      { kind: "commentary" },
      { kind: "search" },
    ])
    // Reasoning-only turns keep the existing panel trigger, not a history row.
    const reasoningOnly = deriveAssistantTurnView(
      { parts: [reasoning], metadata: { provider: "openai" } },
      "ready"
    )
    expect(
      deriveAssistantInlineWork(
        reasoningOnly,
        deriveAssistantTurnPhase(reasoningOnly, { status: "ready", isLast: true })
      ).items
    ).toEqual([])
    expect(view.evidence.timeline[0]).toMatchObject({ text: reasoning.text })
    expect(deriveAssistantActivityModel(view, phase)?.entries[0]).toMatchObject(
      {
        kind: "reasoning",
        title: "Checking dates",
        detail: "The sources need verification.",
      }
    )
  })

  it("moves the normalized running search into one active tail and restores it to history when complete", () => {
    const running: UIMessage["parts"][number] = {
      type: "tool-web_search",
      toolCallId: "search",
      state: "input-available",
      input: {},
    }
    const initial = project([]).work
    expect(initial.items).toEqual([])
    expect(initial.activeTail?.item).toMatchObject({
      kind: "status",
      title: "Thinking",
    })
    const during = project([text("Checking.", "commentary"), running]).work
    expect(during.items.map((item) => item.kind)).toEqual(["commentary"])
    expect(during.activeTail?.item).toMatchObject({
      kind: "search",
      title: "Searching the web",
      status: "running",
    })
    const after = project([text("Checking.", "commentary"), search]).work
    expect(after.items[1].id).toBe(during.activeTail?.item.id)
    expect(after.items[1]).toMatchObject({ kind: "search", status: "complete" })
    expect(after.activeTail?.item.title).toBe("Thinking")
  })

  it("streams reasoning bodies without provider headings or heading flashes", () => {
    const reasoning = (value: string) =>
      ({
        type: "reasoning",
        text: value,
        state: "streaming",
      }) satisfies UIMessage["parts"][number]
    for (const prefix of [
      "*",
      "**",
      "**Researching",
      "**Researching*",
      "**Researching**",
      "#",
      "## Researching",
    ]) {
      const { work } = project([reasoning(prefix)])
      expect(work.items).toEqual([])
      expect(work.activeTail?.item.title).toBe("Thinking")
    }
    for (const heading of [
      "**Researching current tech news**",
      "### Researching current tech news",
    ]) {
      const part = reasoning(`${heading}\n\nI need to`)
      const { view, work } = project([part])
      expect(work.items[0]).toMatchObject({
        text: "I need to",
        streaming: true,
      })
      expect(view.evidence.timeline[0]).toMatchObject({ text: part.text })
      expect(
        project([part, search, text("Answer", "final_answer")]).work.items[0]
      ).toMatchObject({ text: "I need to" })
    }
    for (const body of [
      "**AI** is relevant.",
      "A paragraph with **emphasis**.",
      "    **Code, not a heading**\n\nBody.",
    ]) {
      expect(project([reasoning(body)]).work.items[0]).toMatchObject({
        text: body,
      })
    }
  })

  it("preserves partial SDK reasoning bodies across repeated search steps", () => {
    const first: UIMessage["parts"][number] = {
      type: "reasoning",
      text: "Checking",
      state: "streaming",
    }
    const partial = project([first])
    expect(partial.work.items[0]).toMatchObject({
      kind: "reasoning",
      text: "Checking",
      streaming: true,
    })
    first.text += " sources. **Funding** needs verification."
    const grown = project([first])
    expect(grown.work.items[0]).toMatchObject({
      id: partial.work.items[0].id,
      text: first.text,
    })
    // OpenAI can leave an earlier summary streaming until metadata arrives.
    expect(project([first, search]).work.activeTail?.item.title).toBe(
      "Thinking"
    )
    const second: UIMessage["parts"][number] = {
      type: "reasoning",
      text: "Comparing",
      state: "streaming",
    }
    const next = project([first, search, second])
    expect(next.work.items.map((item) => item.kind)).toEqual([
      "reasoning",
      "search",
      "reasoning",
    ])
    expect(next.work.items[2]).toMatchObject({
      text: "Comparing",
      streaming: true,
    })
    second.text += " the launch dates."
    const parts = [first, search, second, { ...search, toolCallId: "search2" }]
    const between = project(parts)
    expect(between.work.items.map((item) => item.kind)).toEqual([
      "reasoning",
      "search",
      "reasoning",
      "search",
    ])
    expect(between.work.items[2]).toMatchObject({
      id: next.work.items[2].id,
      text: second.text,
    })
    expect(between.work.mode).toBe("live")
    expect(between.work.activeTail?.item.title).toBe("Thinking")
    const final = project([...parts, text("Answer", "final_answer")])
    expect(final.work.mode).toBe("complete")
    expect(final.work.items).toEqual(between.work.items)
    expect(final.work.activeTail?.item.title).toBeUndefined()
    // Explicit commentary must not erase separate supplied reasoning bodies.
    expect(
      project([text("Checking.", "commentary"), ...parts]).work.items.filter(
        (item) => item.kind === "reasoning"
      )
    ).toHaveLength(2)
  })

  it("keeps work visible through empty final-answer start without changing the semantic boundary", () => {
    const parts = [
      text("Checking sources.", "commentary"),
      search,
      text("Comparing results.", "commentary"),
    ]
    const live = project(parts)
    expect(live.view.inlineContent.answerText).toBe("")
    expect(live.work.mode).toBe("live")
    expect(live.work.items.map((item) => item.kind)).toEqual([
      "commentary",
      "search",
      "commentary",
    ])
    expect(live.work.activeTail?.item.title).toBe("Thinking")
    const final = project([...parts, text("", "final_answer")])
    expect(final.work.mode).toBe("live")
    expect(final.work.activeTail?.item.title).toBe("Thinking")
    expect(final.view.inlineContent.hasFinalAnswer).toBe(true)
    expect(final.view.text).toBe("Checking sources.Comparing results.")
    expect(final.view.inlineContent.answerText).toBe("")
    expect(project([...parts, text(" \n", "final_answer")]).work.mode).toBe(
      "live"
    )
    expect(
      project([...parts, text("The answer.", "final_answer")]).work.mode
    ).toBe("complete")
    expect(
      project([...parts, text("The answer.", "final_answer")]).view
        .inlineContent.answerText
    ).toBe("The answer.")
  })

  it("uses concrete later tools for unphased commentary while preserving explicit final answers and late citations", () => {
    const beforeTool = text("Let me check.")
    expect(project([beforeTool]).view.inlineContent.answerText).toBe(
      "Let me check."
    )
    expect(
      project([beforeTool, search, text("Result")]).view.inlineContent
        .answerText
    ).toBe("Result")
    expect(
      project([text("Answer", "final_answer"), search]).view.inlineContent
        .answerText
    ).toBe("Answer")
    expect(
      project([
        text("Answer"),
        { type: "source-url", sourceId: "s", url: "https://example.com" },
      ]).view.inlineContent.answerText
    ).toBe("Answer")
  })

  it("detects an in-place provider phase change with identical text", () => {
    const part = text("Same text", "commentary")
    const before = project([part]).view
    if (part.type === "text")
      part.providerMetadata = { openai: { phase: "final_answer" } }
    const after = project([part]).view
    expect(assistantTurnViewsEqual(before, after)).toBe(false)
    expect(before.inlineContent.answerText).toBe("")
    expect(after.inlineContent.answerText).toBe("Same text")
  })

  it("restores completed search history after a transient reasoning summary and stops frozen tools", () => {
    const parts: UIMessage["parts"] = [
      text("Checking.", "commentary"),
      search,
      {
        type: "reasoning",
        text: "**Focusing on the roundup**",
        state: "streaming",
      },
    ]
    const live = project(parts)
    expect(live.work.items.map((item) => item.kind)).toEqual(["commentary"])
    expect(live.work.activeTail?.item).toMatchObject({
      kind: "status",
      title: "Focusing on the roundup",
    })
    const growingSummary = project([
      ...parts.slice(0, 2),
      {
        type: "reasoning",
        text: "**Focusing on the roundup and funding**",
        state: "streaming",
      },
    ]).work.activeTail
    expect(growingSummary).toMatchObject({
      contentKey: live.work.activeTail?.contentKey,
      item: { title: "Focusing on the roundup and funding" },
    })
    expect(
      project([...parts, text("Answer", "final_answer")]).work.items.map(
        (item) => item.kind
      )
    ).toEqual(["commentary", "search"])
    const continued = project([...parts, text("Comparing.", "commentary")]).work
    expect(continued.items[1]).toMatchObject({ kind: "search" })
    expect(continued.items.map((item) => item.kind)).toEqual([
      "commentary",
      "search",
      "commentary",
    ])
    const stopped = project(
      [
        {
          type: "tool-web_search",
          toolCallId: "pending",
          state: "input-available",
          input: {},
        },
      ],
      "ready"
    )
    expect(stopped.work.activeTail?.item.title).toBeUndefined()
    expect(stopped.work.items[0]).toMatchObject({ status: "stopped" })
  })
})
