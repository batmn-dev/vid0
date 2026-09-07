import {
  composerEntityPillToDOM,
  parseComposerEntityPill,
} from "@/components/ui/composer-entity-pill"
import type { Nodes, PhrasingContent, RootContent } from "mdast"
import {
  defaultMarkdownSerializer,
  MarkdownSerializer,
} from "prosemirror-markdown"
import {
  Fragment,
  Schema,
  type Mark,
  type Node as ProseMirrorNode,
} from "prosemirror-model"
import { bulletList, listItem, orderedList } from "prosemirror-schema-list"
import { EditorState, TextSelection } from "prosemirror-state"
import type { EditorView } from "prosemirror-view"
import remarkParse from "remark-parse"
import { unified } from "unified"

/**
 * The Composer's document model and Markdown-string boundary: the schema, the
 * string↔document serializers, and the text-offset↔position mapping that
 * keeps the editor's controlled `value` contract entity-free.
 */

export type PromptInputEntity = Readonly<{
  id: string
  /** "capability" renders as an ecosystemMention pill and "tool" as a
   * skillMention pill. */
  kind: "capability" | "tool"
  label: string
  /** Connector-style pills carry an icon image; built-in capabilities without
   * one fall back to the web-search glyph. */
  iconUrl?: string | null
  /** False for status entities that are visible but cannot be removed. */
  removable?: boolean
}>

const promptInputSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "inline*",
      group: "block",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", { dir: "auto" }, 0],
    },
    heading: {
      attrs: { level: { default: 1 } },
      content: "inline*",
      group: "block",
      defining: true,
      parseDOM: [1, 2, 3].map((level) => ({
        tag: `h${level}`,
        attrs: { level },
      })),
      toDOM: (node) => [`h${node.attrs.level}`, { dir: "auto" }, 0],
    },
    bullet_list: { ...bulletList, content: "list_item+", group: "block" },
    ordered_list: { ...orderedList, content: "list_item+", group: "block" },
    list_item: { ...listItem, content: "paragraph block*" },
    hard_break: {
      inline: true,
      group: "inline",
      selectable: false,
      parseDOM: [{ tag: "br" }],
      toDOM: () => ["br"],
    },
    composerEntityCursorTarget: {
      atom: true,
      attrs: {
        entityId: { validate: "string" },
      },
      group: "inline",
      inline: true,
      parseDOM: [
        {
          tag: "span[data-inline-selection-pill-cursor-target]",
          getAttrs: () => ({ entityId: "" }),
        },
      ],
      selectable: false,
      toDOM: (node) => [
        "span",
        {
          "aria-hidden": "true",
          contenteditable: "false",
          "data-inline-selection-pill-cursor-target": "",
        },
        "\uFEFF",
      ],
    },
    composerEntity: {
      atom: true,
      attrs: {
        id: { validate: "string" },
        kind: { validate: "string" },
        label: { validate: "string" },
        iconUrl: { default: null },
        removable: { default: true },
      },
      group: "inline",
      inline: true,
      parseDOM: [
        {
          tag: "span[data-inline-selection-pill]",
          getAttrs: parseComposerEntityPill,
        },
      ],
      selectable: false,
      toDOM: composerEntityPillToDOM,
    },
    text: { group: "inline" },
  },
  marks: {
    strong: {
      parseDOM: [
        { tag: "strong" },
        { tag: "b" },
        { style: "font-weight=bold" },
      ],
      toDOM: () => ["strong", 0],
    },
    em: {
      parseDOM: [{ tag: "em" }, { tag: "i" }, { style: "font-style=italic" }],
      toDOM: () => ["em", 0],
    },
    link: {
      attrs: { href: {} },
      inclusive: false,
      parseDOM: [
        {
          tag: "a[href]",
          getAttrs: (element) => {
            const href = normalizePromptInputLink(
              element.getAttribute("href") ?? ""
            )
            return href ? { href } : false
          },
        },
      ],
      toDOM: (node) => [
        "a",
        { href: node.attrs.href, target: "_blank", rel: "noopener noreferrer" },
        0,
      ],
    },
  },
})

