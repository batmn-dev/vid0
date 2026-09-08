/**
 * Based on prompt-kit: https://prompt-kit.com/docs/prompt-input
 * The stable ProseMirror editor is callback-ref owned and never remounts for
 * controlled updates. Expansion derives from value and compact width without
 * effect-driven layout dispatch. Actions use the app-level TooltipProvider.
 */
"use client"

import { useBrowserLayoutEffect } from "@/app/hooks/use-browser-layout-effect"
import { ComposerIconButton } from "@/components/ui/composer-icon-button"
import { Icon } from "@/components/ui/icon"
import {
  createActionQueryPublisher,
  createPromptInputDocument,
  createPromptInputPlugins,
  endPromptInputActionQuery,
  promptInputEntitiesEqual,
  promptInputSchema,
  readPromptInputDocument,
  readPromptInputEntities,
  replacePromptInputActionQuery,
  replacePromptInputDocument,
  setPromptInputSelection,
  toggleSyntheticPromptInputActionQuery,
  type PromptInputActionQuery,
  type PromptInputEntity,
} from "@/components/ui/prompt-input-editor"
import { useOptionalScrollRoot } from "@/components/ui/scroll-root"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  createComposerPaintController,
  type ComposerPaintController,
} from "@/lib/observability/composer-paint"
import { cn } from "@/lib/utils"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { RiCollapseDiagonalLine, RiExpandDiagonalLine } from "@remixicon/react"
import { motion, MotionConfig, type HTMLMotionProps } from "motion/react"
import { EditorState } from "prosemirror-state"
import { EditorView } from "prosemirror-view"
import React, { createContext, useContext, useRef, useState } from "react"

export type PromptInputEditorHandle = {
  focus: (options?: FocusOptions) => void
  replaceActionQuery: (
    actionQuery: PromptInputActionQuery,
    entity?: PromptInputEntity
  ) => boolean
  /** Open a synthetic action-query session at the caret (the + button), or
   * close the current one when it is already synthetic. */
  toggleSyntheticActionQuery: () => void
  /** End the active action-query session (synthetic Escape / focus-out). */
  endActionQuery: () => void
  setSelectionRange: (selectionStart: number, selectionEnd: number) => void
}

export type { PromptInputActionQuery, PromptInputEntity }

type PromptInputContextType = {
  isLoading: boolean
  value: string
  setValue: (value: string) => void
  entities: readonly PromptInputEntity[]
  setEntities: (entities: readonly PromptInputEntity[]) => void
  setTextareaExpanded: React.Dispatch<React.SetStateAction<boolean>>
  setCanExpandComposer: React.Dispatch<React.SetStateAction<boolean>>
  layoutDependency: string
  maxHeight?: number | string
  onSubmit?: () => void
  disabled?: boolean
  editorRef: React.RefObject<PromptInputEditorHandle | null>
}

const PromptInputContext = createContext<PromptInputContextType | undefined>(
  undefined
)

function usePromptInput() {
  const context = useContext(PromptInputContext)
  if (!context) {
    throw new Error("usePromptInput must be used within a PromptInput")
  }
  return context
}

type PromptInputProps = {
  isLoading?: boolean
  value?: string
  onValueChange?: (value: string) => void
  entities?: readonly PromptInputEntity[]
  onEntitiesChange?: (entities: readonly PromptInputEntity[]) => void
  expanded?: boolean
  maxHeight?: number | string
  onSubmit?: () => void
  disabled?: boolean
  children: React.ReactNode
  formControls?: React.ReactNode
  className?: string
}

