# Provider reasoning, commentary, and answer lifecycle at the API boundary

Research date: 2026-09-09. Branch `darknight/harvey-bullock` at `548ca357` (clean).
Author: research agent. Consumer: a separate implementation agent plus an
independent QA subagent. This document is self-contained; it does not depend on
the research conversation.

> **Status: implemented 2026-09-09; historical.** The decision record is
> `docs/adr/0041-provider-reasoning-boundary.md` and the outcome is Section 12.
> Sections 2 through 7 describe the pre-implementation state and the plan as
> written before the work; where Section 12 records a different outcome
> (Mistral `mistral-medium-3-5` and Perplexity `sonar-reasoning-pro` keep
> `reasoningText: false`), Section 12 and the ADR are the contract. Do not
> re-apply these steps.

## 1. Objective, scope, acceptance criteria

### Objective

Interpret each supported provider's reasoning, commentary, tool activity, and
final-answer events correctly at the API/evidence boundary, while every route
shares one UI lifecycle (`submitted → thinking → tooling → responding → settled`),
one inline-work renderer (ADR-0040), one persistence path, and one replay path
(ADR-0039).

### In scope

- Request shaping so that reasoning is actually returned where the catalog says
  `reasoningText: true` (Anthropic 4.7+/5 `display`, Mistral `reasoning_effort`).
- One shared text-phase reader and one shared reasoning-part classifier, so
  provider phase knowledge lives in `lib/chat-messages/turn-evidence.ts` and is
  consumed by the client projection, the durable work-summary tracker, and the
  replay prefix guard through the same function.
- Perplexity inline `<think>` normalization into reasoning parts at the server
  stream seam.
- Provider-neutral pre-answer duration (`workSummaryDurationMs`) for unphased
  tool turns so reload matches live.
- OpenAI replay preserving `phase` while still stripping server-linked ids.
- Verification of the answer-onset transition for unphased providers.

### Out of scope

- New dependencies or SDK upgrades (the installed `@ai-sdk/anthropic` 4.0.40
  rejects `display: "updates"`; see Open question Q3).
- Automatic `pause_turn` continuation for Anthropic (documented as optional
  step 9 with its mechanism; ship only if the smoke test shows real incidence).
- Any client-side pacing, reveal queue, or completion gate (ADR-0016 forbids).
- Redis/replay protocol changes. The retained stream already carries SDK chunks
  with `providerMetadata`; nothing here changes the frame format.

### Acceptance criteria

1. Claude Opus 4.8, Sonnet 5, and Fable 5 (direct routes) show streamed
   reasoning text in the Activity panel and inline work, not an opaque
   "Thinking" state, when reasoning effort is at any level. Verified by an
   authenticated Chrome run per model and by a request-shaping unit test.
2. Mistral routes with `reasoningText: true` either return reasoning parts
   (verified live) or their catalog flag is corrected to `false`. No route
   claims reasoning it cannot show.
3. Perplexity `sonar-reasoning-pro` renders no literal `<think>` text in the
   answer body; its reasoning appears as a reasoning part with a live timer.
4. For every provider in the matrix, a turn with at least one tool call and a
   final answer shows "Worked for Ns" with the same N (±1 s) live, after a
   hard refresh mid-stream, and after completion. Absent durations for legacy
   records stay absent (never fabricated).
5. OpenAI history replay sends `phase` on assistant message items and never
   sends `item_reference` ids (no `providerMetadata.openai.itemId` on replayed
   parts). Covered by the provider-request replay matrix test.
6. Exactly one function reads a text part's phase and exactly one classifies a
   reasoning part as visible/opaque/progress. `grep -rn "openai?.phase"` outside
   `lib/chat-messages/turn-evidence.ts` returns nothing in production code.
7. Answer onset, completion, Stop, error, and hard refresh never flash, drop,
   truncate, duplicate, reorder, or de-format visible text, for both phased
   (OpenAI) and unphased (Anthropic, Google, xAI, OpenRouter) turns. Proven by
   continuous video at normal speed plus DOM samples, not screenshots alone.
8. `bun run typecheck`, `bun run lint`, `bun run test`, and `bun run build:next`
   pass. `bun run build` is never run (it deploys production Convex).

## 2. Mandatory instructions for the implementation agent

1. Revalidate repository state before editing: `git status --short` must be
   clean or its dirt noted as user-owned; confirm installed versions in
   Section 4 with `node -p "require('./node_modules/<pkg>/package.json').version"`;
   re-run the grep commands cited in the evidence table for any adapter line you
   depend on (line numbers drift on upgrade).
2. Revalidate the three material research assumptions before coding (Section 10,
   Q1, Q2, Q4) with the smoke tests described there. Use the user's
   authenticated Chrome session on the user's own dev server (port 3000 is owned
   by the user's `bun dev`; never kill it). Use cheap models where the check is
   provider-shape only (GPT-5 Mini, Haiku 4.5, Gemini 3.5 Flash), and the
   specific model only where the finding is model-specific (Opus 4.8 display).
3. Implement Section 7 in order, preserving unrelated work and every existing
   streaming guarantee: snapshot throttling and version dirtiness, the terminal
   content-survival write, the retained-stream tee, ADR-0016 immediate
   rendering, the no-rewind restoration rule.
4. Launch a separate QA subagent (Agent tool, `general-purpose`) with this
   document and the diff. Give it these responsibilities: review the code
   against Sections 6 and 7; run the focused checks in Section 9; smoke-test
   the provider lifecycles in Section 9 through the user's authenticated Chrome;
   identify missing work; and directly correct defects within its file
   ownership. File ownership for the QA pass: QA owns `*.test.ts(x)` files it
   adds or edits and `docs/plans/provider-reasoning-lifecycle-boundary.md`
   status notes; the implementation agent owns production files. If QA must
   touch a production file, it names the file and the exact hunk in its report
   and the implementation agent applies it. Never edit the same file
   concurrently.
5. For visible lifecycle or animation changes (answer onset, work collapse,
   reasoning-to-text transition), use the `compare-ui` skill and review the
   continuous recording at normal speed. Check DOM samples (text length, part
   order, `data-inline-work-active-row`) and the source behavior. Screenshots
   alone do not prove streaming parity.
6. Explicitly verify that text does not flash, disappear, truncate, duplicate,
   reorder, or lose formatting at answer onset, completion, or hard refresh.
   Report delivery preservation (canonical text equality before/after) separately
   from visual animation correctness (no visible flash in the recording).
7. Integrate QA corrections, then request another independent QA pass after
   any material fix. Continue until Section 1 criteria pass or a concrete
   external blocker (provider outage, missing key, SDK limitation) is written
   down with evidence.
8. Report completed changes, validation evidence (commands, counts, artifact
   paths), remaining limitations, and blocked checks. Never claim parity or
   verification without the artifact that proves it.
9. Do not commit, push, or deploy unless separately authorized. Never run
   `bun run build`.

## 3. Provider, route, and model capability matrix

Sources for each row are in Section 4. "Direct" rows are hand-authored
records in `lib/models/data/*.ts`; OpenRouter rows are generated from the
snapshot plus allowlist (95 routes, 83 with reasoning; 22 of them map onto a
direct logical model via `logicalModelId`).

Legend: Vis = reasoning text visible on the wire; Phase = explicit
commentary/final-answer metadata; Interleave = reasoning can appear between
tool calls inside one turn; Opaque = signatures/encrypted blobs that must be
carried on parts.

