# ChatGPT thinking lifecycle replication

Reference: user recording `chatgpt-thinking-ui.mp4` (84.181 seconds, 936 × 1080, 20 fps), authenticated ChatGPT conversation `https://chatgpt.com/c/6aa06b7e-7d70-83e9-9eb8-7d14bd04c674`, and a fresh replay of the exact prompt on September 8, 2026.

## Observed contract

1. Empty response: standalone tertiary Thinking occupies the response slot.
2. Work begins: full-size interim narrative replaces it. A trailing Thinking/search status follows the current work, with no top work-history button.
3. Searches: live search label and 20px favicon/native-tool marker; completed searches remain in chronological position between narratives. Search rows expand inline.
4. Further work: append commentary and tools in order; current reasoning can replace the trailing search summary. The history retains completed searches.
5. Final answer begins: all preceding work collapses into Worked for Ns above the streaming answer. This happens before answer completion. No interim text is duplicated in the final answer.
6. Completion: response actions appear; the work header remains. Opening it restores full-size commentary and nested search disclosures inline, without opening a side panel.
7. Source disclosure: seven initial site chips, N more, then Show less. Collapsing/reopening the parent resets nested disclosure state.

## Measured styling and motion

- Work header: 16px font, 24px line height, weight 400, light tertiary rgb(143,143,143); 4px chevron gap. Chevron always visible, rotates 90 degrees.
- Work body: 16px/24px primary Markdown, 16px vertical gaps, 16px top padding after expanded header.
- Search row: 16px/24px tertiary, 8px marker/text gap, 20px marker with 2px top inset. Nested chevron hidden at rest, visible on hover or when expanded; 150ms rotation.
- Source chips: 25px height, 12px text, 12px horizontal padding, 12px favicon, 4px wrapping gaps, 8px top inset, light background #f4f4f4.
- Manual disclosures: separate 300ms height and opacity layers, ease-in-out, with an opacity starting style. Historical reopening skips individual entry fades. CoTV5 source inspection supersedes the initial motion estimates: narrative snapshots enter over 700ms and retain the previous snapshot at full opacity for 300ms. Layout growth uses 300ms with the remaining 260ms initial entry delay. Ordinary active-status replacement uses 150ms exit, then 300ms entry after 150ms delay. Preserve reduced-motion support. The recording's automatic work-to-answer collapse occurs within about 100ms; do not impose the manual collapse animation on it.
- Measure live and resting states separately; use semantic tokens and shared primitives for equivalent controls.

## Approach and implementation ownership

Extend `turn-evidence` and `assistant-activity` / `assistant-turn`, the existing pure message projection. Do not create an independent tool classifier or inspect SDK parts in React components. Installed AI SDK 7/OpenAI provider types expose text phase `commentary | final_answer`; interpret that at the evidence boundary. For providers without phase, use actual ordered text/tool/step evidence conservatively. Never invent summaries or lose answer text. Preserve raw text for copy/share and provider history.

Add an inline work renderer consuming normalized presentation. Preserve the existing panel for source navigation and approval/tool details until those affordances have equivalent inline owners. The work-header action itself must expand inline. Preserve approval, error, stop, opaque reasoning, multiple tool steps, replay/reload, keyboard operation, and mobile behavior. Update row memo equality to include the immutable inline facts now rendered; avoid rerendering the Markdown answer for unrelated source deltas where possible.

Implementation agent owns production projection/UI files and essential adjacent tests. Root owns this plan, ADR/context synchronization, lifecycle fixture, and browser evidence. Comparison agent initially owns video audit artifacts; it will receive production ownership only after implementation handoff.

Alternative considered: restyle the existing side-panel trigger. Rejected because it cannot represent the observed chronological inline work and automatic pre-answer collapse. No new dependency is planned (Motion is already installed). The only provider-execution change is the ADR-0040 prompt addition: default-prompt OpenAI tool turns request concise pre-tool progress and updates when findings change the next step; custom system prompts remain authoritative.

### Reload findings and bounded backend follow-through

The independent persistence audit found that final snapshots and retained SSE preserve text phase, but throttled durable snapshots flatten reasoning and text into two unphased parts. It also found that the existing `workDurationMs` intentionally counts all generation, including final answer text. A client-only fix would change chronology and elapsed labels after reconnect/reload.

