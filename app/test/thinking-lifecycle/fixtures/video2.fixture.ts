import type { UIMessage } from "ai"
import sources from "./video2-sources.json"

type Part = UIMessage["parts"][number]
export type Video2Frame = {
  at: number
  label: string
  parts: Part[]
  status: "streaming" | "ready"
}

// Public text from the second supplied recording. Times are video timestamps,
// aligned to the first visible Thinking at 2s. Chunk boundaries are visual samples.
const narratives = [
  "I’m scanning today’s VC/tech headlines, then I’ll filter for what’s actually useful to a founder/designer: funding signals, product/design shifts, and AI-native company moves.",
  "A few themes are already clear: capital is concentrating into **frontier AI + infrastructure**, while the most interesting product shift for designers is toward **agents embedded directly inside creative workflows**, not separate “AI tools.”",
  "The founder-side signal is more interesting than the raw funding totals: investors are funding both **AI capability** and the new “control layers” around it—compliance, brand governance, workflow orchestration, and vertical agents.",
]
const answer =
  "Yes—**September 8 is a pretty consequential AI/VC day.** After filtering out the noise, these are the developments I’d pay attention to as a founder/designer.\n\n### 💰 VC / startup news that matters\n\n- **Cognition raised more than $2B at a $48B valuation.** The company behind Devin says annualized revenue has jumped from about $492M in May to roughly **$900M now**. That is probably today’s most important venture datapoint: investors are treating autonomous coding agents as a massive new software category, not merely a feature of IDEs.\n\n- **Mistral raised €3B (~$3.5B) at roughly a $24B valuation**, nearly doubling its valuation in a year. It’s also expanding beyond models toward data-center infrastructure. The interesting signal is that investors are assigning substantial value to **model/provider independence and sovereign AI**, even when a company isn’t necessarily winning every benchmark."

export function video2Frames(nativeReasoning: boolean): Video2Frame[] {
  const history: Part[] = []
  const frames: Video2Frame[] = []
  const add = (time: number, label: string, parts: Part[]) => {
    frames.push({ at: time - 2, label, parts: [...parts], status: "streaming" })
  }
  const narrative = (text: string, state: "streaming" | "done"): Part =>
    nativeReasoning
      ? { type: "reasoning", text, state }
      : {
          type: "text",
          text,
          state,
          providerMetadata: { openai: { phase: "commentary" } },
        }
  const search = (index: number, done: boolean): Part => ({
    type: "tool-web_search",
    toolCallId: `video2-search-${index}`,
    input: {
      query: [
        "venture capital tech news today",
        "AI startup funding September 8 2026",
        "AI founder designer news today",
      ][index],
    },
    ...(done
      ? { state: "output-available", output: { sources: sources[index] } }
      : { state: "input-available" }),
  })
  const appendNarrative = (index: number, start: number, end: number) => {
    const text = narratives[index]
    const chunks = Math.ceil(text.length / 32)
    for (let i = 1; i <= chunks; i++) {
      add(
        start + ((end - start) * (i - 1)) / (chunks - 1),
        `Paragraph ${index + 1} streaming`,
        [...history, narrative(text.slice(0, i * 32), "streaming")]
      )
    }
    history.push(narrative(text, "done"))
    add(end + 0.1, `Thinking after paragraph ${index + 1}`, history)
  }
  const appendSearch = (index: number, start: number, end: number) => {
    add(start, `Search ${index + 1} starts`, [...history, search(index, false)])
    add(start + 0.5, `Search ${index + 1} running`, [
      ...history,
      search(index, false),
      ...sources[index].map((source, i): Part => ({
        type: "source-url",
        sourceId: `video2-source-${index}-${i}`,
        ...source,
        providerMetadata: { openai: { toolCallId: `video2-search-${index}` } },
      })),
    ])
    history.push(search(index, true))
    add(end, `Search ${index + 1} complete`, history)
  }
  const summary = (text: string, state: "streaming" | "done"): Part => ({
    type: "reasoning",
    text: `**${text}**`,
    state,
  })
  add(2, "Initial Thinking", [])
  appendNarrative(0, 7.2, 7.8)
  appendSearch(0, 10.8, 16.7)
  appendNarrative(1, 17.0, 18.0)
  appendSearch(1, 19.4, 38.2)
  add(38.5, "Reviewing technology updates", [
    ...history,
    summary("Reviewing technology updates", "streaming"),
  ])
  add(43, "Reviewed technology updates", [
    ...history,
    summary("Reviewed technology updates", "done"),
  ])
  appendNarrative(2, 45.8, 46.8)
  appendSearch(2, 48.0, 57.5)
  add(58, "Synthesizing startup news", [
    ...history,
    summary("Synthesizing startup news", "streaming"),
  ])
  add(67, "Synthesized startup news", [
    ...history,
    summary("Synthesized startup news", "done"),
  ])
  for (let i = 1; i <= 70; i++) {
    add(69 + ((85.8 - 69) * (i - 1)) / 69, "Final answer streaming", [
      ...history,
      {
        type: "text",
        text: answer.slice(0, Math.ceil((answer.length * i) / 70)),
        state: "streaming",
        providerMetadata: { openai: { phase: "final_answer" } },
      },
    ])
  }
  // The source video ends during generation. This extra state is labeled separately.
  frames.push({
    at: 85,
    label: "Post-video completion",
    parts: [
      ...history,
      {
        type: "text",
        text: answer,
        state: "done",
        providerMetadata: { openai: { phase: "final_answer" } },
      },
    ],
    status: "ready",
  })
  return frames
}