function PromptInput({
  className,
  isLoading = false,
  expanded = false,
  maxHeight,
  value,
  onValueChange,
  entities,
  onEntitiesChange,
  onSubmit,
  disabled = false,
  children,
  formControls,
}: PromptInputProps) {
  const [internalValue, setInternalValue] = useState(value || "")
  const [internalEntities, setInternalEntities] = useState<
    readonly PromptInputEntity[]
  >([])
  const [textareaExpanded, setTextareaExpanded] = useState(false)
  const [canExpandComposer, setCanExpandComposer] = useState(false)
  const [expandedComposer, setExpandedComposer] = useState(false)
  const [isPasting, setIsPasting] = useState(false)
  const pasteTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const editorRef = useRef<PromptInputEditorHandle>(null)
  const isExpanded = expanded || textareaExpanded
  const isExpandedComposer = canExpandComposer && expandedComposer
  // The reference snapshots layout only when one of its expansion modes changes.
  const layoutDependency = `${isExpanded}-${isExpandedComposer}`
  const scrollRoot = useOptionalScrollRoot()

  useBrowserLayoutEffect(
    () => () => {
      if (pasteTimeout.current !== null) clearTimeout(pasteTimeout.current)
    },
    []
  )

  // React's adjust-during-render pattern keeps the derived mode from surviving
  // a clear-on-send or a draft below the expansion threshold. The callback ref
  // below applies the root attribute during commit, so render stays pure.
  if (!canExpandComposer && expandedComposer) {
    setExpandedComposer(false)
  }

  const formRef = React.useCallback(
    (node: HTMLFormElement | null) => {
      scrollRoot?.setScrollRootMode(
        "expanded-composer",
        node !== null && isExpandedComposer
      )
    },
    [isExpandedComposer, scrollRoot]
  )

  const handleChange = (newValue: string) => {
    setInternalValue(newValue)
    onValueChange?.(newValue)
  }

  const handleEntitiesChange = (nextEntities: readonly PromptInputEntity[]) => {
    setInternalEntities(nextEntities)
    onEntitiesChange?.(nextEntities)
  }

  return (
    <PromptInputContext.Provider
      value={{
        isLoading,
        value: value ?? internalValue,
        setValue: onValueChange ?? handleChange,
        entities: entities ?? internalEntities,
        setEntities: onEntitiesChange ?? handleEntitiesChange,
        setTextareaExpanded,
        setCanExpandComposer,
        layoutDependency,
        maxHeight,
        onSubmit,
        disabled,
        editorRef,
      }}
    >
      <MotionConfig
        reducedMotion="user"
        transition={{
          layout: isPasting
            ? { duration: 0 }
            : { type: "spring", bounce: 0.1, duration: 0.3 },
        }}
      >
        <form
          ref={formRef}
          autoComplete="off"
          className={cn("group/composer relative z-1 w-full", className)}
          style={
            {
              "--composer-border-radius": "28px",
              viewTransitionName: "var(--vt-composer)",
            } as React.CSSProperties
          }
          data-expanded={isExpanded ? "" : undefined}
          data-expanded-composer={isExpandedComposer ? "" : undefined}
          data-expanded-composer-mode-button={
            canExpandComposer ? "" : undefined
          }
          data-type="unified-composer"
          onPaste={() => {
            setIsPasting(true)
            if (pasteTimeout.current !== null)
              clearTimeout(pasteTimeout.current)
            pasteTimeout.current = setTimeout(() => setIsPasting(false), 250)
          }}
          onSubmit={(event) => {
            event.preventDefault()
            if (!disabled) onSubmit?.()
          }}
        >
          {formControls}
          <div className="relative">
            <motion.div
              layout
              layoutDependency={layoutDependency}
              style={{ borderRadius: 28 }}
              data-composer-surface="true"
              data-expanded-composer={isExpandedComposer ? "" : undefined}
              data-slot="prompt-input-surface"
              className={cn(
                "shadow-short-composer border-border-subtle relative grid cursor-text grid-cols-[minmax(0,1fr)] grid-rows-[max-content_0_auto] flex-col overflow-clip border-0 bg-[var(--composer-surface-primary)] bg-clip-padding contain-inline-size [corner-shape:superellipse(1.1)] [grid-template-areas:'eyebrow'_'controls'_'body'] group-not-data-expanded/composer:min-h-[52px] motion-safe:transition-colors motion-safe:duration-200 motion-safe:ease-in-out max-sm:not-dark:shadow-[0_0_0_1px_rgba(0,_0,_0,_0.04),0_2px_8px_0_rgba(0,_0,_0,_0.04),0px_4px_40px_8px_rgba(0,_0,_0,_0.025)]",
                isExpandedComposer &&
                  "my-4 h-[min(calc(100svh-var(--header-height)-8rem),48rem)] max-h-[calc(100svh-var(--header-height)-8rem)]"
              )}
              onClick={() => {
                editorRef.current?.focus()
              }}
            >
              <div
                className="relative col-start-1 col-end-2 row-start-2 row-end-3 h-0 shrink-0"
                data-composer-controls-anchor=""
              >
                {canExpandComposer && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <ComposerIconButton
                          aria-label={
                            isExpandedComposer ? "Collapse" : "Expand"
                          }
                          aria-pressed={isExpandedComposer}
                          className="absolute end-2.5 top-2.5 z-10"
                          type="button"
                          pressMotion="none"
                          onPointerDown={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                          }}
                          onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            setExpandedComposer((current) => !current)
                            editorRef.current?.focus({ preventScroll: true })
                          }}
                        >
                          <Icon
                            className="text-[var(--text-secondary)]"
                            icon={
                              isExpandedComposer
                                ? RiCollapseDiagonalLine
                                : RiExpandDiagonalLine
                            }
                            slotSize={20}
                          />
                        </ComposerIconButton>
                      }
                    />
                    <TooltipContent side="bottom">
                      {isExpandedComposer ? "Collapse" : "Expand"}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
              <div
                data-composer-body=""
                data-composer-grid=""
                data-composer-layout="true"
                className="col-start-1 col-end-2 row-start-3 row-end-4 grid min-h-0 min-w-0 flex-1 grid-cols-[auto_1fr_auto] px-2 py-[9px] [--composer-compact-editor-padding-end:6px] [--composer-compact-editor-padding-start:7px] [grid-template-areas:'header_header_header'_'leading_primary_trailing'_'._footer_.'] group-not-data-expanded/composer:py-[5px] group-data-expanded/composer:[grid-template-areas:'header_header_header'_'primary_primary_primary'_'leading_footer_trailing'] group-data-expanded-composer/composer:grid-rows-[auto_minmax(0,1fr)_auto] max-sm:[grid-template-areas:'header_header_header'_'primary_primary_primary'_'leading_footer_trailing'] max-sm:group-not-data-expanded/composer:pb-2 @max-[520px]/main:[grid-template-areas:'header_header_header'_'primary_primary_primary'_'leading_footer_trailing']"
              >
                {children}
              </div>
            </motion.div>
            <div
              data-composer-overlay-host=""
              className="pointer-events-none absolute inset-0 z-50 *:pointer-events-auto"
            />
          </div>
        </form>
      </MotionConfig>
    </PromptInputContext.Provider>
  )
}

