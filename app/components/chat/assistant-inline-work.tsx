"use client"

import { useBrowserLayoutEffect } from "@/app/hooks/use-browser-layout-effect"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Favicon } from "@/components/ui/favicon"
import { Icon } from "@/components/ui/icon"
import type { AssistantActivitySearchEntry } from "@/lib/chat-messages/assistant-activity"
import { deriveAssistantActivityPresentation } from "@/lib/chat-messages/assistant-activity"
import {
  deriveAssistantInlineWork,
  type InlineWorkActiveTail,
  type InlineWorkItem,
} from "@/lib/chat-messages/assistant-inline-work"
import type {
  AssistantTurnPhase,
  AssistantTurnRenderStatus,
  AssistantTurnView,
} from "@/lib/chat-messages/assistant-turn"
import { resolveSourceLinkDestination } from "@/lib/url-safety"
import { cn } from "@/lib/utils"
import { RiArrowRightSLine, RiGlobalLine } from "@remixicon/react"
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
} from "motion/react"
import { useCallback, useRef, useState, type ReactNode } from "react"
import { ActivityPanelTrigger } from "./activity/activity-panel-trigger"
import { StatusText } from "./activity/status-text"
import { InlineSearchLabel } from "./inline-search-label"
import { InlineWorkNarrative } from "./inline-work-narrative"

const DISCLOSURE_MOTION =
  "inline-work-disclosure h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-300 ease-[ease-in-out] data-starting-style:h-0 data-ending-style:h-0 motion-reduce:transition-none"
const CHEVRON =
  "shrink-0 transition-transform duration-150 motion-reduce:transition-none"
const CHIP =
  "group inline-flex h-[25px] max-w-full items-center gap-1 overflow-hidden rounded-full bg-[var(--inline-work-source-surface)] px-3 text-xs text-[var(--text-secondary)] select-none hover:bg-foreground hover:text-background focus-visible:ring-2 focus-visible:ring-focus-ring outline-none"

function InlineWorkDisclosure({ children }: { children: ReactNode }) {
  return (
    <CollapsibleContent className={DISCLOSURE_MOTION}>
      <div className="inline-work-disclosure-body">{children}</div>
    </CollapsibleContent>
  )
}

function InlineSearchSources({
  entry,
}: {
  entry: AssistantActivitySearchEntry
}) {
  const [showAll, setShowAll] = useState(false)
  const sources = showAll ? entry.sources : entry.sources.slice(0, 7)
  const remaining = entry.sources.length - 7
  return (
    <div
      className="flex flex-wrap gap-1 pt-2"
      role="group"
      aria-label={`Sources for ${entry.title}`}
    >
      {sources.map((source) => {
        const destination = resolveSourceLinkDestination(source.url)
        const content = (
          <>
            <Favicon
              url={source.faviconDomain ?? source.url}
              className="-ms-1 size-3"
            />
            <span className="truncate">
              {destination?.url.hostname ?? source.title}
            </span>
          </>
        )
        return destination ? (
          <a
            key={source.url}
            className={CHIP}
            href={destination.href}
            target={destination.target}
            rel={destination.rel}
          >
            {content}
          </a>
        ) : (
          <span className={CHIP} key={source.url}>
            {content}
          </span>
        )
      })}
      {remaining > 0 && (
        <button
          type="button"
          className={CHIP}
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll ? (
            "Show less"
          ) : (
            <>
              {entry.sources.slice(7, 10).map((source) => (
                <Favicon
                  key={source.url}
                  url={source.faviconDomain ?? source.url}
                  className="group-hover:border-foreground -ms-3 box-content size-3 border border-[var(--inline-work-source-surface)] first:-ms-1"
                />
              ))}
              <span className="max-w-32 truncate">{`${remaining} more`}</span>
            </>
          )}
        </button>
      )}
    </div>
  )
}

function ThinkingFavicon({ url }: { url: string | undefined }) {
  const [unavailableUrl, setUnavailableUrl] = useState<string>()
  if (!url || unavailableUrl === url)
    return <Icon icon={RiGlobalLine} slotSize={20} glyphInset={0} />
  return (
    <span
      className="flex size-5 shrink-0"
      onLoadCapture={(event) => {
        const image = event.target
        // Our favicon endpoint proxies Google S2, including its tiny fallback.
        if (
          image instanceof HTMLImageElement &&
          (image.naturalWidth < 20 || image.naturalHeight < 20)
        )
          setUnavailableUrl(url)
      }}
      onErrorCapture={() => setUnavailableUrl(url)}
    >
      <Favicon url={url} className="size-5 shrink" />
    </span>
  )
}