| Provider (SDK) | Route(s) | Reasoning control the app sends today | Vis (documented) | Phase | Interleave | Opaque metadata | Search evidence shape | Title source |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI Responses (`@ai-sdk/openai` 4.0.45, `openai(id)` builds a Responses model) | gpt-5.6-sol/terra/luna, gpt-5.5, gpt-5.4(-mini/-nano/-pro), gpt-5, gpt-5-mini, o3 | `reasoningEffort` only on user override; `reasoningSummary: "auto"` always when `reasoningText` | Summary only, never raw (docs). Streams as `reasoning-{start,delta,end}` ids `rs_x:summaryIndex` | Yes: `providerMetadata.openai.phase` = `commentary` or `final_answer` on `text-start`/`text-end` | Yes: reasoning item per step; summaries only, `store` default true | `itemId` (msg_/rs_) on text and reasoning; `reasoningEncryptedContent` null unless `store:false` | One `web_search` tool part per action (`search`/`open_page`/`find_in_page`), sources with `toolCallId` | Commentary text is model-authored; labels are app-derived |
| OpenAI (no reasoning) | gpt-5.1 (`reasoningText:false`), gpt-4.1, gpt-4o | none | n/a | Phase still possible on gpt-5.1 (SDK treats gpt-5.x as reasoning models for message mode) | n/a | itemId | as above | app-derived |
| Anthropic (`@ai-sdk/anthropic` 4.0.40) adaptive generation | claude-opus-4-8, claude-sonnet-5, claude-fable-5 | `thinking: {type:"adaptive"}` (+ `effort` on override); **no `display`** | **Default `display: "omitted"` on these models: thinking blocks arrive with empty text and no `thinking_delta`.** `display: "summarized"` returns summarized thinking | No phase field. Fable 5 writes documented progress-update thinking blocks before `tool_use`; under `summarized` they are indistinguishable from reasoning; under `updates` (beta header, SDK enum rejects it) only they carry text | Yes, automatic with adaptive | `signature` on every thinking block (arrives as `reasoning-delta` with empty delta), `redactedData` for redacted blocks; web search results carry `encrypted_content` | `server_tool_use` becomes a `web_search` tool part; citations become sources | app-derived; heading-shaped first line of a summary is a model convention, not a contract |
| Anthropic adaptive 4.6 | claude-opus-4-6, claude-sonnet-4-6 | adaptive, or `enabled`+`budgetTokens` when search is active (`searchThinkingDowngrade`, pause_turn workaround) | `summarized` is the default on 4.6 | none | adaptive yes; fixed-budget on Opus 4.6 no | as above | as above | app-derived |
| Anthropic budget era | claude-sonnet-4-5, claude-haiku-4-5 | `enabled` + catalog `thinkingBudget` | summarized (default) | none | Haiku: no interleaving | as above | as above | app-derived |
| Google (`@ai-sdk/google` 4.0.49, generateContent) | gemini-3.1-pro-preview, gemini-3.5-flash, gemini-3.1-flash-lite | `thinkingConfig.includeThoughts: true` + `thinkingLevel` on override | Thought summaries stream as `reasoning-*`; adapter splits text/thought transitions into separate parts | none | Yes: thought and text parts interleave inside one candidate | `thoughtSignature` rides `providerMetadata.google` on text/reasoning/tool parts; Gemini 3 tool replay without one gets the `skip_thought_signature_validator` sentinel | `google_search` tool part plus grounding sources | app-derived |
| Google 2.5 | gemini-2.5-pro, gemini-2.5-flash (`reasoningText:true`, no `effortLevels`) | includeThoughts only | summaries | none | yes | thoughtSignature | as above | app-derived |
| xAI Responses (`@ai-sdk/xai` 4.0.42, `provider.responses(id)`) | grok-4.3 (visible), grok-4-0709 and others hidden | `reasoningEffort` only on override (grok-4.3 only) | Adapter emits `reasoning-*` from `response.reasoning_summary_text.delta` and `response.reasoning_text.delta`; docs show summaries for grok-4.6, grok-4.3 exposure unverified (Q5) | none (adapter has no `phase`) | per step | `itemId`; `reasoningEncryptedContent` only when `store:false` (not sent) | `web_search_call`/`x_search_call` items become tool parts; citations become sources | app-derived |
| Mistral (`@ai-sdk/mistral` 4.0.31) | mistral-medium-3-5, mistral-small-2603 (`reasoningText:true`) | **nothing** at research time (request shaping had no Mistral case); now `reasoningEffort: "high"` whenever `reasoningText` is true, and `mistral-medium-3-5` is flagged `reasoningText: false` (Section 12, Q2) | Docs: reasoning is off unless `reasoning_effort:"high"`; adapter emits `reasoning-*` from `thinking` chunks. SDK gate accepts ids `mistral-small-2603`, `mistral-medium-3.5` (dot), not `mistral-medium-3-5` (catalog id) | none | n/a | none | no native search (Exa layer) | app-derived |
| Perplexity (`@ai-sdk/perplexity` 4.0.30) | sonar, sonar-reasoning-pro (visible); sonar-pro, sonar-deep-research hidden | none | **`sonar-reasoning-pro` is documented to emit a literal `<think>…</think>` section inside content; the adapter has no parser.** Live streaming showed no tags and no reasoning (default `stream_mode: "full"` suppresses them); the route keeps `reasoningText: false`; the tag-lift transform exists but no route declares `inlineReasoningTags` after review (Section 12, R4) | none | n/a | none | `citations` become `source` parts (no tool part) | app-derived |
| OpenRouter (`@openrouter/ai-sdk-provider` 3.0.0, chat completions) | 95 routes | Construction-time `.chat(id, {reasoning: {effort}})` from catalog or override | `reasoning_details` (`reasoning.text`/`summary`/`encrypted`) and legacy `reasoning` string become one `reasoning-*` block per step; **reasoning arriving after content in the same step is accumulated but never emitted** | none | Only before text in each step | `reasoning_details` (with `signature`) attached on `reasoning-end`; unsigned details are dropped on replay by the provider | Web plugin: `url_citation` annotations become sources; **no tool part** (implied-search item) | app-derived |

Model-specific differences that matter (do not generalize across a provider):

- OpenAI: `effortLevels` differ (gpt-5 has `minimal`, no `none`; 5.1+ the
  reverse; `max` from 5.6). `gpt-5.4-pro` has `reasoningText` without effort
  levels. `gpt-5.1` is a reasoning-capable model with reasoning off by default
  (`reasoningText:false`), so `reasoningSummary` is never sent for it.
- Anthropic: `display` default flips at 4.7 (omitted) vs 4.6 and earlier
  (summarized). `xhigh` is absent on 4.6. Haiku 4.5 never interleaves.
  Progress updates exist only on Fable 5 (and 5.1/Mythos, not catalogued).
- Google: Gemini 3 takes `thinkingLevel`; 2.5 takes budgets and cannot fully
  disable thinking on models where it is on by default.
- xAI: only grok-4.3 accepts `reasoning_effort` (`none` disables); other Grok 4
  models reason unconditionally.
- Perplexity: only the `reasoning` family emits `<think>`; `sonar` does not.
- OpenRouter: `max` is not wire-expressible (clamped to `xhigh`).

## 4. Evidence table

Installed versions (verified from `node_modules/*/package.json` on 2026-09-09):
`ai` 7.0.73, `@ai-sdk/openai` 4.0.45, `@ai-sdk/anthropic` 4.0.40,
`@ai-sdk/google` 4.0.49, `@ai-sdk/xai` 4.0.42, `@ai-sdk/mistral` 4.0.31,
`@ai-sdk/perplexity` 4.0.30, `@openrouter/ai-sdk-provider` 3.0.0,
`@ai-sdk/react` 4.0.76, `@ai-sdk/provider` 4.0.7, `redis` 6.2.1. Declared
ranges in `package.json` match (`^4.0.x`, `^7.0.73`, `^3.0.0`).

Kinds: DOC = official documentation; SDK = installed adapter source (path and
line as of the versions above); REPO = this repository; OSS = maintained
open-source reference; OBS = observed in a prior session's artifacts;
UNRESOLVED = needs the smoke test in Section 10.

