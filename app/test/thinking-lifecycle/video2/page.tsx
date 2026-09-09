"use client"

import { MessageAssistant } from "@/app/components/chat/message-assistant"
import { useBrowserLayoutEffect } from "@/app/hooks/use-browser-layout-effect"
import { deriveAssistantTurnView } from "@/lib/chat-messages/assistant-turn"
import { useRef, useState } from "react"
import { REFERENCE_PROMPT } from "../fixtures/lifecycle.fixture"
import { video2Frames } from "../fixtures/video2.fixture"

export default function Video2Replay() {
  const [nativeReasoning, setNativeReasoning] = useState(false)
  const [frameIndex, setFrameIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [run, setRun] = useState(0)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  useBrowserLayoutEffect(() => () => timers.current.forEach(clearTimeout), [])
  const frames = video2Frames(nativeReasoning)
  const frame = frames[frameIndex]
  const final = frame.label.includes("answer") || frame.status === "ready"
  const view = deriveAssistantTurnView(
    {
      parts: frame.parts,
      metadata: {
        workDurationMs: 85000,
        ...(final ? { workSummaryDurationMs: 64000 } : {}),
      },
    },
    frame.status
  )
  const stop = () => {
    timers.current.forEach(clearTimeout)
    timers.current = []
    setPlaying(false)
  }
  const play = () => {
    stop()
    setFrameIndex(0)
    setRun((value) => value + 1)
    setPlaying(true)
    timers.current = frames.map((next, index) =>
      setTimeout(() => {
        setFrameIndex(index)
        if (index === frames.length - 1) setPlaying(false)
      }, next.at * 1000)
    )
  }
  return (
    <main className="bg-background text-foreground h-dvh overflow-y-auto">
      <nav
        aria-label="Video 2 replay"
        className="bg-background sticky top-0 z-10 flex items-center gap-3 border-b p-3 text-sm"
      >
        <button type="button" onClick={playing ? stop : play}>
          {playing ? "Stop replay" : "Replay video 2"}
        </button>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={nativeReasoning}
            onChange={(event) => {
              stop()
              setNativeReasoning(event.target.checked)
              setFrameIndex(0)
              setRun((value) => value + 1)
            }}
          />
          AI SDK reasoning parts
        </label>
        <select
          aria-label="Replay frame"
          value={frameIndex}
          onChange={(event) => {
            stop()
            setFrameIndex(Number(event.target.value))
          }}
        >
          {frames.map((next, index) => (
            <option key={index} value={index}>
              {(next.at + 2).toFixed(2)}s · {next.label}
            </option>
          ))}
        </select>
        <span>Sampled text boundaries · original elapsed timing</span>
      </nav>
      <div className="md:ml-[260px]">
        <div className="mx-auto w-full max-w-[800px] px-4 pt-[19px] pb-24">
          <div className="bg-secondary mb-10 ml-auto max-w-[70%] rounded-[22px] px-4 py-2.5 text-base leading-6">
            {REFERENCE_PROMPT}
          </div>
          <section
            key={run}
            aria-label="Assistant response"
            data-lifecycle-stage={frame.label}
          >
            <MessageAssistant
              view={view}
              messageId="fixture-video2"
              isLast
              status={frame.status}
              finishReason={frame.status === "ready" ? "stop" : undefined}
            >
              {view.text}
            </MessageAssistant>
          </section>
        </div>
      </div>
    </main>
  )
}
