import type { UIMessage } from "ai"
import firstSources from "./first-sources.json"
import nativeCapture from "./native-capture.json"
import secondSources from "./second-sources.json"

// Public reference content from the supplied video; never sent to a provider.
export const REFERENCE_PROMPT =
  "Please research what happened in venture capital tech news today? Any design related things I should know about? Any AI specific founder/designer things I should know about?"
export const FIRST_COMMENTARY =
  "I’m pulling together three lenses for today: **VC/funding & startup moves**, **design/product news**, and **AI-specific signals for founders/designers**. I’ll prioritize what changed today and what’s actually actionable rather than just listing headlines."
export const SECOND_COMMENTARY =
  "A pattern is already clear: **AI capital is still enormous, but investors are getting more selective about what counts as real value.** The strongest stories today cluster around infrastructure, regulated verticals, and products with workflow/data moats—not generic “AI wrapper” narratives."
export const FINAL_ANSWER =
  "Here’s the tech/VC briefing for **Tuesday, September 8, 2026, as of ~4:10 PM ET**. There are a few developments today that are unusually relevant to someone sitting at the intersection of **design + AI + company-building**.\n\n### The 8 things I’d pay attention to\n\n1. **Mistral just raised €3B at a €21B+ valuation.** Samsung led the Series D alongside EQT’s Scaleup Europe Fund and PSG Equity. It’s reportedly the largest equity financing ever for a private European tech company. Mistral says the capital goes toward frontier research, compute, infrastructure and international expansion.\n\n   The important part isn't merely the giant valuation. Investors are putting a strategic premium on **sovereign/open-weight AI infrastructure** that offers an alternative to OpenAI, Anthropic and Chinese labs. AI is increasingly becoming geopolitical infrastructure rather than merely software.\n\n2. **Amazon made a massive strategic bet on Qualcomm's AI chips.** Amazon could purchase up to **$60B of Qualcomm AI data-center products**, while Qualcomm granted Amazon warrants worth roughly $4B. Qualcomm is explicitly trying to become another serious supplier alongside Nvidia and other custom silicon providers."

type Part = UIMessage["parts"][number]
const commentary = (
  text: string,
  state: "streaming" | "done" = "done"
): Part => ({
  type: "text",
  text,
  state,
  providerMetadata: { openai: { phase: "commentary" } },
})
const search = (
  id: string,
  complete: boolean,
  sources: typeof firstSources
): Part =>
  complete
    ? {
        type: "tool-web_search",
        toolCallId: id,
        state: "output-available",
        input: {
          query:
            "venture capital tech news September 8 2026 startup funding AI deals",
        },
        output: { sources },
      }
    : {
        type: "tool-web_search",
        toolCallId: id,
        state: "input-available",
        input: {
          query:
            "venture capital tech news September 8 2026 startup funding AI deals",
        },
      }

const sourceParts = (id: string, sources: typeof firstSources): Part[] =>
  sources.map((source, index) => ({
    type: "source-url",
    sourceId: `${id}-${index}`,
    ...source,
    providerMetadata: { openai: { toolCallId: id } },
  }))

const first = commentary(FIRST_COMMENTARY)
const second = commentary(SECOND_COMMENTARY)
const firstSearch = search("fixture-search-first", true, firstSources)
const secondSearch = search("fixture-search-second", true, secondSources)
const history: Part[] = [
  first,
  firstSearch,
  { type: "step-start" },
  second,
  secondSearch,
]
const finalPart: Part = {
  type: "text",
  text: FINAL_ANSWER,
  state: "done",
  providerMetadata: { openai: { phase: "final_answer" } },
}

