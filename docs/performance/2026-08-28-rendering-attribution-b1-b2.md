# B1/B2 rendering attribution — layout, not JavaScript

> **Resolved 2026-08-28** — see the experiment log at the end: the layout
> storm was Chromium's document-wide invalidation on CSS Custom Highlight
> mutation (the streaming decay overlay), fixed by `content-visibility:
> auto` on settled markdown blocks. B1 TBT 3,916 → 40 ms, B2 571 → 291 ms
> in the standard suite, all correctness gates green.

Date: 2026-08-28 · Build: `.next-perf` (instrumented, split flag on — the
flag touches no rendering path) · Tool:
`benchmarks/chat-performance/browser/trace-attribution.ts` (Chrome tracing
over one deterministic guest turn per case; every ≥50 ms main-thread task
attributed by trace-event self-times, joined with the app's own
`chat-perf:*` User Timing marks, which fire inside the tasks that pay for
them — no clock alignment needed).

## Result

| | B1 `long-markdown:100:fixed` | B2 `mixed-markdown:30:fixed` cpu4 |
|---|---|---|
| stream window | 30.2 s | 13.6 s |
| long tasks | 188 (13.4 s, TBT **4.02 s**) | 66 (4.0 s, TBT **0.74 s**) |
| **layout** | **10.4 s (78%)** | **2.2 s (55%)** |
| js | 1.2 s | 1.1 s |
| style (recalc) | 1.2 s | 0.4 s |
| paint | 0.4 s | 0.2 s |
| gc / other | 0.2 s | 0.1 s |
| app-measured projection advances | 0.50 s (502 ms over ~500 advances) | 0.40 s |
| app-measured Shiki | 0.30 s | 0.36 s |

TBT matches the baseline harness numbers (B1 ~3.9 s, B2 ~0.6 s), so the
trace is measuring the same phenomenon the suite reports.

## The layout signature

Across the whole B1 window there are 1,002 `Layout` events totalling
17.9 s (10.4 s of it inside long tasks), mean 17.9 ms each, and:

- **Not forced reflow:** 14 ms of the 17.9 s sits inside `FunctionCall`;
  0 ms inside `FireAnimationFrame`. This is the browser's own frame
  lifecycle re-laying out after each streamed commit — no JS layout-read
  antipattern to fix.
- **Cost scales with accumulated content:** layout ms per 5 s bucket climbs
  1.8 → 3.3 → 3.1 → 3.9 → 4.0 s as the answer grows (B2 shows the same
  ramp). Per-frame layout cost is proportional to how much has already
  streamed, which is exactly why long streams degrade superlinearly.
- **The dirty set is tiny; the work is not:** `dirtyObjects` p50 = 22
  (max 274) against `totalObjects` up to 17,212, yet each pass costs ~18 ms.
  Chrome only *marks* a few objects dirty, but laying out the dirtied block
  means re-running inline/text layout for the whole growing message
  container — one "object" whose internal layout is the entire answer.

What this rules out: markdown projection JS (500 ms, and its per-advance
durations are already capped ~13 ms in these runs), Shiki (300 ms),
React/JS broadly (1.2 s total — second-order), paint, GC, and
IntersectionObserver (78 ms).

## Implication — the next experiment is layout containment

The fix class is CSS/structure, not JS: stop per-beat layout from scaling
with the full accumulated answer.

1. **Contain completed blocks.** The streaming renderer (ADR-0016) already
   splits settled markdown blocks from the growing tail. Completed block
   elements are layout-static; `contain: layout` (or `content-visibility:
   auto` with `contain-intrinsic-size`) on them should cap each beat's
   layout at the tail block's size. Measure with this same trace tool:
   expect the per-5s layout ramp to flatten.
2. **Audit the container chain.** `totalObjects` reaching ~17 K suggests
   layout roots escape the message. Verify the turn/thread containers
   (`contain` style, the eager-arm `content-visibility` on TurnRows) actually
   isolate settled turns while a stream is live in the last turn.
