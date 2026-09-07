/** @vitest-environment jsdom */

import { RI_GLOBAL_LINE_PATH } from "@/lib/icons/composer"
import React, { act, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { Button } from "./button"
import {
  PromptInput,
  PromptInputAction,
  PromptInputActions,
  PromptInputFooter,
  PromptInputTextarea,
} from "./prompt-input"
import { ScrollRoot } from "./scroll-root"

let surfaceWidth = 768
let leadingWidth = 36
let trailingWidth = 148
let scrollHeightReads = 0
let mediaMatches = false
let resizeObservers: ResizeObserverMock[] = []

function rect(width: number): DOMRect {
  return {
    bottom: 0,
    height: 0,
    left: 0,
    right: width,
    top: 0,
    width,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }
}

class ResizeObserverMock {
  readonly observe = vi.fn()
  readonly unobserve = vi.fn()
  readonly disconnect = vi.fn()

  constructor(private readonly callback: ResizeObserverCallback) {
    resizeObservers.push(this)
  }

  trigger() {
    this.callback([], this as unknown as ResizeObserver)
  }
}

describe("PromptInput responsive expansion", () => {
  let container: HTMLDivElement
  let root: Root

  beforeAll(() => {
    ;(
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT
  })

  beforeEach(() => {
    surfaceWidth = 768
    leadingWidth = 36
    trailingWidth = 148
    scrollHeightReads = 0
    mediaMatches = false
    resizeObservers = []

    vi.stubGlobal("ResizeObserver", ResizeObserverMock)
    Object.defineProperties(Range.prototype, {
      getBoundingClientRect: {
        configurable: true,
        value: () => rect(0),
      },
      getClientRects: {
        configurable: true,
        value: () => [],
      },
    })
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: mediaMatches,
        media: "(max-width: 639px)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
    )

    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function getBoundingClientRect(this: Element) {
        if (!(this instanceof HTMLElement)) return rect(0)
        if (
          this.dataset.composerSurface === "true" ||
          this.dataset.composerLayout === "true"
        ) {
          return rect(surfaceWidth)
        }
        if (this.dataset.composerLeading === "true") {
          return rect(leadingWidth)
        }
        if (this.dataset.composerTrailing === "true") {
          return rect(trailingWidth)
        }
        return rect(this instanceof HTMLTextAreaElement ? 555 : 0)
      }
    )

    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      if (element instanceof HTMLTextAreaElement) {
        return {
          lineHeight: "26px",
          paddingBottom: "16px",
          paddingTop: "0px",
          getPropertyValue: () => "",
        } as unknown as CSSStyleDeclaration
      }

      return {
        paddingLeft: "8px",
        paddingRight: "8px",
        getPropertyValue: (property: string) => {
          if (property === "--composer-compact-editor-padding-start") {
            return "7px"
          }
          if (property === "--composer-compact-editor-padding-end") {
            return "6px"
          }
          return ""
        },
      } as unknown as CSSStyleDeclaration
    })

    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
      function scrollHeight(this: HTMLElement) {
        if (
          !this.classList.contains("composer-prosemirror") ||
          this.style.position !== "absolute"
        )
          return 42
        scrollHeightReads += 1
        const width = Number.parseFloat(this.style.width) || 555
        return (this.textContent?.length ?? 0) * 8 > width ? 68 : 42
      }
    )

    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("remeasures a static draft when available inline width changes", () => {
    const value = "a".repeat(65)

    act(() => {
      root.render(
        <PromptInput value={value} onValueChange={() => {}}>
          <PromptInputActions data-composer-leading="true" />
          <PromptInputTextarea aria-label="Ask anything" />
          <PromptInputFooter aria-hidden="true" />
          <PromptInputActions data-composer-trailing="true" />
        </PromptInput>
      )
    })

    const form = container.querySelector("form")
    const observer = resizeObservers.at(-1)
    expect(observer).toBeTruthy()
    expect(form?.hasAttribute("data-expanded")).toBe(false)

    expect(scrollHeightReads).toBe(1)
    const readsAfterInitialLayout = scrollHeightReads
    act(() => observer?.trigger())
    expect(scrollHeightReads).toBe(readsAfterInitialLayout)

    trailingWidth = 264
    act(() => observer?.trigger())
    expect(form?.hasAttribute("data-expanded")).toBe(true)

    trailingWidth = 148
    act(() => observer?.trigger())
    expect(form?.hasAttribute("data-expanded")).toBe(false)

    surfaceWidth = 650
    act(() => observer?.trigger())
    expect(form?.hasAttribute("data-expanded")).toBe(true)

    surfaceWidth = 768
    act(() => observer?.trigger())
    expect(form?.hasAttribute("data-expanded")).toBe(false)
  })

  it("measures the visible link label rather than its destination", () => {
    act(() => {
      root.render(
        <PromptInput
          value={`[Short](https://example.com/${"long".repeat(100)})`}
          onValueChange={() => {}}
        >
          <PromptInputActions data-composer-leading="true" />
          <PromptInputTextarea aria-label="Ask anything" />
          <PromptInputActions data-composer-trailing="true" />
        </PromptInput>
      )
    })
    expect(container.querySelector("form")?.hasAttribute("data-expanded")).toBe(
      false
    )
    expect(
      container.querySelector(".composer-prosemirror a")?.textContent
    ).toBe("Short")
  })

  it("remeasures text appended after a link with a long destination", () => {
    const link = `[Short](https://example.com/${"x".repeat(2100)})`
    const render = (value: string) =>
      act(() => {
        root.render(
          <PromptInput value={value} onValueChange={() => {}}>
            <PromptInputActions data-composer-leading="true" />
            <PromptInputTextarea aria-label="Ask anything" />
            <PromptInputActions data-composer-trailing="true" />
          </PromptInput>
        )
      })
    render(link)
    expect(container.querySelector("form")?.hasAttribute("data-expanded")).toBe(
      false
    )
    render(`${link} ${"visible text ".repeat(10)}`)
    expect(container.querySelector("form")?.hasAttribute("data-expanded")).toBe(
      true
    )
    render(link)
    expect(container.querySelector("form")?.hasAttribute("data-expanded")).toBe(
      false
    )
  })

  it("disconnects geometry observation with the textarea DOM lifecycle", () => {
    act(() => {
      root.render(
        <PromptInput value="draft" onValueChange={() => {}}>
          <PromptInputActions data-composer-leading="true" />
          <PromptInputTextarea aria-label="Ask anything" />
          <PromptInputActions data-composer-trailing="true" />
        </PromptInput>
      )
    })

    const observer = resizeObservers.at(-1)
    expect(observer).toBeTruthy()

    act(() => root.unmount())
    expect(observer?.disconnect).toHaveBeenCalledTimes(1)

    root = createRoot(container)
  })

  it("describes the focusable visually disabled action with its tooltip", () => {
    act(() => {
      root.render(
        <PromptInput value="" onValueChange={() => {}}>
          <PromptInputAction tooltip="Message is empty">
            <Button visuallyDisabled aria-label="Send prompt" />
          </PromptInputAction>
        </PromptInput>
      )
    })

    const button = container.querySelector(
      'button[aria-label="Send prompt"]'
    ) as HTMLButtonElement
    const descriptionId = button.getAttribute("aria-describedby")

    expect(button.hasAttribute("data-visually-disabled")).toBe(true)
    expect(button.disabled).toBe(false)
    expect(button.tabIndex).toBe(0)
    expect(button.getAttribute("aria-disabled")).toBe("true")
    expect(button.getAttribute("data-slot")).toBe("button")
    expect(button.parentElement?.getAttribute("data-slot")).toBe(
      "tooltip-trigger"
    )
    expect(button.parentElement?.getAttribute("aria-describedby")).toBe(
      descriptionId
    )
    expect(descriptionId).toBeTruthy()
    expect(document.getElementById(descriptionId ?? "")?.textContent).toBe(
      "Message is empty"
    )
  })

  it("keeps one ProseMirror textbox across controlled draft replacements", () => {
    const renderDraft = (value: string) => {
      act(() => {
        root.render(
          <PromptInput value={value} onValueChange={() => {}}>
            <PromptInputTextarea
              aria-label="Ask anything"
              placeholder="Ask anything"
            />
          </PromptInput>
        )
      })
    }

    renderDraft("first line")

    const editor = container.querySelector("#prompt-textarea") as HTMLElement
    const fallback = container.querySelector(
      ".composer-fallback-textarea"
    ) as HTMLTextAreaElement

    expect(editor.getAttribute("contenteditable")).toBe("true")
    expect(editor.getAttribute("role")).toBe("textbox")
    expect(editor.getAttribute("aria-multiline")).toBe("true")
    expect(editor.getAttribute("data-virtualkeyboard")).toBe("true")
    expect(editor.getAttribute("autocomplete")).toBe("off")
    expect(editor.getAttribute("inputmode")).toBe("text")
    expect(editor.getAttribute("autocorrect")).toBe("on")
    expect(editor.getAttribute("autocapitalize")).toBe("sentences")
    expect(editor.getAttribute("spellcheck")).toBe("true")
    expect(editor.getAttribute("translate")).toBe("no")
    expect(editor.textContent).toBe("first line")
    expect(editor.querySelector("p")?.getAttribute("dir")).toBe("auto")
    expect(fallback.getAttribute("aria-hidden")).toBeNull()
    expect(fallback.getAttribute("tabindex")).toBeNull()
    expect(fallback.getAttribute("readonly")).toBeNull()
    expect(fallback.name).toBe("prompt-textarea")
    expect(fallback.style.display).toBe("none")

    renderDraft("second line\nthird line")

    expect(container.querySelector("#prompt-textarea")).toBe(editor)
    expect(
      Array.from(
        editor.querySelectorAll("p"),
        (paragraph) => paragraph.textContent
      )
    ).toEqual(["second line", "third line"])
  })

  it("keeps one empty paragraph through the Strict Mode callback-ref remount", () => {
    act(() => {
      root.render(
        <StrictMode>
          <PromptInput value="" onValueChange={() => {}}>
            <PromptInputTextarea
              aria-label="Ask anything"
              placeholder="Ask anything"
            />
          </PromptInput>
        </StrictMode>
      )
    })

    const editor = container.querySelector("#prompt-textarea") as HTMLElement
    const paragraph = editor.querySelector("p")

    expect(editor.querySelectorAll("p")).toHaveLength(1)
    expect(paragraph?.getAttribute("data-empty-paragraph")).toBe("true")
    expect(paragraph?.getAttribute("data-placeholder")).toBe("Ask anything")

    act(() => {
      root.render(
        <StrictMode>
          <PromptInput value={"\n"} onValueChange={() => {}}>
            <PromptInputTextarea
              aria-label="Ask anything"
              placeholder="Ask anything"
            />
          </PromptInput>
        </StrictMode>
      )
    })

    expect(editor.querySelectorAll("p")).toHaveLength(2)
    expect(editor.querySelector("p.placeholder")).toBeNull()
  })

  it("renders protected typed entities inside the stable editor DOM", () => {
    const entity = {
      id: "web-search",
      kind: "capability" as const,
      label: "Web search",
    }

    act(() => {
      root.render(
        <PromptInput
          entities={[entity]}
          value="draft"
          onEntitiesChange={() => {}}
          onValueChange={() => {}}
        >
          <PromptInputTextarea aria-label="Ask anything" />
        </PromptInput>
      )
    })

    const editor = container.querySelector("#prompt-textarea") as HTMLElement
    const cursorTarget = editor.querySelector(
      "span[data-inline-selection-pill-cursor-target]"
    )
    const entityNode = editor.querySelector("span[data-inline-selection-pill]")

    expect(cursorTarget?.getAttribute("aria-hidden")).toBe("true")
    expect(cursorTarget?.textContent).toBe("\uFEFF")
    expect(entityNode?.getAttribute("contenteditable")).toBe("false")
    expect(entityNode?.getAttribute("data-id")).toBe("search")
    expect(entityNode?.getAttribute("data-keyword")).toBe("Web search")
    expect(entityNode?.getAttribute("data-system-hint-type")).toBe("search")
    expect(entityNode?.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true"
    )
    expect(entityNode?.querySelector("circle")).toBeNull()
    expect(entityNode?.querySelector("path")?.getAttribute("d")).toBe(
      RI_GLOBAL_LINE_PATH
    )
    expect(entityNode?.querySelector("path")?.getAttribute("fill")).toBe(
      "var(--web-search-icon-foreground)"
    )
    expect(entityNode?.textContent).toBe("Web search")
    expect(entityNode?.nextSibling?.nodeType).toBe(Node.TEXT_NODE)
    expect(entityNode?.nextSibling?.textContent).toBe(" draft")
    expect(editor.querySelector(".ProseMirror-trailingBreak")).toBeNull()

    act(() => {
      root.render(
        <PromptInput
          entities={[{ ...entity }]}
          value="draft"
          onEntitiesChange={() => {}}
          onValueChange={() => {}}
        >
          <PromptInputTextarea aria-label="Ask anything" />
        </PromptInput>
      )
    })

    expect(container.querySelector("#prompt-textarea")).toBe(editor)
    expect(editor.querySelector("span[data-inline-selection-pill]")).toBe(
      entityNode
    )
  })

  it("keeps the composer ID distinct from a mounted message editor", () => {
    const renderEditors = (editId: string) => {
      act(() => {
        root.render(
          <>
            <PromptInput value="New message">
              <PromptInputTextarea />
            </PromptInput>
            <PromptInput value="Earlier message">
              <PromptInputTextarea id={editId} autoFocus={false} />
            </PromptInput>
          </>
        )
      })
    }
    renderEditors("message-edit-first")
    const main = container.querySelector("#prompt-textarea")
    const edit = container.querySelector("#message-edit-first")
    expect(container.querySelectorAll("#prompt-textarea")).toHaveLength(1)
    expect(edit?.textContent).toBe("Earlier message")
    renderEditors("message-edit-second")
    expect(container.querySelector("#message-edit-first")).toBeNull()
    expect(container.querySelector("#message-edit-second")).toBe(edit)
    expect(container.querySelector("#prompt-textarea")).toBe(main)
  })

  it("submits Enter and preserves Shift+Enter as a draft paragraph", () => {
    const onSubmit = vi.fn()
    const onValueChange = vi.fn()

    act(() => {
      root.render(
        <PromptInput
          value="draft"
          onSubmit={onSubmit}
          onValueChange={onValueChange}
        >
          <PromptInputTextarea aria-label="Ask anything" />
        </PromptInput>
      )
    })

    const editor = container.querySelector("#prompt-textarea") as HTMLElement

    act(() => {
      editor.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
      )
    })
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onValueChange).not.toHaveBeenCalled()

    act(() => {
      editor.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Enter",
          shiftKey: true,
        })
      )
    })
    expect(onValueChange).toHaveBeenLastCalledWith("\ndraft")
  })

  it("keeps IME composition and disabled submission inside the editor primitive", () => {
    const onSubmit = vi.fn()
    const onKeyDown = vi.fn()

    act(() => {
      root.render(
        <PromptInput
          disabled
          value="draft"
          onSubmit={onSubmit}
          onValueChange={() => {}}
        >
          <PromptInputTextarea
            aria-label="Ask anything"
            onKeyDown={onKeyDown}
          />
        </PromptInput>
      )
    })

    const editor = container.querySelector("#prompt-textarea") as HTMLElement
    const form = container.querySelector("form") as HTMLFormElement

    expect(editor.getAttribute("contenteditable")).toBe("false")
    expect(editor.getAttribute("aria-disabled")).toBe("true")
    expect(editor.getAttribute("aria-readonly")).toBe("true")

    act(() => {
      form.dispatchEvent(
        new SubmitEvent("submit", { bubbles: true, cancelable: true })
      )
    })
    expect(onSubmit).not.toHaveBeenCalled()

    act(() => {
      root.render(
        <PromptInput value="draft" onSubmit={onSubmit} onValueChange={() => {}}>
          <PromptInputTextarea
            aria-label="Ask anything"
            onKeyDown={onKeyDown}
          />
        </PromptInput>
      )
    })

    const composingEnter = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    })
    Object.defineProperty(composingEnter, "isComposing", { value: true })
    act(() => editor.dispatchEvent(composingEnter))

    const imeEnter = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    })
    Object.defineProperty(imeEnter, "keyCode", { value: 229 })
    act(() => editor.dispatchEvent(imeEnter))

    const alreadyHandledEnter = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    })
    alreadyHandledEnter.preventDefault()
    act(() => editor.dispatchEvent(alreadyHandledEnter))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(onKeyDown).not.toHaveBeenCalled()
    expect(editor.getAttribute("aria-disabled")).toBeNull()
    expect(editor.getAttribute("aria-readonly")).toBeNull()
  })

  it("uses an accessible expand control and root-owned scroll lock", () => {
    const renderComposer = (expanded: boolean) => {
      act(() => {
        root.render(
          <ScrollRoot>
            <PromptInput
              expanded={expanded}
              value={expanded ? "first line\nsecond line" : "draft"}
              onValueChange={() => {}}
            >
              <PromptInputTextarea aria-label="Ask anything" />
              <PromptInputFooter aria-hidden="true" />
            </PromptInput>
          </ScrollRoot>
        )
      })
    }

    renderComposer(true)

    const scrollRoot = container.querySelector(
      "[data-scroll-root]"
    ) as HTMLElement
    const form = container.querySelector("form") as HTMLFormElement
    const surface = container.querySelector(
      '[data-composer-surface="true"]'
    ) as HTMLElement
    const expandButton = container.querySelector(
      'button[aria-label="Expand"]'
    ) as HTMLButtonElement

    expect(form.hasAttribute("data-expanded-composer-mode-button")).toBe(true)
    expect(
      container.querySelector("[data-composer-controls-anchor]")
    ).not.toBeNull()
    expect(expandButton.type).toBe("button")
    expect(expandButton.getAttribute("aria-pressed")).toBe("false")
    expect(expandButton.getAttribute("data-slot")).toBe("tooltip-trigger")
    expect(expandButton.hasAttribute("data-composer-control")).toBe(true)
    expect(expandButton.querySelector('[data-slot="icon"]')).not.toBeNull()

    act(() => expandButton.click())

    const collapseButton = container.querySelector(
      'button[aria-label="Collapse"]'
    ) as HTMLButtonElement
    expect(collapseButton.getAttribute("aria-pressed")).toBe("true")
    expect(form.hasAttribute("data-expanded-composer")).toBe(true)
    expect(surface.hasAttribute("data-expanded-composer")).toBe(true)
    expect(scrollRoot.hasAttribute("data-expanded-composer")).toBe(true)

    renderComposer(false)
    expect(scrollRoot.hasAttribute("data-expanded-composer")).toBe(false)
    expect(container.querySelector('button[aria-label="Expand"]')).toBeNull()
  })

  it("keeps the expand and collapse tooltip synchronized with the control", async () => {
    await act(async () => {
      root.render(
        <PromptInput
          expanded
          value={"first line\nsecond line"}
          onValueChange={() => {}}
        >
          <PromptInputTextarea aria-label="Ask anything" />
        </PromptInput>
      )
    })

    const expandButton = container.querySelector(
      'button[aria-label="Expand"]'
    ) as HTMLButtonElement

    await act(async () => {
      expandButton.focus()
    })
    expect(
      document.body.querySelector('[data-slot="tooltip-content"]')?.textContent
    ).toBe("Expand")

    await act(async () => {
      expandButton.click()
    })
    const collapseButton = container.querySelector(
      'button[aria-label="Collapse"]'
    ) as HTMLButtonElement
    await act(async () => {
      collapseButton.blur()
      collapseButton.focus()
    })
    expect(
      document.body.querySelector('[data-slot="tooltip-content"]')?.textContent
    ).toBe("Collapse")
  })
})