| # | Conclusion | Kind | Source |
| --- | --- | --- | --- |
| E1 | Anthropic: on Opus 4.8/4.7, Sonnet 5, Fable 5 (and Opus 5, 5.1, Mythos) `display` defaults to `"omitted"`: thinking blocks return with an empty `thinking` field; when streaming no `thinking_delta` is emitted, only `signature_delta`. `"summarized"` is the default on Opus 4.6, Sonnet 4.6 and earlier. | DOC | https://platform.claude.com/docs/en/build-with-claude/thinking sections "Controlling thinking display" and "Streaming thinking" (lines 443-449, 473, 783 of the fetched page) |
| E2 | The installed Anthropic adapter accepts `thinking: {type:"adaptive", display: "omitted"\|"summarized"}` and sends `display` in the request body. | SDK | `node_modules/@ai-sdk/anthropic/dist/index.js:1032-1041` (schema), `:3896-3912` (request args) |
| E3 | The app never sends `display`. | REPO | `lib/openproviders/request-shaping.ts:117-124` |
| E4 | LobeHub explicitly sets `display: 'summarized'` for Fable 5/Opus 5/Sonnet 5/Opus 4.8/4.7 because the model default is `omitted`. | OSS | `../LobeHub/packages/model-runtime/src/core/anthropicCompatibleFactory/resolveThinkingConfig.ts:20-45` |
| E5 | Anthropic Fable 5 writes progress-update thinking blocks before `tool_use`; under `summarized` they are "not distinguishable from a reasoning block"; `display: "updates"` (beta header `thinking-display-updates-2026-08-18`) makes only them carry text. | DOC | thinking page, "Progress updates between tool calls" table |
| E6 | Installed Anthropic adapter schema restricts `display` to `omitted\|summarized`; `updates` fails `parseProviderOptions`. | SDK | `@ai-sdk/anthropic/dist/index.js:1040` |
| E7 | Anthropic web search response documents a text block ("I'll search for…") before `server_tool_use`; `pause_turn` means "send the paused assistant message back unchanged in a new request". | DOC | https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool "Response" and "pause_turn stop reason" |
| E8 | Installed Anthropic adapter maps `pause_turn` to unified `stop` and keeps the raw reason in `finishReason.raw`; the runtime only records telemetry. | SDK, REPO | `@ai-sdk/anthropic/dist/index.js:3447-3453`, `:5533-5539`; `app/api/chat/chat-turn-runtime.ts:1731-1756` |
| E9 | Anthropic thinking `signature` arrives as a `reasoning-delta` with empty delta and `providerMetadata.anthropic.signature`; redacted blocks start with `redactedData`; replay drops reasoning parts lacking either (warning, no error). | SDK | `@ai-sdk/anthropic/dist/index.js:5353-5366`, `:4846-4858`, `:2869-2905` |
| E10 | Anthropic thinking blocks must be passed back complete and unmodified in tool-use turns; models 4.6+ keep prior-turn blocks; Fable 5.1+ validates signatures against the unchanged prefix. | DOC | thinking page "Preserving thinking blocks", "Thinking block preservation by model", "Preserved thinking" |
| E11 | OpenAI Responses labels assistant messages with `phase` (`commentary`/`final_answer`); "For models like gpt-5.3-codex and beyond, when sending follow-up requests, preserve and resend phase on all assistant messages — dropping it can degrade performance." | DOC | https://developers.openai.com/api/reference/resources/responses/methods/create (EasyInputMessage.phase, ResponseOutputMessage.phase) |
| E12 | Installed OpenAI adapter emits `phase` on `text-start` and `text-end` (falling back to the active message phase), and maps a text part's `providerOptions.openai.phase` back onto the replayed message. | SDK | `@ai-sdk/openai/dist/index.js:7569-7583`, `:7604-7621`, `:4861-4873` |
| E13 | The app strips BOTH `callProviderMetadata` and `providerMetadata` from every OpenAI history part, so `phase` is dropped on replay. Rationale: `itemId` would serialize as `item_reference` under `store:true`. | REPO | `app/api/chat/adapters/openai.ts:155-200` |
| E14 | OpenAI reasoning summaries are never raw reasoning; `summary: auto` is "equivalent to detailed for most reasoning models"; encrypted content only with `store:false`; reasoning items should be passed back with function calls. | DOC | https://developers.openai.com/api/docs/guides/reasoning |
| E15 | Installed OpenAI adapter emits one reasoning part per `(item, summary_index)`; `reasoning-end` for a summary part is emitted at `summary_part.done` when `store` is true, otherwise deferred to `output_item.done`; `reasoningEncryptedContent` is `null` while streaming and filled at item done. | SDK | `@ai-sdk/openai/dist/index.js:8234-8306`, `:8077-8101` |
| E16 | App sends `reasoningSummary: "auto"` whenever `reasoningText` is true, regardless of wire effort (including `none`). The SDK's own default withholds a summary when effort is `none`. | REPO, SDK | `lib/openproviders/request-shaping.ts:141-146`; `@ai-sdk/openai/dist/index.js:6491` |
| E17 | Google adapter interleaves: a `thought` part closes any open text block and opens a reasoning block, and vice versa; `thoughtSignature` rides `providerMetadata.google` on every delta. | SDK | `@ai-sdk/google/dist/index.js:2283-2340` |
| E18 | Google replay injects `skip_thought_signature_validator` for Gemini 3 function calls lacking a signature (adapter and app both do this for the last assistant message). | SDK, REPO | `@ai-sdk/google/dist/index.js:901-903,1021`; `app/api/chat/adapters/google.ts:297-330` |
| E19 | Gemini thought summaries stream incrementally and can interleave with answer text; thinking cannot be fully disabled where on by default; thought blocks may carry only a signature. The current Google guide describes newer field names (`thinking_summaries`, `store`) than the installed adapter uses (`thinkingConfig.includeThoughts`). | DOC, UNRESOLVED | https://ai.google.dev/gemini-api/docs/thinking (Q6) |
| E20 | xAI Responses adapter emits reasoning from `response.reasoning_summary_text.delta` and `response.reasoning_text.delta`; no `phase`; `reasoning.encrypted_content` only when `store === false`. | SDK | `@ai-sdk/xai/dist/index.js:2844-2900`, `:2475-2481` |
| E21 | xAI docs: grok-4.6 exposes "summarizations of the model's internal reasoning"; `reasoning_effort` low/medium/high(/xhigh) on 4.5/4.6; older Grok 4 reasoning exposure not stated. grok-4.3 accepts `none..xhigh` (live-verified 2026-08-26 per catalog comment). | DOC, REPO | https://docs.x.ai/docs/guides/reasoning; `lib/models/data/grok.ts:28-35` |
| E22 | Mistral: reasoning is off unless `reasoning_effort: "high"`; `mistral-medium-3-5` and `mistral-small-latest` support it; response content becomes `thinking`/`text` chunks. | DOC | https://docs.mistral.ai/capabilities/reasoning |
| E23 | Installed Mistral adapter only sends `reasoning_effort` for ids `mistral-small-latest`, `mistral-small-2603`, `mistral-medium-3`, `mistral-medium-3.5`; the catalog id is `mistral-medium-3-5`. The adapter emits `reasoning-*` from `thinking` chunks. | SDK, REPO | `@ai-sdk/mistral/dist/index.js:409-431`, `:606-640`; `lib/models/data/mistral.ts:5` |
| E24 | App request shaping has no Mistral case (falls to `default: return {}`), so no Mistral route ever asks for reasoning. | REPO | `lib/openproviders/request-shaping.ts:152-155` |
| E25 | Perplexity `sonar-reasoning-pro` "is designed to output a `<think>` section containing reasoning tokens"; `response_format` does not remove them. | DOC | https://docs.perplexity.ai/docs/sonar/models/sonar-reasoning-pro |
| E26 | Installed Perplexity adapter has no `<think>` handling; it emits one text block (`id: "0"`) plus `source` parts from `citations`. | SDK | `@ai-sdk/perplexity/dist/index.js:430-436`, `:533-580` |
| E27 | OpenRouter adapter emits reasoning only while `!textStarted` in a step; later `reasoning_details` are accumulated for `reasoning-end` metadata but never surfaced; `reasoning-end` fires on first content or at flush. Web plugin results arrive as `url_citation` annotations (sources), never tool parts. | SDK | `@openrouter/ai-sdk-provider/dist/index.js:4008-4098`, `:4263-4330`, `:3806-3820` |
| E28 | OpenRouter docs: pass `reasoning_details` back unmodified with tool results; reasoning and content can interleave across chunks; Claude via OpenRouter defaults to `thinking.display: 'summarized'`. | DOC | https://openrouter.ai/docs/use-cases/reasoning-tokens |
| E29 | AI SDK UI reducer: `providerMetadata` on a delta REPLACES the part's metadata (not merged); `text-end`/`reasoning-end` metadata also replaces; parts get `state: "streaming"` then `"done"`; `start-step` pushes `step-start` parts. | SDK | `node_modules/ai/dist/index.js:6993-7090`, `:7367-7375` |
| E30 | `turn-evidence.ts` reads `providerMetadata.openai.phase` directly; so do `resumable-chat.ts` (prefix guard) and `work-duration-tracker.ts` (server). No component reads phase. | REPO | `lib/chat-messages/turn-evidence.ts:403`, `lib/chat-stream/resumable-chat.ts:83-86`, `app/api/chat/work-duration-tracker.ts:50` |
| E31 | Unphased fallback: a text block whose `activityOffset <= lastToolOffset` is commentary; otherwise answer. Explicit phase wins. `hasFinalAnswer` becomes true on any non-empty unphased text or a `final_answer` block. | REPO | `lib/chat-messages/assistant-turn.ts:68-88` |
| E32 | Inline work for non-OpenAI providers uses reasoning text as narrative, dropping a leading `# Heading` or `**Heading**` line (model convention) and using a standalone `**Heading**` as a compact active title. | REPO | `lib/chat-messages/assistant-inline-work.ts:41-58`, `:97-116` |
| E33 | `workSummaryDurationMs` is frozen only on an OpenAI `final_answer` `text-start`/`text-end`; nothing else ever sets it. Client fallback uses `persistedWorkDurationMs` only when the turn has no final answer. | REPO | `app/api/chat/work-duration-tracker.ts:38-58`; `lib/chat-messages/assistant-inline-work.ts:160-171` |
| E34 | Durable snapshots reuse the SDK projection (`toUIMessageStream` + `readUIMessageStream`), so part order, states, and `providerMetadata` survive checkpoints; persisted `content` concatenates every text part (commentary included). | REPO | `app/api/chat/durable-turn-runtime.ts:709-740`; `convex/domain/message_facts.ts:37-53` |
| E35 | Retained Redis stream stores raw `UIMessageChunk`s per run; the client rebuilds silently from the base message and only publishes once caught up; the prefix guard allows opaque metadata to change but requires phase equality. | REPO | `lib/chat-stream/server.ts`, `lib/chat-stream/resumable-chat.ts:54-108,158-214` |
| E36 | Server word chunking is evidence-gated to `anthropic/claude-haiku-4-5-20251001` and `google/gemini-3.5-flash` only. | REPO | `app/api/chat/word-chunking-transform.ts:35-44` |
| E37 | OpenAI-compatible history adapter drops `reasoning` parts entirely (xAI, Mistral, OpenRouter non-Anthropic/OpenAI/Google vendors); OpenRouter Anthropic/OpenAI/Google vendors route through the respective direct adapters. | REPO | `app/api/chat/adapters/openai-compatible.ts:47-61`; `app/api/chat/adapters/index.ts:24-91` |
| E38 | LibreChat models `AssistantTextPhase = 'commentary' \| 'final_answer'` and generates activity labels with an LLM ("generatePhase"); Vercel Chatbot renders reasoning parts only, no phase. | OSS | `../LibreChat/packages/api/src/agents/activityPhases/runtime.ts:11,80-100`; `../VercelChatbot/components/chat/message-reasoning.tsx` |
| E39 | ChatGPT's own answer-onset collapse and CoT paint behavior, measured 2026-09-08. | OBS | `docs/adr/0040-inline-assistant-work.md`; `output/thinking-ui-parity-20260908/` |

