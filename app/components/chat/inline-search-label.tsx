"use client"

import { TextShimmer } from "@/components/ui/text-shimmer"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { StatusText } from "./activity/status-text"

const INHERITED_SHIMMER = { animation: "none", backgroundPosition: "inherit" }

export function InlineSearchLabel({
  title,
  running,
  animate,
}: {
  title: string
  running: boolean
  animate: boolean
}) {
  const reducedMotion = useReducedMotion()
  const numbers = [...title.matchAll(/\d+/g)]
  if (!running || !animate || reducedMotion || numbers.length !== 1)
    return (
      <StatusText label={title} shimmer={running} shimmerVariant="tertiary" />
    )

  const number = numbers[0]
  const count = number[0]
  const start = number.index ?? 0
  const before = title.slice(0, start)
  const after = title.slice(start + count.length)

  return (
    <span data-slot="inline-search-label">
      <span className="sr-only">{title}</span>
      <TextShimmer
        variant="tertiary"
        aria-hidden="true"
        className="relative inline-block self-start pb-0.5 text-base leading-6 font-normal tabular-nums select-none"
        style={{
          background: "none",
          WebkitTextFillColor: "inherit",
          animationDuration: "2s",
        }}
      >
        {/* Both full-width paint layers inherit one continuous shimmer phase. */}
        <TextShimmer
          variant="tertiary"
          className="whitespace-pre"
          style={INHERITED_SHIMMER}
        >
          {before}
          <span className="invisible">{count}</span>
          {after}
        </TextShimmer>
        <AnimatePresence initial={false}>
          <motion.span
            key={count}
            className="loading-shimmer-tertiary absolute inset-0 inline-block whitespace-pre"
            style={INHERITED_SHIMMER}
            initial={{ opacity: 0, y: 6 }}
            animate={{
              opacity: 1,
              y: 0,
              transition: {
                duration: 0.4,
                delay: 0.15,
                ease: [0.19, 1, 0.22, 1],
              },
            }}
            exit={{
              opacity: 0,
              y: -4,
              transition: { duration: 0.15, ease: [0.8, 0, 0.4, 1] },
            }}
          >
            <span className="invisible">{before}</span>
            {count}
            <span className="invisible">{after}</span>
          </motion.span>
        </AnimatePresence>
      </TextShimmer>
    </span>
  )
}
