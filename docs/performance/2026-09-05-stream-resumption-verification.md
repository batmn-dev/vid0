# Stream resumption verification history

These local experiments explain how the implementation evolved. Paced historical
replay was superseded. The current contract and final evidence are in
[ADR-0039](../adr/0039-resumable-generation-stream.md).

### Prior recovery evidence (2026-09-05; insufficient UX parity)

Authenticated Chrome, localhost:3002, GPT-5.6 Luna: a full document reload during
run `js7cf7rtv6xrqrvj6je0g1gwh58dv223` reconnected by GET to the same run. The
1,420-character pre-refresh prefix survived; 26 nonempty live DOM samples after
rehydration grew from 3,302 to 8,000 characters without prefix regression. The
final 12,016-character answer matched exactly after a subsequent completed-page
reload. A separate 28,177-character response also resumed and matched exactly
after completion and reload. Loading skeletons during document/auth rehydration
are expected; this does not promise a page reload with zero loading time.

The review video and raw timestamped browser captures are local artifacts under
`output/playwright/stream-refresh/`. The video labels its cut from live streaming
to the later completed-answer reload. Captures preserve observed timing within
each segment; they do not synthesize intermediate token frames. This proves local
browser recovery, not production deployment, worker-crash continuation, or a
browser-cache purge guarantee. Production still requires `CHAT_STREAM_REDIS_URL`.

UI verification also exposed a shared Stop-button race: Stop can synchronously
change the same element into a submit button. Its click now prevents the browser
default before changing state so a waiting composer draft cannot be submitted.
The corrected live Stop test retained exactly one user/assistant pair and the
waiting draft after reload. Stop retains the existing server checkpoint cutoff:
the test's persisted aborted answer ended 27 characters before the last locally
observed tail. Retained replay does not change that cancellation boundary.

### Earlier T3 Chat comparison (2026-09-05; insufficient parity criterion)

Authenticated Chrome, GPT-5.6 Luna Instant, identical 40-paragraph prompt: a
full reload from 12,067 visible characters showed progressive replay of
1,318 → 3,565 → 5,917 → 7,163 → 9,055 → 10,944 → 13,528 characters, then
normal live growth. The first observed text was 1.67 seconds after reload;
the pre-reload text was caught up by 3.60 seconds. Those sampled prefixes were interpreted as a requirement to animate all retained
text. The user's direct testing rejected that interpretation; the intended UX
restores old text immediately and resumes new output.
Raw timestamped screenshots and DOM samples are in
`output/playwright/stream-parity/t3/capture.json`.

### Prior paced-replay verification (2026-09-05; superseded)

The optimized Next.js build on localhost:3002 used the same model and prompt.
During the recorded full reload, 10,591 characters had already arrived. The
first sampled text appeared 1.29 seconds after reload, then grew through
2,304 → 5,321 → 8,342 → 12,116 characters, catching the pre-reload prefix by
3.19 seconds. Subsequent live samples continued growing to 17,641 characters.
The completed 22,879-character answer matched exactly after another full reload.
These are sampled browser observations, not precise frame latency guarantees.

The [comparison recording](https://drive.google.com/file/d/1j8AjTed87PZKN8mcVMuHfEWIrEcY5hMj/view)
shows both apps with a labeled cut to their later live tails. The
[phone recording](https://drive.google.com/file/d/1X2tNjUGBdScd8HjTA_75j6h7cP5NM4sj/view)
shows Wrapper continuously, including a manual scroll after reconnect.
Both preserve actual screenshot timing without synthesized text or speed-up.
Raw screenshots, DOM samples and completion equality evidence are under
`output/playwright/stream-parity/wrapper-corrected/`; the matched reference
recording is under `output/playwright/stream-parity/t3-final/`.

Independent review found and helped resolve early-discovery Stop, completed
replay drain, and new Send/regenerate ownership races. Final verification passed
2,943 tests (one skipped), typecheck, lint and the optimized Next.js build.
Nested agent checkouts were excluded from test and lint discovery. This verifies
the observed local replay pattern; production deployment and production Redis
configuration remain separate work.

### Prior parity polish (2026-09-05; replay policy superseded)

Independent artifact review led to bounded splitting of historical deltas,
readable replay without the decay overlay, preservation of an already-painted
checkpoint, and submission-only scroll placement. Further live tracing identified
the semantic-list containment collapse described in
[ADR-0039](../adr/0039-resumable-generation-stream.md). Temporary diagnostics
were removed before the final build.

The new matched-model/prompt comparison uses real timestamped screenshots in
`output/playwright/stream-parity-polish/`. Wrapper reloaded with 7,636 visible
characters: the first sampled text appeared after 797 ms and caught that prefix
by 2,433 ms. T3 reloaded with 5,164 characters, first sampled text after 1,964 ms,
and caught up by 2,437 ms. Different retained lengths and provider cadence mean
these observations do not establish a general latency ranking.

After manual scroll, Wrapper held scrollTop 2569.5 while output grew from
9,893 to 12,433 characters. The completed 22,254-character answer matched exactly
after another full reload, with one user and one assistant message. Independent
review of the new video confirmed progressive readable replay and no scroll
reset. Existing live-tail fading and provider cadence remain visibly different;
the recording demonstrates the targeted recovery behavior, not universal visual
identity across every model or Markdown shape.

The [updated comparison video](https://drive.google.com/file/d/1MhblZ5qkHbh_FUCW9W4YODLwMlVpGTbE/view)
preserves capture timing and labels the cut to later live output. Full video
decode passed. Final focused validation passed 70 tests, typecheck, targeted
ESLint and the optimized Next.js build. This remains local verification on
localhost:3002; production had not been deployed at this verification point.

## PR benchmark dependency normalization

The Redis dependency addition initially stopped the paired CI benchmark before
measurement because its lockfiles differed. The runner now permits only additive
production dependencies with every baseline package resolution, existing manifest
setting and workspace setting unchanged. It installs the head manifest and lock
in the isolated baseline checkout, then retains the identical-lockfile check.
Dependency upgrades/removals and fixture or timing-helper drift still fail closed.

Both builds therefore use the same installed dependencies while retaining their
own product source. The manifest records the original baseline lock hash and all
added dependency/package names; the baseline diff records the normalization.
This measures product changes under common dependencies, not dependency-upgrade
performance. Five focused rejection/acceptance tests and validation against this
branch's real lockfiles passed. Hosted benchmark results remain authoritative.

**Amendment (2026-09-10).** The additive-only rule made every dependency
upgrade fail closed, including a server-only Convex component bump (PR #187)
whose client and route surface was byte-identical between base and head, and it
would have blocked the routine dependency refresh. The overlay now also permits
version changes of direct dependencies and dev dependencies, plus the locked
package additions, changes, and removals that follow from them; the head
manifest and lock are still installed in both builds, so the comparison keeps
its common-dependency footing and the responsiveness targets still judge the
head run in absolute terms. Removing a direct dependency, and any change outside
the dependency sets (scripts, lockfile settings, other workspaces), still fails
closed. The results manifest records added and changed dependencies and the
package delta.
