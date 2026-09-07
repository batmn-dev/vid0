# 16. Streaming rendering: direct HTTP foreground, incremental projection, Convex durability

- Status: accepted (2026-07-27), amended (2026-07-31, 2026-09-07)
- Date: 2026-07-27
- Extended by ADR-0039: authenticated retained-stream replay feeds the same
  SDK rendering state after refresh. Saved text restores immediately; historical
  chunks reconstruct silently until caught up, and live chunks then retain
  their arrival cadence and existing paint treatment.
- Related: ADR-0009 (durable turn runtime — 750 ms snapshot cadence, unchanged),
  ADR-0011 (settlement, unchanged), ADR-0013 (back-navigation detach, unchanged),
  ADR-0015 (presentation reveal — superseded by this decision). Implementation
  and verification history lives in PRs #130 and #131.

## Context

Assistant responses must appear immediately, stay smooth as they grow, and
recover durably across navigation, reloads, tabs, and devices. Two prior
efforts shaped this decision. The 2026-07-23 chat-responsiveness work added a
50 ms AI SDK notification throttle and a 300 ms growing-code highlight
throttle because the renderer was intrinsically expensive: the full
accumulated Markdown was re-parsed on every displayed-text update, and Shiki
shipped statically with 35 eager grammars. PR #130 (ADR-0015) then attacked
the visible lumpiness of the 50 ms cadence with a presentation reveal — a
second, display-only prefix scheduler that faded words in above the throttle.

The 2026-07-27 streaming-architecture review rejected the reveal: it held
displayed text behind a second timer, wrapped every streamed word in DOM
spans, and treated renderer slowness as a presentation problem. The correct
order is to make the raw rendering path fast enough to present provider
deltas directly, then pick the simplest cadence.

## Decision

### Ownership model

```text
Initiating visible tab
Provider → direct HTTP stream → AI SDK local message state
         → incremental Markdown projection
         → stable memoized blocks + one bounded mutable region
         → lazy syntax highlighting at stable block boundaries

Durability and shared observation
Provider stream → durable snapshot writer (750 ms) → Convex
Convex → reactive run/message projection
       → navigation recovery, reload recovery, other tabs/devices, terminal truth
```

- The initiating tab's token-to-paint path never routes through Convex.
- AI SDK local message state is the single canonical in-memory text for the
  active stream. Presentation state is never persisted, and displayed
  settled content is exactly canonical content.
- Convex remains the durable, reactive coordination plane: periodic
  snapshots, run lifecycle, settlement receipts, approval recovery, and the
  projection every other surface (reload, second tab, other device) renders.

### Incremental Markdown projection (`lib/markdown/incremental-block-projection.ts`)

Ordinary append-only growth re-parses only the mutable tail TOGETHER with
the trailing stable context blocks (at least two, extended backward to a
blank-line-preceded block start). A blank line is deliberately NOT trusted
as a parser reset point — the 2026-07-27 review proved parser state crosses
it in this remark stack (an indented code block changes how the next block
parses; footnote definitions absorb later indented content). Correctness
rests on context reproduction: every re-parsed context block must come back
byte-identical, otherwise the update falls back to the authoritative full
parse with a counted `context-divergence` reason. Identity changes,
non-prefix corrections, and parser drift reset with all-new block
identities; settlement runs one authoritative full parse, verifies
equivalence against the incremental result, and freezes every block. Block
identities are monotonic per lineage, so completed blocks never re-key,
re-parse, or re-render during growth. The remark/unified pipeline stays the
single semantic authority; the legacy full splitter remains as the
reference implementation, reset/settlement path, and test oracle. A
30-fixture corpus — including the parser-state counterexamples — streams
char-by-char and at seeded random chunk boundaries, proving block-for-block
equality with the full parser at every prefix, and a rendered-DOM corpus
compares the streamed tree against a fresh authoritative mount at sampled
mid-stream prefixes and settlement. Anomalies (reset/fallback/
settle-mismatch) emit content-free marks.

### Lazy Shiki (`lib/markdown/shiki-client.ts`)

No static `shiki` import anywhere in client components. `shiki/core` + the
JavaScript regex engine (no WASM) + the two github themes load behind one
dynamic-import boundary on first demand; grammars load per-language from an
explicit typed allowlist of fine-grained `@shikijs/langs` modules. Unknown
languages render as escaped plain text. No-code conversations ship zero
Shiki bytes. Growing code is always displayed immediately as escaped plain
code. Every canonical code, language, or theme change invalidates highlighted
HTML. The terminal block of a streaming message stays plain until it becomes
non-terminal or the message settles; stable blocks highlight immediately.
Shiki may publish HTML only for the exact current tuple. Obsolete requests
abort before tokenization after asynchronous core/grammar loading, without
cancelling shared resource loads.

