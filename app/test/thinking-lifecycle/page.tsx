"use client"

import { MessageAssistant } from "@/app/components/chat/message-assistant"
import { useBrowserLayoutEffect } from "@/app/hooks/use-browser-layout-effect"
import { deriveAssistantTurnView } from "@/lib/chat-messages/assistant-turn"
import { useRef, useState } from "react"
import {
  COMMENTARY_CHUNK_INTERVAL_MS,
  HANDOFF_STAGES,
  LIFECYCLE_STAGES,
  NATIVE_CAPTURE_STAGES,
  REFERENCE_PROMPT,
  STREAMED_COMMENTARY_STAGES,
  VIDEO_STAGE_TIMES,
} from "./fixtures/lifecycle.fixture"

export default function ThinkingLifecyclePage() {
  const [replayStartedAt, setReplayStartedAt] = useState(0)
  const [nativeStageIndex, setNativeStageIndex] = useState<number | null>(null)
  const [stageIndex, setStageIndex] = useState(0)
  const [streamedStageIndex, setStreamedStageIndex] = useState<number | null>(
    null
  )
  const [playing, setPlaying] = useState(false)
  const [handoffStageIndex, setHandoffStageIndex] = useState<number | null>(
    null
  )
  const [run, setRun] = useState(0)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  useBrowserLayoutEffect(() => () => timers.current.forEach(clearTimeout), [])
  const stage =
    nativeStageIndex !== null
      ? NATIVE_CAPTURE_STAGES[nativeStageIndex]
      : handoffStageIndex !== null
        ? HANDOFF_STAGES[handoffStageIndex]
        : streamedStageIndex === null
          ? LIFECYCLE_STAGES[stageIndex]
          : STREAMED_COMMENTARY_STAGES[streamedStageIndex]
  const live = stage.status === "streaming"
  const view = deriveAssistantTurnView(
    {
      parts: stage.parts,
      metadata: {
        provider: "openai",
        workDurationMs: nativeStageIndex !== null ? 14000 : 55000,
        ...(nativeStageIndex !== null ? { workSummaryDurationMs: 14000 } : {}),
        ...([
          "Final answer starts",
          "Final answer streaming",
          "Completed",
        ].includes(stage.label)
          ? { workSummaryDurationMs: 36000 }
          : {}),
        ...(stage.status === "failed"
          ? { durableError: "Fixture interruption" }
          : {}),
      },
    },
    live ? "streaming" : "ready"
  )

  const stopPlayback = () => {
    timers.current.forEach(clearTimeout)
    timers.current = []
    setPlaying(false)
    setHandoffStageIndex(null)
    setNativeStageIndex(null)
  }
  const play = () => {
    stopPlayback()
    setStreamedStageIndex(null)
    setStageIndex(0)
    setRun((value) => value + 1)
    setPlaying(true)
    timers.current = VIDEO_STAGE_TIMES.map((seconds, index) =>
      setTimeout(() => {
        setStageIndex(index)
        if (index === VIDEO_STAGE_TIMES.length - 1) setPlaying(false)
      }, seconds * 1000)
    )
  }

  const playStreamedCommentary = () => {
    stopPlayback()
    setStageIndex(1)
    setStreamedStageIndex(0)
    setRun((value) => value + 1)
    setPlaying(true)
    timers.current = STREAMED_COMMENTARY_STAGES.slice(1).map((_, index) =>
      setTimeout(
        () => setStreamedStageIndex(index + 1),
        (index + 1) * COMMENTARY_CHUNK_INTERVAL_MS
      )
    )
    timers.current.push(
      setTimeout(
        () => {
          setStreamedStageIndex(null)
          setStageIndex(
            LIFECYCLE_STAGES.findIndex(
              (item) => item.label === "First search running"
            )
          )
          setPlaying(false)
        },
        STREAMED_COMMENTARY_STAGES.length * COMMENTARY_CHUNK_INTERVAL_MS + 400
      )
    )
  }

  return (
    <main
      id="main"
      data-replay-started-at={replayStartedAt}
      className="bg-background text-foreground h-dvh w-full overflow-y-auto"
    >
      <nav
        aria-label="Lifecycle replay"
        className="bg-background sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b p-3 text-sm"
      >
        <label htmlFor="lifecycle-stage">State</label>
        <select
          id="lifecycle-stage"
          value={stageIndex}
          onChange={(event) => {
            stopPlayback()
            setStreamedStageIndex(null)
            setStageIndex(Number(event.target.value))
          }}
        >
          {LIFECYCLE_STAGES.map((item, index) => (
            <option key={item.label} value={index}>
              {item.label}
            </option>
          ))}
        </select>
        <button type="button" onClick={playing ? stopPlayback : play}>
          {playing ? "Stop replay" : "Replay lifecycle"}
        </button>
        <button type="button" onClick={playStreamedCommentary}>
          Replay streamed commentary
        </button>
        <button
          type="button"
          onClick={() => {
            stopPlayback()
            setHandoffStageIndex(0)
            setRun((value) => value + 1)
            timers.current = HANDOFF_STAGES.slice(1).map((stage, index) =>
              setTimeout(() => setHandoffStageIndex(index + 1), stage.atMs)
            )
          }}
        >
          Replay fast commentary handoff
        </button>
        <button
          type="button"
          onClick={() => {
            stopPlayback()
            setReplayStartedAt(Date.now())
            setNativeStageIndex(0)
            setRun((value) => value + 1)
            timers.current = NATIVE_CAPTURE_STAGES.slice(1).map(
              (stage, index) =>
                setTimeout(() => setNativeStageIndex(index + 1), stage.atMs)
            )
          }}
        >
          Replay captured ChatGPT
        </button>
        <span>Deterministic reference fixture</span>
      </nav>
      <div className="md:ml-[260px]">
        <div className="mx-auto w-full max-w-[800px] px-4 pt-[19px] pb-24">
          <div className="bg-secondary mb-10 ml-auto max-w-[70%] rounded-[22px] px-4 py-2.5 text-base leading-6">
            {REFERENCE_PROMPT}
          </div>
          <section
            key={run}
            aria-label="Assistant response"
            data-lifecycle-stage={stage.label}
          >
            <MessageAssistant
              view={view}
              messageId="fixture-thinking-lifecycle"
              isLast
              status={stage.status}
              finishReason={live ? undefined : "stop"}
            >
              {view.text}
            </MessageAssistant>
          </section>
        </div>
      </div>
    </main>
  )
}
