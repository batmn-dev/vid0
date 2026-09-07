# To Do

- **Model presentation: Improve how models display across the UI**
  - Make model logos appear during thinking states to make assistant output ownership clear
- **Per-turn effort, platform-funded UX (ADR-0026 v1 follow-up):** two accepted
  nuances to review and tackle: (1) platform-funded turns silently run at the
  provider default even when the resolved route supports the requested level —
  requested and the concrete provider default are both recorded so the badge and
  reopened composer stay honest, but the composer gives no hint before sending.
  Decide between surfacing an affordance ("effort applies on your own key / paid
  usage") and implementing effort-scaled reservations. (2) An effort
  selection can steer resolution off a platform-entitled route onto the user's
  own BYOK key when only that route serves the level — capability-correct, but
  it silently shifts cost onto the user's key; decide whether that needs
  disclosure in the composer or a funding-tier preference in the resolver.
- **Web Search modes and quantity controls:** Think through how the Composer
should expose an **Always** option that lets users force `web_search`, alongside
the existing Off and Auto behavior where the model decides whether to search.
Research and implement the multiple search-quantity controls exposed by
t3.chat, including their interaction model and request-level mapping.
- **Progressive Activity UX:** Inline thinking/status exists. Add progressive
reasoning and intermediate text in the thread; retain full Activity-panel history.
- **Chat composer text editing:** Add chat composer text / markdown editing (link, bold, italic, headings, etc...)
- **Dictation:** Add chat-composer dictation
- **Image generation:** Nano banna and state of the art image gen tools (Using Vercel's SDK Framework)
- **Video generation:** Using Vercel's SDK framework
- **Admin Portal:** A way to manage users, controls, features, etc...
- **Automatic conversation context management:** replace the current
context-limit hard stop with model-aware input budgeting that reserves space
for instructions, tool schemas, attachments, and output. Before the selected
path exceeds its budget, derive a versioned summary checkpoint for older
completed turns while retaining recent turns verbatim and preserving the full
canonical transcript, branch/edit/regeneration semantics, tool outcomes, and
source provenance. Make compaction idempotent, observable, and visible to the
user; fall back to an explicit hard stop when safe compaction cannot fit. Cover
authenticated and guest chats, model switches, attachments, and multi-step
tool turns with cross-provider tests and token/compaction telemetry.
- **Durable long-running generations:** Move provider execution beyond the
initiating HTTP request's lifetime. Preserve Convex ownership, live snapshots,
Stop, supersession, recovery, and usage settlement. Document the execution and
cancellation model in an ADR.
- **Project-scoped agent context:** let each project define shared instructions,
knowledge and files, tool or connector permissions, and optional durable
memory that are automatically available to every chat in that project, similar
to project-scoped contexts in modern AI chat products. Make context precedence,
token budgeting, provenance, access control, versioning, and user-visible
reset or opt-out behavior explicit so project chats remain reproducible and
do not leak context across project boundaries.
- **Voice Mode:** Using Eleven Labs
- **Assistant Response UI Widgets:** Image Carousels, Image Previews, Weather, Stock UI, Charts (maybe), editable markdown (maybe)
- **Monetization:** Setup Usage-based monthly pricing using Stripe or better option
- **Agent-first file library:** Create a computer-like environment where agents can easily discover files?
- **Evaluate inference on Fluid:** From [Theo's post](https://x.com/theo/status/1997784385337372877)
- **Retained-stream admission:** Bound concurrent replay readers per user across
instances using existing admission patterns. Measure Redis usage and preserve
refresh and multi-tab recovery.
- **Evaluate Vercel's BotID:** Assess bot attestation for platform-funded
turn admission, including compatibility with guest access and existing limits.
- **Connectors:** Integrations with Google, YouTube, Figma, and personal tools
- **Agentic design system (future):** Define an agent-readable, customizable
visual system after the product's core interaction patterns stabilize.
- **Thread code splitting:** Measure and defer remaining charts and Composer
extras; audit client Zod imports. Verify reduced cold-load JavaScript without
regressing typing, first-send latency, or first-text rendering in the browser.
- **Warm chat navigation:** Improve revisited-thread paint latency using the
existing cache and warming paths (ADR-0031). Measure visited/unvisited p50/p95
and verify bounded subscriptions and memory after 50 switches.
- **Investigate visibility-gated chat hydration (replicate T3 Chat):** observed
on 2026-09-02 while benchmarking against t3.chat: their chat client does not
finish hydrating while `document.visibilityState` is `hidden`. The composer
stays a disabled server-rendered shell (send button disabled, model picker
reads "Loading…", no React props on the textarea) until the tab is actually
shown, then boots normally; our app hydrates and streams fully in a hidden
tab. Plan: confirm what they gate (hydration itself, the model catalog and
sync-engine boot, or both), then prototype a `visibilitychange`-deferred boot
for the chat surface behind an env escape hatch so the harness and hidden-tab
automation keep working. Verifiable test: open the app in five background
tabs before and after and record, until the first time each tab is shown,
renderer CPU time and memory (Chrome task manager or
`performance.measureUserAgentSpecificMemory`), bytes transferred, and open
Convex subscriptions; then show a tab and measure time from visible to a
working composer. Expected: near-zero subscriptions and chat JS execution
while hidden, and a composer that accepts input within 500 ms of becoming
visible.
- **Evaluate effort-level naming: API accuracy vs provider-interface parity:**
the composer's effort menu labels are the wire values spelled out
(`lib/reasoning-effort.ts`: `none` → "Off", `xhigh` → "Extra High", `max` →
"Max"), which ADR-0026 chose as "the honest provider-level names, not invented
tiers". The providers' own products do not use those words: T3 Chat and
ChatGPT show "Instant" for OpenAI's `none`, Anthropic's console groups
`output_config.effort`, and xAI/Google expose their own scales. Decide, per
level and per provider, whether the label should track the API value (stable,
greppable, matches docs and the request-shaping code, but "Off" next to a
model that still reasons a little is misleading and "Extra High/Max" read as
invented) or the provider's consumer-facing name (recognizable to users coming
from ChatGPT/T3, but a single label table then lies for other providers that
share the wire value, e.g. Grok 4.3's `none`, and names drift with each
provider's marketing). Options to weigh: keep API names; per-provider label
overrides in the catalog (ADR-0020 discipline: a route fact, not a UI
constant); or API name as the primary label with the provider's word as
secondary text or tooltip. Verifiable test: a five-person label-comprehension
check with the three benchmark models (which option makes users pick the
level they intended for "fastest reply" and "deepest reasoning"), plus a
catalog test asserting every declared `effortLevels` value has a label per
provider so no route can render a wrong or missing word. Expected outcome: a
short ADR-0026 amendment recording the rule and the label source of truth.



## Dependency watch

- **AI SDK stable approval-persistence hook:** Evaluate a stable replacement for
`experimental_transform`. Require approval persistence before forwarding,
backpressure, abort propagation, multi-step support, and settlement ordering;
preserve ADR-0009 ownership.
- **Research and implement Anthropic** `pause_turn` **continuation:** check the
  latest AI SDK and Anthropic provider behavior against Anthropic's replay
  contract, and measure production incidence by model and search configuration.
  If no released SDK fix exists, build a provider-boundary continuation adapter
  that replays paused assistant content with the same tools, bounded
  continuation, abort propagation, deduplicated parts, and exact aggregate
  usage. Until those guarantees are tested, retain the catalog-scoped
  fixed-thinking search workaround only for Claude 4.6 models that still accept
  `budget_tokens`; never apply it to adaptive-only models. Remove
  `searchThinkingDowngrade` after the continuation path is proven.
- **Signed tool approvals:** Assess whether SDK signatures close a concrete gap
in Convex-authoritative approvals. Validate end-to-end signature preservation,
pending unsigned approvals, and shared-secret rotation before adoption.



## Correctness and maintenance

- **Document nuanced motion-performance exceptions:** update the front-end
guidance to distinguish the default prohibition on continuously repainting
animations from narrowly approved, behavior-critical exceptions. Require a
bounded live-state lifecycle, reduced-motion fallback, and measured profiling
before assigning severity or changing established behavior; prefer a
compositor-friendly equivalent when it preserves the same interaction and
visual result.
- **Routine compatible dependency refresh:** Update compatible direct and
transitive dependencies and the declared Bun version. Audit the lockfile and
run the normal project checks.
- **Staged major dependency upgrades:** Evaluate TypeScript, ESLint, jsdom,
Motion, and Recharts separately. Verify runtime and tooling compatibility;
validate each upgrade with focused checks.
- **Assistant responsiveness:** Rendering optimizations shipped; end-to-end
responsiveness remains open. Measure TTFT with chat-performance spans, quantify
the platform-funded title-usage wait before settlement, and verify streaming
smoothness in the browser.
