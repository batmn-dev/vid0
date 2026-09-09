"use client"

/**
 * Composer — the deep client module that assembles a Chat turn payload. See
 * CONTEXT.md "Composer".
 *
 * It owns the draft (display state + per-chat persistence + clearing), the
 * pending attachment files, paste/drop capture, and the primary
 * action; it reads the model picker and search toggle from the Turn context
 * and auth from the user store directly. Its interface to the parent is one
 * payload callback (`onTurn`) plus a small imperative handle for external
 * commands (quote insertion, ?prompt= hydration, focus) — replacing the
 * former 21-prop ChatInput and its parent-side orchestration memo.
 *
 * Draft contract: the display clears at send handoff; the PERSISTED draft
 * clears only when `onTurn` resolves `true` (the turn was dispatched). A
 * rejected turn (`false`) restores the payload into the composer — the error
 * toast must not fire over an emptied box.
 */
import { useTurnContext } from "@/app/components/chat/turn-context"
import { useFilePickerState } from "@/app/components/chat/use-file-upload"
import { useBrowserLayoutEffect } from "@/app/hooks/use-browser-layout-effect"
import { useChatDraft } from "@/app/hooks/use-chat-draft"
import { ModelSelector } from "@/components/common/model-selector/base"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui/icon"
import { useIntentPrefetch } from "@/components/ui/intent-prefetch"
import { Kbd } from "@/components/ui/kbd"
import { preloadMarkdown } from "@/components/ui/lazy-markdown"
import {
  PromptInput,
  PromptInputAction,
  PromptInputActions,
  PromptInputFooter,
  PromptInputTextarea,
  type PromptInputActionQuery,
  type PromptInputEditorHandle,
} from "@/components/ui/prompt-input"
import { toast } from "@/components/ui/toast"
import { TooltipShortcut } from "@/components/ui/tooltip"
import { type Attachment } from "@/lib/file-handling"
import { StopBulkRoundedIcon } from "@/lib/icons"
import { getLogicalModelInfo } from "@/lib/models"
import type { ChatUiWindow } from "@/lib/observability/chat-ui-observer"
import { isReasoningEffortControlEnabled } from "@/lib/reasoning-effort"
import { useUser } from "@/lib/user-store/provider"
import { cn, debounce } from "@/lib/utils"
import { RiArrowUpLine } from "@remixicon/react"
import { useConvex } from "convex/react"
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react"
import { flushSync } from "react-dom"
import { ButtonPlusMenu } from "./button-plus-menu"
import type { ComposerActionId } from "./composer-action-registry"
import { runComposerSlideTransition } from "./composer-view-transition"
import { EffortControl } from "./effort-control"
import { FileList } from "./file-list"
import { InputDropZone } from "./input-drop-zone"
import { coordinateComposerPaste } from "./large-paste-policy"
import {
  restoreLargePasteText,
  type PendingAttachment,
} from "./pending-attachment"
import { resolveComposerPrimaryActionState } from "./primary-action-state"
import { useComposerConnectors } from "./use-composer-connectors"
import { WebSearchControl } from "./web-search-control"

export type ComposerTurnPayload = {
  text: string
  files: File[]
  attachments: Attachment[]
}

export type ComposerHandle = {
  /** Append quoted text ("> …") to the draft and focus the textarea. */
  insertQuote: (text: string) => void
  /** Replace the display text (e.g. ?prompt= hydration). Display only — does
   * not write the persisted draft. */
  setText: (text: string) => void
  focus: () => void
}