**Stable-boundary highlighting (2026-09-07).** Replaces the 150 ms inactivity
timer. A 40-update replay of a 12,243-character code block at 180/250 ms
intervals triggered 40 complete highlights (251,001 input characters), compared
with one final highlight at 50 ms intervals. Provider pauses repeatedly looked
like completion to that timer. Reuse the existing block-stability classification
instead of tuning another interval: unfinished terminal code remains readable
but uncolored during pauses. A closed terminal fence also waits for a following
block or settlement; no second fence parser or provider-specific rule is added.
The shared service skips stale work while loading, and current plain text never
waits for highlighting. Measurement limitations and validation are in the
[shared streaming audit](../performance/2026-09-07-shared-streaming-audit.md).

### Notification cadence

The accepted target is one frame-aligned message publication, implemented by
`useFrameAlignedChat`. AI SDK continues to update its `Chat.messages`
canonical snapshot for every stream part; the adapter coalesces only React's
message-subscriber notification with `requestAnimationFrame`. This follows
60 Hz, 90 Hz, 120 Hz, and variable-refresh displays instead of treating a
fixed 16 ms wall-clock interval as a frame. There is no displayed-text copy,
provider-specific client cadence, or feature flag.

Writes outside an active stream publish synchronously. Status and error keep
their own immediate subscriptions, and any transition out of `streaming`
flushes the latest message snapshot synchronously after cancelling the pending
frame. Terminal-ordering tests cover completion, Stop, transport error, and
approval pause and prove that no trailing notification survives settlement.
The historical 50/16 ms settings describe earlier implementations, not the
current architecture.

Production-browser selection evidence is recorded separately from this
architectural decision. A candidate build is not release-validated until the
normal and 4× CPU frame gates in the results document pass.

### Provider smoothing

`smoothStream()` is not used. It may be introduced only for a specific
provider/model that traces prove emits visually unacceptable bursts after
this client path, and never to conceal renderer slowness.

**Escape hatch exercised (2026-07-28; adaptive amendment 2026-07-31).** The
investigation found that direct Anthropic Haiku 4.5
(`claude-haiku-4-5-20251001`) emits ~90–430-char text slabs every ~100–400 ms,
which this client path faithfully paints as slabs. The implementation is
`createWordChunkingTransform` (`app/api/chat/word-chunking-transform.ts`) at
the server `streamText` seam — NOT the SDK's `smoothStream`, whose installed
version also delays reasoning deltas and holds timers across aborts. Runtime
eligibility is limited to measured provider/model pairs; every other
provider/model retains its raw text-delta behavior until equivalent traces
justify another entry. Once eligible, word-like segments are reconstructed
across arbitrary provider delta boundaries using `Intl.Segmenter`, so both one
large slab and many small deltas delivered in a network burst enter the same
pacing queue. Drain rate follows an exponential
arrival-rate estimate with 1.1× headroom; queue pressure accelerates it enough
to cap intentional lag at 400 ms. Word spacing normally stays between 5 and
80 ms. Already-slow complete, boundary-terminated word chunks avoid further
pacing when their next scheduled reveal time has already passed. An incomplete
terminal word is held for at most 80 ms to reconstruct cross-delta words
without making time-to-first-visible-text depend on the provider's next
boundary. The deadline is per held word: it arms on the word's first fragment,
is never extended by later fragments of the same word, and restarts only when a
completed word leaves the buffer — so a word that completes within its own
80 ms window is never flushed mid-word by a timer armed for an earlier word.

Text deltas only; non-text parts preserve their order behind preceding text.
Abort cancels all pacing immediately through the runtime execution signal,
drops both the queued suffix and any partial word, and emits the abort
terminal itself when the provider has already filled AI SDK's upstream queue.
That explicit terminal prevents a stopped mid-drain response from closing as
a successful completion.

Provider metadata is also a boundary: flush a held partial word before a new
metadata-bearing text delta. Preserve empty metadata events unchanged and in
order, without feeding them into the text-arrival estimate. This retains
Google's text-part thought signatures, including metadata sent without text.

