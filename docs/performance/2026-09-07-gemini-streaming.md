# Gemini 3.5 Flash streaming comparison

Status: the initial experiment was withdrawn while the shared path was audited.
After renderer fixes, authenticated browser checks, and a direct-Google versus
OpenRouter experiment, direct Gemini 3.5 Flash now reuses the existing canonical
word transform without new timing constants. The captures below remain historical;
current verification is in the [shared streaming audit](2026-09-07-shared-streaming-audit.md).

## Scope and method

Compare authenticated Chrome at `https://t3.chat` (Gemini 3.5 Flash,
Instant) and the existing `http://localhost:3002` development server
(Gemini 3.5 Flash, Minimal). Use the same prompt in fresh chats, foreground
tabs, and matching 2560 × 1296 CSS viewports at DPR 2. Generated wording and
provider load can vary; separate first-visible latency, output throughput,
and the size/cadence of visible text updates.

Browser evidence uses sampled screenshots and short, read-only DOM sampling
windows. It cannot establish continuous visual smoothness across capture
gaps. Compare growth only between adjacent samples less than 100 ms apart;
do not count gaps between sampling windows as renderer stalls. First-text
and completion timestamps inferred from samples are bounds, not exact
events. Server traces independently record text-delta lengths and elapsed
arrival/release times, without prompt or response content.

## Source findings and approach

- The client publishes the canonical AI SDK message store at most once per
  browser frame (`lib/chat-performance/message-throttle.ts`). It has no fixed
  50 ms notification throttle to remove.
- `app/api/chat/word-chunking-transform.ts` already reconstructs word-like
  segments and adaptively paces coarse incoming chunks. Before this change,
  eligibility covered only direct Claude Haiku 4.5. Gemini bypassed it.
- The initial experiment extended ADR-0016's measured-provider escape hatch.
  The subsequent review rejected burst size alone as sufficient evidence for
  expanding pacing. Shared-path measurement now precedes any extension; see
  [the shared streaming audit](2026-09-07-shared-streaming-audit.md).
- A second client text queue would duplicate canonical message state and
  terminal handling. LobeHub's local `packages/fetch-sse/src/fetchSSE.ts`
  illustrates that alternative; ADR-0016 already rejects it for this app.
  Vercel Chatbot's direct stream and LibreChat's presentation fade do not
  establish T3's current implementation.
- The official [AI SDK smoothing reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/smooth-stream)
  documents word buffering and configurable delays. The app's existing
  adaptive transform also bounds intentional delay and handles execution
  cancellation; no new dependency is needed.

## Results

- Raw direct Google baseline: 30 text deltas, 3,203 characters; median 117
  characters per delta and 180 ms between deltas, maximum gap 259 ms. Released
  chunks matched incoming chunks. This establishes provider burstiness for that
  run, not a client rendering defect.
- Experimental paced run: 29 raw deltas became 513 released deltas. Median
  released size was 6 characters and median gap 9 ms. First-release overhead was
  about 2 ms in that run; the final nonempty text trailed incoming text by about
  292 ms. This changed delivery cadence, not provider generation speed.
- A separate synthetic replay of the measured arrival cadence preserved all
  3,203 characters, with maximum added character lag 289 ms and completion tail
  268 ms. It cannot establish browser smoothness.
- Dense sampled UI repeats observed T3's final text at 8.857 s and the
  experimental local response at 6.941 s, but generated text differed and
  sampling gaps reached 344/741 ms. Neither timing nor successful video encoding
  establishes continuous visual parity.

Raw traces remain under `/tmp/naw-gemini-*`; sampled source captures remain under
`/tmp/gemini-streaming-20260907/`. The comparison agent's composites and manifests
are under the session's `gemini-streaming/` visualization directory. Treat these
as diagnostic artifacts from the withdrawn experiment.