/** Only navigation protocols are accepted, including on HTML paste. */
export function normalizePromptInputLink(value: string) {
  const trimmed = value.trim()
  if (!trimmed || /[\u0000-\u0020\u007f]/.test(trimmed)) return null
  const href = /^[a-z][a-z\d+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`
  return /^(https?:|mailto:|tel:)/i.test(href) ? href : null
}

const markdownParser = unified().use(remarkParse)

function inlineNodes(
  children: readonly PhrasingContent[],
  source: string,
  marks: readonly Mark[] = []
): ProseMirrorNode[] {
  return children.flatMap((child) => {
    if (child.type === "text")
      return child.value ? [promptInputSchema.text(child.value, marks)] : []
    if (child.type === "strong" || child.type === "emphasis") {
      const mark =
        promptInputSchema.marks[
          child.type === "strong" ? "strong" : "em"
        ].create()
      return inlineNodes(child.children, source, [...marks, mark])
    }
    if (child.type === "link") {
      const href = normalizePromptInputLink(child.url)
      return inlineNodes(
        child.children,
        source,
        href ? [...marks, promptInputSchema.marks.link.create({ href })] : marks
      )
    }
    if (child.type === "break")
      return [promptInputSchema.nodes.hard_break.create(null, null, marks)]
    const literal = source.slice(
      child.position?.start.offset,
      child.position?.end.offset
    )
    return literal ? [promptInputSchema.text(literal, marks)] : []
  })
}

function parseInline(line: string) {
  // Parse syntax while retaining indentation and trailing spaces verbatim.
  const leading = line.match(/^\s*/)?.[0] ?? ""
  const trailing = line.slice(leading.length).match(/\s*$/)?.[0] ?? ""
  const content = line.slice(
    leading.length,
    trailing.length ? -trailing.length : undefined
  )
  const parsed = markdownParser.parse(content).children[0]
  const children =
    parsed?.type === "paragraph"
      ? inlineNodes(parsed.children, content)
      : content
        ? [promptInputSchema.text(content)]
        : []
  return [
    ...(leading ? [promptInputSchema.text(leading)] : []),
    ...children,
    ...(trailing ? [promptInputSchema.text(trailing)] : []),
  ]
}

function parseBlocks(
  children: readonly RootContent[],
  source: string
): ProseMirrorNode[] {
  return children.flatMap((child) => {
    if (child.type === "heading" && child.depth <= 3) {
      return [
        promptInputSchema.nodes.heading.create(
          { level: child.depth },
          inlineNodes(child.children, source)
        ),
      ]
    }
    if (child.type === "list") {
      return [
        promptInputSchema.nodes[
          child.ordered ? "ordered_list" : "bullet_list"
        ].create(
          child.ordered ? { order: child.start ?? 1 } : null,
          child.children.map((item) => {
            const blocks = parseBlocks(item.children, source)
            if (blocks[0]?.type !== promptInputSchema.nodes.paragraph)
              blocks.unshift(promptInputSchema.nodes.paragraph.create())
            return promptInputSchema.nodes.list_item.create(null, blocks)
          })
        ),
      ]
    }
    if (child.type === "paragraph")
      return [
        promptInputSchema.nodes.paragraph.create(
          null,
          inlineNodes(child.children, source)
        ),
      ]
    const literal = source.slice(
      child.position?.start.offset,
      child.position?.end.offset
    )
    return literal
      .split("\n")
      .map((line) =>
        promptInputSchema.nodes.paragraph.create(null, parseInline(line))
      )
  })
}

function entityNodes(entities: readonly PromptInputEntity[]) {
  return entities.flatMap((entity) => [
    promptInputSchema.nodes.composerEntityCursorTarget.create({
      entityId: entity.id,
    }),
    promptInputSchema.nodes.composerEntity.create(entity),
    promptInputSchema.text(" "),
  ])
}

function createPromptInputDocument(
  value: string,
  entities: readonly PromptInputEntity[] = []
) {
  const tree = markdownParser.parse(value)
  const supportedFormatting = (node: Nodes): boolean =>
    ["heading", "list", "strong", "emphasis", "link", "break"].includes(
      node.type
    ) ||
    ("children" in node && node.children.some(supportedFormatting))
  const markdown =
    supportedFormatting(tree) ||
    value
      .split("\n")
      .some(
        (line) =>
          /^(?: {4}|\t)/.test(line) &&
          supportedFormatting(markdownParser.parse(line.trim()))
      ) ||
    /\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(value)
  if (!markdown) {
    return promptInputSchema.nodes.doc.create(
      null,
      value
        .split("\n")
        .map((line, index) =>
          promptInputSchema.nodes.paragraph.create(null, [
            ...(index === 0 ? entityNodes(entities) : []),
            ...(line ? [promptInputSchema.text(line)] : []),
          ])
        )
    )
  }
  const blocks: ProseMirrorNode[] = []
  let nextLine = 1
  let previous: RootContent | undefined
  for (const child of tree.children) {
    const startLine = child.position?.start.line ?? nextLine
    const blankLines = startLine - nextLine
    // Lists need a structural blank line where ordinary paragraphs need only
    // one newline. Additional blank lines still represent empty paragraphs.
    if (
      previous?.type === "list" &&
      (child.type === "paragraph" || blankLines >= 2) &&
      nextLine < startLine
    )
      nextLine++
    if (
      child.type === "list" &&
      child.ordered &&
      child.start !== 1 &&
      (previous?.type === "paragraph" || blankLines >= 2) &&
      nextLine < startLine
    )
      nextLine++
    while (nextLine < startLine) {
      blocks.push(promptInputSchema.nodes.paragraph.create())
      nextLine++
    }
    if (
      child.type === "paragraph" &&
      child.children.some((node) => node.type === "break")
    ) {
      blocks.push(
        promptInputSchema.nodes.paragraph.create(
          null,
          inlineNodes(child.children, value)
        )
      )
    } else if (child.type === "paragraph") {
      blocks.push(
        ...value
          .split("\n")
          .slice(startLine - 1, child.position?.end.line ?? startLine)
          .map((line) =>
            promptInputSchema.nodes.paragraph.create(null, parseInline(line))
          )
      )
    } else {
      blocks.push(...parseBlocks([child], value))
    }
    nextLine = (child.position?.end.line ?? startLine) + 1
    previous = child
  }
  const lineCount = value.split("\n").length
  if (previous?.type === "list" && lineCount - nextLine >= 1) nextLine++
  while (nextLine <= lineCount) {
    const line = value.split("\n")[nextLine - 1]
    blocks.push(
      promptInputSchema.nodes.paragraph.create(
        null,
        line ? promptInputSchema.text(line) : null
      )
    )
    nextLine++
  }
  if (!blocks.length) blocks.push(promptInputSchema.nodes.paragraph.create())
  let document = promptInputSchema.nodes.doc.create(null, blocks)
  if (entities.length) {
    const state = TextSelection.atStart(document)
    const transaction = EditorState.create({ doc: document }).tr.insert(
      state.from,
      entityNodes(entities)
    )
    document = transaction.doc
  }
  return document
}

const inlineMarkdownSerializer = new MarkdownSerializer(
  {
    paragraph: (state, node) => state.renderInline(node),
    heading: (state, node) => state.renderInline(node),
    text: (state, node) => state.text(node.text ?? ""),
    hard_break: defaultMarkdownSerializer.nodes.hard_break,
  },
  {
    strong: defaultMarkdownSerializer.marks.strong,
    em: defaultMarkdownSerializer.marks.em,
    link: {
      ...defaultMarkdownSerializer.marks.link,
      open: "[",
      close: (_state, mark) =>
        `](${String(mark.attrs.href).replace(/[()"\\&]/g, "\\$&")})`,
    },
  },
  { escapeExtraCharacters: /&(?=[#a-zA-Z0-9]+;)/g }
)

type SerializedDocument = { text: string; positions: number[] }

function serializePromptInputDocument(
  document: ProseMirrorNode,
  mapPositions = false
): SerializedDocument {
  let text = ""
  // Empty formatting must not turn a visually blank draft into sendable Markdown.
  const hasText = /\S/.test(document.textContent)
  const positions: number[] = []
  const append = (value: string, position: number, literal = false) => {
    if (mapPositions)
      for (let index = 0; index < value.length; index++)
        positions.push(position + (literal ? index : 0))
    text += value
    positions[text.length] = position + (literal ? value.length : 0)
  }
  const inline = (node: ProseMirrorNode, pos: number) => {
    let expectsEntitySpacer = false
    let visible = ""
    const children: ProseMirrorNode[] = []
    const visiblePositions: number[] = []
    node.forEach((child, offset) => {
      const at = pos + 1 + offset
      if (child.type.name === "composerEntity") {
        expectsEntitySpacer = true
        return
      }
      if (child.type.name === "composerEntityCursorTarget") return
      if (child.isText) {
        const skip = expectsEntitySpacer && child.text?.startsWith(" ") ? 1 : 0
        const value = (child.text ?? "").slice(skip)
        visible += value
        if (value) children.push(promptInputSchema.text(value, child.marks))
        for (let index = 0; index < value.length; index++)
          visiblePositions.push(at + skip + index)
      } else {
        children.push(child)
        if (child.type.name === "hard_break") visible += "\n"
        visiblePositions.push(at)
      }
      expectsEntitySpacer = false
    })
    const content = node.copy(Fragment.from(children))
    const encoded = hasText
      ? inlineMarkdownSerializer.serialize(
          promptInputSchema.nodes.doc.create(null, content)
        )
      : visible
    if (!mapPositions) {
      text += encoded
      return
    }
    let cursor = 0
    let sourceOffset = 0
    const start = text.length
    const endPosition = pos + 1 + node.content.size
    append(encoded, visiblePositions[0] ?? endPosition)
    const mapUntil = (end: number) => {
      while (sourceOffset < end)
        positions[start + sourceOffset++] =
          visiblePositions[cursor] ?? endPosition
    }
    if (encoded === visible) {
      for (let index = 0; index < encoded.length; index++)
        positions[start + index] = visiblePositions[index]
      positions[text.length] = endPosition
      return
    }
    const leading = encoded.match(/^\s*/)?.[0].length ?? 0
    const trailing = encoded.slice(leading).match(/\s*$/)?.[0].length ?? 0
    for (; sourceOffset < leading; sourceOffset++, cursor++)
      positions[start + sourceOffset] = visiblePositions[cursor]
    const mapNode = (node: Nodes) => {
      if (node.type === "text" || node.type === "break") {
        const from = (node.position?.start.offset ?? 0) + leading
        const to = (node.position?.end.offset ?? 0) + leading
        mapUntil(from)
        if (node.type === "break") {
          mapUntil(to)
          cursor++
        } else {
          while (sourceOffset < to) {
            positions[start + sourceOffset] =
              visiblePositions[cursor] ?? endPosition
            if (encoded[sourceOffset] === "\\" && sourceOffset + 1 < to) {
              positions[start + ++sourceOffset] =
                visiblePositions[cursor] ?? endPosition
            }
            sourceOffset++
            cursor++
          }
        }
      } else if ("children" in node) {
        node.children.forEach(mapNode)
      }
    }
    mapNode(
      markdownParser.parse(
        encoded.slice(leading, trailing ? -trailing : undefined)
      )
    )
    mapUntil(encoded.length - trailing)
    for (let index = 0; index < trailing; index++)
      positions[start + sourceOffset++] =
        visiblePositions[visiblePositions.length - trailing + index]

    positions[text.length] = pos + 1 + node.content.size
  }
  const block = (node: ProseMirrorNode, pos: number, indent = "") => {
    if (node.isTextblock) {
      if (hasText && node.type.name === "heading")
        append(`${"#".repeat(node.attrs.level)} `, pos + 1)
      inline(node, pos)
    } else if (
      node.type.name === "bullet_list" ||
      node.type.name === "ordered_list"
    ) {
      node.forEach((item, offset, index) => {
        if (index) append(`\n${indent}`, pos + offset + 2)
        const prefix = !hasText
          ? ""
          : node.type.name === "ordered_list"
            ? `${node.attrs.order + index}. `
            : "- "
        append(prefix, pos + offset + 3)
        item.forEach((child, childOffset, childIndex) => {
          if (childIndex) {
            const requiresBlankLine =
              child.isTextblock ||
              (child.type.name === "ordered_list" && child.attrs.order !== 1)
            append(
              `${requiresBlankLine ? "\n\n" : "\n"}${indent}${" ".repeat(prefix.length)}`,
              pos + offset + childOffset + 3
            )
          }
          block(
            child,
            pos + offset + childOffset + 2,
            indent + " ".repeat(prefix.length)
          )
        })
      })
    }
  }
  document.forEach((node, pos, index) => {
    if (index) {
      const previous = document.child(index - 1)
      const followsList =
        previous.type.name === "bullet_list" ||
        previous.type.name === "ordered_list"
      const requiresBlankLine =
        hasText &&
        ((followsList && node.type.name === "paragraph") ||
          (previous.type.name === "paragraph" &&
            node.type.name === "ordered_list" &&
            node.attrs.order !== 1))
      append(requiresBlankLine ? "\n\n" : "\n", pos + 1)
    }
    block(node, pos)
  })
  return { text, positions }
}

function readPromptInputDocument(document: ProseMirrorNode) {
  return serializePromptInputDocument(document).text
}

function readPromptInputEntities(document: ProseMirrorNode) {
  const entities: PromptInputEntity[] = []
  document.descendants((node) => {
    if (node.type !== promptInputSchema.nodes.composerEntity) return true
    entities.push({
      id: node.attrs.id,
      kind: node.attrs.kind,
      label: node.attrs.label,
      iconUrl: node.attrs.iconUrl ?? null,
      ...(node.attrs.removable === false ? { removable: false } : {}),
    })
    return false
  })
  return entities
}

function promptInputEntitiesEqual(
  left: readonly PromptInputEntity[],
  right: readonly PromptInputEntity[]
) {
  return (
    left.length === right.length &&
    left.every(
      (entity, index) =>
        entity.id === right[index]?.id &&
        entity.kind === right[index]?.kind &&
        entity.label === right[index]?.label &&
        (entity.iconUrl ?? null) === (right[index]?.iconUrl ?? null) &&
        (entity.removable ?? true) === (right[index]?.removable ?? true)
    )
  )
}

function textOffsetToDocumentPosition(
  document: ProseMirrorNode,
  offset: number
) {
  const { positions, text } = serializePromptInputDocument(document, true)
  const position =
    positions[Math.min(text.length, Math.max(0, offset))] ??
    TextSelection.atEnd(document).from
  return TextSelection.near(
    document.resolve(Math.max(0, Math.min(document.content.size, position)))
  ).from
}

function replacePromptInputDocument(
  view: Pick<EditorView, "state" | "dispatch">,
  value: string,
  entities: readonly PromptInputEntity[] = []
) {
  if (
    readPromptInputDocument(view.state.doc) === value &&
    promptInputEntitiesEqual(readPromptInputEntities(view.state.doc), entities)
  ) {
    return false
  }

  if (readPromptInputDocument(view.state.doc) === value) {
    const transaction = view.state.tr
    const ranges: { from: number; to: number }[] = []
    view.state.doc.descendants((node, pos) => {
      if (node.type.name !== "composerEntity") return
      const before = view.state.doc.resolve(pos).nodeBefore
      const after = view.state.doc.resolve(pos + node.nodeSize).nodeAfter
      ranges.push({
        from:
          pos -
          (before?.type.name === "composerEntityCursorTarget"
            ? before.nodeSize
            : 0),
        to:
          pos +
          node.nodeSize +
          (after?.isText && after.text?.startsWith(" ") ? 1 : 0),
      })
    })
    for (const range of ranges.reverse())
      transaction.delete(range.from, range.to)
    if (entities.length)
      transaction.insert(
        TextSelection.atStart(transaction.doc).from,
        entityNodes(entities)
      )
    view.dispatch(
      transaction.setMeta("addToHistory", false).setMeta("externalValue", true)
    )
    return true
  }

  const nextDocument = createPromptInputDocument(value, entities)
  if (view.state.doc.eq(nextDocument)) return false
  const transaction = view.state.tr
    .replaceWith(0, view.state.doc.content.size, nextDocument.content)
    .setMeta("addToHistory", false)
    .setMeta("externalValue", true)
  const cursor = textOffsetToDocumentPosition(nextDocument, value.length)
  transaction.setSelection(TextSelection.create(transaction.doc, cursor))
  view.dispatch(transaction)
  return true
}

function setPromptInputSelection(
  view: EditorView,
  selectionStart: number,
  selectionEnd: number
) {
  const anchor = textOffsetToDocumentPosition(view.state.doc, selectionStart)
  const head = textOffsetToDocumentPosition(view.state.doc, selectionEnd)
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.create(view.state.doc, anchor, head))
      .scrollIntoView()
  )
}

export {
  createPromptInputDocument,
  promptInputEntitiesEqual,
  promptInputSchema,
  readPromptInputDocument,
  readPromptInputEntities,
  replacePromptInputDocument,
  setPromptInputSelection,
  textOffsetToDocumentPosition,
}
