"use client"

import {
  chainCommands,
  lift,
  setBlockType,
  toggleMark,
} from "prosemirror-commands"
import { liftListItem, wrapInList } from "prosemirror-schema-list"
import {
  EditorState,
  Plugin,
  TextSelection,
  type Command,
  type Transaction,
} from "prosemirror-state"
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view"
import {
  normalizePromptInputLink,
  promptInputSchema,
} from "./prompt-input-schema"

export type PromptInputBlockStyle =
  "text" | "h1" | "h2" | "h3" | "ordered_list" | "bullet_list"

export function setPromptInputBlockStyle(
  style: PromptInputBlockStyle
): Command {
  return (state, dispatch) => {
    const listType =
      style === "ordered_list" || style === "bullet_list"
        ? promptInputSchema.nodes[style]
        : null
    let listDepth = state.selection.$from.depth
    while (
      listDepth > 0 &&
      !["ordered_list", "bullet_list"].includes(
        state.selection.$from.node(listDepth).type.name
      )
    )
      listDepth--
    if (listType && listDepth > 0) {
      if (state.selection.$from.node(listDepth).type === listType)
        return liftListItem(promptInputSchema.nodes.list_item)(state, dispatch)
      dispatch?.(
        state.tr
          .setNodeMarkup(state.selection.$from.before(listDepth), listType)
          .scrollIntoView()
      )
      return true
    }
    if (listType) {
      let transaction = state.tr
      setBlockType(promptInputSchema.nodes.paragraph)(state, (next) => {
        transaction = next
      })
      const next = state.apply(transaction)
      return wrapInList(listType)(
        next,
        dispatch
          ? (wrapped) => {
              for (const step of wrapped.steps) transaction.step(step)
              dispatch(transaction.scrollIntoView())
            }
          : undefined
      )
    }
    const transaction = state.tr
    const bookmark = state.selection.getBookmark()
    const selectedBlocks: number[] = []
    state.doc.nodesBetween(
      state.selection.from,
      state.selection.to,
      (node, pos) => {
        if (!node.isTextblock) return true
        if (state.selection.empty || pos + 1 < state.selection.to)
          selectedBlocks.push(pos + 1)
        return false
      }
    )
    const appendSteps = (next: Transaction) => {
      for (const step of next.steps) transaction.step(step)
    }
    // Intermediate commands must not run appendTransaction plugins against
    // steps that have not yet been dispatched to the real editor.
    const commandState = () =>
      EditorState.create({
        doc: transaction.doc,
        selection: transaction.selection,
        storedMarks: transaction.storedMarks,
      })
    // A mixed selection cannot be lifted as one list range. Lift its blocks
    // from the end, then restore the selection before changing their type.
    for (const position of selectedBlocks.reverse()) {
      transaction.setSelection(
        TextSelection.near(
          transaction.doc.resolve(transaction.mapping.map(position))
        )
      )
      let nested = true
      while (nested) {
        const { $from } = transaction.selection
        nested = Array.from({ length: $from.depth }, (_, index) =>
          $from.node(index + 1)
        ).some((node) => node.type === promptInputSchema.nodes.list_item)
        if (
          nested &&
          !liftListItem(promptInputSchema.nodes.list_item)(
            commandState(),
            appendSteps
          )
        )
          return false
      }
    }
    transaction.setSelection(
      bookmark.map(transaction.mapping).resolve(transaction.doc)
    )
    setBlockType(
      style === "text"
        ? promptInputSchema.nodes.paragraph
        : promptInputSchema.nodes.heading,
      style === "text" ? null : { level: Number(style.slice(1)) }
    )(commandState(), appendSteps)
    if (!transaction.docChanged) return false
    dispatch?.(transaction.scrollIntoView())
    return true
  }
}

