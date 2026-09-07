# Stream restoration production acceptance

Verified 2026-09-06 in the user's authenticated Chrome profile, GPT-5.6 Luna,
Thinking Off. No runtime changes were required: PR #182's checkpoint adoption
correction was already deployed.

## Build and conversation

- Commit: `5ed93b1f59c3928d02f8a1c28e7da88b2b49990c`.
- Vercel deployment: `dpl_BJSWLd7aDjC16P8bicHvQkgfrmyE`, READY, production.
- Deployment URL: `not-a-wrapper-isr40uy0h-team-andres-the-designer.vercel.app`.
- Vercel metadata confirmed aliases `not-a-wrapper.com` and `www.not-a-wrapper.com`.
- GitHub deployment `6289951277` reported success at `2026-09-06T06:29:04Z`.
- [Acceptance conversation](https://www.not-a-wrapper.com/c/5109f091-19f0-4cbc-88ff-cede0d213f10).

Prompt: request an original 4,000-word detective story about a cartographer in a
lighthouse whose rooms move at midnight, continuous prose without headings,
lists or tools, ending “The lighthouse finally stood still.”

## Observations

Samples read the assistant DOM element's `textContent` and
`data-perf-text-length`. The latter counts source text, including Markdown;
prefix and equality checks compare the actual rendered DOM text separately.
The [content-free comparison evidence](2026-09-06-stream-restoration-evidence.json)
records exact equality and prefix booleans with the captured sample sequences.
Timestamps below are Unix milliseconds. Stop remained visible during every
nonempty live sample and was absent at completion and after the final reload.

| Observation | Timestamp | Source characters | Rendered characters |
| --- | ---: | ---: | ---: |
| Before reload 1 | 1788708081151 | 4,363 | 4,275 |
| First sampled nonempty answer after reload 1 | 1788708087662 | 6,632 | 6,502 |
| Last sample in first live burst | 1788708087810 | 6,674 | 6,542 |
| Before reload 2 | 1788708095792 | 9,549 | 9,337 |
| First nonempty answer after reload 2 | 1788708097253 | 9,723 | 9,505 |
| First sample in second live burst | 1788708104152 | 12,347 | 12,039 |
| Last sample in second live burst | 1788708104461 | 12,426 | 12,118 |
| Completed answer | 1788708180574 | 28,560 | 27,706 |
| Saved answer after final reload | 1788708190194 | 28,560 | 27,706 |

Both reloads preserved the full pre-reload rendered prefix in all sampled
nonempty answers. The first reload has a sampling gap: its first nonempty sample
was 6.5 seconds after the baseline, so it does not measure initial restoration
latency. The second reload was sampled continuously through page hydration:
16 samples contained no assistant element, then the first restored answer
preserved the prefix at 1,461 ms after the baseline. The empty document during
reload is distinct from displaying a shortened answer.

Granular source-length samples after reload 1, over 148 ms:
`6632, 6637, 6637, 6640, 6648, 6655, 6660, 6674`.
After reload 2, over 309 ms:
`12347, 12360, 12360, 12363, 12369, 12375, 12376, 12376, 12379, 12379, 12379, 12379, 12380, 12380, 12388, 12388, 12408, 12424, 12424, 12426`.
These updates occurred before terminal persistence, ruling out the previous
freeze-until-completion behavior in this run. The final 27,706-character rendered
answer matched exactly after reload and contained the requested ending.

## Focused coverage and limits

The receiver suite passes 22 tests, including a new same-document interrupted
transport test using the installed AI SDK reducer. It closes a retained response
without an end frame, verifies the retry keeps the longer visible prefix while
history catches up, then publishes new live output without calling generation
or finish callbacks. Server Redis integration and authenticated route coverage
pass another seven tests against existing local Redis.

The browser run exercised two full reloads of one real text generation. Network
fault injection was covered by the deterministic receiver test, not by changing
browser or system connectivity. This is not worker-crash continuation, a provider
matrix, or browser acceptance of tool/approval continuations.