## 5. Current architecture and confirmed defects

### Path trace

```
Provider HTTP stream
  → @ai-sdk/<provider> adapter: LanguageModelV4 stream parts
     (text-start/delta/end, reasoning-start/delta/end, tool-*, source, finish;
      providerMetadata per part; finishReason {unified, raw})
  → streamText (app/api/chat/chat-turn-runtime.ts ~1479)
     experimental_transform: [word chunking (2 measured routes)] + lifecycle approval transform
     onChunk: liveness, reasoning-activity interval union, work-summary observe,
              durable snapshot tracker (SDK projection → Convex, 750 ms throttle)
  → toUIMessageStream (~2100): sendReasoning, sendSources,
     messageMetadata: start {provider, reasoningEffort, generationBudget},
                      first workSummaryDurationMs, finish {durations, stats}
  → tee: HTTP SSE response  |  Redis retained log (lib/chat-stream/server.ts)
  → browser: ResumableChat (AI SDK Chat) → frame-aligned notifications
  → deriveAssistantTurnView (per render): deriveTurnEvidence → textBlocks{phase}, timeline
     → deriveInlineContent (commentary vs answer) → deriveAssistantTurnPhase
     → deriveAssistantInlineWork → <AssistantInlineWork/> + <Markdown answerText/>
  → persistence: snapshots (parts as-is) → terminal write (content + parts + metadata)
  → reload: Convex path → durableStoredMessageToUiMessage (parts verbatim)
  → replay: GET /api/chat/[chatId]/stream → base + chunks → silent rebuild → publish
```

### Confirmed defects (required fixes)

R1. **Anthropic 4.7+ reasoning is invisible by default** (E1, E2, E3, E4).
Direct routes `claude-opus-4-8`, `claude-sonnet-5`, `claude-fable-5` send
`thinking: {type:"adaptive"}` without `display`, so every thinking block
arrives empty. The UI shows opaque "Thinking" with a timer fed only by the
reasoning-start/end pair, and the inline work has no narrative. Fix in request
shaping (step 1).

R2. **OpenAI replay drops `phase`** (E11, E12, E13). The adapter strips the whole
`providerMetadata` object to avoid `item_reference`. The documented requirement
is to preserve `phase` on assistant messages. Fix: strip only id-bearing keys
(`itemId`, `reasoningEncryptedContent`, `annotations`) and keep `phase` on text
parts (step 6).

R3. **Mistral routes claim reasoning they never request** (E22, E23, E24). No
Mistral request carries `reasoning_effort`, and the installed adapter's id gate
would also reject the catalog id `mistral-medium-3-5`. Fix: add a Mistral case
to request shaping and resolve the id gate by smoke test (step 2, Q2).

R4. **Perplexity reasoning leaks as literal `<think>` text** (E25, E26). Fix: a
server-side stream transform keyed by a route capability that lifts
`<think>…</think>` into reasoning parts before the durable/UI seam (step 3).

R5. **Pre-answer duration is OpenAI-only** (E33). For Anthropic, Google, xAI,
and OpenRouter tool turns, the live label counts up, but after reload the
label shows "Worked" with no duration because `workSummaryDurationMs` was never
persisted and the client refuses `workDurationMs` once a final answer exists.
Fix: provider-neutral freeze rule in the tracker (step 4).

R6. **Phase knowledge is spread across three modules** (E30). Any new phase
source (Perplexity think tags, Anthropic progress updates, future providers)
would need three edits. Fix: one reader in `turn-evidence.ts` consumed by the
server tracker and the replay guard (step 5).

R7. **Answer-onset reclassification for unphased providers must be proven
flash-free** (E31, E7). When an unphased provider streams answer-looking text
and then calls a tool, the text block moves from the answer body into the
collapsed work history in the next render, and `hasFinalAnswer` flips back to
false. This is the intended conservative rule (ADR-0040) and it matches
Anthropic's documented pre-search text. It is a confirmed transition, not yet a
confirmed visual defect. It must be recorded and judged on video (step 8). If
the recording shows a flash, the bounded fix is in the renderer, never in the
evidence rule (Section 6, contract C4).

### Confirmed limitations (document, do not fix here)

L1. OpenRouter cannot surface reasoning that arrives after content in a step
(E27); interleaved Gemini/Claude reasoning through OpenRouter is partially
lost. The route resolver already prefers direct routes; document it in the
matrix and CONTEXT.md.

L2. OpenRouter web search yields sources without tool rows (E27); the
implied-search evidence item is the correct presentation.

L3. Anthropic `pause_turn` is not continued (E7, E8). The 4.6 fixed-budget
workaround is catalog-gated; 4.7+ has none. See optional step 9 and Q7.

L4. Anthropic `display: "updates"` would give a real commentary channel for
Fable 5 but the installed SDK rejects the value (E5, E6). Q3.

L5. Persisted `content` and copy/share include commentary text (E34). This is
the ADR-0040 decision (canonical text unchanged); leave it.

### Optional improvements

O1. Gate `reasoningSummary` on wire effort not being `none` (E16), pending Q4.

O2. Record `reasoningVisibility` (`summarized|omitted|redacted|none`) on the
message metadata at stream start so the UI can label opaque reasoning as
"hidden by provider" rather than the generic Thinking. Only if step 1 leaves any
catalogued route opaque by design.

O3. For Fable 5 under `summarized`, treat a short thinking block that directly
precedes a tool call as a progress update for the compact active title. This is
a heuristic on model-authored text; keep it presentation-only and behind the
existing `compactTitle` path, never as evidence.

## 6. Boundary contracts and normalization rules

All provider-specific interpretation stays in two places: `lib/openproviders/*`
(request side) and `lib/chat-messages/turn-evidence.ts` plus one server stream
transform (response side). Rendering, animation, disclosure, persistence, and
replay stay shared.

### C1. Text phase reader (single source of truth)

```ts
// lib/chat-messages/turn-evidence.ts
export type TextPhase = "commentary" | "final_answer"
export function readTextPhase(part: {
  type: string
  providerMetadata?: Record<string, Record<string, unknown> | undefined>
}): TextPhase | undefined
```

Rule: return `providerMetadata.openai.phase` when it is one of the two values;
otherwise `undefined`. Provider namespaces are enumerated inside this function
only. Consumers: `deriveTurnEvidence` (client), `createWorkSummaryDurationTracker`
(server, via a text-start/text-end part shaped the same way), and
`hasVisiblePrefix` (replay guard). Never read `.phase` elsewhere.

