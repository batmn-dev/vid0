"use client"

import { MessageContent } from "@/components/ui/message"
import { useReducedMotion } from "motion/react"
import { Component, createRef, memo } from "react"

type NarrativeProps = {
  text: string
  streaming: boolean
  animate: boolean
}

type PaintSnapshot = {
  paint: HTMLDivElement
  height: number
  opacityTime: number | null
}

function afterTwoFrames(callback: () => void) {
  let frame = window.requestAnimationFrame(() => {
    frame = window.requestAnimationFrame(callback)
  })
  return () => window.cancelAnimationFrame(frame)
}

// Exit activation waits two frames, so retention is frame-bound: a long
// reasoning stream at one text update per frame keeps only a handful of paint
// clones alive. Above this many the oldest is released at once. It guards the
// visible-tab case where layout starves frames; the hidden-tab case (no frames
// at all) skips capture entirely because nothing paints there.
const MAX_RETAINED_SNAPSHOTS = 6

// Capture the committed DOM before React updates it; the Markdown tree itself
// remains mounted. Only the empty snapshot host is managed imperatively.
class NarrativePaint extends Component<
  NarrativeProps,
  Record<string, never>,
  PaintSnapshot | null
> {
  private frame = createRef<HTMLDivElement>()
  private current = createRef<HTMLDivElement>()
  private snapshots = createRef<HTMLDivElement>()
  private observer?: ResizeObserver
  private opacityAnimation?: Animation
  private opacityHold?: Animation
  private cancelEnter?: () => void
  private cancelLayoutComplete?: () => void
  private targetHeight = 0
  private snapshotAnimations = new Map<HTMLDivElement, Animation>()
  private cleanupTimers = new Map<HTMLDivElement, number>()
  private pendingExits = new Map<HTMLDivElement, () => void>()

  private canAnimate() {
    return (
      this.props.animate && typeof this.current.current?.animate === "function"
    )
  }

  componentDidMount() {
    const current = this.current.current
    if (!current) return
    this.targetHeight = current.getBoundingClientRect().height
    document.addEventListener("visibilitychange", this.handleVisibilityChange)
    if (this.canAnimate()) {
      this.scheduleEnter(0, 260)
      this.observeCurrent()
    }
  }

  // Frames never come while the document is hidden, so retained clones would
  // only pile up (each one is the whole narrative). Release them now; the
  // canonical tree stays put and animates fresh on the next visible update.
  private handleVisibilityChange = () => {
    if (document.hidden) this.releaseSnapshots()
  }

  private releaseSnapshot(paint: HTMLDivElement) {
    this.pendingExits.get(paint)?.()
    this.pendingExits.delete(paint)
    const timer = this.cleanupTimers.get(paint)
    if (timer !== undefined) window.clearTimeout(timer)
    this.cleanupTimers.delete(paint)
    this.snapshotAnimations.get(paint)?.cancel()
    this.snapshotAnimations.delete(paint)
    paint.remove()
  }

  private releaseSnapshots() {
    const host = this.snapshots.current
    if (!host) return
    for (const paint of Array.from(host.children))
      this.releaseSnapshot(paint as HTMLDivElement)
  }

  private observeCurrent() {
    const current = this.current.current
    if (current && !this.observer && typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => {
        if (this.cancelEnter) return
        const height = current.clientHeight
        if (height === this.targetHeight) return
        this.targetHeight = height
        const frame = this.frame.current
        if (this.canAnimate() && frame?.style.height) {
          frame.style.transitionDelay = "0ms"
          frame.style.height = `${height}px`
        }
      })
      this.observer.observe(current)
    }
  }

  getSnapshotBeforeUpdate(previous: NarrativeProps): PaintSnapshot | null {
    const current = this.current.current
    if (
      !this.canAnimate() ||
      !previous.animate ||
      previous.text === this.props.text ||
      document.hidden ||
      !current
    )
      return null
    const paint = current.cloneNode(true) as HTMLDivElement
    paint.removeAttribute("data-inline-work-current")
    paint.setAttribute("data-inline-work-snapshot", "")
    paint.setAttribute("aria-hidden", "true")
    paint.inert = true
    paint.style.opacity = "1"
    paint.style.position = "absolute"
    paint.style.top = "0"
    paint.style.left = "0"
    for (const node of paint.querySelectorAll("[id]"))
      node.removeAttribute("id")
    return {
      paint,
      opacityTime:
        typeof this.opacityAnimation?.currentTime === "number"
          ? this.opacityAnimation.currentTime
          : null,
      height:
        this.frame.current?.getBoundingClientRect().height ?? this.targetHeight,
    }
  }

  componentDidUpdate(
    _previous: NarrativeProps,
    _state: Record<string, never>,
    snapshot: PaintSnapshot | null
  ) {
    if (!this.canAnimate()) {
      this.observer?.disconnect()
      this.observer = undefined
      this.clearPaint()
      this.targetHeight =
        this.current.current?.getBoundingClientRect().height ??
        this.targetHeight
      return
    }
    if (!_previous.animate)
      this.targetHeight =
        this.current.current?.getBoundingClientRect().height ??
        this.targetHeight
    this.observeCurrent()
    if (!snapshot) return
    const host = this.snapshots.current
    while (host && host.children.length >= MAX_RETAINED_SNAPSHOTS)
      this.releaseSnapshot(host.children[0] as HTMLDivElement)
    host?.appendChild(snapshot.paint)
    // Interrupted incoming snapshots continue their original fade while retained.
    if (snapshot.opacityTime !== null) {
      const fade = snapshot.paint.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 700,
        easing: "ease",
        fill: "both",
      })
      fade.currentTime = snapshot.opacityTime
      this.snapshotAnimations.set(snapshot.paint, fade)
    }
    this.pendingExits.set(
      snapshot.paint,
      afterTwoFrames(() => {
        this.pendingExits.delete(snapshot.paint)
        this.cleanupTimers.set(
          snapshot.paint,
          window.setTimeout(() => this.releaseSnapshot(snapshot.paint), 300)
        )
      })
    )
    this.scheduleEnter(snapshot.height, 0)
  }

  private scheduleEnter(height: number, delay: number) {
    this.cancelEnter?.()
    this.cancelLayoutComplete?.()
    this.cancelLayoutComplete = undefined
    this.opacityAnimation?.cancel()
    this.opacityAnimation = undefined
    this.opacityHold?.cancel()
    // Keep CSS transitions enabled when retargeting an interrupted height;
    // the browser preserves its native reversal and shortening behavior.
    const frame = this.frame.current
    if (frame) {
      frame.style.transitionProperty = "height"
      frame.style.transitionDuration = "300ms"
      frame.style.transitionTimingFunction = "ease"
      frame.style.transitionDelay = `${delay}ms`
      frame.style.height = `${height}px`
    }
    this.opacityHold = this.current.current?.animate(
      [{ opacity: 0 }, { opacity: 0 }],
      { duration: 0, fill: "both" }
    )
    this.cancelEnter = afterTwoFrames(() => {
      this.cancelEnter = undefined
      this.targetHeight = this.current.current?.clientHeight ?? height
      if (frame) frame.style.height = `${this.targetHeight}px`
      this.opacityHold?.cancel()
      this.opacityHold = undefined
      this.fadeIncoming()
    })
  }

  private fadeIncoming() {
    this.opacityAnimation?.cancel()
    const animation = this.current.current?.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 700, easing: "ease", fill: "both" }
    )
    if (!animation) return
    this.opacityAnimation = animation
    animation.onfinish = () => {
      if (this.opacityAnimation !== animation) return
      animation.cancel()
      this.opacityAnimation = undefined
      this.cancelLayoutComplete = afterTwoFrames(() => {
        this.cancelLayoutComplete = undefined
        if (this.frame.current) this.frame.current.style.height = ""
      })
    }
  }

  private clearPaint() {
    this.cancelEnter?.()
    this.cancelEnter = undefined
    this.cancelLayoutComplete?.()
    this.cancelLayoutComplete = undefined
    this.opacityHold?.cancel()
    this.opacityHold = undefined
    this.opacityAnimation?.cancel()
    this.opacityAnimation = undefined
    const frame = this.frame.current
    if (frame) {
      frame.style.height = ""
      frame.style.transitionProperty = ""
      frame.style.transitionDuration = ""
      frame.style.transitionTimingFunction = ""
      frame.style.transitionDelay = ""
    }
    this.releaseSnapshots()
  }

  componentWillUnmount() {
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange
    )
    this.observer?.disconnect()
    this.clearPaint()
  }

  render() {
    return (
      <div
        ref={this.frame}
        className="relative w-full overflow-x-visible overflow-y-clip"
        data-inline-work-narrative
      >
        <div
          ref={this.snapshots}
          aria-hidden="true"
          inert
          className="pointer-events-none absolute inset-x-0 top-0"
        />
        <div
          ref={this.current}
          className="relative w-full"
          data-inline-work-current
        >
          <MessageContent
            markdown
            streaming={this.props.streaming}
            animateStreaming={false}
            className="markdown inline-work-narrative prose w-full bg-transparent p-0 text-base leading-6"
          >
            {this.props.text}
          </MessageContent>
        </div>
      </div>
    )
  }
}

export const InlineWorkNarrative = memo(function InlineWorkNarrative(
  props: NarrativeProps
) {
  const reducedMotion = useReducedMotion()
  return <NarrativePaint {...props} animate={props.animate && !reducedMotion} />
})
