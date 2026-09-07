import { chainCommands, liftEmptyBlock, splitBlock } from "prosemirror-commands"
import { undo } from "prosemirror-history"
import { splitListItem } from "prosemirror-schema-list"
import { EditorState, TextSelection, type Transaction } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import { createPromptInputPlugins } from "./prompt-input-editor"
import { setPromptInputBlockStyle } from "./prompt-input-formatting"
import {
  createPromptInputDocument,
  promptInputSchema,
  readPromptInputDocument,
  replacePromptInputDocument,
  textOffsetToDocumentPosition,
} from "./prompt-input-schema"

function editor(value: string) {
  let state = EditorState.create({
    doc: createPromptInputDocument(value),
    plugins: createPromptInputPlugins(() => ""),
  })
  const dispatch = (tr: Transaction) => {
    state = state.apply(tr)
  }
  return {
    get state() {
      return state
    },
    dispatch,
    select(from: number, to = from) {
      dispatch(state.tr.setSelection(TextSelection.create(state.doc, from, to)))
    },
  }
}

describe("composer rich formatting boundary", () => {
  it("round trips all supported formatting and literal delimiters without leaking entities", () => {
    for (const value of [
      "# Heading",
      "## Heading",
      "### Heading",
      "**bold** and *italic*",
      "[a\\]b](https://example.com/a\\(b\\))",
      "- one\n  - sub\n    continued\n- two",
      "\\*literal\\*",
      "**a \\&amp; b**",
    ]) {
      const first = createPromptInputDocument(value)
      const serialized = readPromptInputDocument(first)
      const second = createPromptInputDocument(serialized)
      expect(readPromptInputDocument(second), value).toBe(serialized)
      expect(second.textContent, value).toBe(first.textContent)
    }
    for (const value of ["  draft\n\nlast \n", "\tcode\n    code", " "])
      expect(readPromptInputDocument(createPromptInputDocument(value))).toBe(
        value
      )
  })

  it("canonically escapes live literal syntax before persistence", () => {
    for (const value of [
      "*literal*",
      "# heading",
      "- list",
      "[example](https://example.com)",
      "\\*literal\\*",
      "a &amp; b",
    ]) {
      const doc = promptInputSchema.nodes.doc.create(
        null,
        promptInputSchema.nodes.paragraph.create(
          null,
          promptInputSchema.text(value)
        )
      )
      const serialized = readPromptInputDocument(doc)
      const restored = createPromptInputDocument(serialized)
      expect(restored.textContent, value).toBe(value)
      expect(readPromptInputDocument(restored), value).toBe(serialized)
    }
  })

  it("preserves HTML-pasted hard breaks, loose list paragraphs, and URL entities", () => {
    const doc = promptInputSchema.nodes.doc.create(
      null,
      promptInputSchema.nodes.paragraph.create(null, [
        promptInputSchema.text("first"),
        promptInputSchema.nodes.hard_break.create(),
        promptInputSchema.text("second"),
      ])
    )
    const restored = createPromptInputDocument(readPromptInputDocument(doc))
    expect(restored.eq(doc)).toBe(true)
    for (const value of [
      "- a\n\n  another paragraph",
      "[label](https://example.com/?x=1\\&copy;=2)",
    ]) {
      const first = createPromptInputDocument(value)
      const serialized = readPromptInputDocument(first)
      expect(createPromptInputDocument(serialized).eq(first)).toBe(true)
      expect(
        readPromptInputDocument(createPromptInputDocument(serialized))
      ).toBe(serialized)
    }
    const literal = promptInputSchema.nodes.doc.create(
      null,
      promptInputSchema.nodes.paragraph.create(
        null,
        promptInputSchema.text("*literal*", [
          promptInputSchema.marks.strong.create(),
        ])
      )
    )
    expect(textOffsetToDocumentPosition(literal, 3)).toBe(1)
    for (const value of ["  hi", "    code", "\tcode", "hi  "]) {
      const doc = createPromptInputDocument(value)
      for (let offset = 0; offset <= value.length; offset++)
        expect(
          textOffsetToDocumentPosition(doc, offset),
          `${value} at ${offset}`
        ).toBe(offset + 1)
    }
    const padded = promptInputSchema.nodes.doc.create(
      null,
      promptInputSchema.nodes.paragraph.create(
        null,
        promptInputSchema.text(" hi ", [
          promptInputSchema.marks.strong.create(),
        ])
      )
    )
    expect(textOffsetToDocumentPosition(padded, 3)).toBe(2)
  })

  it("serializes marked literal punctuation and whitespace with the maintained Markdown serializer", () => {
    for (const value of [
      "*literal*",
      "a]b",
      "a &amp; b",
      " label ",
      "    code",
    ]) {
      const doc = promptInputSchema.nodes.doc.create(
        null,
        promptInputSchema.nodes.paragraph.create(
          null,
          promptInputSchema.text(value, [
            promptInputSchema.marks.strong.create(),
          ])
        )
      )
      const restored = createPromptInputDocument(readPromptInputDocument(doc))
      expect(restored.textContent).toBe(value)
      expect(
        restored.rangeHasMark(
          0,
          restored.content.size,
          promptInputSchema.marks.strong
        )
      ).toBe(true)
    }
  })

  it("converts heading to list and list to heading, preserving text and one undo event", () => {
    const view = editor("# Heading")
    view.select(1, 8)
    expect(
      setPromptInputBlockStyle("bullet_list")(view.state, view.dispatch)
    ).toBe(true)
    expect(readPromptInputDocument(view.state.doc)).toBe("- Heading")
    expect(setPromptInputBlockStyle("h2")(view.state, view.dispatch)).toBe(true)
    expect(readPromptInputDocument(view.state.doc)).toBe("## Heading")
    expect(undo(view.state, view.dispatch)).toBe(true)
    expect(readPromptInputDocument(view.state.doc)).toBe("# Heading")
  })

  it("converts deeply nested items to Text or headings while preserving outside content and one undo", () => {
    for (const style of ["text", "h1", "h2", "h3"] as const) {
      const view = editor(
        "Before\n\n- outer\n  - inner\n    - deepest\n  - sibling\n\nAfter"
      )
      const before = view.state.doc
      let selected = 0
      before.descendants((node, pos) => {
        if (node.isText && node.text === "deepest") selected = pos
      })
      view.select(selected, selected + "deepest".length)
      expect(setPromptInputBlockStyle(style)(view.state), style).toBe(true)
      expect(
        setPromptInputBlockStyle(style)(view.state, view.dispatch),
        style
      ).toBe(true)
      const rootBlocks: string[] = []
      view.state.doc.forEach((node) => {
        if (node.textContent === "deepest") {
          expect(node.type.name).toBe(
            style === "text" ? "paragraph" : "heading"
          )
          if (style !== "text")
            expect(node.attrs.level).toBe(Number(style.slice(1)))
          rootBlocks.push(node.textContent)
        }
      })
      expect(rootBlocks).toEqual(["deepest"])
      expect(view.state.doc.textContent).toBe(before.textContent)
      view.state.doc.descendants((node, pos) => {
        if (!node.isText || node.text !== "sibling") return
        const $pos = view.state.doc.resolve(pos)
        expect(
          Array.from({ length: $pos.depth }, (_, depth) =>
            $pos.node(depth + 1)
          ).some((parent) => parent.type === promptInputSchema.nodes.list_item)
        ).toBe(true)
      })
      expect(view.state.doc.firstChild?.eq(before.firstChild!)).toBe(true)
      expect(view.state.doc.lastChild?.eq(before.lastChild!)).toBe(true)
      expect(undo(view.state, view.dispatch)).toBe(true)
      expect(view.state.doc.eq(before)).toBe(true)
    }
  })

  it("converts a mixed paragraph and nested-list selection together without changing surrounding paragraphs", () => {
    const view = editor(
      "Before\n\nplain\n\n- outer\n  - inner\n    - deepest\n\nAfter"
    )
    const before = view.state.doc
    let from = 0
    let to = 0
    before.descendants((node, pos) => {
      if (node.isText && node.text === "plain") from = pos
      if (node.isText && node.text === "deepest") to = pos + node.nodeSize
    })
    view.select(from, to)
    expect(setPromptInputBlockStyle("h2")(view.state, view.dispatch)).toBe(true)
    const headings: string[] = []
    view.state.doc.forEach((node) => {
      if (node.type.name === "heading" && node.textContent) {
        expect(node.attrs.level).toBe(2)
        headings.push(node.textContent)
      }
    })
    expect(headings).toEqual(["plain", "outer", "inner", "deepest"])
    expect(view.state.doc.firstChild?.eq(before.firstChild!)).toBe(true)
    expect(view.state.doc.lastChild?.eq(before.lastChild!)).toBe(true)
    expect(undo(view.state, view.dispatch)).toBe(true)
    expect(view.state.doc.eq(before)).toBe(true)
  })

  it("uses paragraphs after headings and exits an empty list item", () => {
    const view = editor("# Heading")
    view.select(8)
    splitBlock(view.state, view.dispatch)
    expect(view.state.doc.lastChild?.type.name).toBe("paragraph")
    const list = editor("- item")
    list.select(7)
    splitListItem(promptInputSchema.nodes.list_item)(list.state, list.dispatch)
    chainCommands(
      splitListItem(promptInputSchema.nodes.list_item),
      liftEmptyBlock,
      splitBlock
    )(list.state, list.dispatch)
    expect(list.state.doc.lastChild?.type.name).toBe("paragraph")
  })

  it("maps every serialized offset to editable text, including nested list markers", () => {
    const doc = createPromptInputDocument("# h\n\n- a\n  - b\n- c")
    const value = readPromptInputDocument(doc)
    for (let offset = 0; offset <= value.length; offset++) {
      const pos = textOffsetToDocumentPosition(doc, offset)
      expect(
        doc.resolve(pos).parent.isTextblock,
        `offset ${offset}, pos ${pos}`
      ).toBe(true)
    }
  })

  it("entity-only updates preserve the rich document and selection", () => {
    const view = editor("**Bold**\n- item")
    view.select(2, 4)
    const before = view.state.doc
    replacePromptInputDocument(view, readPromptInputDocument(before), [
      { id: "search", kind: "capability", label: "Search" },
    ])
    expect(
      view.state.doc.rangeHasMark(
        0,
        view.state.doc.content.size,
        promptInputSchema.marks.strong
      )
    ).toBe(true)
    expect(view.state.doc.lastChild?.type.name).toBe("bullet_list")
    expect(readPromptInputDocument(view.state.doc)).toBe("**Bold**\n- item")
    expect(view.state.selection.to - view.state.selection.from).toBe(2)
  })
})