function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null) {
  if (!ref) return
  if (typeof ref === "function") {
    ref(value)
    return
  }
  ;(ref as React.MutableRefObject<T | null>).current = value
}

function readPixels(value: string) {
  const parsed = parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function getCompactEditorWidth(
  textarea: HTMLTextAreaElement,
  fullWidth = false
) {
  const surface = textarea.closest<HTMLElement>(
    '[data-composer-surface="true"]'
  )
  if (!surface) {
    return textarea.getBoundingClientRect().width
  }

  const layout = surface.querySelector<HTMLElement>(
    '[data-composer-layout="true"]'
  )
  if (!layout) {
    return textarea.getBoundingClientRect().width
  }

  const layoutStyle = getComputedStyle(layout)
  // These insets live on the surface so compact-width measurement remains
  // stable after the editor wrapper switches to its expanded padding.
  const contentWidth =
    layout.getBoundingClientRect().width -
    readPixels(layoutStyle.paddingLeft) -
    readPixels(layoutStyle.paddingRight)
  // Measure without the expand control's gutter so showing it cannot feed
  // back into the threshold. The multiline wrapper has 10px on both sides.
  if (fullWidth) return Math.max(0, contentWidth - 20)
  const editorPadding =
    readPixels(
      layoutStyle.getPropertyValue("--composer-compact-editor-padding-start")
    ) +
    readPixels(
      layoutStyle.getPropertyValue("--composer-compact-editor-padding-end")
    )

  if (window.matchMedia("(max-width: 639px)").matches) {
    return Math.max(0, contentWidth - editorPadding)
  }

  const leadingWidth =
    surface
      .querySelector<HTMLElement>('[data-composer-leading="true"]')
      ?.getBoundingClientRect().width ?? 36
  const trailingWidth =
    surface
      .querySelector<HTMLElement>('[data-composer-trailing="true"]')
      ?.getBoundingClientRect().width ?? 0

  return Math.max(
    0,
    contentWidth - leadingWidth - trailingWidth - editorPadding
  )
}

function measureTextareaScrollHeight(
  textarea: HTMLTextAreaElement,
  value: string,
  width: number,
  editor?: HTMLElement
) {
  if (editor) {
    const clone = editor.cloneNode(true) as HTMLElement
    clone.removeAttribute("id")
    clone.removeAttribute("contenteditable")
    clone.setAttribute("aria-hidden", "true")
    Object.assign(clone.style, {
      position: "absolute",
      visibility: "hidden",
      pointerEvents: "none",
      width: `${width}px`,
      height: "auto",
      minHeight: "0",
      maxHeight: "none",
      top: "0",
      left: "0",
      margin: "0",
      padding: "0 0 16px",
    })
    // Preserve the live editor's scoped wrapping and typography rules.
    editor.parentElement?.appendChild(clone)
    const height = clone.scrollHeight
    clone.remove()
    return height
  }
  const clone = textarea.cloneNode() as HTMLTextAreaElement
  clone.removeAttribute("id")
  clone.removeAttribute("name")
  clone.tabIndex = -1
  clone.value = value || " "
  clone.rows = 1
  clone.style.position = "absolute"
  clone.style.display = "block"
  clone.style.visibility = "hidden"
  clone.style.pointerEvents = "none"
  clone.style.zIndex = "-1"
  clone.style.top = "0"
  clone.style.left = "0"
  clone.style.height = "auto"
  clone.style.minHeight = "0"
  clone.style.maxHeight = "none"
  clone.style.overflow = "hidden"
  clone.style.width = `${width}px`

  document.body.appendChild(clone)
  const scrollHeight = clone.scrollHeight
  clone.remove()
  return scrollHeight
}

const COLLAPSED_EDITOR_HEIGHT = 42

function getEditorAttributes({
  id,
  ariaLabel,
  className,
  disabled,
}: {
  id: string
  ariaLabel?: string
  className?: string
  disabled: boolean
}) {
  return {
    "aria-label": ariaLabel ?? "",
    "aria-multiline": "true",
    ...(disabled ? { "aria-disabled": "true", "aria-readonly": "true" } : {}),
    autocapitalize: "sentences",
    autocomplete: "off",
    autocorrect: "on",
    class: cn(
      "composer-prosemirror text-foreground block whitespace-break-spaces text-base leading-[26px] outline-none",
      className
    ),
    "data-virtualkeyboard": "true",
    id,
    inputmode: "text",
    role: "textbox",
    spellcheck: "true",
    translate: "no",
  }
}

export type PromptInputTextareaProps = {
  id?: string
  disableAutosize?: boolean
  submitOnEnter?: boolean
  containerClassName?: string
  className?: string
  placeholder?: string
  "aria-label"?: string
  autoFocus?: boolean
  disabled?: boolean
  style?: React.CSSProperties
  onActionQueryChange?: (query: PromptInputActionQuery | null) => void
  onKeyDown?: (event: KeyboardEvent) => void
  onPaste?: (event: ClipboardEvent) => void
}

const PromptInputTextarea = React.forwardRef<
  PromptInputEditorHandle,
  PromptInputTextareaProps
>(function PromptInputTextarea(
  {
    id = "prompt-textarea",
    className,
    containerClassName,
    onActionQueryChange,
    onKeyDown,
    onPaste,
    disableAutosize = false,
    submitOnEnter = true,
    style,
    placeholder,
    "aria-label": ariaLabel,
    autoFocus = true,
    disabled: disabledProp,
  },
  ref
) {
  const {
    value,
    setValue,
    entities,
    setEntities,
    setTextareaExpanded,
    setCanExpandComposer,
    layoutDependency,
    maxHeight,
    onSubmit,
    disabled,
    editorRef,
  } = usePromptInput()
  const viewRef = useRef<EditorView | null>(null)
  const paintControllerRef = useRef<ComposerPaintController | null>(null)
  const editorHandleRef = useRef<PromptInputEditorHandle | null>(null)
  const fallbackTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const forwardedRef = useRef(ref)
  const callbacks = useRef({
    id,
    ariaLabel,
    autoFocus,
    className,
    disabled: disabled ?? disabledProp ?? false,
    onActionQueryChange,
    onKeyDown,
    onPaste,
    submitOnEnter,
    onSubmit,
    placeholder,
    setValue,
    entities,
    setEntities,
    style,
    value,
  })

  useBrowserLayoutEffect(() => {
    callbacks.current = {
      id,
      ariaLabel,
      autoFocus,
      className,
      disabled: disabled ?? disabledProp ?? false,
      onActionQueryChange,
      onKeyDown,
      onPaste,
      submitOnEnter,
      onSubmit,
      placeholder,
      setValue,
      entities,
      setEntities,
      style,
      value,
    }

    if (forwardedRef.current !== ref) {
      assignRef(forwardedRef.current, null)
      forwardedRef.current = ref
      assignRef(ref, editorHandleRef.current)
    }
  }, [
    id,
    ariaLabel,
    autoFocus,
    className,
    disabled,
    disabledProp,
    onActionQueryChange,
    onKeyDown,
    onPaste,
    submitOnEnter,
    onSubmit,
    placeholder,
    ref,
    setValue,
    entities,
    setEntities,
    style,
    value,
  ])

  const measuredLayout = React.useRef<{
    textarea: HTMLTextAreaElement
    doc: EditorState["doc"]
    width: number
    className: string
    style: string
    typography: string
    height: number
    fullWidth: number
    fullHeight: number
  } | null>(null)
  const applyEditorLayout = React.useCallback(
    (textarea: HTMLTextAreaElement | null, nextValue: string) => {
      if (disableAutosize || !textarea) {
        setTextareaExpanded(false)
        setCanExpandComposer(false)
        return
      }

      if (!viewRef.current) return

      // Native field sizing keeps the live editor matched to its rendered
      // lines. Clear a stale imperative height left by an older render/HMR;
      // the nested scroller below, not the textarea, owns the height cap.
      textarea.style.removeProperty("height")

      const richBlock =
        viewRef.current?.state.doc.firstChild?.type.name !== "paragraph"
      if (!nextValue || nextValue.includes("\n")) {
        setTextareaExpanded(Boolean(nextValue))
        setCanExpandComposer(Boolean(nextValue))
        return
      }

      const compactWidth = getCompactEditorWidth(textarea)
      const fullWidth = getCompactEditorWidth(textarea, true)
      const doc = viewRef.current.state.doc
      const previous = measuredLayout.current
      const style = textarea.style.cssText
      const computed = getComputedStyle(textarea)
      const typography = [
        computed.font,
        computed.fontFamily,
        computed.fontSize,
        computed.fontWeight,
        computed.fontStyle,
        computed.fontStretch,
        computed.fontVariationSettings,
        computed.fontFeatureSettings,
        computed.fontVariantLigatures,
        computed.overflowWrap,
        computed.lineHeight,
        computed.letterSpacing,
        computed.wordSpacing,
        computed.textTransform,
        computed.textIndent,
        computed.whiteSpace,
        computed.wordBreak,
        computed.padding,
        computed.boxSizing,
      ].join("|")
      // The editor transaction and controlled-value commit measure the same input.
      const cached =
        previous?.textarea === textarea &&
        previous.doc === doc &&
        previous.width === compactWidth &&
        previous.className === textarea.className &&
        previous.style === style &&
        previous.typography === typography &&
        previous.fullWidth === fullWidth
      const compactScrollHeight = cached
        ? previous.height
        : measureTextareaScrollHeight(
            textarea,
            nextValue,
            compactWidth,
            viewRef.current?.dom
          )
      const shouldExpand =
        richBlock || compactScrollHeight > COLLAPSED_EDITOR_HEIGHT + 1
      const fullHeight = !shouldExpand
        ? compactScrollHeight
        : cached
          ? previous.fullHeight
          : measureTextareaScrollHeight(
              textarea,
              nextValue,
              fullWidth,
              viewRef.current.dom
            )
      measuredLayout.current = {
        textarea,
        doc,
        width: compactWidth,
        className: textarea.className,
        style,
        typography,
        height: compactScrollHeight,
        fullWidth,
        fullHeight,
      }
      // The expansion decision is a function of the value and the DERIVED
      // compact width only. It must not read layout that `textareaExpanded`
      // itself influences (e.g. the live textarea scrollHeight, which changes
      // with the data-expanded grid/padding): state → CSS → measurement →
      // state is a feedback cycle, and a boundary value oscillates it into
      // React's "Maximum update depth exceeded" guard. The live term was also
      // redundant — the expanded textarea is never narrower than the compact
      // one, so any value that wraps live wraps in the compact measurement.
      // Like the reference, multiline layout stays latched until the draft clears.
      setTextareaExpanded((current) => current || shouldExpand)
      setCanExpandComposer(
        fullHeight >
          4 * readPixels(computed.lineHeight) +
            readPixels(computed.paddingBottom) +
            1
      )
    },
    [disableAutosize, setTextareaExpanded, setCanExpandComposer]
  )

  const setFallbackTextareaRef = React.useCallback(
    (node: HTMLTextAreaElement | null) => {
      fallbackTextareaRef.current = node

      if (!node || disableAutosize) return

      const surface = node.closest<HTMLElement>(
        '[data-composer-surface="true"]'
      )
      if (!surface) return

      const leading = surface.querySelector<HTMLElement>(
        '[data-composer-leading="true"]'
      )
      const trailing = surface.querySelector<HTMLElement>(
        '[data-composer-trailing="true"]'
      )
      const compactMedia = window.matchMedia("(max-width: 639px)")
      const readInlineSizes = () =>
        [
          surface.getBoundingClientRect().width,
          leading?.getBoundingClientRect().width ?? 0,
          trailing?.getBoundingClientRect().width ?? 0,
          compactMedia.matches ? 1 : 0,
        ].map((width) => Math.round(width * 100) / 100)
      let lastInlineSizes = readInlineSizes()

      const remeasureForGeometryChange = () => {
        const nextInlineSizes = readInlineSizes()
        if (
          nextInlineSizes.every(
            (inlineSize, index) => inlineSize === lastInlineSizes[index]
          )
        ) {
          return
        }

        lastInlineSizes = nextInlineSizes
        applyEditorLayout(node, callbacks.current.value)
      }

      const resizeObserver =
        typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(remeasureForGeometryChange)
      resizeObserver?.observe(surface)
      if (leading) resizeObserver?.observe(leading)
      if (trailing) resizeObserver?.observe(trailing)
      compactMedia.addEventListener("change", remeasureForGeometryChange)
      applyEditorLayout(node, callbacks.current.value)

      return () => {
        resizeObserver?.disconnect()
        compactMedia.removeEventListener("change", remeasureForGeometryChange)
        if (fallbackTextareaRef.current === node) {
          fallbackTextareaRef.current = null
        }
      }
    },
    [applyEditorLayout, disableAutosize]
  )

  const mountEditor = React.useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return

      let view: EditorView
      let paintController: ComposerPaintController | undefined
      const publishActionQuery = createActionQueryPublisher((actionQuery) =>
        callbacks.current.onActionQueryChange?.(actionQuery)
      )
      const state = EditorState.create({
        doc: createPromptInputDocument(
          callbacks.current.value,
          callbacks.current.entities
        ),
        plugins: createPromptInputPlugins(() => callbacks.current.placeholder),
        schema: promptInputSchema,
      })
      view = new EditorView(
        { mount: node },
        {
          attributes: getEditorAttributes({
            id: callbacks.current.id,
            ariaLabel: callbacks.current.ariaLabel,
            className: callbacks.current.className,
            disabled: callbacks.current.disabled,
          }),
          dispatchTransaction(transaction) {
            const nextState = view.state.apply(transaction)
            view.updateState(nextState)
            paintController?.onEditorUpdate()
            // The action-query plugin owns re-evaluation rules
            // (typed sessions on doc changes, synthetic sessions every
            // transaction); publishing just diffs its state.
            publishActionQuery(nextState)
            if (
              !transaction.docChanged ||
              transaction.getMeta("externalValue")
            ) {
              return
            }

            const nextValue = readPromptInputDocument(nextState.doc)
            const nextEntities = readPromptInputEntities(nextState.doc)
            if (fallbackTextareaRef.current) {
              fallbackTextareaRef.current.value = nextValue
            }
            applyEditorLayout(fallbackTextareaRef.current, nextValue)
            callbacks.current.setValue(nextValue)
            if (
              !promptInputEntitiesEqual(
                nextEntities,
                callbacks.current.entities
              )
            ) {
              callbacks.current.setEntities(nextEntities)
            }
          },
          editable: () => !callbacks.current.disabled,
          handleKeyDown(_view, event) {
            if (
              callbacks.current.disabled ||
              event.defaultPrevented ||
              event.isComposing ||
              event.keyCode === 229
            ) {
              return false
            }

            callbacks.current.onKeyDown?.(event)
            if (event.defaultPrevented) return true

            if (
              callbacks.current.submitOnEnter &&
              event.key === "Enter" &&
              !event.shiftKey
            ) {
              event.preventDefault()
              callbacks.current.onSubmit?.()
              return true
            }

            return false
          },
          handlePaste(_view, event) {
            if (callbacks.current.disabled) return false
            callbacks.current.onPaste?.(event)
            return event.defaultPrevented
          },
          state,
        }
      )
      paintController = createComposerPaintController(view.dom)
      paintControllerRef.current = paintController
      viewRef.current = view

      const handle: PromptInputEditorHandle = {
        focus(options) {
          view.dom.focus(options)
        },
        replaceActionQuery(actionQuery, entity) {
          return replacePromptInputActionQuery(
            view.state,
            view.dispatch,
            actionQuery,
            entity
          )
        },
        toggleSyntheticActionQuery() {
          toggleSyntheticPromptInputActionQuery(view.state, view.dispatch)
          view.focus()
        },
        endActionQuery() {
          endPromptInputActionQuery(view.state, view.dispatch)
        },
        setSelectionRange(selectionStart, selectionEnd) {
          setPromptInputSelection(view, selectionStart, selectionEnd)
        },
      }
      editorHandleRef.current = handle
      editorRef.current = handle
      assignRef(forwardedRef.current, handle)
      if (callbacks.current.autoFocus) handle.focus()

      return () => {
        if (viewRef.current === view) viewRef.current = null
        if (editorHandleRef.current === handle) editorHandleRef.current = null
        if (editorRef.current === handle) editorRef.current = null
        assignRef(forwardedRef.current, null)
        if (paintControllerRef.current === paintController) {
          paintControllerRef.current = null
        }
        paintController.dispose()
        view.destroy()
      }
    },
    [applyEditorLayout, editorRef]
  )

  useBrowserLayoutEffect(() => {
    const view = viewRef.current
    if (!view) return

    view.setProps({
      attributes: getEditorAttributes({
        id,
        ariaLabel,
        className,
        disabled: disabled ?? disabledProp ?? false,
      }),
      editable: () => !(disabled ?? disabledProp ?? false),
    })
    replacePromptInputDocument(view, value, entities)
    view.updateState(view.state)
    if (fallbackTextareaRef.current) {
      fallbackTextareaRef.current.value = value
    }
    applyEditorLayout(fallbackTextareaRef.current, value)
    paintControllerRef.current?.onComposerUpdate()
  }, [
    applyEditorLayout,
    id,
    ariaLabel,
    className,
    disabled,
    disabledProp,
    placeholder,
    entities,
    value,
  ])

  const maxHeightStyle =
    typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight

  return (
    <motion.div
      layout="position"
      layoutDependency={layoutDependency}
      data-composer-editor-wrapper="true"
      data-slot="prompt-input-editor-wrapper"
      className={cn(
        "-my-2.5 flex min-h-14 min-w-0 items-center overflow-x-hidden ps-[var(--composer-compact-editor-padding-start)] pe-[var(--composer-compact-editor-padding-end)] group-data-expanded/composer:mb-0 group-data-expanded/composer:ps-2.5 group-data-expanded/composer:pe-2.5 group-data-[expanded-composer]/composer:min-h-0 group-data-[expanded-composer]/composer:items-stretch group-data-[expanded-composer-mode-button]/composer:pe-0",
        containerClassName
      )}
    >
      <div
        data-composer-editor-scroller="true"
        data-scrollable-surface=""
        data-slot="prompt-input-editor-scroller"
        className="wcDTda_prosemirror-parent default-browser vertical-scroll-fade-mask max-h-[max(30svh,5rem)] min-h-[var(--deep-research-composer-extra-height,unset)] min-w-0 flex-1 scroll-py-4 [scrollbar-width:thin] overflow-auto group-data-[expanded-composer]/composer:h-full group-data-[expanded-composer]/composer:max-h-none! group-data-[expanded-composer-mode-button]/composer:pe-9"
        style={{ maxHeight: maxHeightStyle }}
      >
        <textarea
          ref={setFallbackTextareaRef}
          aria-label={ariaLabel}
          autoCapitalize="sentences"
          autoComplete="off"
          autoCorrect="on"
          className="wcDTda_fallbackTextarea composer-fallback-textarea"
          data-virtualkeyboard="true"
          dir="auto"
          inputMode="text"
          name="prompt-textarea"
          placeholder={placeholder}
          spellCheck="true"
          style={{ display: "none" }}
          defaultValue={value}
          rows={1}
        />
        <div ref={mountEditor} style={style} />
      </div>
    </motion.div>
  )
})

