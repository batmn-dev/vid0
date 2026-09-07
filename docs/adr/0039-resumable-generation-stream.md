# 39. Reconnect to an execution's retained UI stream

- Status: implemented; no-rewind restoration verified in production
- Date: 2026-09-05
- Supersedes: ADR-0008's exclusion of stream resumption
- Preserves: ADR-0011 settlement, ADR-0013 navigation ownership, ADR-0016 immediate rendering

## Decision

Retain ordered AI SDK UI message chunks in a short-lived Redis Stream per generation run. Convex remains authoritative for ownership, selected branch, Stop, approvals, checkpoints and terminal messages. Redis holds replay data, not a second generation lifecycle. Reconnection is an authenticated read of the currently selected, owned run and never starts generation.

The initial browser keeps its direct HTTP stream. A concurrently consumed copy writes replay data independently of that browser. This preserves initial token latency, with the explicit tradeoff that a sudden producer failure can lose output not yet retained or checkpointed. Checkpoints remain enabled. A missing replay never silently starts the model again.

A refreshed browser starts an authenticated reconnect before its Convex WebSocket subscription hydrates. The same owner-checked route resolves the selected run and supplies its selected message path. This removes the client-auth/subscription waterfall without weakening the subscription auth gate or introducing a second lifecycle authority.

The refreshed document restores the selected saved messages immediately, without clearing the assistant's parts. The retained stream reconstructs the SDK state silently from its immutable starting state; the caught-up fence publishes the restored answer once, then live chunks publish at their arrival cadence. Historical output has no pacing or typewriter animation. A subscription checkpoint already displayed, or a transient reconnect's visible prefix, is never replaced with a shorter prefix. Replay does not execute client tools, auto-submit approvals, or call initiating-turn finish handlers.

Checkpoint adoption compares visible content in the representation the checkpoint preserves. Live Convex checkpoints aggregate reasoning and text and omit SDK step boundaries; those checkpoints require cumulative reasoning and text prefixes independently. Invisible `step-start` parts do not participate in comparison. Checkpoints containing structured parts retain ordered per-part guards for text, tools, data, sources and files. Rewriting checkpoint persistence to retain full SDK structure is unnecessary for this handoff.

An ephemeral exact assistant identity bypasses Markdown decay during reconstruction. It never enters message metadata or persistence. Incremental parsing and the existing live-stream paint treatment remain in place.

Conversation scroll placement is armed by local submission or preflight, never by streaming status alone. The exact submitted user turn stays armed through its native stream and first-send URL adoption; settlement or another chat clears it. A resumed GET therefore cannot re-pin the prompt after the reader scrolls into the answer.

The Markdown offscreen-layout optimization excludes semantic list roots and blocks containing lists, including blockquotes. A partial next item can briefly parse as a sibling paragraph, which previously switched a long list into first-time containment with a 3rem fallback. Chrome then clamped the scroll position as the apparent content height collapsed. The exclusion persists after settlement so a concluding paragraph cannot trigger the same transition. Blocks without lists retain containment; offscreen lists trade that optimization for correct geometry.

Successful server completion does not cut an exact retained reader while its historical output is still reaching the screen. The shared presentation resolver keeps that reader active until it drains. Stop, branch changes and new Send/regenerate commands disconnect it immediately. Terminal content and generation ownership remain authoritative in Convex.

Approval continuations reuse messages but create new runs: the Redis key belongs to the run, never the assistant message alone. An approval pause closes the execution; the next execution gets a new replay log and starting message.

## Alternatives

- Snapshot smoothing retains the coarse transport cadence. Rejected in favor of replaying retained structured chunks.
- Visibly paced replay of the entire history was tried and rejected by the user: refresh should restore existing text and continue from there. Earlier comparison observations were insufficient grounds to make replay-from-the-start the product behavior.
- Bare Redis Pub/Sub with producer-memory replay is smaller, but drops replay when the producer dies and cannot recover missed publications by cursor.
- Durable Streams has a suitable protocol but its published AI SDK adapter targets SDK 6; this project uses SDK 7 and does not already operate its production service.

