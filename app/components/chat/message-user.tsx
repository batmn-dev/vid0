"use client"

import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui/icon"
import {
  MessageActions,
  userMessageFooterRevealClassName,
} from "@/components/ui/message"
import {
  MorphingDialog,
  MorphingDialogClose,
  MorphingDialogContainer,
  MorphingDialogContent,
  MorphingDialogImage,
  MorphingDialogTitle,
  MorphingDialogTrigger,
} from "@/components/ui/morphing-dialog"
import {
  PromptInput,
  PromptInputTextarea,
  type PromptInputEditorHandle,
} from "@/components/ui/prompt-input"
import { createPromptInputDocument } from "@/components/ui/prompt-input-schema"
import type { MessageBranchInfo } from "@/lib/chat-messages/branch"
import type { EditTurnResult } from "@/lib/chat-turn/chat-turn-controller"
import { cn } from "@/lib/utils"
import { RiCheckLine, RiFileLine, RiFileTextLine } from "@remixicon/react"
import Image from "next/image"
import type { Node as ProseMirrorNode } from "prosemirror-model"
import React, { useCallback, useId, useMemo, useRef, useState } from "react"
import { defaultUrlTransform } from "react-markdown"
import { MessageActionButton } from "./message-action-button"
import { MessageBranchControls } from "./message-branch-controls"

type MessageAttachment = {
  name: string
  contentType: string
  url: string
}

function getAttachmentLabel(attachment: MessageAttachment): string {
  const extension = attachment.name.split(".").pop()
  if (extension && extension !== attachment.name) return extension.toUpperCase()
  if (attachment.contentType === "application/pdf") return "PDF"
  if (attachment.contentType.startsWith("text/")) return "TXT"
  return "FILE"
}

