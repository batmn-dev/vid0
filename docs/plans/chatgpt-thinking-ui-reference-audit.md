# ChatGPT thinking lifecycle reference audit

Source: `/Volumes/Batdrive/ANDRESTHEDESIGNER/Shared Content/Screen/chatgpt-thinking-ui.mp4`.
Reviewed entire 84.181s clip at one-second cadence, with 0.5s detail frames and original 20fps detail around work auto-collapse and manual toggles. Video resolution 936x1080. Measurements below are video pixels, not verified CSS pixels; root is independently obtaining DOM values. Raw video remains the motion source of truth; contact sheets do not prove motion alone.

## State and interaction sequence

| Video time | State / interaction |
|---|---|
| 0–3.1s | Prompt already populated on new-chat page, High reasoning selected. Mouse moves to Send and tooltip appears. |
| ~3.2–3.7s | Send clicked; prompt moves into user bubble, composer becomes bottom follow-up field with stop button. |
| ~3.7–8.0s | Standalone muted `Thinking` at assistant content left edge. No work header, avatar, card, border, timeline or spinner. Text has moving light highlight. |
| ~8.1–8.8s | First intermediate narrative streams in normal assistant body typography. It replaces initial Thinking. No artificial reasoning title. |
| ~8.8–9.5s | Completed intermediate narrative, then fresh trailing `Thinking` below it. |
| ~9.5–11.5s | Trailing row becomes globe + `Searching venture capital tech news September 8 2026 startup funding AI deals`. Single line, muted highlighted text; fixed icon slot. |
| ~11.5–28.5s | Row becomes `Searching 18 websites`; leading favicon changes through result sites about once every 1.2–1.5s. Count stays fixed. Moving highlight continues in label. No public list yet. |
| ~28.7–29.6s | Row changes to `Searched 18 websites` and stops highlighting. New intermediate paragraph streams beneath. |
| ~29.6–32.5s | Second narrative complete, then a fresh `Thinking` trailing row. First search summary stays between narratives. |
| ~32.5–36.4s | Trailing row `Searching 10 websites`; globe initially then cycling site favicon. |
| ~36.5–41.2s | Trailing row changes to `Focusing on the roundup` without icon. **Second searched row is not separately visible during this stage.** The first completed search row remains. |
| ~40.6–41.2s | User hovers first Searched row: text darkens and trailing right chevron appears. No click/expansion before auto-collapse. |
| 41.20–41.30s | **Automatic transition:** all prior intermediate narrative/tool activity vanishes, replaced at original assistant start with muted `Worked for 36s` + right chevron. Final answer immediately begins below. No gradual height animation visible in this 100ms interval. |
| 41.3–~48s | Final answer streams independently under collapsed work header; header stays unchanged at 36s even as answer generation continues. |
| ~49–64s | User scrolls down through final answer. Stop button later returns to voice button when complete. Ordinary numbered paragraphs and citations. |
| ~64.5–65.5s | User scrolls back to assistant start, exposing collapsed work header above final answer. |
| 66.35–66.65s | User clicks Worked for 36s. Chevron rotates down, activity expands with height + opacity transition, pushing final answer downward. Header remains anchored. |
| 66.7–68.2s | Expanded work contains first narrative, Searched 18 websites, second narrative, **Searched 10 websites**. Both search lists start collapsed. No raw Focusing on the roundup text retained. Full-size narratives use same typography as final answer. |
| ~68.4–69s | Click first Searched row; source list opens inline below. Seven site chips + `11 more`, arranged as natural wrapped inline flow, 4 items first row and 4 second row at this width. |
| ~69.8–70.3s | Click second Searched row; list opens with seven sites + `3 more`, wrapping to 3 rows at this width. |
| ~71.6–72.2s | Click 3 more: second list expands all 10 sites, final control becomes `Show less`; extends to 4 rows. Hovering a site turns its existing chip dark with white text. |
| ~73.3–74s | Click 11 more: first list expands all 18 sites, final control Show less; extends to 5 rows. |
| ~74.9–75.5s | Click first Searched row again; its entire source list collapses. Second source list remains expanded. |
| 76.55–76.80s | Click Worked header; entire work collapses with height + opacity animation, final answer slides upward. |
| 77.55–78.0s | Click Worked header again; whole activity reopens with animation. **Both nested search lists are reset to collapsed**, including second list that was open before parent collapse. |
| 78.65–78.95s | Click Worked header; collapses again with animation. |
| ~80.6–82.6s | OS launcher overlays browser; unrelated to target UI. |
| 83–84.18s | Browser visible, work still collapsed. |

## Reference pixel geometry

All coordinates refer to full 936x1080 video, assuming stable content before scrolling. CSS mapping is unverified because the capture is scaled.