Preserve ordered text/reasoning, phase, and tool boundaries in live snapshots through the existing stream/snapshot seam. Keep write sequencing, version-based dirtiness, throttling, and terminal settlement guarantees unchanged. Prefer an existing SDK/UI message projection over a second reducer. Add optional `workSummaryDurationMs` for pre-answer activity, independently of total `workDurationMs`; freeze it at an observed final-answer boundary, with conservative provider-neutral fallback. Old records without the new measurement remain explicitly absent rather than assigned fabricated durations. Any schema addition is optional for production compatibility.

Comparison agent owns this bounded backend fix and focused snapshot/timing tests before resuming visual comparison. Implementation agent owns its metadata reader and UI consumption. Root owns decision documentation and fixtures. Alternatives considered: retain client-only timing (fails reload), or redefine total work duration (breaks existing generation accounting); both rejected.

## Verification

Use the production renderer with deterministic SDK-shaped lifecycle fixtures for exact content and transition comparison, then rerun the prompt in authenticated local Chrome for integration. Cover empty Thinking, commentary, running/completed search, subsequent commentary/search/reasoning, final-answer boundary, settled history, nested source expansion/more/less/reset, stop/error and opaque reasoning. Keep evidence of viewport/theme/font differences and generated-content variability.

Run essential projection/component tests, typecheck, lint, and Next build (never `bun run build`, which deploys Convex). Review the full source video and final comparison at original timing. Mark criteria pass/fail/unverified; sampled browser captures cannot prove smoothness across gaps. Iterate on observed defects without claiming perfect parity from successful tests or video encoding.

## Implementation result

The shared inline renderer, phased text projection, ordered durable checkpoints, and separate pre-answer timing are implemented. Authenticated browser checks confirm nested disclosure/reset behavior and stable reload of a real generated response. The independent review fixed paragraph metrics, easing, layered entry timing, marker borders, glyph sizing, and fixture chronology. A final correctness review restored settled actions for commentary-only turns.

Final verification: 3,057 tests passed, final typecheck and changed-source ESLint passed, and production Next build passed. Full root lint exhausted memory scanning existing captured JavaScript in ignored output artifacts. Evidence and detailed limits are in `output/thinking-ui-parity-20260908/review.md`. Sampled/cached browser captures leave continuous animation parity unverified; the implementation must not be described as proven pixel-perfect.

## Continuation refinements

Authenticated Chrome measurements corrected full-row search hit targets, exact source-chip spacing, three overlapping remainder favicons, and inverse hover without an extra tooltip. Browser traces verified both disclosure fade directions, smooth intermediate heights during streamed paragraph wrapping, and overlapping search-to-reasoning replacement in one unchanged 24px row. The fixture now includes a streamed-commentary replay to exercise line growth. See `output/thinking-ui-parity-20260908/continued/` for measurements and the revised sampled manual-opening comparison. The earlier full-lifecycle videos precede these refinements.

Final continuation validation: 83 targeted tests, typecheck, targeted ESLint, safe Next production build, and diff check passed after the stable reasoning-step key fix. The final production fixture replay captured all 12 stages in 114 samples over 57.1s, with a maximum 506ms sample interval. `continued/final-lifecycle-comparison-sampled.mp4` is the updated final-build comparison; its manifest preserves original elapsed timing. This removes the earlier multi-second capture gaps, but 2fps samples still cannot certify continuous animation smoothness. Search-to-reasoning animation identity follows the reasoning step, so partial streamed headings update without restarting the crossfade.

## Historical iterations (superseded by ADR-0040 and the final source audit)

The following records explain earlier experiments. They are not the current implementation contract. In particular, raw OpenAI reasoning is no longer used as preamble prose, inner396ms fading is disabled here, and the reveal-drain/automatic300mscollapse experiment was removed.

## Second recording correction

The previous fixture did not exercise the real provider reasoning path. The renderer hid all live reasoning and the projection discarded reasoning when commentary existed. Completed tools also incorrectly established a responding phase before final-answer text, allowing a premature Worked label. These are functional defects, not capture limitations.

Use `chatgpt-thinking-ui-2.mp4` (85.8667s, 1488×1080, 30fps), its authenticated conversation, and the actual downloaded CoTV5 source as authority. The recording contains three progressively revealed narratives and three searches, with a persistent status tail. It ends while the final answer is still streaming. The new replay at `/test/thinking-lifecycle/video2` runs the same chronology through explicit commentary and native SDK reasoning shapes. Sampled text boundaries are labeled; they do not establish original token timing.