function AttachmentFileCard({ attachment }: { attachment: MessageAttachment }) {
  const isText = attachment.contentType.startsWith("text/")
  const icon = isText ? RiFileTextLine : RiFileLine
  const content = (
    <div className="border-border-subtle bg-background text-foreground hover:bg-interactive-hover mb-1 flex w-64 max-w-[min(16rem,calc(100vw-3rem))] items-center gap-3 rounded-md border px-3 py-2 text-left transition">
      <span className="bg-muted text-muted-foreground flex h-9 w-9 shrink-0 items-center justify-center rounded-md">
        <Icon icon={icon} slotSize={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          {attachment.name || "Attachment"}
        </span>
        <span className="text-muted-foreground block truncate text-xs">
          {attachment.contentType || getAttachmentLabel(attachment)}
        </span>
      </span>
      <span className="text-muted-foreground shrink-0 text-xs font-medium">
        {getAttachmentLabel(attachment)}
      </span>
    </div>
  )

  if (!attachment.url) return content

  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open attachment ${attachment.name || "file"}`}
    >
      {content}
    </a>
  )
}

function MessageAttachmentView({
  attachment,
}: {
  attachment: MessageAttachment
}) {
  if (!attachment.contentType?.startsWith("image")) {
    return <AttachmentFileCard attachment={attachment} />
  }

  return (
    <MorphingDialog
      transition={{
        type: "spring",
        stiffness: 280,
        damping: 18,
        mass: 0.3,
      }}
    >
      <MorphingDialogTrigger className="z-10">
        <Image
          className="mb-1 w-40 rounded-md"
          src={attachment.url}
          alt={attachment.name || "Attachment"}
          width={160}
          height={120}
        />
      </MorphingDialogTrigger>
      <MorphingDialogContainer>
        <MorphingDialogContent className="relative rounded-lg">
          {/* Names the lightbox for screen readers; the content's aria-labelledby points here. */}
          <MorphingDialogTitle className="sr-only">
            Attachment preview: {attachment.name || "image"}
          </MorphingDialogTitle>
          <MorphingDialogImage
            src={attachment.url}
            alt={attachment.name || ""}
            className="max-h-[90vh] max-w-[90vw] object-contain"
          />
        </MorphingDialogContent>
        <MorphingDialogClose className="text-primary" />
      </MorphingDialogContainer>
    </MorphingDialog>
  )
}

function CopyUserMessageIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 20 20"
      focusable="false"
      aria-hidden="true"
      fill="currentColor"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M15.1006 1.78516C16.793 1.78556 18.165 3.15808 18.165 4.85059V10.8838C18.1649 12.5762 16.7929 13.9478 15.1006 13.9482H13.998V15.0508C13.9976 16.7431 12.626 18.1151 10.9336 18.1152H4.90039C3.20789 18.1152 1.83537 16.7432 1.83496 15.0508V9.01758C1.83496 7.32482 3.20764 5.95215 4.90039 5.95215H6.00195V4.85059C6.00195 3.15783 7.37463 1.78516 9.06738 1.78516H15.1006ZM4.90039 7.28223C3.94218 7.28223 3.16504 8.05936 3.16504 9.01758V15.0508C3.16544 16.0087 3.94243 16.7852 4.90039 16.7852H10.9336C11.8914 16.785 12.6676 16.0086 12.668 15.0508V9.01758C12.668 8.05945 11.8917 7.28237 10.9336 7.28223H4.90039ZM9.06738 3.11523C8.10917 3.11523 7.33203 3.89237 7.33203 4.85059V5.95215H10.9336C12.6262 5.95229 13.998 7.32491 13.998 9.01758V12.6182H15.1006C16.0584 12.6178 16.8348 11.8416 16.835 10.8838V4.85059C16.835 3.89262 16.0585 3.11564 15.1006 3.11523H9.06738Z"
      />
    </svg>
  )
}

function EditUserMessageIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 20 20"
      focusable="false"
      aria-hidden="true"
      fill="currentColor"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M11.6258 3.30375C13.0516 1.88123 15.3202 1.91012 16.6805 3.29496C18.0834 4.64996 18.1292 6.92825 16.6893 8.36821L9.68929 15.3682L9.68832 15.3672C8.9762 16.1131 8.0665 16.6184 7.11605 16.8389L7.11507 16.8399L3.24789 17.7276L3.24691 17.7256C3.08016 17.7653 2.74207 17.799 2.4725 17.5303C2.20162 17.2601 2.23613 16.9199 2.27621 16.753H2.27425L3.1639 12.8956C3.38813 11.8986 3.89924 11.028 4.6014 10.3272L11.6258 3.30375ZM5.54183 11.2686C5.00143 11.8078 4.62462 12.4592 4.46078 13.1905L4.4598 13.1944L3.7557 16.2461L6.81722 15.543C7.52306 15.3789 8.20539 15.0001 8.73617 14.4405L14.3944 8.78129L11.2118 5.5977L5.54183 11.2686ZM15.742 4.23637C14.9045 3.37296 13.4757 3.3368 12.5653 4.24516L12.1522 4.65727L15.3348 7.84086L15.7489 7.42778C16.6655 6.51112 16.6228 5.08792 15.7577 4.252L15.742 4.23637Z"
      />
    </svg>
  )
}

function SharePromptIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 20 20"
      focusable="false"
      aria-hidden="true"
      fill="currentColor"
    >
      <path d="M16.6663 10.1681C17.0335 10.1681 17.3313 10.4659 17.3313 10.8332V14.1994C17.3313 15.929 15.929 17.3312 14.1995 17.3312H5.80005C4.07048 17.3312 2.66821 15.929 2.66821 14.1994V10.8332C2.66821 10.4659 2.96598 10.1681 3.33325 10.1681C3.70052 10.1681 3.99829 10.4659 3.99829 10.8332V14.1994C3.99829 15.1944 4.80502 16.0011 5.80005 16.0011H14.1995C15.1945 16.0011 16.0012 15.1944 16.0012 14.1994V10.8332C16.0012 10.466 16.2991 10.1683 16.6663 10.1681Z" />
      <path d="M9.31763 3.08317C9.71412 2.76014 10.2865 2.75993 10.6829 3.08317L10.7649 3.15739L14.012 6.40446C14.2716 6.66406 14.2714 7.08517 14.012 7.34489C13.7523 7.60459 13.3312 7.60459 13.0715 7.34489L10.6653 4.93864V11.8752C10.6653 12.2423 10.3674 12.54 10.0002 12.5402C9.63297 12.5402 9.33521 12.2424 9.33521 11.8752V4.93669L6.92896 7.34489C6.66926 7.60459 6.24725 7.60459 5.98755 7.34489C5.72836 7.08521 5.72817 6.66402 5.98755 6.40446L9.23462 3.15739L9.31763 3.08317Z" />
    </svg>
  )
}

function CollapsibleUserMessageChevron() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="size-4"
      fill="currentColor"
    >
      <path d="M12.629 5.879a.525.525 0 1 1 .742.742l-4.765 4.765a.86.86 0 0 1-1.212 0L2.629 6.62a.525.525 0 1 1 .742-.742L8 10.508z" />
    </svg>
  )
}

const collapsedMessageMaxHeight = 264

function renderUserMessageNode(
  node: ProseMirrorNode,
  key: number
): React.ReactNode {
  if (node.isText) {
    let content: React.ReactNode = node.text
    for (const mark of [...node.marks].reverse()) {
      if (mark.type.name === "strong") content = <strong>{content}</strong>
      if (mark.type.name === "em") content = <em>{content}</em>
    }
    const link = node.marks.find((mark) => mark.type.name === "link")
    if (link) {
      const destination = String(link.attrs.href)
      const href = /^tel:/i.test(destination)
        ? destination
        : defaultUrlTransform(destination)
      if (href) {
        content = (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {content}
          </a>
        )
      }
    }
    return <React.Fragment key={key}>{content}</React.Fragment>
  }
  if (node.type.name === "hard_break") return <br key={key} />

  const children: React.ReactNode[] = []
  let emptyParagraphs = 0
  const appendBlankLines = (index: number) => {
    const atEdge = children.length === 0 || index === node.childCount
    const blankLines = emptyParagraphs - (atEdge ? 0 : 1)
    if (blankLines > 0) {
      children.push(
        <span
          key={`blank-${index}`}
          aria-hidden="true"
          className="user-message-preserved-blank-lines"
          data-preserved-blank-lines={blankLines}
          style={{ height: `${blankLines}lh` }}
        />
      )
    }
    emptyParagraphs = 0
  }
  const tightItem =
    node.type.name === "list_item" &&
    Array.from({ length: node.childCount }, (_, index) =>
      node.child(index)
    ).filter((child) => child.type.name === "paragraph").length === 1
  node.forEach((child, _offset, index) => {
    if (
      node.type.name === "doc" &&
      child.type.name === "paragraph" &&
      child.content.size === 0
    ) {
      emptyParagraphs += 1
      return
    }
    // Only interior gaps include a Markdown separator supplied by block margins.
    appendBlankLines(index)
    // The reference omits paragraph wrappers inside tight list items.
    if (tightItem && child.type.name === "paragraph") {
      const inlineContent: React.ReactNode[] = []
      child.forEach((inline, _inlineOffset, inlineIndex) => {
        inlineContent.push(renderUserMessageNode(inline, inlineIndex))
      })
      children.push(
        <React.Fragment key={index}>{inlineContent}</React.Fragment>
      )
    } else {
      children.push(renderUserMessageNode(child, index))
    }
  })
  appendBlankLines(node.childCount)
  switch (node.type.name) {
    case "paragraph":
      return <p key={key}>{children.length ? children : <br />}</p>
    case "heading":
      return React.createElement(`h${node.attrs.level}`, { key }, children)
    case "bullet_list":
      return <ul key={key}>{children}</ul>
    case "ordered_list":
      return (
        <ol
          key={key}
          start={node.attrs.order === 1 ? undefined : Number(node.attrs.order)}
        >
          {children}
        </ol>
      )
    case "list_item":
      return <li key={key}>{children}</li>
    default:
      return <React.Fragment key={key}>{children}</React.Fragment>
  }
}

function UserMessageContent({ children }: { children: string }) {
  const doc = useMemo(() => createPromptInputDocument(children), [children])
  let plain = true
  doc.descendants((node) => {
    if (
      !["paragraph", "text", "hard_break"].includes(node.type.name) ||
      node.marks.length
    ) {
      plain = false
    }
  })

  return plain ? (
    <div className="max-w-full min-w-0 [overflow-wrap:anywhere] whitespace-pre-wrap">
      {doc.textBetween(0, doc.content.size, "\n", "\n")}
    </div>
  ) : (
    <div className="markdown user-message-markdown">
      {renderUserMessageNode(doc, 0)}
    </div>
  )
}

function CollapsibleUserMessage({ children }: { children: string }) {
  const contentId = useId()
  const [canExpand, setCanExpand] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)

  const setContentNode = useCallback((node: HTMLDivElement | null) => {
    resizeObserverRef.current?.disconnect()
    resizeObserverRef.current = null
    if (!node) return

    const measure = () => {
      const isOverflowing = node.scrollHeight > collapsedMessageMaxHeight
      setCanExpand(isOverflowing)
      if (!isOverflowing) setIsExpanded(false)
    }

    measure()
    if (typeof ResizeObserver === "undefined") return

    const observer = new ResizeObserver(measure)
    observer.observe(node)
    resizeObserverRef.current = observer
  }, [])

  return (
    <div
      className="grid"
      data-custom-highlighting-behavior="boundary"
      data-collapsed={canExpand && !isExpanded ? "" : undefined}
      data-testid="collapsible-user-message-root"
      data-can-expand={canExpand ? "" : undefined}
    >
      <div
        id={contentId}
        ref={setContentNode}
        data-testid="collapsible-user-message-content"
        className={cn(
          canExpand &&
            !isExpanded &&
            "max-h-[264px] overflow-clip [mask-image:linear-gradient(#000_calc(100%_-_48px),transparent)]"
        )}
      >
        <UserMessageContent>{children}</UserMessageContent>
      </div>
      {canExpand && (
        <button
          type="button"
          aria-controls={contentId}
          aria-expanded={isExpanded}
          className="user-message-collapse-toggle mt-2 flex w-fit items-center gap-1 rounded-md py-0.5 text-sm leading-5 font-medium select-none"
          data-testid="collapsible-user-message-toggle"
          onClick={() => setIsExpanded((expanded) => !expanded)}
        >
          <span className={cn(isExpanded && "hidden")}>Show more</span>
          <span className={cn(!isExpanded && "hidden")}>Show less</span>
          <div
            className={cn(
              "size-4 motion-safe:transition-transform motion-safe:duration-150",
              isExpanded && "rotate-180"
            )}
          >
            <CollapsibleUserMessageChevron />
          </div>
        </button>
      )}
    </div>
  )
}

function UserMessageBubble({
  children,
  containsAttachments,
}: {
  children: React.ReactNode
  containsAttachments: boolean
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-start self-end rtl:items-end rtl:self-start",
        "w-fit max-w-(--user-chat-width,70%)"
      )}
    >
      <div className="contents w-full">
        <div
          className={cn(
            "corner-superellipse/0.98 user-message-bubble-color relative w-full min-w-0 overflow-hidden rounded-[22px] [background-color:var(--theme-user-msg-bg,var(--user-message-bg))] px-4 py-2.5 leading-6 [color:var(--theme-user-msg-text,var(--foreground))]",
            containsAttachments && "rounded-se-lg"
          )}
        >
          {children}
        </div>
      </div>
    </div>
  )
}

function UserMessageEditor({
  id,
  attachments,
  editError,
  editInput,
  onCancel,
  onChange,
  onSave,
}: {
  id: string
  attachments?: MessageAttachment[]
  editError: string | null
  editInput: string
  onCancel: () => void
  onChange: (value: string) => void
  onSave: () => void
}) {
  const initialValue = useRef(editInput)
  const focusEditor = useCallback((editor: PromptInputEditorHandle | null) => {
    if (!editor) return
    editor.focus({ preventScroll: true })
    editor.setSelectionRange(
      initialValue.current.length,
      initialValue.current.length
    )
  }, [])

  return (
    <div className="user-message-editor font-native bg-secondary rounded-3xl px-3 py-3">
      {attachments && attachments.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {attachments.map((attachment, index) => (
            <MessageAttachmentView
              attachment={attachment}
              key={`${attachment.name}-${index}`}
            />
          ))}
        </div>
      ) : null}
      <div
        className="m-2 max-h-[25dvh] overflow-auto"
        onCopy={(event) => event.stopPropagation()}
      >
        {/* No pending state: a successful save swaps this row for the edited
            message before the request settles (reference: ChatGPT), so the
            editor never gets to show a lock. Double submits are caught in
            handleSave. */}
        <PromptInput
          className="user-message-edit-input"
          value={editInput}
          onValueChange={onChange}
        >
          <PromptInputTextarea
            ref={focusEditor}
            id={`message-edit-${id}`}
            aria-label="Edit message"
            disableAutosize
            submitOnEnter={false}
            onKeyDown={(event) => {
              if (event.isComposing) return
              if (
                event.key === "Enter" &&
                (event.metaKey || event.ctrlKey) &&
                !event.shiftKey
              ) {
                event.preventDefault()
                onSave()
                return
              }
              if (event.key === "Escape" && !event.defaultPrevented) {
                event.preventDefault()
                onCancel()
              }
            }}
          />
        </PromptInput>
        {editError ? (
          <p className="text-destructive mt-2 text-sm" role="alert">
            {editError}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap justify-end gap-2 px-2 pt-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          <div className="flex items-center justify-center">Cancel</div>
        </Button>
        <Button type="button" onClick={onSave} disabled={!editInput.trim()}>
          <div className="flex items-center justify-center">Send</div>
        </Button>
      </div>
    </div>
  )
}

export type MessageUserProps = {
  attachments?: MessageAttachment[]
  children: string
  copied: boolean
  copyToClipboard: () => void
  sharePrompt?: () => void
  id: string
  className?: string
  onReload?: (messageId: string) => void
  branch?: MessageBranchInfo
  onSelectBranch?: (messageId: string) => void
  onEdit?: (
    id: string,
    newText: string
  ) => Promise<EditTurnResult | void> | EditTurnResult | void
  isEditing: boolean
  onEditingChange: (isEditing: boolean) => void
  isDurableChat?: boolean
}

export function MessageUser({
  attachments,
  children,
  copied,
  copyToClipboard,
  sharePrompt,
  id,
  className,
  branch,
  onSelectBranch,
  onEdit,
  isEditing,
  onEditingChange,
  isDurableChat,
}: MessageUserProps) {
  const [editInput, setEditInput] = useState(children)
  const [editError, setEditError] = useState<string | null>(null)
  // Each editor open/close starts a new session. A pending save captures its
  // session and only settles the editor it started from, so a completion that
  // lands after the editor was closed and reopened never discards the new draft.
  const editSessionRef = useRef(0)
  // Ref, not state: a second Send inside the in-flight window is dropped
  // without rendering a locked editor.
  const saveInFlightRef = useRef(false)

  const handleEditCancel = () => {
    editSessionRef.current += 1
    onEditingChange(false)
    setEditInput(children)
    setEditError(null)
    saveInFlightRef.current = false
  }

  const handleSave = async () => {
    if (saveInFlightRef.current) return
    if (!editInput.trim()) return
    if (!onEdit) {
      setEditError("Editing is not available for this message.")
      return
    }

    const editSession = editSessionRef.current
    saveInFlightRef.current = true
    setEditError(null)
    let failure: string | null = null
    try {
      const result = await onEdit(id, editInput)
      if (result && !result.ok) {
        failure = result.message || "The edit was not submitted."
      }
    } catch {
      failure = "Failed to submit the edit. Please try again."
    } finally {
      // Only the save that still owns the session clears the guard: an older
      // save settling after cancel-and-reopen must not unlock a newer one.
      if (editSession === editSessionRef.current) {
        saveInFlightRef.current = false
      }
    }
    if (editSession !== editSessionRef.current) return

    if (failure) {
      setEditError(failure)
      return
    }
    onEditingChange(false)
  }

  const handleEditStart = () => {
    editSessionRef.current += 1
    onEditingChange(true)
    setEditInput(children)
    setEditError(null)
    saveInFlightRef.current = false
  }

  if (isEditing) {
    return (
      <UserMessageEditor
        id={id}
        attachments={attachments}
        editError={editError}
        editInput={editInput}
        onCancel={handleEditCancel}
        onChange={(value) => {
          setEditInput(value)
          if (editError) setEditError(null)
        }}
        onSave={handleSave}
      />
    )
  }

  return (
    <>
      {/* Captured turn anatomy (box-chain verified 2026-07-11): a gap-4 content
          wrapper groups the `text-message` block(s); the action row is a
          ZERO-GAP column-level sibling, so the buttons sit p-1 (4px) under
          the bubble. */}
      <div className={cn("flex max-w-full grow flex-col gap-4", className)}>
        <div
          className="text-message font-native keyboard-focused:focus-ring relative flex min-h-8 w-full flex-col items-end gap-2 text-start break-words whitespace-normal outline-none [.text-message+&]:mt-1"
          data-message-id={id}
          data-message-author-role="user"
          dir="auto"
        >
          <div className="flex w-full flex-col items-end gap-1 empty:hidden rtl:items-start">
            {attachments?.map((attachment, index) => (
              <div
                className="flex flex-row gap-2"
                key={`${attachment.name}-${index}`}
              >
                <MessageAttachmentView attachment={attachment} />
              </div>
            ))}
            <UserMessageBubble
              containsAttachments={Boolean(attachments?.length)}
            >
              <CollapsibleUserMessage key={children}>
                {children}
              </CollapsibleUserMessage>
            </UserMessageBubble>
          </div>
        </div>
      </div>
      {/* Every sent-message control belongs to one composable action family:
          it shares the same reveal behavior and button primitive. */}
      <div className="z-0 flex justify-end">
        <MessageActions
          className={cn(
            "-ms-2.5 -me-1 flex-wrap items-center gap-0 gap-y-4 p-1 select-none",
            userMessageFooterRevealClassName
          )}
          aria-label="Your message actions"
          role="group"
          tabIndex={-1}
        >
          <MessageActionButton
            label="Copy message"
            tooltip={copied ? "Copied!" : "Copy Message"}
            onClick={copyToClipboard}
            icon={
              copied ? (
                <Icon icon={RiCheckLine} slotSize={20} />
              ) : (
                <CopyUserMessageIcon />
              )
            }
          />
          {isDurableChat && sharePrompt ? (
            <MessageActionButton
              label="Share prompt"
              onClick={sharePrompt}
              icon={<SharePromptIcon />}
              testId="share-prompt-link-turn-action-button"
            />
          ) : null}
          {isDurableChat && (
            <MessageActionButton
              label="Edit message"
              onClick={handleEditStart}
              icon={<EditUserMessageIcon />}
            />
          )}
          {/* Branch nav reveals with the footer actions to match the captured
            reference (2026-07-11). This supersedes the earlier
            always-visible rule ("a fresh regenerate/edit gives no cue that
            versions exist"): the reference hides the pager at rest too, and
            the row's hover reveal is the discovery affordance. */}
          <MessageBranchControls
            branch={branch}
            onSelectBranch={onSelectBranch}
          />
        </MessageActions>
      </div>
    </>
  )
}