describe("composer formatting input rules", () => {
  it("discards queued selection positioning after editor teardown", async () => {
    const { EditorView } = await import("prosemirror-view")
    const { EditorState, TextSelection } = await import("prosemirror-state")
    const { createPromptInputPlugins, createPromptInputDocument } =
      await import("./prompt-input-editor")
    const doc = createPromptInputDocument("Selected text")
    const mount = document.createElement("div")
    document.body.append(mount)
    const view = new EditorView(mount, {
      state: EditorState.create({
        doc,
        selection: TextSelection.create(doc, 1, 9),
        plugins: createPromptInputPlugins(() => ""),
      }),
    })
    // The focused DOM can survive briefly while its EditorView is replaced by HMR.
    vi.spyOn(view, "hasFocus").mockReturnValue(true)
    const positioning = vi.spyOn(view, "coordsAtPos").mockReturnValue(rect(100))
    view.dom.dispatchEvent(new FocusEvent("focus"))
    view.destroy()
    positioning.mockClear()
    await Promise.resolve()
    expect(positioning).not.toHaveBeenCalled()
    mount.remove()
    vi.restoreAllMocks()
  })

  it("formats the selected text and applies then clears a link through the toolbar", async () => {
    const { EditorView } = await import("prosemirror-view")
    const { EditorState, TextSelection } = await import("prosemirror-state")
    const {
      createPromptInputPlugins,
      createPromptInputDocument,
      promptInputSchema,
    } = await import("./prompt-input-editor")
    const mount = document.createElement("div")
    document.body.append(mount)
    const view = new EditorView(mount, {
      state: EditorState.create({
        doc: createPromptInputDocument("Selected text"),
        plugins: createPromptInputPlugins(() => ""),
      }),
    })
    try {
      view.focus()
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 9))
      )
      const toolbar = document.querySelector<HTMLElement>(
        '[role="toolbar"][aria-label="Formatting"]'
      )
      expect(toolbar?.hidden).toBe(false)
      toolbar?.querySelector<HTMLButtonElement>('[aria-label="Bold"]')?.click()
      expect(
        view.state.doc.rangeHasMark(1, 9, promptInputSchema.marks.strong)
      ).toBe(true)
      expect(view.state.selection.to - view.state.selection.from).toBe(8)
      toolbar?.querySelector<HTMLButtonElement>('[aria-label="Link"]')?.click()
      expect(
        mount.querySelector(".composer-format-preserved-selection")?.textContent
      ).toBe("Selected")
      toolbar
        ?.querySelector("input")
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        )
      expect(
        mount.querySelector(".composer-format-preserved-selection")
      ).toBeNull()
      const reopenLink = () => {
        view.focus()
        view.dispatch(
          view.state.tr.setSelection(TextSelection.create(view.state.doc, 1))
        )
        view.dispatch(
          view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 9))
        )
        toolbar
          ?.querySelector<HTMLButtonElement>('[aria-label="Link"]')
          ?.click()
      }
      reopenLink()
      document.body.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true })
      )
      expect(
        mount.querySelector(".composer-format-preserved-selection")
      ).toBeNull()
      reopenLink()
      const input = toolbar?.querySelector("input")
      expect(input).toBeTruthy()
      if (input) {
        input.value = "https://example.com"
        input.dispatchEvent(new Event("input", { bubbles: true }))
      }
      toolbar
        ?.querySelector<HTMLButtonElement>('[aria-label="Apply link"]')
        ?.click()
      expect(
        view.state.doc.rangeHasMark(1, 9, promptInputSchema.marks.link)
      ).toBe(true)
      expect(view.state.selection.empty).toBe(true)
      expect(
        mount.querySelector(".composer-format-preserved-selection")
      ).toBeNull()
      toolbar
        ?.querySelector<HTMLButtonElement>('[aria-label="Clear link"]')
        ?.click()
      expect(
        view.state.doc.rangeHasMark(1, 9, promptInputSchema.marks.link)
      ).toBe(false)
      expect(toolbar?.hidden).toBe(true)
    } finally {
      view.destroy()
      mount.remove()
    }
  })

  it("clears the selected link when two links share a destination", async () => {
    const { EditorView } = await import("prosemirror-view")
    const { EditorState, TextSelection } = await import("prosemirror-state")
    const {
      createPromptInputPlugins,
      createPromptInputDocument,
      promptInputSchema,
    } = await import("./prompt-input-editor")
    const mount = document.createElement("div")
    document.body.append(mount)
    const view = new EditorView(mount, {
      state: EditorState.create({
        doc: createPromptInputDocument(
          "[First](https://example.com) [Second](https://example.com)"
        ),
        plugins: createPromptInputPlugins(() => ""),
      }),
    })
    try {
      view.focus()
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, 2))
      )
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, 8))
      )
      document
        .querySelector<HTMLButtonElement>('[aria-label="Clear link"]')
        ?.click()
      expect(
        view.state.doc.rangeHasMark(1, 6, promptInputSchema.marks.link)
      ).toBe(true)
      expect(
        view.state.doc.rangeHasMark(7, 13, promptInputSchema.marks.link)
      ).toBe(false)
    } finally {
      view.destroy()
      mount.remove()
    }
  })

  it("turns typed prefixes and emphasis into rich nodes and restores syntax on undo", async () => {
    const { EditorView } = await import("prosemirror-view")
    const { EditorState, TextSelection } = await import("prosemirror-state")
    const { undoInputRule } = await import("prosemirror-inputrules")
    const {
      createPromptInputPlugins,
      promptInputSchema,
      readPromptInputDocument,
    } = await import("./prompt-input-editor")
    for (const [prefix, typed, expected, nodeName] of [
      ["#", " ", "", "heading"],
      ["-", " ", "", "bullet_list"],
      ["1.", " ", "", "ordered_list"],
      ["**Bold*", "*", "**Bold**", "paragraph"],
      ["*Italic", "*", "*Italic*", "paragraph"],
    ]) {
      const doc = promptInputSchema.nodes.doc.create(
        null,
        promptInputSchema.nodes.paragraph.create(
          null,
          promptInputSchema.text(prefix)
        )
      )
      const view = new EditorView(document.createElement("div"), {
        state: EditorState.create({
          doc,
          selection: TextSelection.atEnd(doc),
          plugins: createPromptInputPlugins(() => ""),
        }),
      })
      try {
        const from = view.state.selection.from
        const handled = view.someProp("handleTextInput", (handler) =>
          handler(view, from, from, typed, () =>
            view.state.tr.insertText(typed)
          )
        )
        expect(handled, prefix).toBe(true)
        expect(view.state.doc.firstChild?.type.name, prefix).toBe(nodeName)
        expect(readPromptInputDocument(view.state.doc), prefix).toBe(expected)
        expect(undoInputRule(view.state, view.dispatch), prefix).toBe(true)
        expect(view.state.doc.textContent, prefix).toBe(prefix + typed)
      } finally {
        view.destroy()
      }
    }
  })
})
