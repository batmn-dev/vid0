/** @vitest-environment jsdom */
import React, { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { InlineWorkNarrative } from "./inline-work-narrative"

vi.mock("motion/react", () => ({ useReducedMotion: () => false }))
vi.mock("@/components/ui/message", () => ({
  MessageContent: ({
    children,
    animateStreaming,
  }: {
    children: React.ReactNode
    animateStreaming: boolean
  }) => (
    <p id="canonical-markdown" data-inner-animation={animateStreaming}>
      {children}
    </p>
  ),
}))

const container = document.createElement("div")
let root = createRoot(container)
const animations: {
  cancel: ReturnType<typeof vi.fn>
  onfinish: (() => void) | null
  currentTime: number
  target: Element
  keyframes: Keyframe[] | PropertyIndexedKeyframes | null
  options: number | KeyframeAnimationOptions | undefined
}[] = []
const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 0
let contentHeight = 24
let frameHeight = 0
let resized: (() => void) | undefined
const originalAnimate = Element.prototype.animate

beforeEach(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  animations.length = 0
  frames.clear()
  contentHeight = 24
  frameHeight = 0
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id))
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resized = callback
      }
      observe() {}
      disconnect() {
        resized = undefined
      }
    }
  )
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      return {
        height: this.hasAttribute("data-inline-work-current")
          ? contentHeight
          : frameHeight,
      } as DOMRect
    }
  )
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(
    () => contentHeight
  )
  Element.prototype.animate = vi.fn(function (
    this: Element,
    keyframes,
    options
  ) {
    const animation = {
      cancel: vi.fn(),
      onfinish: null,
      currentTime: 0,
      target: this,
      keyframes,
      options,
    }
    animations.push(animation)
    return animation as unknown as Animation
  })
})