3. **Tail size control.** If a single markdown block can grow unbounded
   (giant paragraph/code fence), containment can't help inside it; the
   renderer's block segmentation is then the lever.

Before/after protocol per the plan: implement one candidate, rerun
`trace-attribution.ts` (layout bucket + ramp) and the standard suite
(`long-markdown-100-fixed`, `mixed-markdown-30-fixed-cpu4`: TBT, projection
settle correctness), on this branch, one change at a time.

Artifacts: `results/traces/*.analysis.json` (per-task buckets, top tasks,
marks-inside); raw traces alongside (gitignored).

## Experiment log — from attribution to fix (2026-08-28)

Each step used the same tool; probes were runtime CSS/media injections
(`INJECT_CSS_FILE` / `EMULATE_REDUCED_MOTION`), so hypotheses were tested
without a rebuild. B1 TBT per step:

| step | B1 TBT | verdict |
|---|---|---|
| baseline | 4,021 ms | 78% layout |
| probe: `contain: layout` on settled blocks | 4,324 ms | **rejected** — settled siblings were not being re-laid (Blink fragment caching already skips them) |
| probe: turn `content-visibility` disabled | 3,692 ms | minor; the turn-level c-v/:has() machinery is a real but secondary cost (B2 742 → 476 ms) |
| invalidation-tracking trace | — | the mechanism: per-commit layout cost correlates with TOTAL layout objects at r = 0.984 (~5.8 µs/object, dirtyObjects ~22) — a whole-tree walk; mass `Related style rule` style recalc; the same sr-only/KaTeX `position:absolute` nodes re-attached per commit |
| probe: `prefers-reduced-motion` emulated | **10 ms** | conviction: everything motion-gated off — the streaming decay overlay is the driver |
| fix attempt: persistent `Highlight` objects, ranges mutated in place | 3,698 ms | kept (registry keys must not churn; B2 742 → 487 ms) but insufficient — Chromium invalidates document-wide on highlight CONTENT mutation too |
| probe: `animation: none` everywhere, overlay live | 4,742 ms | animations exonerated |
| probe → **fix**: `content-visibility: auto` + `contain-intrinsic-size: auto 3rem` on settled markdown blocks (`.markdown > :not(:last-child)`, `@supports`-guarded) | **8 ms** | locked off-screen blocks are skipped by the invalidation walk; the fade stays fully live |

**Root cause.** The streaming decay overlay repaints via the CSS Custom
Highlight API every ≤24 ms tick. Chromium invalidates `::highlight` rule
matching document-wide on ANY highlight registry/content mutation — every
element's style recalcs, absolutely-positioned/hidden elements re-attach,
and layout re-walks the entire tree at ~5.8 µs/object. Cost therefore
scaled with the accumulated answer, which is why long streams degraded
superlinearly while the overlay itself remained "paint-only" by design.

**The shipped fix** attacks the walk, not the overlay: settled markdown
blocks (`:not(:last-child)` — the growing block is last by construction)
get `content-visibility: auto`, so off-screen settled content is skipped by
style recalc and layout entirely. `contain-intrinsic-size: auto 3rem`
memoizes each block's real rendered height after first render (no scroll
jumps; the 3 rem fallback only sizes never-rendered blocks). The persistent
`Highlight` objects change is kept as hygiene.

**Verification.** Standard suite (RUNS=10, all 11 scenarios): correctness
green everywhere; `long-markdown-100` TBT 3,916 → 40 ms (long tasks
192 → 2), `cpu4` TBT 571 → 291 ms, DOM growth byte-identical in every
scenario, projection advance and send→visible unchanged, Shiki totals
slightly down. Full unit suite (2,572 tests) green. Visual check on the
perf build: streaming render, spacing, table/KaTeX/code, and the decay
fade all intact; computed styles confirm `auto` on settled blocks and
`visible` on the growing block.

**Residual B2 (291 ms TBT at 4× throttle)** is now ordinary work
(viewport-visible layout, JS, Shiki) plus the turn-level c-v/:has() cost
the no-cv probe isolated — a candidate for a later, smaller experiment.