Alternative considered: a `phase` field on the wire (`messageMetadata`) stamped
by the server. Rejected: it would duplicate part-level truth the SDK already
carries and would not survive the SDK's own replay reconstruction.

### C2. Reasoning-part classification

```ts
export type ReasoningVisibility = "visible" | "opaque"
```

`visible` when the part text is non-empty after trim; `opaque` otherwise. Opaque
covers Anthropic omitted/redacted, OpenRouter encrypted, and OpenAI items whose
summary was empty. Opaque parts count as observed activity (timer, "Thinking")
but never produce a Reasoning section or inline narrative. This is already the
behavior of `deriveReasoningView`; the contract makes it explicit and adds a
test per provider fixture.

### C3. Unphased commentary rule (unchanged, now written down)

For text blocks without an explicit phase: a block is commentary if and only if
at least one tool call appears later in part order. Text after the last tool is
answer. Explicit `commentary`/`final_answer` always wins. Sources, reasoning, and
implied-search items never make text commentary. This matches the documented
Anthropic search example (E7) and the ADR-0040 decision.

Alternative: treat text between tools as answer until settlement. Rejected: it
would put pre-tool narration into the final answer and duplicate ChatGPT's
collapsed work as body prose.

### C4. Answer-onset move must be content-preserving and single-render

When a block changes classification (unphased text becomes commentary because
a tool arrived), the same `text-${partIndex}` id must appear in the work history
in the same render that removes it from the answer body. No intermediate render
may show neither. Canonical text is never edited. If video shows a flash, the
renderer may keep the outgoing answer block mounted for one frame under the
existing snapshot-host mechanism of `inline-work-narrative.tsx`; it may not
delay incoming text.

### C5. Provider-neutral pre-answer duration

`workSummaryDurationMs` freezes at, in order of precedence:

1. the recorded `text-start` time of the first `final_answer` block (existing);
2. otherwise, at `finish`, the recorded `text-start` time of the first text
   part that began after the last `tool-result`/`tool-call` of the turn, when
   at least one tool call occurred and that text part is non-empty;
3. otherwise absent.

Rule 2 is computed at finish because "last tool" is only known then. It is
provider-neutral and derived from SDK order, never from model text. Approval
continuations carry the prior value through `initialWorkDurationMs` as today.

### C6. Perplexity think-tag lift

For routes with catalog `inlineReasoningTags: "think"` (new optional
`ModelConfig` field; only `sonar-reasoning-pro`, `sonar-deep-research` if kept),
a `StreamTextTransform` converts `text-delta` content between `<think>` and
`</think>` into `reasoning-start/delta/end` with a stable id (`think-<n>`),
emitting the surrounding text as ordinary text deltas. Partial tags at chunk
boundaries are buffered up to 8 characters (`"</think>".length`) and flushed on
`text-end`/`finish`/abort. The transform runs before the lifecycle transform so
the durable tracker, Redis, and the browser all see the same canonical parts.

Alternative: parse on the client. Rejected: it would create a second text
interpretation and would not fix persisted `content`.

### C7. Replay metadata preservation rules (per provider)

- OpenAI text parts: keep `phase`; strip `itemId`, `annotations`. Reasoning
  parts: keep stripping everything (self-contained replay; the SDK then skips
  them with a warning, which is the existing behavior).
- Anthropic: pass-through (signature, redactedData, encrypted search results).
- Google: pass-through plus the existing sentinel injection.
- xAI/Mistral/OpenRouter (openai-compatible adapter): reasoning dropped, tool
  triples preserved (existing).

### C8. Titles

All live labels ("Thinking", "Searching N websites", "Worked for Ns") are
application-derived. Model-authored text appears only as commentary narrative
(OpenAI `commentary`, Anthropic/other reasoning summaries as fallback). The
leading-heading trim in `inlineReasoningBody` is a presentation heuristic over
model-authored Markdown and must stay presentation-only. No code may branch on
heading text to decide lifecycle.

## 7. Ordered implementation steps

Owner: implementation agent unless noted. Dependencies are listed; steps with
no dependency on each other can be parallelized by file ownership.

### Step 1. Anthropic `display: "summarized"` (R1)

Files: `lib/openproviders/request-shaping.ts`, `lib/openproviders/request-shaping.test.ts`.

- In the adaptive branch, send `thinking: { type: "adaptive", display: "summarized" }`
  whenever `modelConfig.reasoningText` is true. Do not add a catalog field:
  the documented default only differs per model, and the app's intent (show
  reasoning when the catalog says it is visible) is the same on every adaptive
  model; `summarized` is a no-op on 4.6 (E1). Fixed-budget path unchanged
  (`display` is invalid with `enabled`).
- Test: table rows for `claude-opus-4-8`, `claude-sonnet-5`, `claude-fable-5`
  assert `display: "summarized"`; the search-downgrade row asserts no `display`.
- Smoke (QA): Opus 4.8, effort Default and Low, prompt requiring reasoning;
  assert reasoning-delta chunks arrive (Network tab on `/api/chat`, SSE frames
  of type `reasoning-delta`) and the Activity panel shows text.

### Step 2. Mistral reasoning request (R3)

Files: `lib/openproviders/request-shaping.ts` (+test), possibly
`lib/models/data/mistral.ts`.