export const promptInputFormattingKeymap: Record<string, Command> = {
  "Mod-b": toggleMark(promptInputSchema.marks.strong),
  "Mod-i": toggleMark(promptInputSchema.marks.em),
  "Mod-Alt-0": setPromptInputBlockStyle("text"),
  "Mod-Alt-1": setPromptInputBlockStyle("h1"),
  "Mod-Alt-2": setPromptInputBlockStyle("h2"),
  "Mod-Alt-3": setPromptInputBlockStyle("h3"),
  "Mod-Alt-4": setPromptInputBlockStyle("ordered_list"),
  "Mod-Alt-5": setPromptInputBlockStyle("bullet_list"),
  "Mod-[": chainCommands(liftListItem(promptInputSchema.nodes.list_item), lift),
}

// Glyph geometry observed in the reference's public composer icon sprite.
const icons = {
  link: {
    viewBox: "0 0 20 20",
    paths: [
      {
        d: "M4.67 7.768a.665.665 0 0 1 .945.935L4.52 9.81l-.002.002c-1.47 1.47-1.5 3.877.147 5.523 1.646 1.646 4.052 1.618 5.523.148l.002-.002 1.107-1.096a.666.666 0 0 1 .935.945l-1.105 1.096c-2.019 2.015-5.267 1.986-7.403-.15s-2.164-5.383-.15-7.402z",
      },
      {
        d: "M12.029 7.03a.666.666 0 0 1 .941.941l-5 5a.667.667 0 0 1-.941-.941z",
      },
      {
        d: "M8.875 3.575c2.018-2.016 5.265-1.987 7.4.149 2.137 2.136 2.167 5.384.151 7.402l-1.095 1.106a.665.665 0 0 1-.946-.936l1.096-1.106.002-.002c1.47-1.47 1.498-3.878-.148-5.524s-4.052-1.617-5.523-.146l-.002.002-1.105 1.094a.665.665 0 1 1-.937-.944z",
      },
    ],
    fillRule: "nonzero",
  },
  bold: {
    viewBox: "0 0 16 16",
    paths: [
      {
        d: "M4.915 13.3c-.702 0-1.115-.426-1.115-1.16V3.852c0-.727.413-1.153 1.115-1.153h3.52c2 0 3.256 1.021 3.256 2.645 0 1.16-.871 2.13-2 2.299v.059c1.446.11 2.509 1.16 2.509 2.563 0 1.866-1.41 3.034-3.683 3.034zm1.114-6.193h1.602c1.188 0 1.867-.521 1.867-1.417 0-.852-.597-1.337-1.638-1.337H6.03zm0 4.54h1.92c1.284 0 1.978-.543 1.978-1.557 0-.992-.716-1.52-2.03-1.52H6.029z",
      },
    ],
    fillRule: "nonzero",
  },
  italic: {
    viewBox: "0 0 16 16",
    paths: [
      {
        d: "M9.953 12.82a.58.58 0 0 1-.575.48H4.933a.58.58 0 0 1-.575-.67.58.58 0 0 1 .575-.483H6.6l1.495-8.294H6.621a.58.58 0 0 1-.576-.67.58.58 0 0 1 .576-.483h4.446c.358 0 .632.317.576.667a.58.58 0 0 1-.576.486h-1.67l-1.495 8.294h1.476c.362 0 .636.322.575.674",
      },
    ],
    fillRule: "nonzero",
  },
  chevron: {
    viewBox: "0 0 16 16",
    paths: [
      {
        d: "M12.629 5.879a.525.525 0 1 1 .742.742l-4.765 4.765a.86.86 0 0 1-1.212 0L2.629 6.62a.525.525 0 1 1 .742-.742L8 10.508z",
      },
    ],
    fillRule: "nonzero",
  },
  apply: {
    viewBox: "0 0 20 20",
    paths: [
      {
        d: "M15.894 3.762a.666.666 0 0 1 1.095.756L9.007 16.085a.79.79 0 0 1-1.208.112l-4.73-4.692a.665.665 0 0 1 .937-.944L8.278 14.8z",
      },
    ],
    fillRule: "nonzero",
  },
  edit: {
    viewBox: "0 0 20 20",
    paths: [
      {
        d: "M11.626 3.304c1.426-1.423 3.694-1.394 5.054-.009 1.403 1.355 1.45 3.633.01 5.073l-7 7h-.002a5.2 5.2 0 0 1-2.572 1.47v.002l-3.868.888-.001-.002c-.167.04-.505.073-.774-.196-.271-.27-.237-.61-.197-.777h-.002l.89-3.857A5.25 5.25 0 0 1 4.6 10.327zm-6.084 7.965c-.54.539-.917 1.19-1.081 1.922l-.001.003-.704 3.052 3.061-.703a3.88 3.88 0 0 0 1.92-1.102l5.657-5.66-3.182-3.183zm10.2-7.033c-.838-.863-2.266-.9-3.177.01l-.413.411 3.183 3.184.414-.413c.917-.917.874-2.34.009-3.176z",
      },
    ],
    fillRule: "evenodd",
  },
  copy: {
    viewBox: "0 0 20 20",
    paths: [
      {
        d: "M15.1 1.785a3.065 3.065 0 0 1 3.065 3.066v6.033a3.065 3.065 0 0 1-3.064 3.064h-1.103v1.103a3.065 3.065 0 0 1-3.064 3.064H4.9a3.066 3.066 0 0 1-3.065-3.064V9.018A3.066 3.066 0 0 1 4.9 5.952h1.102V4.851a3.066 3.066 0 0 1 3.065-3.066zM4.9 7.282c-.958 0-1.735.777-1.735 1.736v6.033c0 .958.777 1.734 1.735 1.734h6.034c.957 0 1.734-.776 1.734-1.734V9.018c0-.959-.776-1.736-1.734-1.736zm4.167-4.167c-.958 0-1.735.777-1.735 1.736v1.101h3.602a3.065 3.065 0 0 1 3.064 3.066v3.6h1.103c.957 0 1.734-.776 1.734-1.734V4.85c0-.958-.777-1.735-1.734-1.736z",
      },
    ],
    fillRule: "evenodd",
  },
  open: {
    viewBox: "0 0 20 20",
    paths: [
      {
        d: "M8.333 3.334a.665.665 0 0 1 0 1.33H6.667a2.003 2.003 0 0 0-2.002 2.003v6.666c0 1.105.896 2.002 2.002 2.002h6.666a2 2 0 0 0 2.002-2.003v-1.666a.665.665 0 0 1 1.33 0v1.666a3.33 3.33 0 0 1-3.332 3.333H6.667a3.33 3.33 0 0 1-3.332-3.332V6.666a3.333 3.333 0 0 1 3.332-3.333z",
      },
      {
        d: "M16.578 2.505c.505 0 .915.41.915.915l.001 4.044a.666.666 0 0 1-1.33 0v-2.68l-4.885 4.884a.665.665 0 0 1-.94-.94l4.891-4.893-2.695.001a.666.666 0 0 1 0-1.33z",
      },
    ],
    fillRule: "nonzero",
  },
  clear: {
    viewBox: "0 0 20 20",
    paths: [
      {
        d: "M14.006 16.022a.666.666 0 0 1 .807.484l.416 1.667a.665.665 0 0 1-1.29.322l-.417-1.667a.666.666 0 0 1 .484-.806M4.707 7.742a.666.666 0 0 1 .94.94l-1.13 1.13c-1.47 1.47-1.498 3.878.148 5.524s4.053 1.617 5.524.147l1.13-1.13a.665.665 0 0 1 .94.94l-1.13 1.13c-2.018 2.018-5.268 1.99-7.405-.146-2.137-2.138-2.165-5.388-.147-7.406zM16.828 13.522l1.667.417a.666.666 0 0 1-.322 1.29l-1.667-.416a.666.666 0 0 1 .322-1.291",
      },
      {
        d: "M8.164 10.896a.666.666 0 0 1 .94.941l-1.133 1.134a.666.666 0 0 1-.941-.94zM8.871 3.577c2.018-2.017 5.268-1.99 7.405.147s2.165 5.387.147 7.405l-1.13 1.13a.666.666 0 0 1-.94-.94l1.13-1.13c1.47-1.47 1.499-3.878-.147-5.524s-4.054-1.618-5.524-.147l-1.13 1.13a.666.666 0 0 1-.94-.94z",
      },
      {
        d: "M12.03 7.03a.666.666 0 0 1 .94.941l-1.133 1.134a.666.666 0 0 1-.941-.94zM1.828 4.772l1.667.417a.666.666 0 0 1-.322 1.29l-1.667-.416a.666.666 0 0 1 .322-1.291M5.256 1.022a.666.666 0 0 1 .807.484l.416 1.667a.665.665 0 0 1-1.29.322l-.417-1.667a.666.666 0 0 1 .484-.806",
      },
    ],
    fillRule: "nonzero",
  },
} as const

