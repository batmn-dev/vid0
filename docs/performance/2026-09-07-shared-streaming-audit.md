# Shared streaming audit

## Decision and scope

Use one canonical stream and shared rendering path across models. Separate
provider arrival, server release, browser receipt, and visible-content delay
before changing cadence. Evaluate first useful output, completion, interaction
responsiveness, and Stop together. This extends ADR-0016 and ADR-0037; it does not
introduce another state store, dependency, observer framework, or universal pacer.

The initial direct-Gemini smoothing experiment was withdrawn while the shared
path was audited. Following the audit and paired provider-route measurements,
the measured direct-Google route now reuses the existing Haiku transform without
new timing constants or another state store. It remains an explicitly bounded
latency/readability tradeoff, not the default for unmeasured providers.

## Evidence

### Server delivery

- Ordinary text appends synchronously in `createDurableSnapshotTracker` and
  starts throttled persistence without awaiting it. Approval persistence waits
  only on approval requests. Do not remove that correctness boundary.
- Redis retention consumes an independent tee. Its 20 ms batch interval does
  not gate the initiating tab's HTTP stream.
- Installed AI SDK text output, UI conversion, and SSE serialization contain no
  text batching timer. Only explicitly eligible server smoothing adds pacing.
- A bounded composition check held snapshot persistence unresolved and left
  the retained tee unread. Five text deltas still arrived 31–32 ms apart against
  a 30 ms schedule. Completion waited for the snapshot flush, as intended.
  This verifies those server seams, not browser speed or hosted-service latency.
- Provider-start authorization and terminal settlement/title waits affect other
  portions of the journey. They are not evidence of midstream buffering.

### Client rendering

- Canonical SDK state updates per stream part; React notifications align with
  browser frames. No blanket 50 ms client throttle remains to remove.
- Completed Markdown blocks are memoized. Growing prose, lists, and tables can
  still incur substantial per-block work. The fade overlay also does text/range
  work. Neither mechanism received speculative changes in this audit.
- Controlled real-component replay: a 12,243-character, 400-line code fixture
  split into 40 updates produced 40 full highlights at 180/250 ms intervals,
  versus one final highlight at 50 ms intervals. The former processed 251,001
  characters, 20.5 times the final code length.
- Actual Shiki service microbenchmark, five rounds: median total CPU-call time
  for 40 intermediate highlights was 1,804.9 ms, versus 88.54 ms for one final
  highlight. These Bun measurements establish duplicate work, not browser FPS.
- A deferred-load reproduction showed obsolete requests still calling
  `codeToHtml` after caller cancellation. Dropping their eventual HTML prevented
  stale output but did not prevent the wasted tokenization.

## Implementation

Keep growing code visible as escaped plain text. Highlight using the existing
nonterminal/settled block boundary, removing the 150 ms timer. An unfinished
terminal block remains uncolored during pauses; even a closed terminal fence
waits for the next block or settlement. This avoids a parallel fence parser.

Pass cancellation through the shared lazy highlighter. Check before loading and
after asynchronous core/grammar waits, before synchronous tokenization, including
grammar-failure fallback. Keep shared loads reusable by current requests; keep
the existing exact-input guard against stale HTML. Cancellation cannot interrupt
a synchronous tokenization already executing on the main thread.

Alternatives considered: retain the inactivity timer plus cancellation only
(leaves repeated completed highlights); increase the timeout (still depends on
provider cadence); add model-specific pacing (delays text and hides the rendering
cost). The chosen change uses existing semantic state and removes work.

## Browser evidence and validation boundary

The authenticated Chrome extension exposes DOM reads, screenshots, and console
logs, but not network bodies, performance marks, CDP, or continuous video capture.
The full ADR-0037 harness cannot attach through that extension. Chrome was not
restarted, and no isolated browser or replacement account was used.

A separate production build at `http://localhost:3111` enables the existing
deterministic provider and content-free console observer. Baseline build:
`RTPnOrqIlEL5oSr6kC7--`. Raw samples and build identities remain in the session
artifacts. Early cold diagnostic captures may overlap independent CPU work and
are not controlled before/after benchmarks.