afterEach(() => {
  act(() => root.unmount())
  root = createRoot(container)
  Element.prototype.animate = originalAnimate
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function render(text: string, animate = true) {
  act(() =>
    root.render(<InlineWorkNarrative text={text} streaming animate={animate} />)
  )
}

function frame() {
  const callbacks = [...frames.values()]
  frames.clear()
  act(() => callbacks.forEach((callback) => callback(0)))
}

function duration(animation: (typeof animations)[number]) {
  return typeof animation.options === "object"
    ? animation.options.duration
    : animation.options
}

it("keeps the canonical tree and an active snapshot's fade time through its two-frame exit activation", () => {
  render("Checking")
  frame()
  frame()
  const canonical = container.querySelector("#canonical-markdown")
  animations.find((animation) => duration(animation) === 700)!.currentTime = 175
  render("Checking sources.")
  expect(
    animations.find((animation) =>
      animation.target.hasAttribute("data-inline-work-snapshot")
    )?.currentTime
  ).toBe(175)
  expect(container.querySelector("#canonical-markdown")).toBe(canonical)
  expect(canonical?.textContent).toBe("Checking sources.")
  expect(canonical?.getAttribute("data-inner-animation")).toBe("false")
  const snapshot = container.querySelector<HTMLDivElement>(
    "[data-inline-work-snapshot]"
  )
  expect(snapshot?.textContent).toBe("Checking")
  expect(snapshot?.getAttribute("aria-hidden")).toBe("true")
  expect(snapshot?.inert).toBe(true)
  expect(container.querySelectorAll("#canonical-markdown")).toHaveLength(1)
  act(() => vi.advanceTimersByTime(300))
  expect(container.contains(snapshot)).toBe(true)
  frame()
  frame()
  act(() => vi.advanceTimersByTime(299))
  expect(container.contains(snapshot)).toBe(true)
  act(() => vi.advanceTimersByTime(1))
  expect(container.querySelector("[data-inline-work-snapshot]")).toBeNull()
})

it("cancels pre-active fades and retargets CSS height transitions after two frames", () => {
  render("Checking")
  const layout = container.querySelector<HTMLDivElement>(
    "[data-inline-work-narrative]"
  )!
  expect(layout.style.height).toBe("0px")
  expect(layout.style.transitionDelay).toBe("260ms")
  frame()
  frame()
  expect(layout.style.height).toBe("24px")
  frameHeight = 12
  contentHeight = 48
  render("Checking sources.")
  expect(layout.style.height).toBe("12px")
  expect(layout.style.transitionProperty).toBe("height")
  expect(layout.style.transitionDuration).toBe("300ms")
  expect(layout.style.transitionTimingFunction).toBe("ease")
  expect(layout.style.transitionDelay).toBe("0ms")
  contentHeight = 72
  act(() => resized?.())
  expect(layout.style.height).toBe("12px")
  render("Checking sources and dates.")
  const pendingSnapshot = container.querySelectorAll<HTMLDivElement>(
    "[data-inline-work-snapshot]"
  )[1]
  expect(pendingSnapshot.style.opacity).toBe("1")
  expect(
    animations.some((animation) => animation.target === pendingSnapshot)
  ).toBe(false)
  const fadeCount = animations.filter(
    (animation) => duration(animation) === 700
  ).length
  frame()
  expect(
    animations.filter((animation) => duration(animation) === 700)
  ).toHaveLength(fadeCount)
  frame()
  expect(
    animations.filter((animation) => duration(animation) === 700)
  ).toHaveLength(fadeCount + 1)
  expect(layout.style.height).toBe("72px")
  expect(animations.some((animation) => animation.target === layout)).toBe(
    false
  )
  act(() => animations.at(-1)?.onfinish?.())
  frame()
  expect(layout.style.height).toBe("72px")
  frame()
  expect(layout.style.height).toBe("")
  render("Another update pending activation.")
  act(() => root.unmount())
  root = createRoot(container)
  expect(frames.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  expect(
    animations.every((animation) => animation.cancel.mock.calls.length > 0)
  ).toBe(true)
})

it("captures no paint clones while the document is hidden and releases retained ones on hide", () => {
  // Exit activation is frame-bound and hidden documents get no frames: without
  // this, every text update of a long reasoning stream left a full clone of the
  // narrative in the DOM until the tab came back (101 clones, 1.2 MB of text).
  render("Checking")
  frame()
  frame()
  render("Checking sources.")
  expect(container.querySelectorAll("[data-inline-work-snapshot]")).toHaveLength(1)
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true)
  act(() => document.dispatchEvent(new Event("visibilitychange")))
  expect(container.querySelectorAll("[data-inline-work-snapshot]")).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
  render("Checking sources and dates.")
  render("Checking sources, dates and authors.")
  expect(container.querySelectorAll("[data-inline-work-snapshot]")).toHaveLength(0)
  expect(container.textContent).toBe("Checking sources, dates and authors.")
  hidden.mockReturnValue(false)
  render("Visible again.")
  expect(container.querySelectorAll("[data-inline-work-snapshot]")).toHaveLength(1)
})

it("caps retained paint clones when frames stall while visible", () => {
  render("0")
  frame()
  frame()
  // No frame runs between updates, so no exit activates; the host must not
  // grow past the cap and the oldest clone goes first.
  for (let i = 1; i <= 9; i++) render(`text ${i}`)
  const snapshots = container.querySelectorAll("[data-inline-work-snapshot]")
  expect(snapshots).toHaveLength(6)
  expect(snapshots[0].textContent).toBe("text 3")
  expect(snapshots[5].textContent).toBe("text 8")
  act(() => root.unmount())
  root = createRoot(container)
  expect(frames.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it("renders replay and history immediately and cancels pending activation when animation stops", () => {
  render("First", false)
  render("First and second", false)
  expect(container.textContent).toBe("First and second")
  expect(animations).toHaveLength(0)
  render("Streaming", true)
  render("Streaming more", true)
  expect(frames.size).toBeGreaterThan(0)
  render("Replay", false)
  const layout = container.querySelector<HTMLDivElement>(
    "[data-inline-work-narrative]"
  )!
  expect(layout.style.height).toBe("")
  expect(layout.style.transitionProperty).toBe("")
  expect(container.querySelector("[data-inline-work-snapshot]")).toBeNull()
  expect(frames.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})
