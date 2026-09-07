/**
 * Based on prompt-kit: https://prompt-kit.com/docs/code-block
 * Local contracts: theme-driven highlighting, app-surface backgrounds, and a
 * plain SSR fallback before the highlighter is ready.
 */
"use client"

import { highlightCode } from "@/lib/markdown/shiki-client"
import {
  isChatPerfClientEnabled,
  markChatPerf,
} from "@/lib/observability/chat-performance"
import { cn } from "@/lib/utils"
import { useTheme } from "next-themes"
import React, { useEffect, useRef, useState } from "react"

export type CodeBlockProps = {
  children?: React.ReactNode
  className?: string
} & React.HTMLProps<HTMLDivElement>

function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  // Source-fidelity box: 24px radius and asymmetric flow margins. The derived
  // 3xl token is 22px, so the literal radius is intentional.
  return (
    <div
      className={cn(
        "not-prose relative mt-4 mb-1 flex w-full flex-col overflow-clip border",
        "border-border bg-card text-card-foreground rounded-[24px]",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export type CodeBlockCodeProps = {
  code: string
  language?: string
  className?: string
  /**
   * True only for the terminal code block of a live message, as classified in
   * `components/ui/markdown.tsx`. Growing blocks render changed code as
   * escaped plain text immediately. Highlight only when the block becomes
   * non-terminal or the message settles.
   */
  growing?: boolean
} & React.HTMLProps<HTMLDivElement>

function CodeBlockCode({
  code,
  language = "tsx",
  className,
  growing = false,
  ...props
}: CodeBlockCodeProps) {
  const { resolvedTheme: appTheme } = useTheme()
  const theme = appTheme === "dark" ? "github-dark" : "github-light"
  const [highlighted, setHighlighted] = useState<{
    code: string
    language: string
    theme: "github-dark" | "github-light"
    html: string
  } | null>(null)

  // Stale async completions are invalidated by generation token in addition
  // to the exact tuple carried by `highlighted`; unmount and every input
  // change cancel obsolete work waiting on shared module loads.
  const generationRef = useRef(0)

  useEffect(() => {
    const generation = ++generationRef.current
    let cancelled = false
    // Provider pauses do not make an unfinished block stable.
    if (!code || growing) return
    const controller = new AbortController()

    const runHighlight = async () => {
      try {
        // Lazy service (ADR-0016 "Lazy Shiki"): Shiki core, themes, and the
        // grammar for this language load on first demand; unknown/plain ids
        // resolve to the grammar-less `text` language inside the service.
        // Includes first-use grammar/theme loading; records duration only.
        const highlightStartedAt = isChatPerfClientEnabled()
          ? performance.now()
          : null
        const html = await highlightCode({
          code,
          language,
          theme,
          signal: controller.signal,
        })
        if (highlightStartedAt !== null) {
          markChatPerf("shiki_highlight", {
            durationMs: performance.now() - highlightStartedAt,
          })
        }
        if (cancelled || generation !== generationRef.current) return
        setHighlighted({ code, language, theme, html })
      } catch {
        // Module or grammar loading failed: keep the React-escaped plain
        // fallback for this tuple; a later input change retries.
      }
    }

    void runHighlight()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [code, language, theme, growing])

  // Captured code text metrics: 14px / 24px (0.875em at 1.71429), 20px inline
  // padding, 12px block padding; the container's card surface shows through.
  const classNames = cn(
    "w-full overflow-x-auto text-sm leading-6 [&>pre]:px-5 [&>pre]:py-3 [&>pre]:!bg-transparent",
    className
  )

  // Render highlighted HTML only for the exact current tuple. A code,
  // language, or theme change therefore exposes the new canonical code
  // immediately through the escaped plain fallback while older async work
  // becomes obsolete.
  const showHighlighted =
    !growing &&
    highlighted !== null &&
    highlighted.code === code &&
    highlighted.language === language &&
    highlighted.theme === theme &&
    Boolean(code)

  // Plain path doubles as the SSR/pre-highlight fallback: React-escaped text
  // in the same wrapper, so `<script>`-like content renders as text.
  return showHighlighted ? (
    <div
      className={classNames}
      dangerouslySetInnerHTML={{ __html: highlighted.html }}
      {...props}
    />
  ) : (
    <div className={classNames} {...props}>
      <pre>
        <code>{code ?? ""}</code>
      </pre>
    </div>
  )
}

export type CodeBlockGroupProps = React.HTMLAttributes<HTMLDivElement>

function CodeBlockGroup({
  children,
  className,
  ...props
}: CodeBlockGroupProps) {
  return (
    <div
      className={cn("flex items-center justify-between", className)}
      {...props}
    >
      {children}
    </div>
  )
}

export { CodeBlockGroup, CodeBlockCode, CodeBlock }