The earlier T3/Gemini videos are explicitly sampled and concern the withdrawn
experiment. They cannot certify the final shared change or reveal T3's server
implementation. Theo's recent T3 Code/Lakebed comments informed the measurement
strategy; they are not evidence that T3 Chat ships this architecture.

Candidate build: `uU3FG_tp19GunxkQ6gdiB`. Final component replay at 50/180/250 ms
intervals produced zero growing highlights and one settlement highlight, processing
only the final 12,243 characters. This removes the measured duplicate work; it is
not a 20.5-times application-speed claim.

Earlier shared-highlighting candidate validation (`uU3FG_tp19GunxkQ6gdiB`):
74 focused renderer/Markdown/service tests and 59 route/transform tests passed,
before the final Gemini eligibility and metadata-preservation checks brought the
route/transform total to 63 (recorded below). Narrow ESLint, `git diff --check`,
and the instrumented production `bun run build:next` passed. The build retains its existing design-system dynamic
filesystem tracing warning. Independent review found no actionable issue.
Build-generated `tsconfig.json` entries were removed; no configuration change is
part of the patch. Evidence and exact test commands are under
`benchmarks/chat-performance/browser/results/shared-stream-audit/` (ignored).

Authenticated-browser baseline completion matched all 12,292 canonical characters
and all 12,244 rendered fenced-code characters in `code-block`. Typing succeeded
during a separate baseline stream; the attempted Stop arrived after completion,
so it does not establish Stop behavior.

Candidate browser correctness checks **passed** through the authenticated Chrome
extension. Native screen/AX discovery reported a locked Mac, but direct browser
discovery and DOM access remained available. Treating that native error as a
browser blocker was an investigation mistake. Full DOM snapshots also timed out
on the long code page; small DOM reads and browser screenshots succeeded.

- `code-block:30:fixed` completed with 12,244 rendered code characters and syntax
  coloring visible in the screenshot (3,160 token/line spans). Its fixture hash
  `f912eeebb073892a` matches `hashValue(buildCodePayload() + "\n")`. Reload
  restored exactly the same code. The earlier admission error did not recur.
- `code-block:10:fixed` showed 124 code characters and zero highlight spans
  while Stop was available. Clicking Stop during the stream left 2,244 rendered
  code characters, removed Stop, and applied highlighting. Reload restored the
  identical stopped code without restarting generation. The partial code has
  the Markdown renderer's normal terminal newline; excluding that newline, it
  is a prefix of the completed fixture.
- Browser command timeouts prevent treating these runs as smoothness or
  interaction-latency measurements. They establish rendered content, completion,
  cancellation, and reload correctness.

The temporary build directory was moved from `.next-stream-audit/` into the
existing ignored `.next-perf/audits/uU3FG_tp19GunxkQ6gdiB/`. The unignored build
had been scanned by Tailwind in the development server, producing invalid CSS.
The same candidate build remains served at port 3111; the development server
was restarted to clear that generated CSS state and returned HTTP 200. No
stylesheet change was made.

### Final Gemini prose comparison

A fresh real Gemini 3.5 Flash prose comparison used the candidate at port 3111
without a deterministic directive or Gemini pacing. The browser stayed visible
to the page and both runs completed without capture errors. The coarse visible
growth difference remains: T3 had 117 positive-growth observations (median 19
characters), while the candidate had 21 (median 120 characters). Median observed
growth gaps were 35 ms and 153.5 ms respectively. These are polling observations,
not provider token counts or frame intervals. Sparse screenshots and possible
development-server compilation overlap during the T3 run prevent a controlled
performance verdict. The candidate's final growth was observed sooner, but
different generated answers and capture conditions prevent an equal-work speed
claim.

**The original Gemini prose cadence target was not met by the raw candidate.**
The shared code change fixes measured duplicate highlighting work; it does not
subdivide incoming prose chunks. Prior direct-Google traces already contained
coarse chunks before rendering. That supports an upstream contribution but does
not reveal T3's private delivery or presentation implementation. Preserve this
distinction instead of claiming that code-block validation proves prose parity.

The follow-up adapter audit found no removable text aggregation: our provider
strategy constructs the stock Google provider; it requests
`streamGenerateContent?alt=sse`; the provider-utils SSE parser processes each
complete event; and the Google adapter immediately emits each ordinary
`part.text` unchanged. The installed options expose no text chunk-size or cadence
setting. OpenRouter is a supported alternate route, but finer output from it has
not been demonstrated by that source audit alone.