Source-backed implementation replaces guessed per-word narrative animation with content-keyed full Markdown snapshots (700ms entry, previous snapshot retained 300ms), and a stable active status row (150ms exit; 300ms entry after 150ms delay). Preserve every supplied reasoning body and keep Thinking until actual answer evidence. Do not infer private structured progress metadata or invent past-tense titles. See the independent `video2-audit/video2-review.md` for exact source functions and timestamps.

The real authenticated API run completed seven searches and retained reasoning between them. The final source-based favicon sequence advances every 1500ms, stops at its last source, resumes when sources arrive, and preserves its cursor across status text changes. Undersized favicons use a native globe. Final correction validation: 89 targeted tests, typecheck, targeted ESLint and diff check pass; the safe Next build passed before the last isolated favicon refinement. Updated video composites, DOM traces, capture-gap labels and a criterion-by-criterion verdict are in `output/thinking-ui-parity-20260908/video2-live/review.md`. Continuous motion parity remains unverified.

## Immediate thought-stream correction

The next review traced the nested CoT Markdown implementation, not only CoTV5 wrappers. It explicitly disables streaming text-color decay and does not enable the alternative streaming mask. The downloaded preamble path reveals via wrapper opacity and vertical height clipping; the 56px gradient mask belongs to a capped activity scroller. Do not attribute that gradient to individual thought paragraphs.

Copying full-text snapshot keys onto native SDK reasoning remounted Markdown for every delta. Replace that with one stable incremental Markdown tree per work item, rendering all currently available text synchronously. Keep the outer reveal independent of delivery, and apply the existing bounded paint-only append fade for smooth SDK text arrival. This follows ADR-0016 and the user's immediate-streaming requirement; it is an adaptation, not literal parity with the downloaded preamble internals. No provider pacing, displayed-prefix queue or new animation scheduler is introduced. The prior sampled videos precede this correction. See `output/thinking-ui-parity-20260908/thought-streaming-review.md` for current verification and the authenticated-browser blocker.

## Provider heading correction

The user's live screenshot exposed leading provider reasoning headings rendered as bold narrative sections. Strip only the leading Markdown heading from each reasoning part's inline body, suppressing incomplete heading fragments so they cannot flash while streaming. Body text renders immediately and retains its part identity. Inline emphasis, commentary, final answers and canonical stored text are unchanged. The existing compact active-summary slot remains separate; heading-only parts no longer return as bold history rows. Projection tests cover split headings, immediate body arrival, preserved emphasis and unchanged canonical evidence.

## Rapid thinking-to-answer handoff correction

The sampled Luna run exposed a real presentation cutoff: the final reasoning paragraph contained its text in DOM but its wrapper had revealed only 4.7px at 15.078s; by 15.327s the live tree was gone. The reference `Gn` renderer instead retains outgoing history for a 300ms height/opacity exit. Remove the 260ms entry delay for SDK reasoning, preserve its streaming paint through part completion, drain only the outstanding reveal, and then run that exit. Answer text continues rendering immediately. Preserve the live row arrangement through drain to avoid duplicate searches; incorporate same-commit final narrative text. Keep semantic final-phase timing unchanged while empty final placeholders remain visually Thinking.

Independent review covers retained search/title snapshots, replay/reduced motion, timer cancellation on resumed work, final delta survival and immediate answer rendering. Evidence is in `output/thinking-ui-parity-20260908/handoff-fix/`.


## Final source audit

The active contract is ADR-0040. Authenticated captures confirm model-authored commentary before tools and later progress commentary. OpenAI reasoning remains canonical and available in Activity, without flashing its headings or raw body inline. The renderer keeps one incremental Markdown tree and overlapping inert paint snapshots. Native activation waits two animation frames; incoming opacity is700ms, layout300ms with initial260msdelay, and outgoing cleanup300ms after exit activation. A pre-activation interruption becomes opaque; an already-active snapshot continues its original fade.

The high-frequency native DOM trace proves live96px work becomes24px summary plus answer within12ms, with no exiting nodes. The earlier interpretation of Gn's conditional disclosure animation was wrong. Live work is replaced atomically at the first visible answer, with emptyfinalplaceholders still showingThinking. Search numbers have their own400msenter/150msexit animation and stable surrounding label. See exact-lifecycle/comparison-agent for independent iteration findings and exact-lifecycle/final-review.md for final verification and remaining capture limits.