## Residual-B2 follow-up — turn-level c-v/:has() (2026-08-28, later)

> Superseded on 2026-09-08: whole-turn containment is now removed. The
> Markdown-block optimization above remains unchanged. See the completion
> correction below.

Re-probed on the CURRENT build (the settled-block c-v fix shipped): the
pre-fix 742 → 476 ms delta no longer exists — the block-level fix already
absorbed most of the turn machinery's cost. Fresh single-run traces at
cpu4: rebaseline TBT 218 ms (style 38 ms), turn-c-v-off probe 217 ms
(style 5 ms), cis-only-off probe 232 ms (style 6 ms). The marginal cost is
now ~30 ms of long-task style recalc, driven by `contain-intrinsic-size:
auto` last-remembered-size bookkeeping plus `:has()` invalidation on the
mutating live section.

Shipped anyway as hygiene (the invalidation surface, not a rescue):

- the two `:has([data-writing-block])` pointer-events rules on every turn
  section were DEAD — nothing in this app renders `data-writing-block`
  (reference residue from an unimplemented canvas feature);
- the live (last, generation-active) turn no longer gets
  `content-visibility: auto` — it is on-screen by definition and mutates
  every commit, so c-v there pays relevancy + intrinsic-size bookkeeping
  for zero skip; settled turns re-gain it after the stream ends;
- with the live turn c-v-free, the `:has([data-dotball-loading-indicator])`
  content-visibility escape became vacuous and was deleted (the dotball
  only shows on a live turn).

Post-fix traces: B2 190 ms TBT, B1 3 ms TBT. A conversation test pins the
contract (live turn c-v-free while streaming, settled turns keep c-v, no
`:has(` in section classes).

**Harness verification + a measurement lesson.** Standard harness RUNS=10:
long-markdown TBT p50 40 → 34 ms; cpu4 came back 358–363 ms against the
earlier session's 291 ms — which triggered a same-session A/B bisect via
temporary `NEXT_DIST_DIR=.next-ab` builds at `cf200df1` (377 ms),
`9cd26e45` (380 ms), `d69861b8` (365 ms), and this change (358–363 ms,
fewest long tasks). Verdict: flat across commits — no code regression, and
this change is the best of the group. The 291 → ~370 gap is CROSS-SESSION
ambient load (another project's dev server + turbopack workers were
running during the later session), which shifts the 4×-throttled scenario
~25%. Also note the two TBT definitions differ: the trace tool's window
ends at `stream_terminal`, while the harness's in-app long-task observer
covers the page lifetime including the post-terminal decay-fade window.
Absolute TBT numbers are only comparable within one session on this
machine — for regressions, A/B on the same session (or the pinned CI
runner with relative thresholds).

## Completion scroll correction (2026-09-08)

Authenticated Chrome reproduced a long Batman answer jumping from scrollTop
30,447.5 to 15,737.5 at completion while its 15,825 rendered text characters
and 15,838px Markdown height stayed unchanged. The turn acquired
`content-visibility: auto` with `contain-intrinsic-size: auto 100lvh` only
after streaming. Without a remembered turn size, its fallback could temporarily
shrink the scroll range and clamp the reader's position.

Remove whole-turn containment, keeping the existing Markdown-block containment,
canonical SDK stream, incremental block identities, and decay overlay. Delaying
the same toggle until the next send only moves the failure. Recording and DOM
checks on the corrected build preserved scrollTop 40,328.5 through completion;
the new answer retained all 15,342 rendered characters. A continuous 60fps window
recording covers that run. These checks verify completion behavior, not a new
performance benchmark; the earlier 218ms versus 217ms probe supports the scope.

Actual-Markdown integration coverage now checks text-end, completion, and
terminal saved-message adoption for both reasoning/story and commentary/tool
turns, retaining earlier DOM nodes and exact final answer text. The conversation
test also checks stable wrapper identity and sizing classes across settlement.
Evidence: `output/thinking-ui-parity-20260908/exact-lifecycle/completion-regression/`
(`before2-dom.json`, `after-dom.json`, `after-continuous.mov`).