### Provider-route experiment and final approach

Four sequential live provider calls, Google/OpenRouter/Google/OpenRouter, used
the same public synthetic prompt, minimal reasoning, temperature 1, and a
1,024-token output cap through the repository's actual provider construction.
They bypassed application smoothing and recorded only delta sizes and arrival
times. All completed without retries or warnings. Direct Google median chunks
were 118/119 characters, with median gaps of 153/147 ms; OpenRouter medians were
116/115 characters, with gaps of 226/230 ms. Direct completion was 4.89/4.98 s,
OpenRouter 7.82/7.04 s, for similarly sized outputs around 3,100 characters.
Two pairs do not establish a provider-wide latency ranking, but this experiment
provides no reason to switch routes to fix coarse chunking. Sanitized results
are in `provider-route-cadence.json` under the ignored audit results directory.

The chosen fix is to enable the already implemented canonical word transform
for direct Google `gemini-3.5-flash`, after proving the renderer is not creating
these coarse chunks. No new Gemini pacing layer, parameters, or client text
queue is introduced. Existing execution-abort handling, ordered non-text events,
text identity, and the 400 ms intentional holdback cap remain in force. The
plain shared code renderer stays in place. The installed SDK `smoothStream`
is not a drop-in simplification: it also delays reasoning and its inner delay
loop does not observe the runtime's execution signal. Route switching had no
observed cadence benefit; a second client queue would duplicate canonical state.
This is our measured implementation decision, not a statement that Theo uses
the same mechanism. Final browser comparison of this eligibility change follows.

Adversarial review found one correctness requirement for this reuse: Google's
adapter can emit empty text deltas carrying thought-signature metadata. The old
transform dropped those events and could lose new metadata on a fragment that
completed an earlier held word. The shared fix flushes held text at metadata
boundaries and retains empty metadata events in order, without treating them as
text-arrival samples. Two focused tests reproduced the losses before the fix;
all 63 tests in `app/api/chat/word-chunking-transform.test.ts` and
`app/api/chat/chat-turn-runtime.test.ts` pass. Tool-call metadata was already preserved
by the non-text path; this finding does not establish a tool-call failure.

No performance parity or complete-suite pass is claimed from unit tests, partial
scenarios, or builds. The full network-to-presentation comparison also needs a
supported tracing connection; the current extension does not expose it.

### Final paced comparison and Stop follow-up

Two sequential paired trials used real Gemini 3.5 Flash, fresh chats, the same
12-paragraph story prompt, search off, and a 2560×1296 viewport. T3 used Instant;
the candidate used Minimal. Build `WqqXrE3PZAbaWCQnPgvzE` included the shared
renderer change, Gemini transform eligibility, and metadata preservation.

For adjacent DOM polls less than 100 ms apart, median positive text growth was
18/19 characters on T3 and 21/22 on the candidate; p95 was 40/37 versus 34/41.
Median growth gaps were 32/33 ms versus 27/29 ms. Before eligibility, the raw
candidate grew by a median 120 characters. The candidate's first and final
observed text arrived sooner in both pairs, but varying generated answers and
sampling gaps prevent an equal-work latency claim. Between 1.96% and 3.10% of
active polling intervals were excluded by the 100 ms bound. These samples meet
the observed prose-cadence target; they are not exact paint or network traces.

Both sampled comparison videos were encoded, decoded, and reviewed at selected
timestamps. Evidence lives under the task's `gemini-streaming` visualization
directory in `comparison-paced-final1-sampled.mp4`,
`comparison-paced-final2-sampled.mp4`, and `paced-final-metrics.json`.

The final Stop check exposed a separate persistence race: 166 visible characters
fell back to the 2-character durable checkpoint. The shared Stop fix captures
the current SDK text before abort and retains a compatible bounded extension
inside the existing owned Stop transaction. It keeps worker metadata, tool
evidence, billing, and terminal guards server-controlled. ADR-0011 documents
the narrow authority amendment and rejected two-phase cancellation alternative.
Backend runtime/seam tests passed (134), frontend core tests passed (32), and
independent review found no remaining issues. The updated functions were pushed
only to development `polite-jackal-630`. Narrow lint, Convex typecheck, and the
full Next build passed. The build retains an unrelated existing dynamic-file
tracing warning in the design-system source reader.