- Add `case "mistral": return { mistral: { reasoningEffort: "high" } }` when
  `reasoningText` is true (the adapter's only enabling value).
- Resolve Q2 first: run one authenticated turn on `mistral-medium-3-5` and one
  on `mistral-small-2603`, inspect SDK warnings in the server log
  (`chat_stream_provider_error` will not fire; look for the AI SDK warning
  "This model does not support reasoning configuration") and whether
  reasoning-delta frames arrive. If the medium id is rejected by the SDK gate,
  either (a) the Mistral API accepts `mistral-medium-3.5` and the catalog id
  should migrate through `model-id-migration.ts` (ADR-0025 succession), or (b)
  set `reasoningText: false` on that route with a dated comment. Do not guess.

Outcome (Section 12, Q2): the `mistral` request-shaping case exists and sends
`reasoningEffort: "high"`; option (b) was applied to `mistral-medium-3-5`.
Nothing here remains to implement.

### Step 3. Perplexity think-tag transform (R4, C6)

Files: new `app/api/chat/inline-reasoning-tag-transform.ts` (+ `.test.ts`),
`lib/models/types.ts` (optional `inlineReasoningTags?: "think"`),
`lib/models/data/perplexity.ts`, `app/api/chat/chat-turn-runtime.ts` (compose
before `wordChunkingTransform`/`lifecycleTransform` at ~1423-1434).

- Keep the transform pure and abort-aware like `word-chunking-transform.ts`.
- Set `reasoningText: true` on `sonar-reasoning-pro` (and hidden
  `sonar-deep-research` if it also emits tags; verify) so the activity
  presentation treats it as a visible-reasoning route.
- Tests: split tags across deltas, tag at chunk boundary, unterminated tag at
  finish, no tags (identity), abort mid-tag.

Outcome (Section 12, R4): the transform shipped as written, but
`sonar-reasoning-pro` keeps `reasoningText: false` because the API's default
streaming mode suppresses reasoning events, and review on #186 then withdrew
`inlineReasoningTags` from the route too: with no tagged output on the wire,
the lift would only remove a literal `<think>` section a user asked the model
to write. No shipped route declares the flag. Do not flip either field on that
route from this step.

### Step 4. Provider-neutral work-summary freeze (R5, C5)

Files: `app/api/chat/work-duration-tracker.ts` (+test),
`app/api/chat/chat-turn-runtime.ts` (call the finish-time resolver in
`messageMetadata` for `finish` before building the finish metadata;
`durable-turn-runtime.ts` already accepts `workSummaryDurationMs` on the final
snapshot through `lifecycle.stream.onChunk`, verify the final write carries it).

- Tracker records `text-start` times by id, counts tool calls/results, and
  exposes `resolveAtFinish()` implementing C5. Keep `observe()` semantics for
  the explicit phase path unchanged.
- The durable snapshot tracker only stores the value it receives through
  `lifecycle.stream.onChunk(chunk, summaryDurationMs)`
  (`app/api/chat/durable-turn-runtime.ts:748`) and writes it on the final
  snapshot (`:797`). Resolve C5 rule 2 on the `finish` chunk inside the runtime's
  `onChunk` callback (before drain) so both the final snapshot and the `finish`
  message metadata carry the same number.
- Tests: OpenAI explicit phase unchanged; Anthropic-shaped fixture
  (text, tool-call, tool-result, text) freezes at the second text-start;
  no-tool turn stays absent; approval continuation keeps initial value.

### Step 5. Single phase reader and reasoning visibility (R6, C1, C2)

Files: `lib/chat-messages/turn-evidence.ts` (+test),
`app/api/chat/work-duration-tracker.ts`, `lib/chat-stream/resumable-chat.ts`.

- Export `readTextPhase` and `readReasoningVisibility`; replace the three raw
  reads. `turn-evidence.ts` is client-safe and dependency-free, so the server
  import is fine (it already imports from `ai`).
- Add fixtures per provider shape (OpenAI phased, Anthropic empty-with-
  signature, Google interleaved, OpenRouter reasoning_details, xAI itemId) and
  assert `textBlocks[].phase` and reasoning visibility.

### Step 6. OpenAI replay keeps `phase` (R2, C7)

Files: `app/api/chat/adapters/openai.ts` (+ `__tests__`),
`app/api/chat/provider-request-replay-matrix.test.ts`.

- `stripProviderMetadataFromPart`: for `text` parts, rebuild
  `providerMetadata.openai` with only `phase`; for all other parts keep the
  current full strip.
- Matrix test: an OpenAI-origin history with commentary and final_answer text
  replayed to OpenAI produces two `message` input items with `phase` set and
  no `id`/`item_reference`.

### Step 7. Documentation sync

Files: `CONTEXT.md` (Turn evidence, Inline assistant work, Request shaping,
History adaptation entries), `docs/adr/0040-inline-assistant-work.md` (amend),
new `docs/adr/0041-provider-reasoning-boundary.md` (Section 11), the plan's
status section, `lib/models/types.ts` doc comments.

### Step 8. Browser verification and QA loop (Section 2 items 4-8, Section 9)

Owner: implementation agent runs; QA subagent independently repeats.

### Step 9 (optional). Anthropic `pause_turn` continuation (L3, Q7)

Only if Q7 shows incidence on 4.7+/5 with search. Mechanism: in the runtime's
step loop, when `steps.at(-1).rawFinishReason === "pause_turn"` and the
provider is `anthropic`, issue one continuation `streamText` call with the
response messages appended unchanged (E7), merged into the same UI message
stream under the same run (no new run: this is not an approval). Bound to two
continuations. Document in ADR-0041 if shipped; remove the 4.6 fixed-budget
downgrade only after the continuation is verified on 4.6 with search.

## 8. Compatibility requirements

- Saved conversations: parts persist verbatim; no migration. New optional
  metadata (`workSummaryDurationMs` for unphased turns) is additive. Legacy
  aggregate checkpoints (two unphased parts) remain readable by
  `hasVisiblePrefix`.
- Active streams during deploy: the stream frame format is unchanged. A client
  built before the change reading a stream produced after it sees the same
  chunk types (Perplexity now yields `reasoning-*` chunks, which the old client
  already renders).
- Replay: `readTextPhase` returns the same values the guard reads today, so
  restored prefixes compare identically. Anthropic `display` change adds
  `reasoning-delta` chunks to retained logs; the 1 MiB record cap and 16 MiB
  log cap are unaffected (deltas are small).
- Approval continuations: reasoning effort, budget, and initial durations ride
  the existing signed proof; nothing new is added to the proof.
- Provider history: OpenAI replay gains `phase` (documented improvement);
  Anthropic replay is unchanged; the Perplexity transform only affects the
  producing turn (Perplexity replay is text-only).
- Feature gating: none required. Every change is either a documented-default
  correction or additive. No rollout flag (ADR-0029 discipline).

## 9. Verification matrix

Run through the user's authenticated Chrome on the user's dev server. Record
continuous video for rows marked V. Capture DOM samples (`answerText` length,
part types in order, `data-inline-work-active-row`) at 250 ms for rows marked D.
Use the existing deterministic provider (`app/api/chat/deterministic-provider.ts`)
and the fixture pages under `app/test/thinking-lifecycle/` for exact-content
cases; use live providers for provider-shape cases.

| Case | Routes | Expect | Proof |
| --- | --- | --- | --- |
| Reasoning enabled, no tools | Opus 4.8 (Default, Low), Sonnet 5, Gemini 3.5 Flash, GPT-5.6 Luna (Medium), grok-4.3 (Medium), Mistral medium (post step 2), OpenRouter Claude Sonnet 5 | reasoning-delta frames on the wire; "Thought for Ns" after settle; Activity panel section present | SSE frame log, DOM |
| Reasoning disabled | GPT-5.6 Luna (`none`), grok-4.3 (`none`), gpt-5.1, gemini-2.5-flash-lite | no reasoning parts; no empty Reasoning section; no timer | DOM |
| Reasoning unavailable/opaque | Anthropic fixture with empty thinking + signature; OpenRouter encrypted fixture | "Thinking" label with timer; no Reasoning section; label says nothing false | unit + DOM |
| Tool interleaving | Opus 4.8 + web search (interleaved thinking), Gemini 3.1 Pro + search, GPT-5.6 + search (commentary/final_answer), MCP tool on any provider | chronological work history, one row per tool call, reasoning rows between tools, answer only after last tool | V, D |
| Answer onset (phased) | GPT-5.6 Luna + search | collapse to "Worked for Ns" at first final_answer character; no duplicate commentary in body | V, D |
| Answer onset (unphased) | Opus 4.8 + search, Gemini 3.5 Flash + search, OpenRouter Gemini + search | pre-tool text moves to history in one render; answer text never disappears once it is the post-last-tool text | V, D (C4) |
| Completion | all above | final `answerText` equals persisted `content` minus commentary blocks; formatting intact | DOM + Convex read |
| Cancellation | Stop during reasoning; Stop during tool; Stop during answer (GPT-5.6, Opus 4.8) | frozen parts read "stopped"/"complete"; stub kept; durations settle | D |
| Errors | invalid BYOK key on one provider; tool error via MCP | error row; no fabricated progress | D |
| Refresh/reconnect | hard refresh mid-reasoning, mid-tool, mid-answer on GPT-5.6 and Opus 4.8; transient network drop mid-answer | restored prefix never shorter; labels and phase identical to live; "Worked for Ns" N matches live within 1 s | V, D, ADR-0039 recipe |
| Perplexity | sonar-reasoning-pro | no `<think>` text in body; reasoning part present; citations as sources | DOM |
| Replay to provider | OpenAI history replayed (matrix test) | phase present, ids absent | unit |

Focused automated checks: `bun run test -- lib/chat-messages app/api/chat/work-duration-tracker app/api/chat/adapters lib/openproviders app/api/chat/inline-reasoning-tag-transform lib/chat-stream`, then the full `bun run test`, `bun run typecheck`, `bun run lint`, `bun run build:next`.

## 10. Open questions and the investigation for each

Q1. **Does Opus 4.8 with `display: "summarized"` stream `thinking_delta` at every effort level?** Docs say yes; adaptive may skip thinking at low effort for easy prompts. Investigation: two authenticated turns (Low, High) with a reasoning-heavy prompt; count `reasoning-delta` frames. Accept if High shows text.

Q2. **Which Mistral id does the installed adapter accept for reasoning, and does the Mistral API accept `mistral-medium-3.5`?** Investigation: step 2 smoke; also `curl https://api.mistral.ai/v1/models` with the user's key through the app's key path is not permitted; use only the app's own turn and its server log.

Q3. **Anthropic `display: "updates"` for Fable 5.** The SDK enum rejects it (E6). Investigation: check the `@ai-sdk/anthropic` changelog for a version adding `updates` and the header; if available, propose an isolated dependency update in a separate PR (ADR required: new commentary channel).

Q4. **Does OpenAI accept `reasoning.summary: "auto"` with `reasoning.effort: "none"`?** Investigation: GPT-5.6 Luna with effort `none`; if the request 400s, apply O1 (gate summary on effort). Currently unverified either way.

Q5. **Does grok-4.3 return reasoning summaries on the Responses API?** Docs only show grok-4.6. Investigation: one authenticated turn at Medium; inspect frames. If none, set `reasoningText` honestly (keep effort levels; `none` still meaningful).

Q6. **Google docs vs installed adapter field names.** The current Gemini thinking guide describes `thinking_summaries`/`store`; the adapter sends `thinkingConfig.includeThoughts`/`thinkingLevel`. Investigation: one Gemini 3.5 Flash turn confirms thoughts still arrive; if the API has deprecated the adapter's fields, record it as an SDK-upgrade item, not an app change.

Q7. **`pause_turn` incidence on 4.7+/5 with search.** Investigation: query PostHog for `anthropic_pause_turn` over the last 30 days by model; if nonzero on 4.7+/5, schedule step 9.

Q8. **Anthropic progress-update blocks under `summarized` on Fable 5.** After step 1, do short pre-tool thinking blocks appear as their own reasoning parts (separate `content_block` index)? Investigation: Fable 5 + web search, inspect part sequence. If yes, O3 can key on "reasoning part immediately followed by tool-call" for the compact title without inspecting text.

## 11. Documentation and ADR updates

- New `docs/adr/0041-provider-reasoning-boundary.md`: decision that reasoning
  visibility is requested explicitly per provider (Anthropic `display`,
  Mistral `reasoning_effort`, Perplexity tag lift), that text phase and
  reasoning visibility have one reader in Turn evidence, and that pre-answer
  duration has a provider-neutral finish-time rule. Alternatives: client-side
  parsing (rejected), per-provider renderers (rejected), LLM-generated labels
  as in LibreChat (rejected: fabricated progress).
- Amend ADR-0040: replace "other providers retain supplied reasoning fallback"
  with the C3/C4 wording and the C5 duration rule; note the OpenRouter L1
  limitation.
- Amend ADR-0026 consequences: Anthropic adaptive requests carry `display`.
- CONTEXT.md: update **Request shaping** (display, Mistral), **Turn evidence**
  (`readTextPhase`, `readReasoningVisibility`), **Inline assistant work**
  (finish-time work summary), **History adaptation** (OpenAI keeps phase), and
  add an _Avoid_ line: "reading `providerMetadata.<provider>.phase` outside
  Turn evidence".
- `lib/models/types.ts`: document `inlineReasoningTags`.
- `docs/plans/provider-reasoning-lifecycle-boundary.md` (this file): append an
  "Implementation result" section with evidence paths, as
  `chatgpt-thinking-ui-parity.md` does.
- Memory note for future agents (outside the repo): Anthropic 4.7+ `display`
  default and the OpenRouter post-text reasoning drop.

## 12. Implementation result (2026-09-09)

Implemented on `darknight/harvey-bullock` (uncommitted at the time of
writing) by the implementation agent; independent QA pass by a separate
subagent (its notes follow below when present). Decision record:
`docs/adr/0041-provider-reasoning-boundary.md`.

### Open questions resolved

| Q | Result | Evidence |
| --- | --- | --- |
| Q1 Opus 4.8 `display: "summarized"` at every effort | Yes. High (default): 7 `reasoning-delta` frames, 218 chars; Low: 4 frames, 199 chars. "Thought for 4s" + Activity text in the UI. Sonnet 5 (Medium): 3 frames, 104 chars (chat `7a8be901-86d7-4d21-9cf9-92d98435e78a`); Fable 5 (High): 3 frames, 66 chars (chat `1fe35f2f-ad8b-4712-b2b8-65b979a4a452`). | User's Chrome, SSE fetch tap on `/api/chat`, chat `db51cd70-4171-40eb-85ba-b3dc34b8e8c5` |
| Q2 Mistral id gate | Installed `@ai-sdk/mistral` 4.0.31 forwards `reasoning_effort` only for `mistral-small-latest`, `mistral-small-2603`, `mistral-medium-3`, `mistral-medium-3.5`; Mistral's docs name `mistral-medium-3-5` (catalog id). Live turns on both routes returned provider 429 ("Mistral rate limit exceeded") four times, so the API-side id question stays open. Applied option (b): `mistral-medium-3-5` → `reasoningText: false` with a dated comment; `mistral-small-2603` keeps `true` and now sends `reasoningEffort: "high"` (request shape unit-tested, live unverified). | `node_modules/@ai-sdk/mistral/dist/index.js:409`; chats "Math Puzzle: Bat and" (two failures each) |
| Q3 `display: "updates"` | Still rejected by the adapter enum (`index.js:1041`); SDK-upgrade item, not app work. | SDK source |
| Q4 OpenAI `summary: auto` with `effort: none` | Accepted: HTTP 200, `reasoningEffort: "none"` in start metadata, one `final_answer` text part, no reasoning parts. O1 not needed. | User's Chrome, chat `693afaac-1993-49b7-b154-35a7ea0c3db6` |
| Q5 grok-4.3 summaries | Not run (out of the three mandated smokes; left for a later pass). | — |
| Q6 Gemini field names | Not run. | — |
| Q7 `pause_turn` incidence | Blocked: the PostHog connector is not authorized in this session. Step 9 not shipped. | — |
| Q8 Fable 5 progress blocks | Not run. | — |

### Defects R1–R7

- R1 fixed (step 1). R2 fixed (step 6; matrix test asserts `phase` on both assistant items and no `item_reference`/ids). R3 resolved by catalog honesty + request shaping (step 2, see Q2). R5 fixed (step 4; Opus 4.8 + web search: live "Worked for 4s", persisted `workSummaryDurationMs` 4622, after hard refresh "Worked for 4s"; chat `3e4b035d-7fbb-402b-b238-1201654a854e`). R6 fixed (step 5; `grep -rn "openai?.phase"` outside `turn-evidence.ts` returns nothing in production code).
- R4 revised: live streaming of `sonar-reasoning-pro` through `@ai-sdk/perplexity` 4.0.30 carries NO `<think>` text and no reasoning (two turns; persisted content clean in Convex `polite-jackal-630`, chat `0aa9228e-1283-4579-a20c-5183a3ae5a56`). Perplexity's API reference now documents `stream_mode` (`full`, the default, "suppresses reasoning events"; `concise` emits them separately) and the adapter's chunk schema has no field for them. The tag-lift transform is shipped (keyed by catalog `inlineReasoningTags`, composed first in the runtime, 6 unit tests) but the route keeps `reasoningText: false`. Review on #186 then withdrew the Perplexity flag as well: with no tagged output on the wire, the guard only risked lifting a user-requested literal `<think>` section out of the answer; the transform and its tests remain, opt-in by catalog, and no shipped route declares it. Enabling `stream_mode: "concise"` is an SDK item.
- R7: for the unphased provider the pre-tool text moved into the work history before its first paint in both Opus runs (text-end and tool-input-start arrive within one frame-aligned batch), so no reclassification was visible. Answer onset collapsed to "Worked for Ns" in the same 100 ms DOM sample as the first answer text.

### Additional defect found and fixed during verification

The client's live "Worked for Ns" estimate anchored to the first renderable part, not to the assistant message's arrival. Opus 4.8 (Low) + search read "Worked for 2s" live and "Worked for 4s" settled. `use-activity-panel.ts` now anchors the clock to the pending assistant message (`workClockMessage`) keyed by its id; re-measured: 3 s live, 3415 ms persisted, 3 s settled (chat `494c329c-865b-4ff3-b7d5-fc969e6072aa`).

QA pass 1 found D1: the tag transform dropped the SDK's `abort` terminal after the execution signal (enqueued upstream of every `experimental_transform`), so Stop on the tag route never reached `isAborted`. Fixed: `abort` is forwarded before the `cancelled` guard with open parts left frozen, exactly like the SDK's own abort path (QA pass 2 advisory applied); the strengthened real-pipeline test asserts `onEnd.isAborted === true` with `abort` last.

### Continuous video and DOM samples

Playwright driver (`output/playwright/reasoning-boundary/driver.ts`, harness
account via `bun run agent:login`; the harness is platform-tier so only
GPT-5 Mini could be recorded) records `video.webm` plus 100 ms DOM samples
(`samples.json`), events (`events.json`) and the SSE order (`stream.json`)
under `output/playwright/reasoning-boundary/runs/<name>/`; `analyze.ts`
checks delivery preservation. GPT-5 Mini emits no `phase`, so these runs
exercise the unphased rule end to end:

| Run | Result |
| --- | --- |
| `gpt5mini-search-onset` | Work live 0.1 s after send; first answer text and "Worked for 21s" in the same sample (27.89 s); settled "Worked for 22s" (server 22490 ms). Frames `frames/f-27.8.jpg`, `f-28.0.jpg`: collapse and first answer paint together, no duplicate commentary. Only two non-prefix text changes, both Markdown citation links closing (`(bun.sh` → chip). |
| `gpt5mini-stop-answer` | Stop at first answer text; buffered text still landed (344 → 385 chars); label stable "Worked for 31s"; no text loss. |
| `gpt5mini-refresh-answer` | Reload at 353 chars; restored document showed the checkpointed work state, then the retained stream published 550 chars (≥ pre-reload prefix); label "Worked" (no N) for ~1.6 s until finish metadata, then "Worked for 27s" (live estimate before reload was 26 s). |
| `gpt5mini-refresh-tool` | Reload mid-search; restored labels identical to live ("Searched 32 websites", active "Searching the web" → "Thinking"); run ended early because of a driver settle bug (fixed afterwards), completion not recorded. |
| `gpt5mini-refresh-tool-2` | Reload at 9.6 s (mid-search); restored state continued live ("Searched 29 websites", Thinking/Searching rows); answer at 37.0 s with live "Worked for 26s", settled "Worked for 31s" (server value). The reloaded client's clock restarts at reload, so the live estimate is short by the pre-reload elapsed time until finish metadata lands; text delivery preserved (0 non-monotonic events). |

Delivery preservation (canonical text) and visual animation are reported
separately: canonical text never shrank, duplicated, reordered or lost
formatting in any run (analyzer: 0 non-monotonic events except the two
citation-link renders); visual onset was reviewed frame by frame only for
`gpt5mini-search-onset`.

### Acceptance criteria

1. Pass for Opus 4.8 (High, Low), Sonnet 5, and Fable 5 (live reasoning-delta frames in the user's Chrome) plus the request-shaping unit test.
2. Pass by correction: Mistral Medium 3.5 flag set false on SDK evidence; Mistral Small 4 request now carries the enabling value but live reasoning is unverified (provider 429).
3. Revised: no literal `<think>` reaches the body (verified live, twice); no reasoning part appears because the API suppresses reasoning events in the default streaming mode (documented, flag kept false).
4. Pass for Anthropic (Opus 4.8, live/refresh/completion 4s/4s/4s, then 3s/3s/3s after the clock fix) and OpenAI unphased (GPT-5 Mini 21–22s live vs 22s settled; refresh restores the settled value once finish lands). Google, xAI, OpenRouter: unverified (no BYOK on the harness account; not run in the user's Chrome in this pass).
5. Pass (`provider-request-replay-matrix.test.ts`, `adapters/__tests__/openai.test.ts`).
6. Pass (`readTextPhase`, `readReasoningVisibility`; grep clean).
7. Pass for delivery preservation on GPT-5 Mini onset/Stop/refresh and Opus 4.8 onset (DOM samples). Continuous video reviewed for the phased-model family only via GPT-5 Mini (unphased path); Opus/Gemini/xAI/OpenRouter video: unverified (harness account lacks keys).
8. Pass: `bun run typecheck`, `bun run lint`, `bun run test` (3111 passed), `bun run build:next` (exit 0). `bun run build` never run.

### Limitations and blocked checks

- Mistral live reasoning: blocked by provider 429 on the configured key.
- Perplexity reasoning visibility: needs the adapter to support `stream_mode: "concise"` events (SDK upgrade).
- `pause_turn` incidence (Q7): PostHog not reachable from this session.
- Unphased-provider continuous video: harness account has no BYOK keys; the user's MCP Chrome tab is hidden behind their active tab (timers throttled, screen recording would capture the wrong page), so unphased onset is proven by wire + 100 ms DOM samples, not video.
- After a hard refresh between answer onset and finish on an unphased turn, the label reads "Worked" without N until finish metadata arrives (the rule resolves at stream end by design). A Stop after answer onset now keeps its N: a third review pass found the value was lost on Stop (live "Worked for 6s", reload "Worked"; Opus 4.8 + search) and fixed it two ways: checkpoints carry the tentative onset under a private `workSummaryCandidateMs` key that the Stop mutation's lifecycle terminal promotes (the user's Stop is the terminal; the worker cannot write afterwards), and server-originated aborts resolve in `onChunk`/`onAbort` so the abort flush carries the value. Rule 2 was also extended to sources-only turns (Perplexity read "Worked for 6s" live and "Worked" on reload). After a hard refresh BEFORE onset, the reloaded client's live clock restarts at reload, so its estimate at onset is short by the pre-reload elapsed time (26 s vs 31 s settled in `gpt5mini-refresh-tool-2`); the settled value is correct. Closing this needs the run's `workStartedAt` (already on `generationRuns`, used server-side in `resolveWorkDurationMs`) to reach the row clock as its seed; not done in this pass.
- GPT-5 Mini writes its default-prompt "progress" sentences inside its single final message (it emits no interleaved commentary items), so that prose is answer text by the C3 rule; a prompt-level follow-up, not a boundary defect.

### QA pass 1 (2026-09-09, independent QA subagent)

Reviewed the working tree against Sections 6–8; ran the Section 9 checks.

- Defect (must fix, production file `app/api/chat/inline-reasoning-tag-transform.ts`):
  after the execution signal fires the transform drops every later part,
  including the SDK's own `abort` terminal, which `streamText` enqueues
  UPSTREAM of `experimental_transform`. `toUIMessageStream` then never sees
  `abort`, `onEnd` gets `isAborted: false` with no `finish`, and settlement
  falls to the completion write (`durable_finish_handoff_missed`). Reachable
  on every Stop of `sonar-reasoning-pro` (the only `inlineReasoningTags`
  route; word chunking is not in its chain). Proven by the new real-pipeline
  test in `inline-reasoning-tag-transform.test.ts` (red until the hunk lands)
  and a scratch control/fixed run (control: `…text-delta, abort`; fixed:
  `…reasoning-delta, abort`). Fix: pass `part.type === "abort"` through before
  the `cancelled` guard (hunk in the QA report).
- Tests added (green): prefix guard accepts an unphased legacy checkpoint
  against a phased candidate (`resumable-chat.test.ts`); C4 same-derivation
  move of `text-0` into the work history (`assistant-inline-work.test.ts`);
  work clock runs from the pending shell, keeps its key across pending→live,
  restarts on a new assistant id (`use-activity-panel.test.tsx`).
- Verified by reading source: v7 `onChunk` is notified for every part in
  `eventProcessor.transform`, including `finish`, so the single-observer
  C5 rule resolves before the final snapshot and the finish metadata;
  `flushFinal` reuses the same stored value. Assistant `id` is the server id
  from the `start` chunk, so the pending→live key is stable.
- Live smoke (user's Chrome, hidden tab, fetch tap): Fable 5 High →
  `reasoning-delta` 3 frames / 97 chars, `text-delta` 5 / 450 chars,
  `finish` 1, label "Thought for 2s". Sonnet 5 not re-smoked by QA.
- Commands: focused suites 77 files / 747 passed; `bun run test` 298 files /
  3114 passed, 1 failed (the new abort proof); typecheck, lint, `build:next`
  exit 0. `bun run build` never run.

### QA pass 2 (2026-09-09, independent QA subagent)

Re-reviewed the D1 hunk in `app/api/chat/inline-reasoning-tag-transform.ts`
against AI SDK 7.0.73 and re-ran the Section 9 checks.

- D1 closed. The SDK enqueues `{ type: "abort" }` from the base stream's
  `pull` (`node_modules/ai/dist/index.js:9386-9416`), upstream of the
  `isRunning` filter and every `experimental_transform` (`:9432-9450`);
  `handleUIMessageStreamFinish` flips `isAborted` only when that chunk
  passes (`:7480-7491`). The transform now forwards it before the
  `cancelled` guard. Proof: the pass-1 real-pipeline test was strengthened to
  consume `result.toUIMessageStream({ onEnd })` and asserts
  `onEnd.isAborted === true` with `abort` as the last chunk (7/7 green). A
  scratch probe of the same pipeline confirmed `isAborted: true` on Stop
  mid-think and mid-answer for the tag route.
- Advisory (not a defect; no change required for criterion 8): the hunk calls
  `finishSource(controller)` before forwarding `abort`, which synthesizes
  `reasoning-end`/`text-end` after the execution signal. The SDK itself never
  closes open parts on abort (the `pull` abort path enqueues the terminal and
  closes; `:9397-9404`), and the app's contract assumes frozen parts
  (`turn-evidence.ts` "part states freeze in place on stop/abort/error";
  `resolveEntryStatus` gates them by settled). Probe: native route Stop
  persists `text:streaming`; tag route Stop persists `reasoning:done` /
  `text:done`. Both resolve to "complete" on a settled turn, and the trackers
  ignore end markers after `close()`, so it is harmless today, but it is the
  one route whose Stop persists different part states. Recommended hunk (owner:
  implementation agent): drop the `finishSource(controller)` call in the
  `abort` branch and reword its comment to say open parts stay frozen like the
  SDK's own abort path.
- Commands: focused suites (transform, chat-stream, chat-messages,
  components/chat, work-duration-tracker, adapters, openproviders) 77 files /
  751 passed; `bun run test` 299 files / 3115 passed, 0 failed (exit 0);
  `bun run typecheck` exit 0; `bun run lint` exit 0; `bun run build:next`
  exit 0. `bun run build` never run. Criterion 8: pass.