type ComposerProps = {
  chatId: string | null
  /** Run one send-type Chat turn from the assembled payload. Resolve `true`
   * when the turn was dispatched (the Composer clears its persisted draft) or
   * `false` when it was rejected (the Composer restores the payload). The
   * boolean is required: a `void` handler would silently take the
   * restore-payload path after every successful send. */
  onTurn: (payload: ComposerTurnPayload) => Promise<boolean> | boolean
  isSubmitting?: boolean
  /** Holds Send while the surface loads required context; typing and Stop remain available. */
  isSendReady?: boolean
  status?: "submitted" | "streaming" | "ready" | "error"
  stop?: () => void
  /** Resolver-driven Stop affordance beyond the local transport: a stoppable
   * background, awaiting-approval, or possibly-stale run
   * presents Stop even while the local status reads ready. */
  stoppable?: boolean
  onLockedGuestModelSelect?: (modelId: string) => void
  /** Draft-persistence scope when there is no chat id (e.g. `project-<id>`),
   * so surface drafts don't bleed into the home composer's "new chat" draft. */
  draftScopeId?: string
  /** Surface-owned prompt copy. Other Composer behavior remains shared. */
  placeholder?: string
  /** Accessible prompt name when visible placeholder copy is compacted. */
  ariaLabel?: string
  /** Surface-owned spacing below the composer shell. */
  bottomSpacing?: "default" | "none"
}

const isOnlyWhitespace = (text: string) => !/[^\s]/.test(text)

// Shared across mounts and retained only while a send can settle.
const pendingDraftSends = new Map<string | null, Set<{ edited: boolean }>>()

type ComposerDraftIdentity = {
  persistenceId: string | null
  displayId: string
}

function resolveComposerDraftIdentity(
  chatId: string | null,
  draftScopeId?: string
): ComposerDraftIdentity {
  if (chatId) {
    return {
      persistenceId: chatId,
      displayId: `chat:${chatId}`,
    }
  }

  if (draftScopeId) {
    return {
      persistenceId: draftScopeId,
      displayId: `scope:${draftScopeId}`,
    }
  }

  return {
    persistenceId: null,
    displayId: "new-chat",
  }
}

function useComposerDraftDisplay(
  draftIdentity: ComposerDraftIdentity,
  draftValue: string
) {
  const [localValue, setLocalValue] = useState(() => draftValue)
  const valueRef = useRef(localValue)
  const draftSyncRef = useRef({
    displayId: draftIdentity.displayId,
    hasLocalOverride: false,
    lastDraftValue: draftValue,
  })

  const adoptDraftValue = useCallback((newValue: string) => {
    draftSyncRef.current.hasLocalOverride = false
    valueRef.current = newValue
    setLocalValue(newValue)
  }, [])

  const applyValue = useCallback((newValue: string) => {
    draftSyncRef.current.hasLocalOverride = true
    valueRef.current = newValue
    setLocalValue(newValue)
  }, [])

  useBrowserLayoutEffect(() => {
    const currentDraft = draftSyncRef.current

    if (currentDraft.displayId !== draftIdentity.displayId) {
      draftSyncRef.current = {
        displayId: draftIdentity.displayId,
        hasLocalOverride: false,
        lastDraftValue: draftValue,
      }

      adoptDraftValue(draftValue)
      return
    }

    if (currentDraft.lastDraftValue === draftValue) {
      return
    }

    currentDraft.lastDraftValue = draftValue
    if (!currentDraft.hasLocalOverride && draftValue !== valueRef.current) {
      adoptDraftValue(draftValue)
    }
  }, [adoptDraftValue, draftIdentity.displayId, draftValue])

  const isCurrentDraft = useCallback(
    () => draftSyncRef.current.displayId === draftIdentity.displayId,
    [draftIdentity.displayId]
  )

  return { localValue, valueRef, applyValue, isCurrentDraft }
}