The final build, `jA1SYE7S-7mgjwItXSo2h`, passed two real Gemini Stop/reload
trials. Trial 1 had 211 canonical characters before the click and retained 243
after the click; trial 2 had 361 and retained 405. Text arriving between the
observation and click was retained too. Both earlier observed prefixes survived,
both stopped responses reloaded exactly, and neither restarted or grew during
later checks (38.6 seconds after Stop in trial 2). The viewport was restored.
Cadence was unchanged from the two completed comparison pairs.

The observed Gemini prose-cadence and early Stop/reload targets pass on the local
production-style build with the development backend. This is not a production
deployment claim or a universal latency guarantee. Primitive's saved session
was rejected during this task, so its decision graph was unavailable; the
lasting decisions are recorded in ADR-0011 and ADR-0016.

## Final frontend review and other-model smoke tests

An independent subagent reviewed the uncommitted streaming changes against
`HEAD` (`cdac3ae8`). Standards and requested-behavior reviews found no actionable
defects or useful simplifications. The removed idle-highlighting helper has no
remaining references. Shared stream ownership, metadata preservation, Stop
accounting, and cancellation checks remain intact. No speculative cleanup was
made. The T3 comparison distinguishes historical accessible frontend evidence
from current sampled product behavior; its private implementation is not known.
A bounded recheck of the current public `index-DEkDq-kE.js` bundle returned
HTTP 429 at 16:51:54 UTC on September 7. The source comparison therefore uses
the September 2 audit of `index-CrsmAoWm.js`, which recorded immediate
`processChatStream` to Zustand delivery and runtime evidence for Luna only.

Authenticated Chrome smoke tests ran against the updated development server at
`http://localhost:3002`, with real providers and no deterministic directives.
The completion prompt requested a paragraph, a 30-name TypeScript array, a
numbered list, and `SMOKE_COMPLETE`, with tools disabled by instruction.

| Model | Completion and highlighted code | Reload preserves exact response and code | Chat |
| --- | --- | --- | --- |
| Claude Haiku 4.5 | Pass | Pass | `39dabee3-1f04-4aa6-a11a-bbbfd1ae427c` |
| GPT-5.6 Luna | Pass | Pass | `c7ae4e19-2621-4758-bdc9-aae0b0713cf9` |
| GLM-5.3 | Pass | Pass | `027a567c-cbe0-4388-a38c-a91f52e4eaad` |

A separate Haiku test stopped a growing 200-name code response. The pre-click
sample had 141 code characters and zero syntax spans while streaming. Stop
retained 191 characters including that prefix, applied syntax highlighting,
removed the Stop control, and reloaded with exactly identical response and code.
The stopped result was visually inspected in chat
`091cce00-e557-48c0-a8d1-10ba05576eb5`. Partial code is intentionally incomplete
when interrupted. The original GLM-5.3 model selection was restored afterward.

These are completion, formatting, Stop, and persistence smoke tests, not
cross-provider speed benchmarks. No new runtime change was needed.

## Research sources

- Theo's [August 25 reply](https://x.com/theo/status/2092081314870771761)
  distinguishes his T3 Code streaming preference from chat experiences. Full
  reply text was available through mirrors; X's public embed truncated it.
- [September 3, 42:03](https://www.youtube.com/watch?v=r_dw-1109Ag&t=2523s):
  reducing transferred data during T3 Code streaming/catch-up.
- [September 4, 32:53](https://www.youtube.com/watch?v=XFWpf0wLbh0&t=1973s):
  measuring and reducing Lakebed request/synchronization latency.
- Current AI SDK [streaming](https://ai-sdk.dev/docs/ai-sdk-core/generating-text)
  and [smoothing](https://ai-sdk.dev/docs/reference/ai-sdk-core/smooth-stream)
  documentation was checked alongside installed package source. The local
  Vercel Chatbot direct-stream implementation and LibreChat smoothing hook were
  complementary references, not evidence of T3 behavior or reasons to replace
  this application's state model.