function useSearchMarkerIndex(
  searchId: string | undefined,
  sourceCount: number
) {
  const [cursor, setCursor] = useState({ searchId, index: 0 })
  const lastIndex = Math.max(0, sourceCount - 1)
  const index =
    cursor.searchId === searchId ? Math.min(cursor.index, lastIndex) : 0
  if (cursor.searchId !== searchId || cursor.index !== index)
    setCursor({ searchId, index })
  useBrowserLayoutEffect(() => {
    if (
      index >= lastIndex ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    )
      return
    const timer = window.setTimeout(
      () => setCursor({ searchId, index: index + 1 }),
      1500
    )
    return () => window.clearTimeout(timer)
  }, [index, lastIndex, searchId])
  return index
}

function RunningSearchMarker({
  entry,
}: {
  entry: AssistantActivitySearchEntry
}) {
  const index = useSearchMarkerIndex(entry.id, entry.sources.length)
  const source = entry.sources[index]
  return <ThinkingFavicon url={source?.faviconDomain ?? source?.url} />
}

function SearchWorkItem({
  entry,
  animate,
  onOpenActivity,
  markerIndex,
}: {
  entry: AssistantActivitySearchEntry
  animate: boolean
  onOpenActivity?: () => void
  markerIndex?: number
}) {
  const [open, setOpen] = useState(false)
  const firstSource = entry.sources[0]
  const marker =
    firstSource && entry.status === "running" ? (
      markerIndex === undefined ? (
        <RunningSearchMarker entry={entry} />
      ) : (
        <ThinkingFavicon
          url={
            entry.sources[markerIndex]?.faviconDomain ??
            entry.sources[markerIndex]?.url
          }
        />
      )
    ) : firstSource ? (
      <ThinkingFavicon url={firstSource.faviconDomain ?? firstSource.url} />
    ) : (
      <Icon icon={RiGlobalLine} slotSize={20} glyphInset={0} />
    )
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="group/search min-w-0"
      data-inline-work-search={entry.id}
    >
      <CollapsibleTrigger
        aria-label={entry.title}
        disabled={entry.sources.length === 0 && entry.status !== "approval"}
        onClick={entry.status === "approval" ? onOpenActivity : undefined}
        className="focus-visible:ring-focus-ring hover:text-foreground flex min-h-8 w-full items-start gap-2 text-left text-base leading-6 font-normal text-[var(--text-tertiary)] outline-none focus-visible:ring-2"
      >
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--background-tertiary)]">
          {marker}
        </span>
        <InlineSearchLabel
          title={entry.title}
          running={entry.status === "running"}
          animate={animate}
        />
        {entry.sources.length > 0 && (
          <Icon
            icon={RiArrowRightSLine}
            slotSize={20}
            glyphInset={0}
            className={cn(
              CHEVRON,
              "-ms-1 mt-0.5 opacity-0 group-focus-within/search:opacity-100 group-hover/search:opacity-100",
              open && "rotate-90 opacity-100"
            )}
          />
        )}
      </CollapsibleTrigger>
      <InlineWorkDisclosure>
        <InlineSearchSources entry={entry} />
      </InlineWorkDisclosure>
      {entry.detail && (
        <div className="pt-1 text-sm text-[var(--text-tertiary)]">
          {entry.detail}
        </div>
      )}
    </Collapsible>
  )
}

function WorkStatusTransition({
  children,
  instant = false,
}: {
  children: ReactNode
  instant?: boolean
}) {
  const present = useIsPresent()
  return (
    <motion.div
      data-inline-work-transition
      inert={!present}
      aria-hidden={!present || undefined}
      initial={{ opacity: instant ? 1 : 0 }}
      animate={{
        opacity: 1,
        transition: {
          duration: instant ? 0 : 0.3,
          delay: instant ? 0 : 0.15,
          ease: [0.25, 0.1, 0.25, 1],
        },
      }}
      exit={{
        opacity: instant ? 1 : 0,
        transition: {
          duration: instant ? 0 : 0.15,
          ease: [0.25, 0.1, 0.25, 1],
        },
      }}
      className={cn(
        "w-full",
        !present && "pointer-events-none absolute inset-x-0 top-0"
      )}
    >
      {children}
    </motion.div>
  )
}