export const LIFECYCLE_STAGES = [
  { label: "Initial Thinking", parts: [], status: "streaming" },
  { label: "First commentary", parts: [first], status: "streaming" },
  {
    label: "First search query",
    parts: [first, search("fixture-search-first", false, [])],
    status: "streaming",
  },
  {
    label: "First search running",
    parts: [
      first,
      search("fixture-search-first", false, []),
      ...sourceParts("fixture-search-first", firstSources),
    ],
    status: "streaming",
  },
  {
    label: "First search complete",
    parts: [first, firstSearch],
    status: "streaming",
  },
  {
    label: "Second commentary",
    parts: [first, firstSearch, { type: "step-start" }, second],
    status: "streaming",
  },
  {
    label: "Second search running",
    parts: [
      first,
      firstSearch,
      { type: "step-start" },
      second,
      search("fixture-search-second", false, []),
      ...sourceParts("fixture-search-second", secondSources),
    ],
    status: "streaming",
  },
  { label: "Second search complete", parts: history, status: "streaming" },
  {
    label: "Reasoning resumes",
    parts: [
      ...history,
      {
        type: "reasoning",
        text: "**Focusing on the roundup**",
        state: "streaming",
      },
    ],
    status: "streaming",
  },
  {
    label: "Final answer starts",
    parts: [
      ...history,
      { ...finalPart, text: FINAL_ANSWER.slice(0, 110), state: "streaming" },
    ],
    status: "streaming",
  },
  {
    label: "Final answer streaming",
    parts: [...history, { ...finalPart, state: "streaming" }],
    status: "streaming",
  },
  { label: "Completed", parts: [...history, finalPart], status: "ready" },
  { label: "Stopped during work", parts: history, status: "aborted" },
  { label: "Failed during work", parts: history, status: "failed" },
  {
    label: "Opaque reasoning",
    parts: [{ type: "reasoning", text: "", state: "streaming" }],
    status: "streaming",
  },
] satisfies {
  label: string
  parts: Part[]
  status: "streaming" | "ready" | "aborted" | "failed"
}[]

// Original video starts Thinking at 3.7s; replay uses that as zero.
// Discrete checkpoints preserve lifecycle timing, not individual text deltas.
export const VIDEO_STAGE_TIMES = [
  0, 4.4, 5.8, 7.8, 25, 25.9, 28.8, 32.7, 32.8, 37.6, 38.6, 55,
]

// Small SDK-shaped deltas expose line-growth motion between lifecycle checkpoints.
export const STREAMED_COMMENTARY_STAGES = Array.from(
  { length: Math.ceil(FIRST_COMMENTARY.length / 20) },
  (_, index) => ({
    label: "Streamed commentary",
    parts: [
      commentary(FIRST_COMMENTARY.slice(0, (index + 1) * 20), "streaming"),
    ],
    status: "streaming" as const,
  })
)
export const COMMENTARY_CHUNK_INTERVAL_MS = 200

// Reproduce a final reasoning burst followed immediately by answer deltas.
const handoffThought =
  "I have checked the sources and compared their dates. The final thought must finish revealing before this work collapses."
export const HANDOFF_STAGES = [
  { atMs: 0, text: handoffThought.slice(0, 28) },
  { atMs: 100, text: handoffThought.slice(0, 70) },
  { atMs: 180, text: handoffThought, answer: "" },
  { atMs: 220, text: handoffThought, answer: "Here is the answer." },
  {
    atMs: 280,
    text: handoffThought,
    answer:
      "Here is the answer. It keeps streaming while the final thought finishes its reveal.",
  },
].map(({ atMs, text, answer }) => ({
  atMs,
  label: "Fast reasoning handoff",
  status: "streaming" as const,
  parts: [
    ...history,
    commentary(text, answer === undefined ? "streaming" : "done"),
    ...(answer === undefined
      ? []
      : [{ ...finalPart, text: answer, state: "streaming" }]),
  ] as Part[],
}))

// Observed sampled ChatGPT deltas, not simulated provider timing.
export const NATIVE_CAPTURE_STAGES = [
  {
    atMs: 0,
    label: "Captured Thinking",
    parts: [] as Part[],
    status: "streaming" as const,
  },
  ...nativeCapture.events.map((event) => ({
    atMs: event.atMs,
    label: "Captured live work",
    parts: [
      ...(event.text ? [commentary(event.text, "streaming")] : []),
      ...(event.search
        ? [
            search("native-search", false, []),
            ...sourceParts("native-search", firstSources.slice(0, event.count)),
          ]
        : []),
    ],
    status: "streaming" as const,
  })),
  ...[
    "Today,",
    "Today, the biggest signals for founders and designers are in AI.",
  ].map((text, index) => ({
    atMs: nativeCapture.finalAtMs + index * 500,
    label: "Captured final boundary",
    parts: [
      commentary(nativeCapture.events.at(-1)!.text),
      search("native-search", true, firstSources.slice(0, 10)),
      {
        ...finalPart,
        text,
        state: index ? ("done" as const) : ("streaming" as const),
      },
    ],
    status: index ? ("ready" as const) : ("streaming" as const),
  })),
]