type PromptInputFooterProps = HTMLMotionProps<"div">

function PromptInputFooter({
  children,
  className,
  ...props
}: PromptInputFooterProps) {
  const { layoutDependency } = usePromptInput()
  return (
    <motion.div
      layout="position"
      layoutDependency={layoutDependency}
      data-composer-footer="true"
      data-slot="prompt-input-footer"
      className={cn("min-w-0 [grid-area:footer]", className)}
      {...props}
    >
      {children}
    </motion.div>
  )
}

type PromptInputActionsProps = HTMLMotionProps<"div">

function PromptInputActions({
  children,
  className,
  ...props
}: PromptInputActionsProps) {
  const { layoutDependency } = usePromptInput()
  return (
    <motion.div
      layout="position"
      layoutDependency={layoutDependency}
      className={cn("flex items-center gap-1", className)}
      {...props}
    >
      {children}
    </motion.div>
  )
}

type PromptInputActionProps = {
  className?: string
  tooltip: React.ReactNode
  children: React.ReactElement
  side?: "top" | "bottom" | "left" | "right"
  hideArrow?: boolean
} & React.ComponentProps<typeof Tooltip>

function PromptInputAction({
  tooltip,
  children,
  className,
  side = "bottom",
  hideArrow = true,
  ...tooltipProps
}: PromptInputActionProps) {
  const { disabled } = usePromptInput()
  const trigger = useRender({
    defaultTagName: "button",
    render: children,
    props: mergeProps<"button">(
      {
        type: "button",
        disabled,
        onClick: (event) => event.stopPropagation(),
      },
      {}
    ),
  })

  return (
    <Tooltip {...tooltipProps}>
      <TooltipTrigger
        disabled={disabled}
        render={(triggerProps) => (
          <span {...triggerProps} className="inline-flex">
            {React.cloneElement(
              trigger as React.ReactElement<React.AriaAttributes>,
              {
                "aria-describedby": triggerProps["aria-describedby"],
              }
            )}
          </span>
        )}
      />
      <TooltipContent side={side} hideArrow={hideArrow} className={className}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

export {
  PromptInput,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputActions,
  PromptInputAction,
}