function WorkEntry({
  children,
  live,
  animate,
  transitionKey,
  activeTail = false,
  onlyRow = false,
  isReasoningTitle = false,
}: {
  children: ReactNode
  live: boolean
  animate: boolean
  transitionKey?: string
  activeTail?: boolean
  onlyRow?: boolean
  isReasoningTitle?: boolean
}) {
  const reducedMotion = useReducedMotion()
  const skipMotion = reducedMotion || !live || !animate
  const skipInitialMotion =
    skipMotion || (activeTail && (onlyRow || isReasoningTitle))
  const [size, setSize] = useState<{ height: number; delay: number }>()
  const observeContent = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || skipMotion || typeof ResizeObserver === "undefined") return
      const mountedAt = performance.now()
      const measure = () => {
        const height = node.getBoundingClientRect().height
        const delay = activeTail
          ? 0
          : Math.max(0, 0.26 - (performance.now() - mountedAt) / 1000)
        setSize((previous) =>
          previous?.height === height ? previous : { height, delay }
        )
      }
      measure()
      const observer = new ResizeObserver(measure)
      observer.observe(node)
      return () => observer.disconnect()
    },
    [skipMotion, activeTail]
  )
  return (
    <motion.div
      initial={
        skipInitialMotion
          ? false
          : {
              opacity: 0,
              ...(!activeTail ? { height: 0 } : {}),
            }
      }
      animate={{
        opacity: 1,
        height: skipMotion ? "auto" : (size?.height ?? "auto"),
      }}
      transition={{
        opacity: {
          duration: skipInitialMotion ? 0 : activeTail ? 1.2 : 0.7,
          ease: activeTail ? "easeInOut" : [0.25, 0.1, 0.25, 1],
        },
        height: {
          duration: live && !skipMotion ? 0.3 : 0,
          delay: skipMotion || activeTail ? 0 : (size?.delay ?? 0.26),
          ease: [0.25, 0.1, 0.25, 1],
        },
      }}
      className="w-full overflow-x-visible overflow-y-clip"
      data-inline-work-active-row={activeTail || undefined}
    >
      <div ref={observeContent} className="relative w-full">
        {!skipMotion && transitionKey ? (
          <AnimatePresence initial={false}>
            <WorkStatusTransition
              key={transitionKey}
              instant={isReasoningTitle}
            >
              {children}
            </WorkStatusTransition>
          </AnimatePresence>
        ) : (
          children
        )}
      </div>
    </motion.div>
  )
}

function WorkItems({
  items,
  live,
  animate,
  onOpenActivity,
  activeTail,
}: {
  items: InlineWorkItem[]
  live: boolean
  animate: boolean
  onOpenActivity?: () => void
  activeTail?: InlineWorkActiveTail
}) {
  const activeSearch =
    activeTail?.item.kind === "search" ? activeTail.item : undefined
  // Keep the favicon cursor above content-keyed status transitions.
  const markerIndex = useSearchMarkerIndex(
    activeSearch?.id,
    activeSearch?.sources.length ?? 0
  )
  const renderItem = (item: InlineWorkItem) => {
    if (item.kind === "status")
      return (
        <StatusText
          label={item.title}
          shimmer
          shimmerVariant="tertiary"
          className="flex min-h-8 items-start text-[var(--text-tertiary)]"
        />
      )
    if (item.kind === "commentary" || item.kind === "reasoning")
      return (
        <InlineWorkNarrative
          key={item.id}
          text={item.text}
          streaming={live}
          animate={animate}
        />
      )
    if (item.kind === "search")
      return (
        <SearchWorkItem
          key={item.id}
          entry={item}
          animate={animate}
          onOpenActivity={onOpenActivity}
          markerIndex={item === activeSearch ? markerIndex : undefined}
        />
      )
    return (
      <button
        key={item.id}
        type="button"
        onClick={onOpenActivity}
        className="hover:text-foreground w-fit text-left text-base leading-6 text-[var(--text-tertiary)]"
      >
        {item.title}
      </button>
    )
  }
  return (
    <>
      {items.map((item) => {
        const content = renderItem(item)
        if (item.kind === "commentary" || item.kind === "reasoning")
          return content
        return content ? (
          <WorkEntry key={item.id} live={live} animate={animate}>
            {content}
          </WorkEntry>
        ) : null
      })}
      {activeTail && (
        <WorkEntry
          key={items.length === 0 ? "initial-work-row" : "cot-v5-active-row"}
          live={live}
          animate={animate}
          activeTail
          onlyRow={items.length === 0}
          isReasoningTitle={activeTail.isReasoningTitle}
          transitionKey={activeTail.contentKey}
        >
          {renderItem(activeTail.item)}
        </WorkEntry>
      )}
    </>
  )
}