function icon(name: keyof typeof icons) {
  const glyph = icons[name]
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("viewBox", glyph.viewBox)
  svg.setAttribute("fill", "currentColor")
  svg.setAttribute("fill-rule", glyph.fillRule)
  svg.setAttribute("clip-rule", glyph.fillRule)
  svg.setAttribute("aria-hidden", "true")
  for (const path of glyph.paths) {
    const element = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "path"
    )
    element.setAttribute("d", path.d)
    svg.append(element)
  }
  return svg
}

function activeMark(state: EditorState, name: "strong" | "em") {
  return state.doc.rangeHasMark(
    state.selection.from,
    state.selection.to,
    promptInputSchema.marks[name]
  )
}

function currentBlockStyle(state: EditorState): PromptInputBlockStyle {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (node.type.name === "ordered_list" || node.type.name === "bullet_list")
      return node.type.name
  }
  if ($from.parent.type.name === "heading")
    return `h${$from.parent.attrs.level}` as "h1" | "h2" | "h3"
  return "text"
}

function linkAtSelection(state: EditorState) {
  const { $from, from, to } = state.selection
  const mark = [
    ...(state.doc.nodeAt(from)?.marks ?? []),
    ...$from.marks(),
    ...(state.selection.empty ? ($from.nodeBefore?.marks ?? []) : []),
  ].find((mark) => mark.type === promptInputSchema.marks.link)
  if (!mark) return null
  let start = $from.start()
  let end = start
  let found = false
  $from.parent.forEach((node, offset) => {
    const at = $from.start() + offset
    if (!mark.isInSet(node.marks)) {
      if (!found) start = end = at + node.nodeSize
      return
    }
    if (!found && at <= from && at + node.nodeSize >= from) found = true
    if (!found || at === end) end = at + node.nodeSize
  })
  if (!found || to > end) return null
  return { from: start, to: end, href: String(mark.attrs.href) }
}