**Shared responsiveness review (2026-09-07).** Provider burst size alone does
not justify expanding pacing. First separate provider arrival, server release,
browser receipt, and visible-content delay; measure first output, completion,
interaction responsiveness, and Stop under representative delivery shapes.
Preserve the shared canonical stream and frame-aligned client. Smoothing remains
an explicit latency/readability tradeoff, including the existing Haiku exception.
The experimental Gemini allowlist addition was withdrawn pending that evidence.
The completed audit removed repeated code highlighting, verified code/Stop/reload
in authenticated Chrome, and confirmed that raw Gemini prose remained coarse.
Two paired direct-Google/OpenRouter calls showed similarly large incoming chunks
on both routes, with OpenRouter slower in these samples. The measured direct
Google `gemini-3.5-flash` route therefore now uses the **existing** canonical
transform, with no new algorithm or Gemini-specific timing constants. This is
an explicit bounded latency/readability tradeoff supported by our measurements,
not a claim about Theo's private implementation. Other unmeasured routes retain
raw delivery. See the [shared streaming audit](../performance/2026-09-07-shared-streaming-audit.md)
and [Gemini experiment](../performance/2026-09-07-gemini-streaming.md).

### Growing single-block shapes (amendment, 2026-07-28)

The blank-line stable-boundary rule left one measured degradation class: a
block that never emits a blank line (a tight or blank-separated list, an
open fence) pins the restart boundary at its own start, so per-update parse
AND render cost grow with the block — quadratic over a stream, user-visible
as "word-by-word at first, chunky later" (live profile: late-half main-thread
busy 249 s vs early-half 1.7 s on a 300-item list). The parser and open-fence
renderer can be optimized without changing document semantics:

- **Parse: terminal-block line extension.** When appended lines provably
  continue the terminal `list`/`code` block (item-marker/lazy/indented
  continuation rules; open-fence interior with closer detection), the block
  record extends by a line scan with zero parse. Any unprovable line falls
  back to the existing authoritative paths, and settlement's equivalence
  check remains the net. The trailing PARTIAL line is included
  optimistically only while it could still extend the block — within that
  line the projection may partition differently from the parser (which
  itself repartitions such tails char by char); rendering is
  partition-invariant over the same bytes, and the settle check tolerates
  exactly this documented case (`blocksEquivalentModuloPartialTail`).
- **Render: direct fence, canonical lists.** A growing open fence renders its
  `CodeBlock` directly, mirroring the pipeline's DOM. Growing lists continue
  through one authoritative Markdown render. Splitting one source list into
  adjacent `<ol start>`/`<ul>` siblings can mimic sighted numbering, but it
  changes the document exposed to assistive technology, structural selectors,
  and rich selection-copy. Correct single-root semantics take precedence over
  the prior bounded list-render experiment. List parsing remains linearly
  extended by the fast path above; list rendering may still grow with the
  block until an optimization can memoize items beneath one parser-owned list
  root. Long single paragraphs retain the same documented limitation.

### Render-boundary tail mending (amendment, 2026-08-11)

A 2026-08-11 signed-in Chrome comparison used an assistant-scoped
MutationObserver, a chat-stream `fetch` tee, rAF and long-task observers, and a
100 ms text sampler. Across three mixed-Markdown Not A Wrapper runs
(4,865–7,367 visible characters, including one under approximately 75%
synthetic main-thread load), it recorded 15–23 raw trailing-delimiter windows
per response (`**`, `](`, `|` header rows); a 6,684-character list-only
control containing none of those constructs recorded zero. Windows lasted
100–500 ms and roughly doubled under load even though GPT-5 Mini delivery
remained fine-grained (11–37 ms median inter-chunk gaps across runs, 62–233
average bytes per chunk). An
emphasis-heavy reference control recorded 686 samples across 2,368 characters
and at least 45 inline emphasis constructs with zero raw inline-delimiter
hits. The gap was therefore a render property, not a transport property.

A same-day code survey compared seven open-source chat stacks: VercelChatbot,
HuggingChat, LibreChat, OpenWebUI, LobeHub, AnythingLLM, and T3Code. Of those,
the two that treated incomplete Markdown as a first-class concern
(VercelChatbot and HuggingChat) both used `remend`, a pure completion pass at
the render boundary; the others painted incomplete syntax, paced or faded the
reveal, or buffered delivery without completing the Markdown tail. This
convergence supported a render-boundary mend rather than another pacing store.

The fix is `mendGrowingBlockTail` (`lib/markdown/growing-block-tail.ts`),
applied by the Markdown component to exactly one block: the terminal growing
block of a live message, when its nodeType is not `code`. Inline constructs
are COMPLETED, not withheld — `**bol` renders as bold "bol", a partial
`[label](url…` renders its label as plain text (remend `linkMode:
"text-only"`), `inlineKatex` stays off to match `singleDollarTextMath:
false`. Tables are the one construct completion cannot fake: an unproven
trailing pipe-led run — blockquoted rows included, and a newline-terminated
header row still awaiting its delimiter row — is clipped from the render
until a completed GFM delimiter row proves the table
(`clipUnprovenTableTail`).