- Main narrative left x318, content right about x821, effective width ~504px. User bubble x468–822, y88–177.
- Initial Thinking top approximately y215, same x318 as narrative/final answer. No leading reserved icon space for Thinking or reasoning-summary text.
- First intermediate narrative top y215, 3 lines at ~19px baseline interval, bottom ~264. Body glyph height ~12px; appears normal weight with bold markdown spans. Final answer uses same size and line height.
- First running search row icon x319–332 (~13px), text x340, top y285. Row line height ~19px, ~17–20px gap after preceding narrative painted bottom.
- Second narrative top ~316, 4 lines, bottom ~383. First completed search text top ~285. Narrative starts ~31px after search label top.
- Second running search top ~405; later reasoning summary top ~405 without icon, x318.
- Collapsed Worked header top ~215, text x318, right chevron x412–420. Final answer first line top ~247: ~32px top-to-top delta.
- On full work expansion: Worked top~215; first narrative top~247; first search top~316; second narrative top~347; second search top~435; final answer top~467. Expanded work moves final answer down ~220px while header stays at y215.
- Search rows use same ~12–13px apparent text size as body but muted; hover becomes near-primary. No row container background on hover.
- Search collapsed right chevron is hidden at rest and appears on hover. Down chevron is visible when list is expanded. Worked header chevron stays visible in both states.
- Source chips appear ~9px text with ~10px favicons, ~23px row pitch and minimal subtle pale gray backgrounds; they are much smaller than narrative and row labels. Layout is content-width wrapping, not equal-width grid. No bordered cards or full URLs (protocol/path omitted; observed displayed domains often retain www.).
- First source list 7 sites + 11 more: source rows painted top around y347 and y370 when overall work is expanded. Collapsed list adds approximately 52px to work height. More control includes a small overlapping favicon pair then count label.
- Expanded row label icon remains fixed to first source favicon (first search) or globe (second search), not a rotating pending indicator.
- Source hover uses the existing inverse chip surface. Authenticated DOM inspection found no tooltip, title, or aria-describedby; the earlier video-only tooltip interpretation was incorrect.

## Motion and timing findings

- Pending text has a horizontally traveling brighter band: this is not whole-label opacity pulsing. A direct CSS capture is needed to reproduce exact gradient/easing; video alone does not establish color values or duration precisely.
- Search favicon swaps occur periodically (~1.3s observed); text label remains fixed so there is no width/layout wobble.
- Initial narrative appears in streamed chunks, then cursorless stable paragraphs. New final-answer text also appears in small chunks. Avoid inventing a typewriter cursor or block skeleton.
- Automatic transition into final response is effectively atomic in captured video (41.20 prework,41.25/41.30 final). This differs from user-driven manual work toggles.
- User-driven work open/close uses roughly 250–350ms, with height change and fading activity. Repeated expand at77.55 is visibly settled by78.0; collapse at78.65 settles by78.95. Header text stays anchored. Final answer moves as content flow, not absolute overlay.
- Closed→open first interaction 66.35 begins, activity barely visible66.40, largely shown66.50, stable position about66.65. Video contains motion blur from recording, so do not reproduce the blur as CSS filter.
- Parent collapse/reopen discards nested search expansion state, proven at76.5 versus78.0.

## Acceptance checks for implementation comparison

1. Initial blank run has only trailing Thinking at same narrative origin.
2. Intermediate narrative is full-size assistant markdown, ordered with tools; no permanent top Thinking wrapper.
3. Each new reasoning/tool stage occupies latest trailing row; completed tools preserve chronology.
4. Final-answer onset collapses all prior activity once; timer freezes at work duration, not entire assistant response length.
5. Manual work open restores both narratives and both completed search groups, no thinking summary duplicate.
6. Work and search toggles support pointer + keyboard and respect reduced motion.
7. Nested source list has 7 + remainder, more/less, inverse chip hover, wrapping, hover-only collapsed chevrons.
8. Parent reopen resets nested search expansions.
9. Same matched viewport/theme/body typography and exact live DOM tokens; video pixels cannot prove CSS colors.
10. Test generation with tools and generation without tools, abort/error while work active, completion while manually expanded, and reload of persisted completed message to prevent lifecycle regressions. These latter scenarios are robustness criteria, not all evidenced by supplied clip.

## Artifacts

- `overview.jpg`: 1fps full clip overview (small panels; indexing aid only).
- `initial-*.jpg`, `search-*.jpg`, `tools-*.jpg`, `response-*.jpg`, `interactions-*.jpg`, `end-*.jpg`: readable timeline contact sheets.
- `auto-grid-*.jpg`: 100ms timeline at automatic work collapse.
- `open-grid-*.jpg`: 100ms timeline at first manual work expansion.
- `toggle-grid-*.jpg`: 100ms timeline at repeated parent toggles.
- `auto-*.png`, `open-*.png`, `toggle-*.png`: original 50ms detail frames.
- `t09.png`, `t35.png`, `t71.png`: full frames showing narrative/active work/source disclosures.

Implementation verdict pending: root retains Chrome ownership until implementation handoff.

## Continued authenticated comparison

- Search triggers occupy the full 640px content row. The work-summary trigger remains content width, 131.71875px.
- Chips have a negative 4px leading favicon margin. The remainder chip overlaps three favicons, with 12px content plus 1px borders. Measured first-search widths: 134.25, 181.3125, 111.6171875, 145.3125, 102.4921875, 123.390625, 161.46875px; remainder 93.2890625px.
- Historical reopening uses only the parent 300ms height and separate inner 300ms opacity transitions. The per-item 700ms and 260ms entries are inactive on historical expansion. Live reference inspection confirmed all item opacities stayed at 1 while the containing layer faded.
- Initial insertion needs a CSS starting style on the opacity child: browser sampling caught the child appearing at full opacity without it. Corrected local opening measured opacity 0, .006, .023, .056, .159, .232, .314, .405, .595, .686, .765, 1.
- Live streamed text growth needs explicit measured height targets. An unchanged Motion `auto` target does not animate newly wrapped lines. A cleaned-up ResizeObserver measures the natural inner height, skips identical values, and preserves only the remaining initial entry delay. Local browser samples include intermediate heights between 24, 48, and 72px.
- At 36.0–36.5s, the latest search and incoming reasoning occupy the same 24px slot. Source CSS has a 150ms ease exit and 260ms ease entry, with the outgoing content absolutely positioned. The local replacement retains the same item identity and crossfades without moving prior paragraphs or replaying the 700ms entry.
- Unresolved: the reference's second completed search uses a native globe even though its first source has a favicon; the provider rule selecting that marker is not established. Do not hardcode a search ordinal to imitate this one recording.