export const Composer = memo(
  forwardRef<ComposerHandle, ComposerProps>(function Composer(
    {
      chatId,
      onTurn,
      isSubmitting,
      isSendReady = true,
      status,
      stop,
      stoppable,
      onLockedGuestModelSelect,
      draftScopeId,
      placeholder = "Ask anything",
      ariaLabel = placeholder,
      bottomSpacing = "default",
    },
    ref
  ) {
    const { user } = useUser()
    const isUserAuthenticated = !!user?.id
    const convex = useConvex()
    const {
      selectedModel,
      handleModelChange,
      enableSearch,
      setEnableSearch,
      searchMode,
      effortLevels,
      reasoningEffort,
      setReasoningEffort,
    } = useTurnContext()

    const selectModelConfig = getLogicalModelInfo(selectedModel)
    const isFileUploadAvailable = Boolean(selectModelConfig?.vision)
    // Mirrors EffortControl's own render predicate: when the thinking pill is
    // present, the model trigger joins it as one segmented control — tight
    // facing paddings and squared inner corners on the shared edge.
    const hasEffortControl =
      isReasoningEffortControlEnabled() && effortLevels.length > 0
    const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false)
    const [isEffortMenuOpen, setIsEffortMenuOpen] = useState(false)
    const [isActionMenuOpen, setIsActionMenuOpen] = useState(false)
    const isComposerOverlayOpen =
      isModelSelectorOpen || isEffortMenuOpen || isActionMenuOpen
    const editorRef = useRef<PromptInputEditorHandle>(null)
    const [actionQuery, setActionQuery] =
      useState<PromptInputActionQuery | null>(null)
    const handleModelSelectionCommitted = useCallback(() => {
      editorRef.current?.focus({ preventScroll: true })
    }, [])
    const handleActivateActionQuery = useCallback(
      (actionId: ComposerActionId, query: PromptInputActionQuery) => {
        const editor = editorRef.current
        if (
          !editor ||
          actionId !== "web-search" ||
          searchMode !== "optional" ||
          !editor.replaceActionQuery(query)
        ) {
          return false
        }

        setEnableSearch(!enableSearch)
        return true
      },
      [enableSearch, searchMode, setEnableSearch]
    )
    const {
      connectors: menuConnectors,
      activateConnector: handleActivateConnector,
      toggleConnector: handleToggleConnector,
    } = useComposerConnectors({ isUserAuthenticated, editorRef })
    const handleOpenActionMenu = useCallback(() => {
      editorRef.current?.toggleSyntheticActionQuery()
    }, [])
    const handleCloseActionQuery = useCallback(() => {
      editorRef.current?.endActionQuery()
    }, [])
    const handleActionQueryChange = (query: PromptInputActionQuery | null) => {
      setActionQuery(query)
      setIsActionMenuOpen(query !== null)
    }

    // Anonymous chat cannot use authenticated storage, so guests' generated
    // pastes cross the turn seam as ordinary turn text.
    const shouldUploadGeneratedPastes = isUserAuthenticated

    // One Composer-owned picker lifecycle. It stages authenticated files
    // immediately and hands only ready metadata to the Chat turn.
    const {
      attachments,
      attachmentsReady,
      lockedAttachmentIds,
      announcement: attachmentAnnouncement,
      announce: setAttachmentAnnouncement,
      handleFileUpload,
      handleLargePaste,
      handleFileRemove,
      submitAttachments,
      retryAttachment,
    } = useFilePickerState({
      convex,
      uploadGeneratedPastes: shouldUploadGeneratedPastes,
    })

    const handleAttachmentUpload = useCallback(
      (newFiles: File[]) => {
        handleFileUpload(newFiles)
      },
      [handleFileUpload]
    )

    // Draft: display state here, persistence per chat (or per scope) in
    // localStorage via useChatDraft, debounced per keystroke. Scoped no-chat
    // surfaces and chat routes are identity-isolated, so route changes adopt
    // the active key's persisted draft instead of retaining the previous display.
    const draftIdentity = useMemo(
      () => resolveComposerDraftIdentity(chatId, draftScopeId),
      [chatId, draftScopeId]
    )
    const { draftValue, setDraftValue, clearDraft } = useChatDraft(
      draftIdentity.persistenceId
    )
    const { localValue, valueRef, applyValue, isCurrentDraft } =
      useComposerDraftDisplay(draftIdentity, draftValue)

    const debouncedSetDraftValue = useMemo(
      () => debounce((value: string) => setDraftValue(value), 500),
      [setDraftValue]
    )

    // Flush pending draft on tab close; also flush on unmount and when the
    // draft key changes (navigation), so the old chat's pending write lands.
    useEffect(() => {
      const flush = () => debouncedSetDraftValue.flush()
      window.addEventListener("beforeunload", flush)
      return () => {
        window.removeEventListener("beforeunload", flush)
        debouncedSetDraftValue.flush()
      }
    }, [debouncedSetDraftValue])

    // The ref mirrors the display text and is written SYNCHRONOUSLY by
    // useComposerDraftDisplay at every write site (event/imperative time, never
    // during render), so a send in the same tick as a text change always reads
    // the current text — the same guarantee the pre-Composer inputRef gave.
    const handleValueChange = useCallback(
      (newValue: string) => {
        for (const pending of pendingDraftSends.get(
          draftIdentity.persistenceId
        ) ?? []) {
          pending.edited = true
        }
        applyValue(newValue)
        debouncedSetDraftValue(newValue)
      },
      [applyValue, debouncedSetDraftValue, draftIdentity.persistenceId]
    )

    const handleSend = useCallback(async () => {
      const text = valueRef.current
      const key = draftIdentity.persistenceId
      const pendingSend = { edited: false }
      const pending =
        pendingDraftSends.get(key) ?? new Set<typeof pendingSend>()
      pending.add(pendingSend)
      pendingDraftSends.set(key, pending)
      let accepted = false
      try {
        accepted = await submitAttachments(text, (payload) => {
          // Clear only after attachment admission, before dispatch can yield.
          // The persisted draft survives until the turn reports success.
          applyValue("")
          return onTurn(payload)
        })
      } catch {
        toast({ title: "Send failed. Please try again.", status: "error" })
      } finally {
        pending.delete(pendingSend)
        if (pending.size === 0) pendingDraftSends.delete(key)
        // Preserve any new draft typed while dispatch was pending.
        if (
          !accepted &&
          isCurrentDraft() &&
          !pendingSend.edited &&
          text &&
          valueRef.current === ""
        )
          applyValue(text)
        if (accepted && !pendingSend.edited) {
          debouncedSetDraftValue.cancel()
          clearDraft()
        }
      }
    }, [
      applyValue,
      submitAttachments,
      onTurn,
      draftIdentity.persistenceId,
      isCurrentDraft,
      debouncedSetDraftValue,
      clearDraft,
      valueRef,
    ])

    const primaryAction = useMemo(() => {
      // When supplied, the resolver owns the complete Stop policy — including
      // a local transport that is still streaming while an exact durable Stop
      // is already pending. The status fallback preserves standalone/local
      // callers that do not participate in durable presentation.
      const canStop = stoppable ?? status === "streaming"
      // Pre-acceptance Stop cancels locally or defers to this dispatch's run.
      // A resolver-declined Stop is not overridden after submission settles.
      // Never present an enabled Stop without an actionable handler.
      const presentStop = Boolean(stop) && (canStop || Boolean(isSubmitting))
      const isMessageEmpty =
        !isSubmitting &&
        attachmentsReady &&
        isOnlyWhitespace(localValue) &&
        attachments.length === 0
      return resolveComposerPrimaryActionState({
        // Durable Stop is a mutation, so local transport cannot gate it.
        isStreaming: presentStop,
        isAbortable: presentStop,
        canSend:
          isSendReady &&
          !isSubmitting &&
          attachmentsReady &&
          (!isOnlyWhitespace(localValue) || attachments.length > 0),
        isMessageEmpty,
      })
    }, [
      attachments,
      attachmentsReady,
      isSubmitting,
      isSendReady,
      localValue,
      status,
      stop,
      stoppable,
    ])

    const handlePrimaryActionClick = useCallback(
      (event: MouseEvent<HTMLButtonElement>) => {
        // Stop can synchronously turn this same element into a submit button.
        event.preventDefault()
        if (primaryAction.disabled || primaryAction.intent !== "stop") {
          return
        }

        stop?.()
      },
      [primaryAction.disabled, primaryAction.intent, stop]
    )

    const rendererIntentRef = useIntentPrefetch<HTMLDivElement>(preloadMarkdown)
    const handleComposerSubmit = useCallback(() => {
      if (primaryAction.disabled || primaryAction.intent !== "send") {
        return
      }

      ;(window as ChatUiWindow).__chatUiPerf?.confirmSend()
      void preloadMarkdown().catch(() => undefined)

      const send = () => {
        void handleSend()
      }
      if (chatId === null) {
        runComposerSlideTransition(() => flushSync(send))
        return
      }
      send()
    }, [chatId, handleSend, primaryAction.disabled, primaryAction.intent])

    const handlePaste = useCallback(
      (e: ClipboardEvent) => {
        const items = e.clipboardData?.items
        if (!items) return

        const imageFiles: File[] = []
        for (const [index, item] of Array.from(items).entries()) {
          if (item.type.startsWith("image/")) {
            const file = item.getAsFile()
            if (file) {
              imageFiles.push(
                new File(
                  [file],
                  `pasted-image-${Date.now()}-${index + 1}.${file.type.split("/")[1]}`,
                  { type: file.type }
                )
              )
            }
          }
        }

        const decision = coordinateComposerPaste({
          text: e.clipboardData.getData("text/plain"),
          imageFiles,
          isAuthenticated: isUserAuthenticated,
        })

        if (decision.type === "allow-native-text") return

        e.preventDefault()
        if (decision.type === "reject") {
          toast({ title: decision.message, status: "error" })
          setAttachmentAnnouncement(decision.message)
          return
        }
        if (decision.type === "attach-images") {
          handleAttachmentUpload(decision.files)
          return
        }

        const attachment = handleLargePaste(decision.text)
        setAttachmentAnnouncement(
          `${attachment.file.name} attached. ${attachment.characterCount.toLocaleString()} characters.`
        )
      },
      [
        isUserAuthenticated,
        handleAttachmentUpload,
        handleLargePaste,
        setAttachmentAnnouncement,
      ]
    )

    const handleRestoreLargePaste = useCallback(
      (attachment: PendingAttachment) => {
        if (attachment.kind !== "generated-large-paste") return
        if (!handleFileRemove(attachment)) return
        const restored = restoreLargePasteText(valueRef.current, attachment)
        handleValueChange(restored.text)
        setAttachmentAnnouncement(`${attachment.file.name} restored.`)
        requestAnimationFrame(() => {
          const editor = editorRef.current
          editor?.focus()
          editor?.setSelectionRange(
            restored.selectionStart,
            restored.selectionEnd
          )
        })
      },
      [handleFileRemove, handleValueChange, setAttachmentAnnouncement, valueRef]
    )

    const handleAttachmentRemove = useCallback(
      (attachment: PendingAttachment) => {
        handleFileRemove(attachment)
      },
      [handleFileRemove]
    )

    const handleAttachmentRetry = useCallback(
      (attachment: PendingAttachment) => {
        retryAttachment(attachment)
      },
      [retryAttachment]
    )

    useImperativeHandle(
      ref,
      () => ({
        insertQuote: (text: string) => {
          const current = valueRef.current
          const quoted = text
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n")
          handleValueChange(
            current ? `${current}\n\n${quoted}\n\n` : `${quoted}\n\n`
          )
          requestAnimationFrame(() => {
            editorRef.current?.focus()
          })
        },
        setText: (text: string) => {
          applyValue(text)
        },
        focus: () => {
          editorRef.current?.focus()
        },
      }),
      [applyValue, handleValueChange, valueRef]
    )

    return (
      <div
        ref={rendererIntentRef}
        className="relative flex w-full flex-col gap-4"
        data-has-thread-error={status === "error" ? "" : undefined}
      >
        <div
          data-prompt-textarea-header=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-full z-20"
        />
        <InputDropZone
          onFileUpload={handleAttachmentUpload}
          disabled={!isUserAuthenticated || !isFileUploadAvailable}
        >
          <div
            className={cn(
              "pointer-events-auto relative z-1 order-2 flex flex-col pb-3 sm:pb-4 md:order-1",
              bottomSpacing === "none" && "pb-0 sm:pb-0"
            )}
            onClick={() => editorRef.current?.focus()}
          >
            <PromptInput
              expanded={localValue.includes("\n")}
              draftKey={draftIdentity.displayId}
              value={localValue}
              onValueChange={handleValueChange}
              onSubmit={handleComposerSubmit}
            >
              <div className="min-w-0 [grid-area:header]">
                <FileList
                  attachments={attachments}
                  lockedAttachmentIds={lockedAttachmentIds}
                  onFileRemove={handleAttachmentRemove}
                  onRestoreLargePaste={handleRestoreLargePaste}
                  onRetry={handleAttachmentRetry}
                  tooltipDisabled={isComposerOverlayOpen}
                />
              </div>
              <PromptInputActions
                className="h-9 justify-start gap-1.5 self-center [grid-area:leading]"
                data-composer-leading="true"
                data-composer-transition-slot="leading"
                onClick={(e) => e.stopPropagation()}
              >
                <ButtonPlusMenu
                  actionQuery={actionQuery}
                  isUserAuthenticated={isUserAuthenticated}
                  isFileUploadAvailable={isFileUploadAvailable}
                  enableSearch={enableSearch}
                  onActivateActionQuery={handleActivateActionQuery}
                  onToggleSearch={setEnableSearch}
                  searchMode={searchMode}
                  connectors={menuConnectors}
                  onActivateConnector={handleActivateConnector}
                  onToggleConnector={handleToggleConnector}
                  onOpenActionMenu={handleOpenActionMenu}
                  onCloseActionQuery={handleCloseActionQuery}
                  tooltipDisabled={isComposerOverlayOpen}
                  onMenuOpenChange={setIsActionMenuOpen}
                />
                <WebSearchControl
                  enabled={enableSearch}
                  mode={searchMode}
                  onEnabledChange={setEnableSearch}
                  tooltipDisabled={isComposerOverlayOpen}
                />
              </PromptInputActions>
              <PromptInputTextarea
                ref={editorRef}
                placeholder={placeholder}
                aria-label={ariaLabel}
                onActionQueryChange={handleActionQueryChange}
                onPaste={handlePaste}
                containerClassName="[grid-area:primary]"
              />
              <PromptInputFooter aria-hidden="true" />
              <PromptInputActions
                className="h-9 max-w-full min-w-0 gap-1 self-center [grid-area:trailing]"
                data-composer-trailing="true"
                data-composer-transition-slot="trailing"
                onClick={(e) => e.stopPropagation()}
              >
                <div
                  className={cn(
                    // group/segmented: hovering EITHER half of the joined
                    // pair reveals the seam center-out (see EffortControl's
                    // transform motion). cursor-pointer keeps the pointer
                    // steady over the transient seam strip the reveal opens
                    // between the two halves.
                    "group/segmented relative ms-1 flex min-w-0 shrink cursor-pointer items-center",
                    // Joined segmented pair: flush on hover-capable devices
                    // (the seam only opens through the hover reveal), while
                    // touch — whose persistent backgrounds are always visible
                    // — keeps a constant 2px seam between the halves. The
                    // loose 6px gap returns for effortless models.
                    hasEffortControl ? "cant-hover:gap-0.5 gap-0" : "gap-1.5"
                  )}
                >
                  <ModelSelector
                    variant="composer"
                    // Joined: soft-squared trailing corners and tight
                    // trailing padding, and the hover bridge retracts to the
                    // leading side only — flush against the thinking pill, a
                    // trailing bridge would steal its neighbor's leading
                    // clicks. The leading corners restate the pill radius as
                    // a FINITE 2xl (18px = half the 36px height): mixed with
                    // rounded-full's near-infinite radius, the CSS
                    // corner-overlap reduction scales every radius by one
                    // shared factor and crushes the finite corner to zero.
                    // Seam motion: this half translates -3px while the
                    // thinking pill translates +3px (center-out reveal), and
                    // an open popover on either half pins the revealed
                    // position independent of hover — see EffortControl.
                    // transition-transform owns only this seam translation;
                    // the Model and Thinking controls opt out of press scale.
                    className={
                      hasEffortControl
                        ? "can-hover:after:-start-1 can-hover:after:end-0 can-hover:group-hover/segmented:-translate-x-[3px] can-hover:group-has-[[aria-expanded=true]]/segmented:-translate-x-[3px] rounded-s-2xl rounded-e-md pe-1.5 transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
                        : undefined
                    }
                    selectedModelId={selectedModel}
                    setSelectedModelId={handleModelChange}
                    isUserAuthenticated={isUserAuthenticated}
                    onLockedGuestModelSelect={onLockedGuestModelSelect}
                    tooltipDisabled={isComposerOverlayOpen}
                    onOpenChange={setIsModelSelectorOpen}
                    onSelectionCommitted={handleModelSelectionCommitted}
                  />
                  <EffortControl
                    levels={effortLevels}
                    value={reasoningEffort}
                    defaultLevel={selectModelConfig?.defaultEffort}
                    onChange={setReasoningEffort}
                    tooltipDisabled={isComposerOverlayOpen}
                    onOpenChange={setIsEffortMenuOpen}
                    onSelectionCommitted={handleModelSelectionCommitted}
                  />
                </div>
                <div className="ms-auto flex shrink-0 items-center gap-2">
                  <PromptInputAction
                    disabled={isComposerOverlayOpen || undefined}
                    tooltip={
                      primaryAction.mode === "send" &&
                      !primaryAction.disabled ? (
                        <TooltipShortcut label={primaryAction.tooltip}>
                          <Kbd label="Enter">↵</Kbd>
                        </TooltipShortcut>
                      ) : (
                        primaryAction.tooltip
                      )
                    }
                  >
                    <Button
                      size="sm"
                      className="composer-submit-btn composer-submit-button-color can-hover:relative can-hover:after:absolute can-hover:after:-inset-x-1 can-hover:after:inset-y-0 can-hover:after:content-[''] size-9 rounded-full p-0 transition-colors duration-150 ease-out [view-transition-name:var(--vt-composer-speech-button)]"
                      disabled={
                        primaryAction.mode === "stop" && primaryAction.disabled
                      }
                      visuallyDisabled={
                        primaryAction.mode === "send" && primaryAction.disabled
                      }
                      type={primaryAction.buttonType}
                      id="composer-submit-button"
                      data-testid="send-button"
                      onClick={
                        primaryAction.mode === "stop"
                          ? handlePrimaryActionClick
                          : undefined
                      }
                      aria-label={primaryAction.ariaLabel}
                      aria-disabled={primaryAction.disabled}
                    >
                      {primaryAction.mode === "stop" ? (
                        <StopBulkRoundedIcon slotSize={22} glyphSize={22} />
                      ) : (
                        <Icon icon={RiArrowUpLine} slotSize={22} />
                      )}
                    </Button>
                  </PromptInputAction>
                </div>
              </PromptInputActions>
            </PromptInput>
            <p className="sr-only" role="status" aria-live="polite">
              {attachmentAnnouncement}
            </p>
          </div>
        </InputDropZone>
      </div>
    )
  })
)