/** Selection UI belongs to the EditorView, preserving the native selection. */
export function createPromptInputFormattingPlugin() {
  let controller: ReturnType<typeof createFormattingToolbar> | undefined
  return new Plugin({
    props: {
      decorations(state) {
        return controller?.selectionDecorations(state) ?? null
      },
      handleKeyDown(view, event) {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "k"
        ) {
          event.preventDefault()
          controller?.editLink()
          return true
        }
        if (event.key === "Escape") return controller?.dismiss() ?? false
        return false
      },
      handleDOMEvents: {
        focus() {
          queueMicrotask(() => controller?.update())
          return false
        },
        blur() {
          queueMicrotask(() => controller?.update())
          return false
        },
        pointerdown() {
          controller?.reset()
          return false
        },
      },
    },
    view(view) {
      const toolbar = createFormattingToolbar(view)
      controller = toolbar
      return {
        ...toolbar,
        destroy() {
          toolbar.destroy()
          if (controller === toolbar) controller = undefined
        },
      }
    },
  })
}

function createFormattingToolbar(view: EditorView) {
  const toolbar = document.createElement("div")
  toolbar.className = "composer-format-toolbar"
  toolbar.setAttribute("role", "toolbar")
  toolbar.setAttribute("aria-label", "Formatting")
  toolbar.setAttribute("aria-orientation", "horizontal")
  toolbar.hidden = true
  document.body.append(toolbar)
  let disposed = false
  let mode: "format" | "link" | "preview" = "format"
  let dismissed = false
  let menu: HTMLDivElement | null = null
  let savedLink: ReturnType<typeof linkAtSelection> = null
  let input: HTMLInputElement | null = null
  let rendered = ""
  let linkAnchor: { left: number; width: number; centered: boolean } | null =
    null
  let formatAnchor: { left: number; top: number } | null = null
  let previousBlockStyle = currentBlockStyle(view.state)
  let previousSelection = view.state.selection

  const button = (
    label: string,
    glyph: keyof typeof icons | null,
    onClick: () => void,
    text?: string
  ) => {
    const element = document.createElement("button")
    element.type = "button"
    element.className = "composer-format-button"
    element.ariaLabel = label
    element.title = label
    if (glyph) element.append(icon(glyph))
    if (text) {
      element.append(document.createTextNode(text))
      element.classList.add("composer-format-text-button")
    }
    element.addEventListener("click", onClick)
    return element
  }
  const run = (command: Command, close = false) => {
    command(view.state, view.dispatch, view)
    if (close) {
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.near(view.state.doc.resolve(view.state.selection.to))
        )
      )
      dismissed = true
    }
    view.focus()
    update()
  }
  const closeMenu = () => {
    menu?.remove()
    menu = null
    toolbar
      .querySelector('[aria-haspopup="menu"]')
      ?.setAttribute("aria-expanded", "false")
  }
  const position = () => {
    if (disposed || view.isDestroyed || toolbar.hidden) return
    const selection = window.getSelection()
    const range =
      selection?.rangeCount && view.dom.contains(selection.anchorNode)
        ? selection.getRangeAt(0).getBoundingClientRect()
        : null
    const start = view.coordsAtPos(view.state.selection.from)
    const end = view.coordsAtPos(view.state.selection.to)
    const left = range && range.width ? range.left : start.left
    const right = range && range.width ? range.right : end.right
    const top = range && range.height ? range.top : start.top
    const toolbarRect = toolbar.getBoundingClientRect()
    const width = toolbarRect.width
    const preferredLeft =
      mode === "format" && formatAnchor
        ? formatAnchor.left
        : mode === "link" && linkAnchor
          ? linkAnchor.left +
            (linkAnchor.centered ? (linkAnchor.width - width) / 2 : 0)
          : (left + right) / 2 - width / 2
    toolbar.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, preferredLeft))}px`
    const preferredTop =
      mode === "format" && formatAnchor ? formatAnchor.top : top - 44
    const scrollParent = view.dom.closest<HTMLElement>(
      "[data-composer-editor-scroller]"
    )
    const minimumTop = scrollParent
      ? Math.max(
          8,
          scrollParent.getBoundingClientRect().top - toolbarRect.height - 7
        )
      : 8
    toolbar.style.top = `${Math.max(minimumTop, preferredTop)}px`
    if (mode === "format")
      formatAnchor = { left: preferredLeft, top: preferredTop }
  }
  const openMenu = (trigger: HTMLButtonElement) => {
    if (menu) {
      closeMenu()
      return
    }
    menu = document.createElement("div")
    menu.className = "composer-format-menu"
    menu.setAttribute("role", "menu")
    menu.ariaLabel = "Text styles"
    const styles: [PromptInputBlockStyle, string][] = [
      ["text", "Text"],
      ["h1", "Heading 1"],
      ["h2", "Heading 2"],
      ["h3", "Heading 3"],
      ["ordered_list", "Numbered list"],
      ["bullet_list", "Bulleted list"],
    ]
    styles.forEach(([style, label], index) => {
      const item = button(label, null, () => {
        closeMenu()
        run(setPromptInputBlockStyle(style), true)
      })
      item.className = `composer-format-menu-item composer-format-menu-${style}`
      item.setAttribute("role", "menuitemradio")
      item.setAttribute(
        "aria-checked",
        String(currentBlockStyle(view.state) === style)
      )
      const name = document.createElement("span")
      name.textContent = label
      const shortcut = document.createElement("span")
      shortcut.className = "composer-format-shortcut"
      shortcut.textContent = `${navigator.platform.includes("Mac") ? "⌥⌘" : "Ctrl Alt "}${index}`
      item.append(name, shortcut)
      menu?.append(item)
    })
    toolbar.append(menu)
    const toolbarRect = toolbar.getBoundingClientRect()
    const triggerRect = trigger.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - 200, triggerRect.left - 8)) - toolbarRect.left}px`
    menu.style.top = `${triggerRect.bottom - toolbarRect.top + 8}px`
    trigger.setAttribute("aria-expanded", "true")
    menu.addEventListener("keydown", (event) => {
      const items = Array.from(menu?.querySelectorAll("button") ?? [])
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        items[
          (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) %
            items.length
        ]?.focus()
      } else if (event.key === "Escape") {
        event.stopPropagation()
        closeMenu()
        trigger.focus()
      }
    })
    menu.querySelector("button")?.focus({ preventScroll: true })
  }
  const editLink = () => {
    if (view.state.selection.empty && !linkAtSelection(view.state)) return
    savedLink = linkAtSelection(view.state)
    const anchorRect = toolbar.getBoundingClientRect()
    linkAnchor = toolbar.hidden
      ? null
      : {
          left: anchorRect.left,
          width: anchorRect.width,
          centered: mode === "preview",
        }
    mode = "link"
    dismissed = false
    rendered = ""
    view.dispatch(view.state.tr.setMeta("formattingSelection", true))
    input?.focus({ preventScroll: true })
    input?.select()
  }
  const applyLink = () => {
    const href = normalizePromptInputLink(input?.value ?? "")
    if (!href) {
      input?.setAttribute("aria-invalid", "true")
      return
    }
    const { from, to } = savedLink ?? view.state.selection
    const transaction = view.state.tr.addMark(
      from,
      to,
      promptInputSchema.marks.link.create({ href })
    )
    transaction.setSelection(TextSelection.create(transaction.doc, to))
    mode = "preview"
    view.dispatch(transaction)
    view.focus()
    rendered = ""
    update()
  }
  const update = () => {
    if (disposed || view.isDestroyed) return
    if (!previousSelection.eq(view.state.selection)) {
      dismissed = false
      formatAnchor = null
      previousSelection = view.state.selection
    }
    const blockStyle = currentBlockStyle(view.state)
    if (blockStyle !== previousBlockStyle) {
      formatAnchor = null
      previousBlockStyle = blockStyle
    }
    if (!view.editable) {
      toolbar.hidden = true
      return
    }
    const link = linkAtSelection(view.state)
    const hasFocus = view.hasFocus() || toolbar.contains(document.activeElement)
    if (
      dismissed ||
      !hasFocus ||
      (view.state.selection.empty && !link && mode !== "link")
    ) {
      toolbar.hidden = true
      closeMenu()
      return
    }
    if (mode !== "link") mode = link ? "preview" : "format"
    const key = `${currentBlockStyle(view.state)}:${mode}:${activeMark(view.state, "strong")}:${activeMark(view.state, "em")}:${link?.href ?? ""}`
    toolbar.hidden = false
    if (key !== rendered) {
      closeMenu()
      toolbar.replaceChildren()
      input = null
      rendered = key
      if (mode === "link") {
        input = document.createElement("input")
        input.type = "text"
        input.className = "composer-format-link-input"
        input.placeholder = "Type or paste a link"
        input.ariaLabel = "Type or paste a link"
        input.value = savedLink?.href ?? ""
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            applyLink()
          }
          if (event.key === "Escape") {
            event.preventDefault()
            mode = "format"
            rendered = ""
            view.dispatch(view.state.tr.setMeta("formattingSelection", true))
            view.focus()
            update()
          }
        })
        const apply = button("Apply link", "apply", applyLink)
        apply.classList.add("composer-format-apply-button")
        apply.disabled = !normalizePromptInputLink(input.value)
        input.addEventListener("input", () => {
          apply.disabled = !normalizePromptInputLink(input?.value ?? "")
        })
        toolbar.append(input, apply)
      } else if (mode === "preview" && link) {
        const title = document.createElement("span")
        title.className = "composer-format-link-url"
        title.textContent = link.href
        toolbar.append(
          title,
          button("Edit link", "edit", editLink),
          button("Clear link", "clear", () => {
            view.dispatch(
              view.state.tr.removeMark(
                link.from,
                link.to,
                promptInputSchema.marks.link
              )
            )
            mode = "format"
            dismissed = true
            view.focus()
            rendered = ""
            update()
          })
        )
        const separator = document.createElement("span")
        separator.className = "composer-format-separator"
        toolbar.append(
          separator,
          button(
            "Copy link",
            "copy",
            () => {
              void navigator.clipboard.writeText(link.href)
            },
            "Copy"
          ),
          button(
            "Open link",
            "open",
            () => {
              window.open(link.href, "_blank", "noopener,noreferrer")
            },
            "Open"
          )
        )
      } else {
        const bold = button("Bold", "bold", () =>
          run(toggleMark(promptInputSchema.marks.strong))
        )
        bold.setAttribute(
          "aria-pressed",
          String(activeMark(view.state, "strong"))
        )
        const italic = button("Italic", "italic", () =>
          run(toggleMark(promptInputSchema.marks.em))
        )
        italic.setAttribute(
          "aria-pressed",
          String(activeMark(view.state, "em"))
        )
        const styleLabel = {
          text: "Text",
          h1: "Heading 1",
          h2: "Heading 2",
          h3: "Heading 3",
          ordered_list: "Numbered list",
          bullet_list: "Bulleted list",
        }[currentBlockStyle(view.state)]
        const styles = button(
          "Text styles",
          null,
          () => openMenu(styles),
          styleLabel
        )
        styles.classList.add("composer-format-styles-button")
        styles.append(icon("chevron"))
        styles.setAttribute("aria-haspopup", "menu")
        styles.setAttribute("aria-expanded", "false")
        toolbar.append(button("Link", "link", editLink), bold, italic, styles)
      }
    }
    position()
  }
  const dismiss = (restoreFocus = true) => {
    if (toolbar.hidden) return false
    dismissed = true
    mode = "format"
    toolbar.hidden = true
    closeMenu()
    if (!disposed && !view.isDestroyed)
      view.dispatch(view.state.tr.setMeta("formattingSelection", true))
    if (restoreFocus) view.focus()
    return true
  }
  const outsidePointer = (event: PointerEvent) => {
    if (
      !toolbar.contains(event.target as Node) &&
      !view.dom.contains(event.target as Node)
    )
      dismiss(false)
  }
  toolbar.addEventListener("pointerdown", (event) => {
    if (!(event.target instanceof HTMLInputElement)) event.preventDefault()
  })
  toolbar.addEventListener("keydown", (event) => {
    if (
      !menu &&
      !(event.target instanceof HTMLInputElement) &&
      ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
    ) {
      event.preventDefault()
      const buttons = Array.from(
        toolbar.querySelectorAll<HTMLButtonElement>(":scope > button")
      )
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : (index + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) %
              buttons.length
      buttons[next]?.focus()
    }
    if (event.key === "Escape" && !menu) {
      event.preventDefault()
      dismiss()
    }
  })
  document.addEventListener("pointerdown", outsidePointer)
  const reposition = () => {
    formatAnchor = null
    position()
  }
  window.addEventListener("resize", reposition)
  window.addEventListener("scroll", reposition, true)
  return {
    update,
    selectionDecorations(state: EditorState) {
      if (mode !== "link") return null
      const { from, to } = savedLink ?? state.selection
      return from < to
        ? DecorationSet.create(state.doc, [
            Decoration.inline(from, to, {
              class: "composer-format-preserved-selection",
            }),
          ])
        : null
    },
    editLink,
    dismiss,
    reset() {
      dismissed = false
      formatAnchor = null
      mode = "format"
      rendered = ""
    },
    destroy() {
      disposed = true
      toolbar.remove()
      document.removeEventListener("pointerdown", outsidePointer)
      window.removeEventListener("resize", reposition)
      window.removeEventListener("scroll", reposition, true)
    },
  }
}
