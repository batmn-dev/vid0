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

// Official @remixicon/react 4.9.0 paths for ProseMirror's non-React toolbar.
const icons = {
  // RiLink
  link: "M18.3638 15.5355L16.9496 14.1213L18.3638 12.7071C20.3164 10.7545 20.3164 7.58866 18.3638 5.63604C16.4112 3.68341 13.2453 3.68341 11.2927 5.63604L9.87849 7.05025L8.46428 5.63604L9.87849 4.22182C12.6122 1.48815 17.0443 1.48815 19.778 4.22182C22.5117 6.95549 22.5117 11.3876 19.778 14.1213L18.3638 15.5355ZM15.5353 18.364L14.1211 19.7782C11.3875 22.5118 6.95531 22.5118 4.22164 19.7782C1.48797 17.0445 1.48797 12.6123 4.22164 9.87868L5.63585 8.46446L7.05007 9.87868L5.63585 11.2929C3.68323 13.2455 3.68323 16.4113 5.63585 18.364C7.58847 20.3166 10.7543 20.3166 12.7069 18.364L14.1211 16.9497L15.5353 18.364ZM14.8282 7.75736L16.2425 9.17157L9.17139 16.2426L7.75717 14.8284L14.8282 7.75736Z",
  // RiBold
  bold: "M8 11H12.5C13.8807 11 15 9.88071 15 8.5C15 7.11929 13.8807 6 12.5 6H8V11ZM18 15.5C18 17.9853 15.9853 20 13.5 20H6V4H12.5C14.9853 4 17 6.01472 17 8.5C17 9.70431 16.5269 10.7981 15.7564 11.6058C17.0979 12.3847 18 13.837 18 15.5ZM8 13V18H13.5C14.8807 18 16 16.8807 16 15.5C16 14.1193 14.8807 13 13.5 13H8Z",
  // RiItalic
  italic: "M15 20H7V18H9.92661L12.0425 6H9V4H17V6H14.0734L11.9575 18H15V20Z",
  // RiArrowDownSLine
  chevron:
    "M11.9999 13.1714L16.9497 8.22168L18.3639 9.63589L11.9999 15.9999L5.63599 9.63589L7.0502 8.22168L11.9999 13.1714Z",
  // RiCheckLine
  apply:
    "M9.9997 15.1709L19.1921 5.97852L20.6063 7.39273L9.9997 17.9993L3.63574 11.6354L5.04996 10.2212L9.9997 15.1709Z",
  // RiEditLine
  edit: "M6.41421 15.89L16.5563 5.74785L15.1421 4.33363L5 14.4758V15.89H6.41421ZM7.24264 17.89H3V13.6473L14.435 2.21231C14.8256 1.82179 15.4587 1.82179 15.8492 2.21231L18.6777 5.04074C19.0682 5.43126 19.0682 6.06443 18.6777 6.45495L7.24264 17.89ZM3 19.89H21V21.89H3V19.89Z",
  // RiFileCopyLine
  copy: "M6.9998 6V3C6.9998 2.44772 7.44752 2 7.9998 2H19.9998C20.5521 2 20.9998 2.44772 20.9998 3V17C20.9998 17.5523 20.5521 18 19.9998 18H16.9998V20.9991C16.9998 21.5519 16.5499 22 15.993 22H4.00666C3.45059 22 3 21.5554 3 20.9991L3.0026 7.00087C3.0027 6.44811 3.45264 6 4.00942 6H6.9998ZM5.00242 8L5.00019 20H14.9998V8H5.00242ZM8.9998 6H16.9998V16H18.9998V4H8.9998V6Z",
  // RiExternalLinkLine
  open: "M10 6V8H5V19H16V14H18V20C18 20.5523 17.5523 21 17 21H4C3.44772 21 3 20.5523 3 20V7C3 6.44772 3.44772 6 4 6H10ZM21 3V11H19L18.9999 6.413L11.2071 14.2071L9.79289 12.7929L17.5849 5H13V3H21Z",
  // RiLinkUnlink
  clear:
    "M17 17H22V19H19V22H17V17ZM7 7H2V5H5V2H7V7ZM18.364 15.5355L16.9497 14.1213L18.364 12.7071C20.3166 10.7545 20.3166 7.58866 18.364 5.63604C16.4113 3.68342 13.2455 3.68342 11.2929 5.63604L9.87868 7.05025L8.46447 5.63604L9.87868 4.22183C12.6123 1.48816 17.0445 1.48816 19.7782 4.22183C22.5118 6.9555 22.5118 11.3877 19.7782 14.1213L18.364 15.5355ZM15.5355 18.364L14.1213 19.7782C11.3877 22.5118 6.9555 22.5118 4.22183 19.7782C1.48816 17.0445 1.48816 12.6123 4.22183 9.87868L5.63604 8.46447L7.05025 9.87868L5.63604 11.2929C3.68342 13.2455 3.68342 16.4113 5.63604 18.364C7.58866 20.3166 10.7545 20.3166 12.7071 18.364L14.1213 16.9497L15.5355 18.364ZM14.8284 7.75736L16.2426 9.17157L9.17157 16.2426L7.75736 14.8284L14.8284 7.75736Z",
} as const

function icon(name: keyof typeof icons) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("viewBox", "0 0 24 24")
  svg.setAttribute("fill", "currentColor")
  svg.setAttribute("aria-hidden", "true")
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
  path.setAttribute("d", icons[name])
  svg.append(path)
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
    const key = `${currentBlockStyle(view.state)}:${mode}:${activeMark(view.state, "strong")}:${activeMark(view.state, "em")}:${link ? `${link.from}-${link.to}-${link.href}` : ""}`
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