Residual exposure is one token gap, not a construct-wide window: a chunk
ending exactly on a bare opener (`foo **`) renders those delimiter bytes raw
until the next chunk arrives, because only a full inline parse can
distinguish an unmatched opener from a legitimate literal (stripping
blindly would corrupt a _closed_ construct ending in the same bytes). The
measured 100–500 ms windows came from the construct's whole lifetime
(`**Apache Fl…` until the closer landed); those are what this closes.

Invariants preserved: the mend is a pure function of the block's tail bytes,
evaluated during render — the canonical AI SDK store, projection boundaries,
settlement equivalence, and durable snapshots never observe mended text.
Stable blocks, settled messages, and terminal outcome stubs render exact
canonical bytes; a Stop mid-`**bold` displays the raw characters because
they are settled content, not a transient. There is still no displayed-text
copy, no timer, and no pacing: this amendment closes the exposure gap
without revisiting the rejected reveal scheduler below.

### Streaming decay overlay (amendment, 2026-08-11)

The remaining aesthetic gap after tail mending was the reveal feel: paints
track provider commits, so a burst appears instantly instead of flowing in
with a paced word fade. The accepted mechanism is
`lib/markdown/streaming-decay-overlay.ts`: newly appended rendered text is
painted at reduced foreground alpha through the CSS Custom Highlight API
(`CSS.highlights` + `::highlight(naw-stream-decay-N)` rules, 12 buckets ×
33 ms ≈ 400 ms on a linear near-transparent→full ramp). A 2026-08-12
signed-in Claude capture instrumented two streamed responses with a
MutationObserver, synchronous `getComputedStyle`/`getAnimations()` sampling at
node insertion, and CSSOM extraction. It found append cohorts averaging 32
characters (maximum 211), with 91 of 124 inter-cohort gaps between 60 and
120 ms. Every sampled run used one 400 ms linear opacity animation with zero
delay; all 125 spans in the larger response had no inline stagger. Each append
cohort therefore fades as one unit, and the trailing gradient comes from
consecutive cohorts' overlapping fades. An earlier revision staggered words
24 ms apart inside a cohort, but the capture showed no such stagger—even the
211-character run faded uniformly—so the stagger and its paint-span splitting
were removed.
The tint is applied in a layout effect — before the browser paints the
appended text — so new text never flashes a full-color frame first. Mid-word
appends ("hel" + "lo") merge into one fading unit only within a bounded
window (`MAX_WORD_MERGE_CHARS`): unspaced scripts (CJK, Thai) never hit a
word boundary, and an unbounded merge re-timed the entire streamed run to
the newest bucket on every append, pinning whole sentences near-transparent;
bounded, their appends fade as independent cohorts.

This deliberately differs from both the rejected reveal scheduler and the
rejected per-word span wrapping: the overlay owns NO DOM (the React tree is
untouched, so the rendered-DOM equivalence corpus is unaffected and settled
content is canonical by construction), holds no displayed-text copy (its
only state is append cohorts over rendered textContent, derived by
per-commit diffing), and never gates text — every character is painted,
selectable, and exposed to assistive technology from the first frame; only
paint alpha varies for under a second. Adopted text (reload, nav-return)
and non-append changes seed a fresh baseline with no animation; settlement
and unmount clear all ranges synchronously; the rAF driver self-terminates
when no cohorts remain; the overlay no-ops without `CSS.highlights` support
and under `prefers-reduced-motion: reduce` (the stylesheet media-gates the
same rules as defense in depth).

### Why the second reveal scheduler was rejected

- It created displayed-text state that intentionally trailed canonical text
  — a second quasi-canonical store the invariants above forbid.
- Per-word DOM wrapping across the response added main-thread work exactly
  where the renderer needed to shed it.
- Its adaptive scheduler needed terminal flush paths (Stop/error/approval/
  hidden-tab) that re-implemented settlement concerns in the presentation
  layer.
- After PR B/C, per-notification rendering is cheap enough to present raw
  deltas directly; the renderer-slowness problem the reveal compensated for
  no longer exists. A mutable-tail-only CSS fade remains available if a future
  visual-quality gate fails, but is deliberately omitted now.

## Consequences

- Per-update Markdown work is proportional to the mutable region plus the
  verified context: 88.6 ms → ~0.4 ms per update on a ~100 KB response
  (236×, M4 Max Node harness, context verification included), removing the
  long-task-per-notification failure class at its root.
- The renderer no longer needs protecting: frame-aligned publication is a
  smoothness/batching choice, not a survival mechanism.
- Recovery semantics are unchanged and re-verified: reload, navigation,
  second-tab projection, cross-tab durable Stop, and settlement convergence
  behave identically on the production build.
- New invariants are enforced by CI: the equivalence corpus, the 2× p95
  scaling gate, and the stable-block zero-rerender component tests. The
  browser performance workflow owns ongoing long-task measurement.