The official Redis client is the one new dependency. Redis Streams supply cursor-based history and live reads without a separate Pub/Sub attachment race. Redis is optional for existing deployments; configure `CHAT_STREAM_REDIS_URL` to enable replay. Development defaults to a loopback Redis instance. Production has no implicit Redis address.

## Verification requirements

Prove refresh during real model output in authenticated Chrome; restore the retained prefix without replaying it from the beginning, resume granular updates and reach the final saved answer. Preserve the visible prefix on transient reconnects within the same document. Cover replay ordering, cancellation, preparation/completion races, approval baseline and authorization with focused tests. Do not claim worker-crash continuation: the existing lease and checkpoint lifecycle handles interrupted execution.

### No-rewind restoration verification (2026-09-05)

The user rejected replay-from-the-start after directly testing localhost:3002.
The receiver now restores selected messages intact and silently reconstructs
retained history, then publishes live updates. The [earlier experiments](../performance/2026-09-05-stream-resumption-verification.md)
are historical and do not define the acceptance criterion.

Authenticated Chrome, optimized localhost:3002, GPT-5.6 Luna/Off: 4,987 rendered
characters before full reload; first sampled restored text was 5,317 characters
at 931 ms, followed by live growth to 10,797. No sampled restored prefix was
shorter than the pre-reload answer. The completed 21,950-character answer matched
exactly after another full reload. Raw timestamped screenshots, DOM samples and
completion equality are in `output/playwright/stream-parity-polish/wrapper-no-rewind/`.

Focused validation passed 66 tests, targeted ESLint, typecheck and optimized
Next.js build. Independent installed-SDK probes covered text, metadata and
partial tool JSON at the catch-up boundary. The [before/after video](https://drive.google.com/file/d/1HHeqTFCWfx6DFbl2luawIqPNQhs9SkEL/view)
labels the old paced replay and the corrected restoration behavior; timing is preserved.
This browser verification preceded production deployment.

### Hosted Redis and PR verification

The production Vercel project now has a dedicated Upstash Redis instance in
`iad1`, on the free plan with automatic paid upgrades disabled. Its TLS URL is
configured as the server-only `CHAT_STREAM_REDIS_URL` secret. Local Redis remains
separate. The hosted service exposed a request-size constraint absent locally:
records and starting state now have a 1 MiB preflight cap, and the existing
16 MiB total limit is checked before sending as well as atomically in Redis.
Oversized retained output falls back to checkpoints without poisoning the client.
All five Redis integration tests pass against the hosted instance.

### Production checkpoint handoff correction (2026-09-06)

The first production verification after PR #181 restored 9,766 characters from
a pre-reload 9,472-character answer, but then froze until terminal persistence.
Redis continued receiving chunks and the authenticated retained route returned
200. The SDK reconstructed `[step-start, text]` while the live checkpoint held
`[text]`; comparing part indexes rejected every replay publication. Local browser
evidence therefore did not establish production acceptance. Production-shaped
SDK frames reproduce this failure and cover the corrected adoption rule above.
The [fresh production acceptance](../performance/2026-09-06-stream-restoration-acceptance.md)
on corrected deployment `5ed93b1f` passed: two live reloads preserved the sampled
prefix and resumed granular updates before completion. The completed rendered
answer matched exactly after another reload. A focused SDK receiver test covers
same-document transport interruption and prefix-preserving retry separately.

## References

- [Theo's Redis resumption explanation](https://www.youtube.com/watch?v=gZ4Tdwz1L7k&t=3294s)
- [Redis Streams reads](https://redis.io/docs/latest/commands/xread/)
- [AI SDK stream reader](https://ai-sdk.dev/docs/reference/ai-sdk-ui/read-ui-message-stream)