export function AssistantInlineWork({
  view,
  phase,
  status,
  workDurationMs,
  reasoningDurationMs,
  isReplaying = false,
  activityOpen = false,
  activityControlsId,
  onActivityOpenChange,
  onOpenActivity,
}: {
  view: AssistantTurnView
  phase: AssistantTurnPhase
  status: AssistantTurnRenderStatus
  workDurationMs?: number
  reasoningDurationMs?: number
  isReplaying?: boolean
  activityOpen?: boolean
  activityControlsId?: string
  onActivityOpenChange?: (open: boolean) => void
  onOpenActivity?: () => void
}) {
  const complete =
    (view.inlineContent.hasFinalAnswer && phase.kind !== "awaiting-approval") ||
    phase.kind === "settled"
  const [completion, setCompletion] = useState({
    complete,
    duration: complete ? undefined : workDurationMs,
  })
  const frozenDuration =
    complete && completion.complete ? completion.duration : workDurationMs
  const presentation = deriveAssistantInlineWork(view, phase, {
    workDurationMs: frozenDuration,
    reasoningDurationMs,
    status,
  })
  const [open, setOpen] = useState(false)
  const [disclosureCycle, setDisclosureCycle] = useState(0)
  const reducedMotion = useReducedMotion()
  const animate = !isReplaying && !reducedMotion
  const visuallyComplete = presentation.mode === "complete"
  // Freeze work before answer streaming and discard any earlier manual opening.
  if (completion.complete !== complete) {
    setCompletion({ complete, duration: workDurationMs })
    setOpen(false)
  }
  const changeOpen = (nextOpen: boolean) => {
    if (nextOpen && !open) setDisclosureCycle((value) => value + 1)
    setOpen(nextOpen)
  }
  const opaque = deriveAssistantActivityPresentation(view, phase, {
    workDurationMs: frozenDuration,
    reasoningDurationMs,
    status,
  })
  if (!visuallyComplete)
    return (
      <div
        data-slot="assistant-inline-work"
        data-inline-work-live
        aria-busy={phase.kind !== "awaiting-approval"}
        className="flex min-h-8 flex-col gap-4"
      >
        <WorkItems
          items={presentation.items}
          live
          animate={animate}
          onOpenActivity={onOpenActivity}
          activeTail={presentation.activeTail}
        />
      </div>
    )
  if (!presentation.hasWork) return null
  if (presentation.items.length === 0)
    return opaque.kind === "disclosure" && onOpenActivity ? (
      <ActivityPanelTrigger
        open={activityOpen}
        controlsId={activityControlsId}
        onOpenChange={onActivityOpenChange ?? onOpenActivity}
        presentation={opaque}
      />
    ) : (
      <StatusText
        label={opaque.kind === "none" ? presentation.label : opaque.label}
        shimmer={false}
        className="text-[var(--text-tertiary)]"
      />
    )
  return (
    <Collapsible
      open={open}
      onOpenChange={changeOpen}
      data-slot="assistant-inline-work"
    >
      <CollapsibleTrigger className="focus-visible:ring-focus-ring hover:text-foreground flex items-center gap-1 text-base leading-6 font-normal text-[var(--text-tertiary)] outline-none focus-visible:ring-2">
        {presentation.label}
        <Icon
          icon={RiArrowRightSLine}
          slotSize={16}
          glyphInset={0}
          className={cn(CHEVRON, open && "rotate-90")}
        />
      </CollapsibleTrigger>
      <InlineWorkDisclosure>
        <div key={disclosureCycle} className="flex flex-col gap-4 pt-4">
          <WorkItems
            items={presentation.items}
            live={false}
            animate={false}
            onOpenActivity={onOpenActivity}
          />
        </div>
      </InlineWorkDisclosure>
    </Collapsible>
  )
}
