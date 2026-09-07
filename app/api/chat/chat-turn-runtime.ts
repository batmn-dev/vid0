import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type { TitleTerminalUsageEvidence } from "@/convex/domain/usage_accounting"
import type { ChatAdmissionProofPayload } from "@/convex/lib/chatAdmissionProof"
import type { RunTimingReceipt } from "@/convex/lib/runTimingReceipt"
import type {
  ChatTurnEditRequest,
  ChatTurnRegenerationRequest,
} from "@/lib/chat-messages/chat-turn-contract"
import type { GenerationStats } from "@/lib/chat-messages/generation-stats"
import {
  getGenerationStats,
  getReasoningDurationMs,
  getWorkDurationMs,
} from "@/lib/chat-messages/metadata"
import { extractTextFromMessageParts } from "@/lib/chat-messages/parts"
import { initializeRetainedChatStream } from "@/lib/chat-stream/server"
import {
  fallbackChatTitle,
  generateChatTitle,
  INITIAL_CHAT_TITLE_GENERATION,
  selectChatTitleModelConfig,
} from "@/lib/chat-title"
import { CHAT_TURN_EXECUTION_BUDGET } from "@/lib/chat-turn/execution-budget"
import {
  ANONYMOUS_MAX_STEP_COUNT,
  DEFAULT_MAX_STEP_COUNT,
  MCP_MAX_STEP_COUNT,
  SYSTEM_PROMPT_DEFAULT,
} from "@/lib/config"
import type { ResolvedModelRoute } from "@/lib/model-route-resolver"
import { getAllModels } from "@/lib/models"
import { resolveModelSearchMode } from "@/lib/models/catalog"
import type { ModelConfig, ModelReasoningEffort } from "@/lib/models/types"
import {
  flushBraintrust,
  getBraintrustErrorMetadata,
  getBraintrustStreamText,
  hashBraintrustIdentifier,
  logBraintrustTraceMetadata,
  withBraintrustTrace,
  type BraintrustChatMetadata,
  type BraintrustTraceSpan,
} from "@/lib/observability/braintrust"
import { resolveBuildId } from "@/lib/observability/build-identity"
import {
  classifyChatError,
  getToolDimensionForError,
} from "@/lib/observability/chat-error-taxonomy"
import {
  createChatPerfServerSession,
  type ChatPerfServerSession,
} from "@/lib/observability/chat-performance"
import {
  getSanitizedExceptionSummary,
  sanitizeExceptionForTelemetry,
} from "@/lib/observability/sentry-scrubbing"
import { createLanguageModel } from "@/lib/openproviders/create-language-model"
import { resolveGenerationBudget } from "@/lib/openproviders/output-budget"
import {
  resolveReasoningEffort,
  shapeRequest,
} from "@/lib/openproviders/request-shaping"
import {
  captureGeneration,
  flushPostHog,
  getPostHogClient,
} from "@/lib/posthog"
import { scrubForAnalytics } from "@/lib/posthog/scrub"
import { prepareToolRuntime, type ToolRuntime } from "@/lib/tools/runtime"
import {
  buildFinishToolInvocationStreamMetadata,
  buildStartToolInvocationStreamMetadata,
  type ToolInvocationMetadataByCallId,
  type ToolInvocationMetadataByName,
} from "@/lib/tools/ui-metadata"
import type {
  ApiKeySource,
  Provider,
  ProviderCredentialResolution,
  ToolKeyMode,
} from "@/lib/user-keys"
import * as Sentry from "@sentry/nextjs"
import {
  consumeStream,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText as defaultGenerateText,
  isStepCount,
  UIMessage as MessageAISDK,
  safeValidateUIMessages,
  toUIMessageStream,
  validateUIMessages,
  type ModelMessage,
  type UIMessageChunk,
} from "ai"
import {
  fetchMutation as defaultFetchMutation,
  fetchQuery as defaultFetchQuery,
} from "convex/nextjs"
import { after } from "next/server"
import { adaptHistoryForProvider } from "./adapters"
import type { AdaptationContext, AdaptationWarning } from "./adapters/types"
import { splitAndValidateApprovalContinuation } from "./approval-continuation"
import {
  createDeterministicChatModel,
  createDeterministicTitleModel,
  parseDeterministicPerfDirective,
} from "./deterministic-provider"
import type { DurableGenerationInputPlan } from "./durable-generation-input"
import {
  createDurableTurnRuntime,
  isDurableConvexChat,
  type DurableStreamBinding,
  type DurableTurnRuntime,
  type DurableWorkerWire,
  type TerminalUsageFacts,
  type TitleUsageForSettlement,
} from "./durable-turn-runtime"
import { createGenerationTimingTracker } from "./generation-timing"
import { lowerForeignHostedToolParts } from "./hosted-tool-lowering"
import {
  createPostHogToolCallSink,
  createToolCallLogSink,
  createToolTraceLogSink,
} from "./outcome-sinks"
import { normalizeChatError, type PublicChatError } from "./public-error"
import { PublicChatHttpError } from "./public-http-error"
import { createReasoningActivityTracker } from "./reasoning-activity-tracker"
import {
  createStreamLivenessTracker,
  type StreamLivenessSignal,
  type StreamLivenessSnapshot,
} from "./stream-liveness-tracker"
import {
  getTextFilePartReferences,
  prepareTextFilePartsForModelInput,
} from "./text-file-parts"
import { excludeSystemRoleMessages } from "./utils"
import {
  createWordChunkingTransform,
  isWordChunkingEligible,
} from "./word-chunking-transform"
import {
  createWorkDurationTracker,
  type WorkDurationTracker,
} from "./work-duration-tracker"

// Request-scoped execution behind the route's HTTP adapter. `prepare()` may
// fail before model execution; `toResponse()` owns the stream lifecycle; and
// `fail()` persists setup failures (ADR-0006).

// The wire shape (`ChatTurnWireRequest`) lives on the Chat turn wire contract
// (lib/chat-messages/chat-turn-contract.ts), which the route parses through
// `parseChatTurnRequest` before constructing `ChatTurnInput`.

/**
 * The validated, admitted Chat turn the route hands to the runtime: parse,
 * auth, validation 400/401, and usage admission have all happened already.
 * `model` is the LOGICAL model id (ADR-0020) — the identity persisted on
 * chats/messages/runs; `route` names the concrete execution route the
 * resolver chose. `userId` is the resolved caller id.
 */
export type ChatTurnInput = {
  messages: MessageAISDK[]
  chatId: string
  model: string
  /** Immutable route-resolution receipt from route admission (ADR-0020). */
  route: ResolvedModelRoute
  // Optional: absent for a malformed request that passed shape validation;
  // prepare() falls back to SYSTEM_PROMPT_DEFAULT.
  systemPrompt?: string
  enableSearch: boolean
  /** Parser-validated per-turn effort request (ADR-0026); the runtime clamps
   * it to the resolved route via `resolveReasoningEffort`. */
  reasoningEffort?: ModelReasoningEffort
  /** Parser-validated total generation allowance; absent = Auto. */
  generationBudget?: number
  chatVersion?: number
  expectedVisibleMessageCount?: number
  tailMessageId?: string
  edit?: ChatTurnEditRequest
  regeneration?: ChatTurnRegenerationRequest
  requestId: string
  userId: string
  anonymousId: string | undefined
  isAuthenticated: boolean
  convexToken: string | undefined
  /** Server-only credential fact resolved once during route admission. */
  credential: ProviderCredentialResolution
  /**
   * Platform allowance reservation admitted with the route (ADR-0021);
   * attached to the generation run at durable prepare. Present exactly when
   * `route.credentialSource` is "platform" and the actor is authenticated.
   */
  reservationId?: Id<"usageReservations">
  /** Canonical durable input already used for route and allowance admission. */
  generationInput?: DurableGenerationInputPlan
  /**
   * Sampled chat-performance session. Absent/no-op by default; when
   * sampled it wraps preparation stages in content-free spans and receives
   * checkpoint counters from the durable runtime.
   */
  perf?: ChatPerfServerSession
  /**
   * HTTP request receipt time (route-captured). Anchors the receipt-anchored
   * perf spans; absent in tests/non-route callers, which fall back to the
   * runtime's construction clock.
   */
  requestReceivedAtMs?: number
  /**
   * The same instant on `performance.now()` — the monotonic anchor for the
   * run timing receipt's `prepareMs` (ADR-0030), immune to wall-clock steps.
   * Falls back to the runtime's construction instant.
   */
  requestReceivedPerfMs?: number
}

/**
 * Injected dependencies — defaulted to the real implementations, overridable in
 * tests so a whole turn (prepare, stream callbacks, durable writes) can run
 * without an HTTP request or a live model.
 */
export type ChatTurnDeps = {
  streamText: typeof import("ai").streamText
  generateText: typeof import("ai").generateText
  fetchMutation: typeof defaultFetchMutation
  fetchQuery: typeof defaultFetchQuery
  after: typeof after
  getPostHogClient: typeof getPostHogClient
  /**
   * The Durable worker wire (ADR-0011) — grant-authorized post-prepare durable
   * writes. Defaults inside the Durable turn runtime to the Convex
   * /chat-turn/worker HTTP adapter; tests inject a recording fake.
   */
  durableWorkerWire?: DurableWorkerWire
  /** Terminal-write retry backoff override — tests pass zeros. */
  durableSettleRetryDelaysMs?: number[]
  /** Server-only admission signer override for tests. */
  chatAdmissionProofSigner?: (payload: ChatAdmissionProofPayload) => string
}

function resolveDeps(overrides?: Partial<ChatTurnDeps>): ChatTurnDeps {
  return {
    streamText: overrides?.streamText ?? getBraintrustStreamText(),
    generateText: overrides?.generateText ?? defaultGenerateText,
    fetchMutation: overrides?.fetchMutation ?? defaultFetchMutation,
    fetchQuery: overrides?.fetchQuery ?? defaultFetchQuery,
    after: overrides?.after ?? after,
    getPostHogClient: overrides?.getPostHogClient ?? getPostHogClient,
    durableWorkerWire: overrides?.durableWorkerWire,
    durableSettleRetryDelaysMs: overrides?.durableSettleRetryDelaysMs,
    chatAdmissionProofSigner: overrides?.chatAdmissionProofSigner,
  }
}

type ToolExecutionOutcome =
  "none" | "success" | "failure" | "timeout" | "budget_denied"

type CompletedGenerationStep = {
  readonly usage: { readonly outputTokens: number | undefined }
}

const round2 = (value: number) => Math.round(value * 100) / 100

/**
 * Mirrors the AI SDK's own output-chunk definition (the one behind
 * `timeToFirstOutputMs`): generated text, reasoning, tool input, tool calls,
 * and files (reasoning files included). Empty deltas and lifecycle/metadata
 * parts are not output.
 */
function isOutputStreamPart(part: {
  type: string
  text?: string
  delta?: string
}) {
  switch (part.type) {
    case "text-delta":
    case "reasoning-delta":
      return (part.text?.length ?? 0) > 0
    case "tool-input-delta":
      return (part.delta?.length ?? 0) > 0
    case "tool-call":
    case "file":
    case "reasoning-file":
      return true
    default:
      return false
  }
}

/** Null means the provider omitted trustworthy output usage, so another
 * spend-bearing model step must fail closed. */
function completedOutputTokens(
  steps: ReadonlyArray<CompletedGenerationStep>
): number | null {
  let total = 0
  for (const step of steps) {
    const outputTokens = step.usage.outputTokens
    if (
      outputTokens === undefined ||
      !Number.isSafeInteger(outputTokens) ||
      outputTokens < 0
    ) {
      return null
    }
    total += outputTokens
    if (!Number.isSafeInteger(total)) return null
  }
  return total
}

type PreparedTurn = {
  aiModel: ReturnType<typeof createLanguageModel>
  titleModel: ReturnType<typeof createLanguageModel>
  /** Title-route id, reported with the title call's usage (ADR-0021). */
  titleRouteId: string
  modelConfig: ModelConfig
  provider: Provider
  /** Concrete effective effort recorded for badges and reopen (ADR-0026). */
  appliedReasoningEffort: ModelReasoningEffort | undefined
  /** Provider-facing max after route/provider translation (ADR-0028). */
  providerMaxOutputTokens: number | undefined
  /** Total applied generation allowance recorded on the assistant turn. */
  appliedGenerationBudget: number | undefined
  normalizedChatVersion: number
  hasAnyTools: boolean
  shouldInjectSearch: boolean
  maxSteps: number
  startTime: number
  validatedMessages: MessageAISDK[]
  initialWorkDurationMs: number
  initialReasoningDurationMs: number | undefined
  /** The reused assistant message's Generation stats on an approval continuation. */
  initialGenerationStats: GenerationStats | undefined
  modelMessages: ModelMessage[]
  providerOptions: ReturnType<typeof shapeRequest>["providerOptions"]
  requestHeaders: ReturnType<typeof shapeRequest>["headers"]
  toolMetadataByName: ToolInvocationMetadataByName
  enrichedSystemPrompt: string
  braintrustMetadata: BraintrustChatMetadata
  phClient: ReturnType<typeof getPostHogClient>
  titleRequest: { userText: string; generation: number } | null
}

function normalizeChatVersion(
  chatVersion: unknown,
  fallbackMessages: MessageAISDK[]
): number {
  if (
    typeof chatVersion === "number" &&
    Number.isFinite(chatVersion) &&
    chatVersion >= 0
  ) {
    return Math.floor(chatVersion)
  }
  return fallbackMessages.length
}

function getFirstUserText(messages: MessageAISDK[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user")
  if (!firstUserMessage) return ""
  return extractTextFromMessageParts(firstUserMessage.parts).trim()
}

function bucketChatVersion(chatVersion: number): string {
  if (chatVersion <= 1) return "0-1"
  if (chatVersion <= 5) return "2-5"
  if (chatVersion <= 20) return "6-20"
  return "21+"
}

function bucketLatencyMs(latencyMs: number): string {
  if (latencyMs <= 1000) return "le_1s"
  if (latencyMs <= 3000) return "1s_3s"
  if (latencyMs <= 8000) return "3s_8s"
  if (latencyMs <= 15000) return "8s_15s"
  return "gt_15s"
}

function getSlowRequestThresholdMs(): number {
  const fallback = 30000
  const parsed = Number.parseInt(
    process.env.SENTRY_CHAT_SLOW_REQUEST_MS ?? "",
    10
  )
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function getStalledContinuationThresholdMs(): number {
  const fallback = 30000
  // setTimeout overflows past 2^31-1 ms and fires immediately; clamp so a
  // misconfigured threshold cannot turn into a stall alert on every tool step.
  const maxTimeoutMs = 2_147_483_647
  const parsed = Number.parseInt(
    process.env.SENTRY_CHAT_STALLED_CONTINUATION_MS ?? "",
    10
  )
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, maxTimeoutMs)
    : fallback
}

function isReplayShapeError(message: string): boolean {
  const normalized = message.toLowerCase()
  return [
    // OpenAI
    "was provided without its required",
    "no tool output found for function call",
    // Anthropic
    "thinking block must be followed by",
    "tool_use block must be followed by tool_result",
    // Google
    "number of function response parts is equal to",
    "missing a thought_signature",
  ].some((pattern) => normalized.includes(pattern))
}

function summarizeHistoryPartTypes(messages: MessageAISDK[]): {
  roleCounts: Record<string, number>
  partTypeCounts: Record<string, number>
} {
  const roleCounts: Record<string, number> = {}
  const partTypeCounts: Record<string, number> = {}

  for (const message of messages) {
    roleCounts[message.role] = (roleCounts[message.role] ?? 0) + 1
    for (const part of message.parts ?? []) {
      partTypeCounts[part.type] = (partTypeCounts[part.type] ?? 0) + 1
    }
  }

  return { roleCounts, partTypeCounts }
}

function countWarningsByCode(
  warnings: AdaptationWarning[]
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const warning of warnings) {
    counts[warning.code] = (counts[warning.code] ?? 0) + 1
  }
  return counts
}

export type ChatTurnRuntime = {
  /**
   * Resolve the execution plan: model/key, Tool runtime, durable-prepare,
   * history adaptation, request shaping. Intentional client-safe failures use
   * PublicChatHttpError (missing key → 401, durable concurrency → 4xx); all
   * other exceptions are redacted by the route. Must run before `toResponse`.
   */
  prepare(): Promise<void>
  /**
   * Invoke streamText, own the stream-lifecycle state and both `onEnd`
   * layers, and return the streaming Response. The abort signal is wired to the
   * stream and to the chat lifecycle telemetry here.
   */
  toResponse(signal: AbortSignal): Promise<Response>
  /**
   * Finalize a failed turn for the route's outer catch: dispose MCP clients,
   * mark the durable run failed (if one started), and capture to Sentry. Safe
   * even when the stream never started.
   */
  fail(error: unknown): Promise<void>
}

export function createChatTurnRuntime(args: {
  input: ChatTurnInput
  deps?: Partial<ChatTurnDeps>
}): ChatTurnRuntime {
  const { input } = args
  const deps = resolveDeps(args.deps)
  // The budget's deadlines are measured from TURN start, but the platform's
  // route clock started at request receipt — construction happens right
  // after request parsing, so anchoring here charges prepare() (MCP
  // connections, attachment fetches) against the provider deadline instead
  // of silently eroding the settlement reserve.
  const turnStartedAtMs = Date.now()
  const {
    messages,
    chatId,
    model,
    systemPrompt,
    enableSearch,
    reasoningEffort,
    generationBudget,
    chatVersion,
    expectedVisibleMessageCount,
    tailMessageId,
    edit,
    regeneration,
    requestId,
    userId,
    anonymousId,
    isAuthenticated,
    convexToken,
    credential,
    route,
    reservationId,
    generationInput,
  } = input
  // No-op unless the route sampled this request (rate 0 short-circuits).
  const perf = input.perf ?? createChatPerfServerSession(null, { rate: 0 })
  const requestReceivedAtMs = input.requestReceivedAtMs ?? turnStartedAtMs
  const requestReceivedPerfMs = input.requestReceivedPerfMs ?? performance.now()

  // Lifecycle guard — the runtime is one-shot. `prepare()` and `toResponse()`
  // may each run at most once, in order, so a repeated call can never open a
  // second durable run or a second model stream.
  let phase: "idle" | "preparing" | "prepared" | "streaming" | "terminal" =
    "idle"

  // Durable turn runtime (CONTEXT.md; docs/adr/0009-durable-turn-runtime.md):
  // the deep module owning ALL durable-persistence knowledge for this turn.
  // Constructed here — non-null from birth, so the parent never branches on
  // durability and `fail()` never null-checks. The selecting factory
  // internalizes `isDurableConvexChat`; the convex token crosses once, here.
  const durableTurn: DurableTurnRuntime = createDurableTurnRuntime({
    input: {
      chatId,
      requestId,
      model,
      messages,
      isAuthenticated,
      convexToken,
      edit,
      regeneration,
      expectedVisibleMessageCount,
      tailMessageId,
      generationInputHash: generationInput?.inputHash,
      reservationId,
    },
    deps: {
      fetchMutation: deps.fetchMutation,
      workerWire: deps.durableWorkerWire,
      settleRetryDelaysMs: deps.durableSettleRetryDelaysMs,
      admissionProofSigner: deps.chatAdmissionProofSigner,
      perf,
    },
  })

  // Failure-relevant state — assigned as soon as it exists so `fail()` can act
  // even when `prepare()` throws partway through. `provider` is mirrored into
  // `PreparedTurn` for `toResponse()`, but kept here too so `fail()` can tag it
  // on a partial prepare (it is computed before the plan is assembled).
  let toolRuntime: ToolRuntime | null = null
  let openedMcpClientCount = 0
  let provider: Provider | undefined = credential.provider
  let credentialSource: ApiKeySource | undefined = credential.source
  let lastPublicError: PublicChatError | null = null

  // Request-scoped resource teardown (MCP clients, analytics flushes) is
  // owned by SETTLEMENT, not by `after()`: `after()` can fire on
  // response-stream cancellation while a durable worker is still executing,
  // and disposing MCP clients
  // mid-run would fail every later tool step. The `after()` registration
  // below stays only as the backstop for turns whose stream never started
  // (prepare failures) or already settled; the provider deadline bounds how
  // long a started stream can defer disposal.
  let providerStreamStarted = false
  let turnSettled = false
  let turnResourcesDisposed = false
  const disposeTurnResources = async () => {
    if (turnResourcesDisposed) return
    turnResourcesDisposed = true
    if (toolRuntime) await toolRuntime.dispose()
    await flushPostHog().catch(() => {})
    await flushBraintrust().catch(() => {})
  }

  const normalizeTurnError = (error: unknown): PublicChatError => {
    const normalized = normalizeChatError(error, {
      provider,
      credentialSource,
    })
    lastPublicError = normalized
    return normalized
  }

  // The full execution plan, assigned at the end of a successful prepare().
  let prepared: PreparedTurn | null = null

  const slowRequestThresholdMs = getSlowRequestThresholdMs()
  const stalledContinuationThresholdMs = getStalledContinuationThresholdMs()

  async function prepare(): Promise<void> {
    if (phase !== "idle") {
      throw new Error("Chat turn runtime: prepare() may only be called once")
    }
    phase = "preparing"

    const resolvedProvider = credential.provider
    Sentry.setTag("chat_provider", resolvedProvider)

    const allModels = await Sentry.startSpan(
      { name: "chat.load_models", op: "chat.config" },
      async () => getAllModels()
    )
    // Model construction runs on the resolved ROUTE record (ADR-0020): its
    // capabilities, pricing, and construction settings are route-specific.
    // `model` stays the logical id every persisted document speaks in.
    const modelConfig = allModels.find((m) => m.id === route.routeId)

    if (!modelConfig) {
      throw new PublicChatHttpError({
        message: `Model ${model} not found`,
        statusCode: 400,
        code: "INVALID_REQUEST",
      })
    }

    const effectiveSystemPrompt = systemPrompt || SYSTEM_PROMPT_DEFAULT

    const apiKey = credential.apiKey
    credentialSource = credential.source

    // Resolve key and provenance together. If neither user BYOK nor the
    // provider's platform env key exists, fail before constructing the SDK.
    if (!apiKey || !credentialSource) {
      const providerName = modelConfig.provider || resolvedProvider
      throw new PublicChatHttpError({
        message: `No API key configured for ${providerName}. Please add your ${providerName} API key in settings.`,
        statusCode: 401,
        code: "MISSING_API_KEY",
      })
    }
    const providerToolKeyMode: ToolKeyMode = credentialSource

    const phClient = deps.getPostHogClient()
    const normalizedChatVersion = normalizeChatVersion(chatVersion, messages)

    // Tool outcome sinks (CONTEXT.md; app/api/chat/outcome-sinks.ts): the
    // runtime assembles one Tool outcome per call at step finish and dispatches
    // it to each sink. Trace log always; analytics and audit only when their
    // destinations exist for this request.
    const outcomeSinks = [
      createToolTraceLogSink({ requestId, chatId, userId, model }),
      ...(phClient
        ? [
            createPostHogToolCallSink({
              phClient,
              distinctId: userId,
              chatId,
              requestId,
              chatVersion: normalizedChatVersion,
            }),
          ]
        : []),
      ...(convexToken
        ? [
            createToolCallLogSink({
              convexToken,
              chatId,
              requestId,
              chatVersion: normalizedChatVersion,
            }),
          ]
        : []),
    ]

    // Tool runtime (CONTEXT.md; lib/tools/runtime.ts)
    //
    // Loads the three Tool layers (Layer 1 provider-native, Layer 2 Exa
    // search/content, Layer 3 MCP), runs both Capability policy phases, enforces
    // Tool budget, applies naming governance, and prepares runtime-approval
    // decisions — all behind one interface. It owns the stream-lifecycle hooks
    // (`prepareStep`, `onStepFinish`) the turn composes with durable persistence.
    const tool = await perf.span("tool_preparation", () =>
      prepareToolRuntime({
        isAuthenticated,
        convexToken,
        anonymousId,
        provider: resolvedProvider,
        apiKey,
        providerToolKeyMode,
        modelTools: modelConfig.tools,
        modelSearchMode: resolveModelSearchMode(modelConfig),
        enableSearch,
        logContext: { requestId, chatId, userId, model },
        onMcpClientsOpened: (clientCount) => {
          openedMcpClientCount = clientCount
        },
        outcomeSinks,
      })
    )
    toolRuntime = tool
    // Backstop registration only (see disposeTurnResources): a started,
    // unsettled stream skips this — its settlement path disposes — because
    // after() can fire on response cancellation while the durable worker is
    // still executing tool steps. dispose() is idempotent.
    deps.after(async () => {
      if (providerStreamStarted && !turnSettled) return
      await disposeTurnResources()
    })

    const hasAnyTools = tool.hasTools
    const shouldInjectSearch = tool.policySummary.searchInjected

    // Per-turn effort (ADR-0026): resolve only after Capability policy proves
    // whether search is active. Claude 4.6's pause_turn workaround replaces
    // adaptive effort with a fixed budget, so that path must not emit an
    // applied-effort receipt or message badge.
    const { wireReasoningEffort, appliedReasoningEffort } =
      resolveReasoningEffort(modelConfig, reasoningEffort, {
        platformFunded: credentialSource === "platform",
        searchToolsActive: shouldInjectSearch,
      })
    const outputBudget = resolveGenerationBudget({
      route: modelConfig,
      credentialSource,
      requestedGenerationBudget: generationBudget,
      searchToolsActive: shouldInjectSearch,
    })
    if (!outputBudget.ok) {
      throw new PublicChatHttpError({
        message: `This model needs a generation budget of at least ${outputBudget.minimumGenerationBudget.toLocaleString()} tokens when fixed reasoning is enabled.`,
        statusCode: 400,
        code: "INVALID_GENERATION_BUDGET",
      })
    }

    // Active only when the server sets CHAT_PERF_DETERMINISTIC_PROVIDER
    // and the trailing user message carries a well-formed [[perf:...]]
    // directive — the parse returns null otherwise, and everything below the
    // model call (transforms, durable writes, settlement) runs unchanged.
    const perfDirective = parseDeterministicPerfDirective(messages)
    // OpenRouter's reasoning knob is construction-time (provider-strategy.ts),
    // so a per-turn wire override replaces the catalog default here.
    const aiModel = perfDirective
      ? createDeterministicChatModel(perfDirective)
      : createLanguageModel(
          wireReasoningEffort !== undefined &&
            modelConfig.providerId === "openrouter"
            ? { ...modelConfig, reasoning: { effort: wireReasoningEffort } }
            : modelConfig,
          apiKey
        )
    const titleModelConfig = selectChatTitleModelConfig(allModels, modelConfig)
    const titleModel = perfDirective
      ? createDeterministicTitleModel()
      : createLanguageModel(titleModelConfig, apiKey)

    const durableRuntimeEnabled = isDurableConvexChat({
      isAuthenticated,
      convexToken,
    })

    // Reject stale/provider-switched approval responses before durable prepare
    // mutates approval state or creates a continuation run. Durable prepare
    // independently verifies the paused run's provider server-side; this early
    // check also proves the current registry still contains the exact tool.
    const requestApprovalContinuation = splitAndValidateApprovalContinuation({
      messages,
      targetProvider: resolvedProvider,
      tools: tool.tools,
    })
    if (requestApprovalContinuation.tail.length > 0 && !durableRuntimeEnabled) {
      throw new PublicChatHttpError({
        statusCode: 409,
        code: "APPROVAL_CONTINUATION_UNVERIFIABLE",
        message:
          "This approval can no longer be verified. Start a new request instead.",
      })
    }

    // Anonymous users get a lower step count to limit tool call cost exposure.
    // Authenticated users get the full MCP_MAX_STEP_COUNT (20).
    const maxSteps = hasAnyTools
      ? isAuthenticated
        ? MCP_MAX_STEP_COUNT
        : ANONYMOUS_MAX_STEP_COUNT
      : DEFAULT_MAX_STEP_COUNT

    const startTime = Date.now()

    // PostHog/Braintrust flushes ride the same settlement-owned teardown as
    // MCP disposal (disposeTurnResources) — flush() (not shutdown()) allows
    // client reuse in warm containers. No separate after() registrations: the
    // backstop above already covers never-started turns.

    // Durable prepare confirms the read-only input plan before mutating. A
    // planned durable turn then reuses the exact attachment-expanded messages
    // that allowance admission priced; legacy/guest callers use prepare's
    // returned history as before.
    const preparedDurableMessages = await perf.span("durable_prepare", () =>
      durableTurn.prepare({
        provider: resolvedProvider,
        route: {
          routeId: route.routeId,
          credentialSource: route.credentialSource,
          routeReason: route.routeReason,
        },
        ...(reasoningEffort !== undefined ||
        appliedReasoningEffort !== undefined
          ? {
              reasoningEffort: {
                ...(reasoningEffort !== undefined
                  ? { requested: reasoningEffort }
                  : {}),
                ...(appliedReasoningEffort !== undefined
                  ? { applied: appliedReasoningEffort }
                  : {}),
              },
            }
          : {}),
        ...(outputBudget.requestedGenerationBudget !== undefined ||
        outputBudget.appliedGenerationBudget !== undefined
          ? {
              generationBudget: {
                ...(outputBudget.requestedGenerationBudget !== undefined
                  ? { requested: outputBudget.requestedGenerationBudget }
                  : {}),
                ...(outputBudget.appliedGenerationBudget !== undefined
                  ? { applied: outputBudget.appliedGenerationBudget }
                  : {}),
              },
            }
          : {}),
      })
    )
    let canonicalMessages = generationInput?.messages ?? preparedDurableMessages

    // History system messages are untrusted artifacts; trusted instructions use
    // streamText's separate `instructions` input.
    const systemRoleExclusion = excludeSystemRoleMessages(canonicalMessages)
    if (systemRoleExclusion.excludedCount > 0) {
      console.warn(
        JSON.stringify({
          _tag: "model_history_system_messages_excluded",
          requestId,
          chatId,
          provider: resolvedProvider,
          model,
          excludedCount: systemRoleExclusion.excludedCount,
        })
      )
    }
    canonicalMessages = systemRoleExclusion.messages

    // Boundary 1 — STRUCTURAL validation of canonical durable history. The
    // current turn's tool registry is deliberately absent: history may carry
    // provider-executed tool outputs in a FOREIGN provider's wire shape (the
    // shared `web_search` key has an incompatible schema per provider), and
    // judging historical outputs by the newly selected provider's schema
    // rejects valid conversations. Tool-schema validation runs at Boundary 2
    // below, after history has been adapted for the target provider.
    const validatedMessages = await perf.span("message_validation", () =>
      validateUIMessages({
        messages: canonicalMessages,
      })
    )
    // An approval continuation reuses the paused assistant turn, so both
    // duration clocks resume from the persisted pre-pause totals. Work always
    // starts from zero; reasoning preserves absence versus an observed zero.
    const continuationBaseMetadata =
      requestApprovalContinuation.tail.length > 0
        ? validatedMessages.findLast((message) => message.role === "assistant")
            ?.metadata
        : undefined
    const initialWorkDurationMs =
      getWorkDurationMs(continuationBaseMetadata) ?? 0
    const initialReasoningDurationMs = getReasoningDurationMs(
      continuationBaseMetadata
    )
    // Generation stats accumulate across the continuation the same way
    // (ADR-0030); the run timing receipt does not — it is per run.
    const initialGenerationStats = getGenerationStats(continuationBaseMetadata)

    const textFileModelInput = generationInput
      ? {
          messages: validatedMessages,
          ...generationInput.textFileStats,
        }
      : await (async () => {
          const textFileReferences =
            getTextFilePartReferences(validatedMessages)
          const trustedTextAttachments =
            durableRuntimeEnabled &&
            convexToken &&
            textFileReferences.length > 0
              ? await deps.fetchQuery(
                  api.files.getTrustedTextAttachmentsForChat,
                  {
                    chatId,
                    references: textFileReferences,
                  },
                  { token: convexToken }
                )
              : []

          return await prepareTextFilePartsForModelInput(validatedMessages, {
            trustedAttachments: trustedTextAttachments,
          })
        })()

    if (textFileModelInput.convertedCount > 0) {
      console.log(
        JSON.stringify({
          _tag: "text_file_model_input_prepared",
          chatId,
          provider: resolvedProvider,
          model,
          convertedCount: textFileModelInput.convertedCount,
          failedCount: textFileModelInput.failedCount,
          truncatedCount: textFileModelInput.truncatedCount,
          skippedCount: textFileModelInput.skippedCount,
        })
      )
    }

    const adaptationContext: AdaptationContext = {
      targetModelId: model,
      targetRouteId: route.routeId,
      hasTools: hasAnyTools,
      sourceProviderHint: resolvedProvider,
    }

    // A live approval response is the only tool activity exempt from history
    // projection. Prove provider, registry, execution-kind, and provider-tool
    // identity continuity before separating it from history. This prevents a
    // same-named foreign tool or a disabled tool from inheriting an approval.
    const approvalContinuation = splitAndValidateApprovalContinuation({
      messages: textFileModelInput.messages,
      targetProvider: resolvedProvider,
      tools: tool.tools,
    })
    const continuationTail = approvalContinuation.tail
    const historyForAdaptation = approvalContinuation.history

    // Provider-hosted activity is evidence, not a portable call/result pair.
    // Project every historical static/dynamic provider-executed part and every
    // provider grounding source to safe text before any target adapter runs.
    const hostedLowering = lowerForeignHostedToolParts(historyForAdaptation, {
      targetProvider: resolvedProvider,
      tools: tool.tools,
    })
    if (
      hostedLowering.loweredCount > 0 ||
      hostedLowering.sourceProjectionCount > 0
    ) {
      console.log(
        JSON.stringify({
          _tag: "hosted_tool_history_lowered",
          chatId,
          provider: resolvedProvider,
          model,
          loweredCount: hostedLowering.loweredCount,
          sourceProjectionCount: hostedLowering.sourceProjectionCount,
          details: hostedLowering.details,
        })
      )
    }

    const adaptStartTime = Date.now()
    const adapterResult = await adaptHistoryForProvider(
      hostedLowering.messages,
      resolvedProvider,
      adaptationContext
    )
    const adaptedMessagesWithTail = [
      ...adapterResult.messages,
      ...continuationTail,
    ]
    const adaptationTimeMs = Date.now() - adaptStartTime
    perf.record("history_adaptation", adaptationTimeMs)
    const warningCount = adapterResult.warnings.length
    const warningCountsByCode = countWarningsByCode(adapterResult.warnings)
    const partsDroppedTotal = Object.values(
      adapterResult.stats.partsDropped
    ).reduce((sum, count) => sum + count, 0)

    console.log(
      JSON.stringify({
        _tag: "history_adapt",
        chatId,
        provider: resolvedProvider,
        model,
        ...adapterResult.stats,
        warningCount,
        warningCodes: warningCountsByCode,
        adaptationTimeMs,
      })
    )

    if (phClient) {
      phClient.capture({
        distinctId: userId || "anonymous",
        event: "history_adaptation",
        properties: {
          chatId,
          provider: resolvedProvider,
          model,
          originalMessageCount: adapterResult.stats.originalMessageCount,
          adaptedMessageCount: adapterResult.stats.adaptedMessageCount,
          partsDroppedTotal,
          providerIdsStripped: adapterResult.stats.providerIdsStripped,
          warningCount,
          adaptationTimeMs,
        },
      })
    }

    // Boundary 2 — MODEL-BOUND validation. Boundary 1 already enforces the
    // SDK's non-empty structural contract; after projection/adaptation this
    // validation must pass against the current own-property tool registry.
    // Failure is an internal replay invariant breach. Do not silently flatten
    // files, images, sources, reasoning, or continuation state.
    const modelBoundValidation = await perf.span("model_bound_validation", () =>
      safeValidateUIMessages({
        messages: adaptedMessagesWithTail,
        tools: tool.tools as unknown as Parameters<
          typeof safeValidateUIMessages
        >[0]["tools"],
      })
    )

    if (!modelBoundValidation.success) {
      const validationError = modelBoundValidation.error
      console.warn(
        JSON.stringify({
          _tag: "model_bound_validation_failed",
          chatId,
          provider: resolvedProvider,
          model,
          errorName: validationError.name,
        })
      )
      Sentry.captureMessage("chat_model_bound_validation_failed", {
        level: "warning",
        tags: {
          route: "api/chat",
          chat_provider: resolvedProvider,
          chat_model: model,
        },
        extra: { requestId, errorName: validationError.name },
      })
      const invariantError = new Error("Model-bound replay invariant failed")
      invariantError.name = "ModelBoundReplayInvariantError"
      throw invariantError
    }

    const modelMessages: ModelMessage[] = await convertToModelMessages(
      adaptedMessagesWithTail,
      {
        tools: tool.tools,
        ignoreIncompleteToolCalls: true,
      }
    )

    // Request shaping (CONTEXT.md; lib/openproviders/request-shaping.ts):
    // provider options and beta headers behind one seam. The module owns the
    // pause_turn search downgrade and token-efficient beta gating.
    const { providerOptions, headers: requestHeaders } = shapeRequest(
      modelConfig,
      {
        searchToolsActive: shouldInjectSearch,
        hasTools: hasAnyTools,
        ...(wireReasoningEffort !== undefined ? { wireReasoningEffort } : {}),
      }
    )

    // Transport-safe by-name display metadata, resolved by the Tool runtime's
    // metadata resolver (the four per-layer maps never escape the runtime).
    const toolMetadataByName = tool.metadata.toInvocationMetadataByName()

    const enrichedSystemPrompt = effectiveSystemPrompt

    const mcpServerCount = tool.mcpServerCount
    const braintrustMetadata: BraintrustChatMetadata = {
      requestId,
      route: "api/chat",
      operation: "stream_text",
      chatIdHash: await hashBraintrustIdentifier(chatId),
      model,
      provider: resolvedProvider,
      isAuthenticated,
      messageCount: validatedMessages.length,
      chatVersionBucket: bucketChatVersion(normalizedChatVersion),
      searchEnabled: shouldInjectSearch,
      hasTools: hasAnyTools,
      keyMode: providerToolKeyMode,
      exaKeyMode: tool.policySummary.keyMode ?? null,
      maxSteps,
      capabilities: {
        search: tool.policySummary.capabilities.search,
        extract: tool.policySummary.capabilities.extract,
        code: tool.policySummary.capabilities.code,
        mcp: tool.policySummary.capabilities.mcp,
        platform: tool.policySummary.capabilities.platform,
      },
      capabilityReasons: tool.policySummary.capabilityReasons,
      toolPolicy: {
        userTier: tool.policySummary.userTier,
        keyMode: tool.policySummary.keyMode ?? null,
        keyModeReason: tool.policySummary.keyModeReason,
        totalTools: tool.policySummary.totalTools,
        earlyAllowedCount: tool.policySummary.earlyAllowedCount,
        lateAllowedCount: tool.policySummary.lateAllowedCount,
      },
      toolCounts: {
        builtIn: tool.toolCounts.builtIn,
        thirdParty: tool.toolCounts.thirdParty,
        content: tool.toolCounts.content,
        mcp: tool.toolCounts.mcp,
        total: tool.toolCounts.total,
      },
      mcp: {
        serverCount: mcpServerCount,
        toolCount: tool.toolCounts.mcp,
      },
      historyAdaptation: {
        warningCount: adapterResult.warnings.length,
        warningCodes: countWarningsByCode(adapterResult.warnings),
      },
    }

    const durableTitleGeneration = durableTurn.getTitleGeneration()
    const titleGeneration =
      durableTitleGeneration ??
      (durableTurn.mode === "guest" &&
      normalizedChatVersion === 1 &&
      !edit &&
      !regeneration
        ? INITIAL_CHAT_TITLE_GENERATION
        : null)
    const titleUserText =
      titleGeneration === null
        ? ""
        : edit?.replacementMessage.content.trim() ||
          getFirstUserText(validatedMessages) ||
          getFirstUserText(messages)

    prepared = {
      aiModel,
      titleModel,
      titleRouteId: titleModelConfig.id,
      modelConfig,
      provider: resolvedProvider,
      appliedReasoningEffort,
      providerMaxOutputTokens: outputBudget.providerMaxOutputTokens,
      appliedGenerationBudget: outputBudget.appliedGenerationBudget,
      normalizedChatVersion,
      hasAnyTools,
      shouldInjectSearch,
      maxSteps,
      startTime,
      validatedMessages,
      initialWorkDurationMs,
      initialReasoningDurationMs,
      initialGenerationStats,
      modelMessages,
      providerOptions,
      requestHeaders,
      toolMetadataByName,
      enrichedSystemPrompt,
      braintrustMetadata,
      phClient,
      titleRequest:
        titleGeneration !== null && titleUserText
          ? { userText: titleUserText, generation: titleGeneration }
          : null,
    }
    phase = "prepared"
  }

  async function toResponse(signal: AbortSignal): Promise<Response> {
    if (phase !== "prepared") {
      throw new Error(
        "Chat turn runtime: toResponse() requires a completed prepare()"
      )
    }
    phase = "streaming"

    if (!prepared) {
      throw new Error("prepare() must be called before toResponse()")
    }
    const tool = toolRuntime
    if (!tool) {
      throw new Error("Tool runtime missing after prepare()")
    }
    const {
      aiModel,
      titleModel,
      titleRouteId,
      modelConfig,
      provider: resolvedProvider,
      providerMaxOutputTokens,
      appliedGenerationBudget,
      normalizedChatVersion,
      hasAnyTools,
      shouldInjectSearch,
      maxSteps,
      startTime,
      validatedMessages,
      initialWorkDurationMs,
      initialReasoningDurationMs,
      initialGenerationStats,
      modelMessages,
      providerOptions,
      requestHeaders,
      toolMetadataByName,
      enrichedSystemPrompt,
      braintrustMetadata,
      phClient,
      titleRequest,
      appliedReasoningEffort,
    } = prepared

    // The AI SDK lifecycle binding (ADR-0011, Design 2): both callback halves
    // of the durable timeline, bound to the Tool runtime for the stream
    // lifetime. Settlement ordering, worker authority, and retry policy live
    // behind it; the two onEnd positions below stay visible in this closure
    // (ADR-0006).
    const lifecycle: DurableStreamBinding = durableTurn.bind(tool)

    // Provider consumption stops on the FIRST of: the runtime's execution
    // scope ending (durable: worker lost run ownership via heartbeat `lost` /
    // grant rejection — the CLIENT signal is deliberately absent, a reload or
    // disconnect leaves the worker streaming to durable settlement; guest:
    // the request signal itself), or the provider deadline, which reserves
    // enough route time for settlement.
    // Client-disconnect telemetry below stays keyed to
    // the request signal alone and never stops the stream.
    // Remaining provider budget = deadline minus what prepare() already
    // consumed (anchored at construction — see turnStartedAtMs). The floor
    // keeps a pathologically slow prepare from instant-aborting the stream;
    // past it the reserve is already eroded and settlement leans on the
    // degraded-receipt + reaper backstops.
    const providerDeadlineRemainingMs = Math.max(
      15_000,
      CHAT_TURN_EXECUTION_BUDGET.providerDeadlineMs -
        (Date.now() - turnStartedAtMs)
    )
    const executionSignal = AbortSignal.any([
      ...durableTurn.providerAbortSignals(signal),
      AbortSignal.timeout(providerDeadlineRemainingMs),
    ])

    let streamStartMs = 0
    // Monotonic twin of streamStartMs for the receipt's prepare segment.
    let streamStartPerfMs = 0
    let workDuration: WorkDurationTracker | null = null
    const closeWorkDuration = () => workDuration?.close()
    const currentWorkDurationMs = () =>
      workDuration?.getDurationMs() ?? initialWorkDurationMs
    let toolMetadataByCallId: ToolInvocationMetadataByCallId = {}

    const reasoningActivity = createReasoningActivityTracker(
      Date.now,
      initialReasoningDurationMs
    )
    // Provider timing has ONE source: the SDK's per-step performance, read in
    // onStepEnd (ADR-0030). The chunk callback below runs AFTER every
    // experimental_transform, so it may only observe liveness, never time.
    const timing = createGenerationTimingTracker({
      initialStats: initialGenerationStats,
    })
    // Monotonic anchors on the SDK's own clock (performance.now): the first
    // provider call's start, and the first/last output part released to the
    // response stream (post-transform, observed in the UI-stream conversion).
    let firstCallStartPerfMs: number | null = null
    let firstOutputReleasedPerfMs: number | null = null
    let lastOutputReleasedPerfMs: number | null = null
    let firstTextDeltaLatencyMs: number | null = null

    // Title attempt tracker (ADR-0021 cancellation amendment): request-local
    // evidence of whether/where a title call started, created BEFORE the
    // stream so the onAbort closure never has a temporal-dead-zone dependency
    // on the later-created titleTask. "not-run" until an attempt dispatches;
    // route-pinned "started-without-usage" per attempt; route-aware actual
    // usage once the call finishes.
    const titleAttempt: { current: TitleTerminalUsageEvidence } = {
      current: { kind: "not-run" },
    }

    // The finished-step usage aggregate an abort exposes (AI SDK 7:
    // `onAbort.steps` is previously finished steps ONLY). Zero finished steps
    // is NOT proof of zero usage — the classification below then reports
    // started-without-usage, never a zero-usage "actual".
    const aggregateAbortStepUsage = (
      steps: ReadonlyArray<{
        usage?: { inputTokens?: number; outputTokens?: number }
      }>
    ): TerminalUsageFacts["primary"] | null => {
      let inputTokens = 0
      let outputTokens = 0
      let observed = false
      for (const step of steps) {
        if (typeof step.usage?.inputTokens === "number") {
          inputTokens += step.usage.inputTokens
          observed = true
        }
        if (typeof step.usage?.outputTokens === "number") {
          outputTokens += step.usage.outputTokens
          observed = true
        }
      }
      return observed
        ? { kind: "completed-steps", inputTokens, outputTokens }
        : null
    }

    /**
     * The run timing receipt as far as this turn can observe it (ADR-0030).
     * Called at every terminal hand-off; absent fields were unobserved. The
     * durable runtime adds `settlementMs` on the settle path.
     */
    const buildTimingReceipt = (): RunTimingReceipt => {
      const receipt: RunTimingReceipt = {
        ...(providerStreamStarted
          ? { prepareMs: round2(streamStartPerfMs - requestReceivedPerfMs) }
          : {}),
        ...timing.providerSegments(),
      }
      const firstOutputOffsetMs = timing.firstOutputOffsetMs()
      if (
        firstOutputOffsetMs !== undefined &&
        firstCallStartPerfMs !== null &&
        firstOutputReleasedPerfMs !== null
      ) {
        receipt.firstWriteDelayMs = round2(
          firstOutputReleasedPerfMs -
            (firstCallStartPerfMs + firstOutputOffsetMs)
        )
      }
      if (
        firstOutputReleasedPerfMs !== null &&
        lastOutputReleasedPerfMs !== null
      ) {
        receipt.wireStreamMs = round2(
          lastOutputReleasedPerfMs - firstOutputReleasedPerfMs
        )
      }
      const buildId = resolveBuildId()
      if (buildId) receipt.buildId = buildId
      return receipt
    }

    const captureChatLifecycleSignal = (
      signalName: StreamLivenessSignal,
      snapshot: StreamLivenessSnapshot
    ) => {
      Sentry.captureMessage(signalName, {
        level: "warning",
        tags: {
          route: "api/chat",
          chat_route: "/api/chat",
          chat_operation: "stream_text",
          chat_provider: resolvedProvider,
          chat_model: model,
          chat_is_authenticated: String(isAuthenticated),
          chat_error_type: "none",
          chat_stream_phase: snapshot.phase,
        },
        extra: {
          requestId,
          chatId,
          model,
          provider: resolvedProvider,
          isAuthenticated,
          messageCount: validatedMessages.length,
          chatVersion: normalizedChatVersion,
          firstTokenLatencyMs: timing.firstOutputOffsetMs() ?? null,
          ...snapshot,
          mcpClientCount: tool.mcpClientCount,
        },
      })
    }

    // Stream liveness: phase, the post-tool stall timer, and the rule that no
    // signal fires after completion or an execution abort. The tracker owns
    // the state; this closure only decorates its snapshot with identity tags.
    const liveness = createStreamLivenessTracker({
      stalledThresholdMs: stalledContinuationThresholdMs,
      onSignal: captureChatLifecycleSignal,
    })

    // Two abort observers have distinct meanings:
    // the REQUEST signal is client-disconnect telemetry only — for durable
    // chats the stream keeps executing after it fires — while the EXECUTION
    // signal is the stream actually ending, which owns the abort cleanup
    // (reasoning close, stalled-continuation disarm).
    const handleRequestAbort = () => liveness.requestAborted()
    const handleExecutionAbort = () => {
      if (!liveness.executionAborted()) return
      reasoningActivity.close()
      closeWorkDuration()
    }

    if (signal.aborted) {
      handleRequestAbort()
    } else {
      signal.addEventListener("abort", handleRequestAbort, { once: true })
      deps.after(() => {
        signal.removeEventListener("abort", handleRequestAbort)
      })
    }
    if (executionSignal.aborted) {
      handleExecutionAbort()
    } else {
      executionSignal.addEventListener("abort", handleExecutionAbort, {
        once: true,
      })
      deps.after(() => {
        executionSignal.removeEventListener("abort", handleExecutionAbort)
      })
    }

    const streamText = deps.streamText
    const lifecycleTransform = lifecycle.streamTextExtras.experimental_transform
    const wordChunkingTransform = isWordChunkingEligible({
      provider: resolvedProvider,
      model,
    })
      ? createWordChunkingTransform(executionSignal)
      : undefined
    const experimentalTransform = wordChunkingTransform
      ? lifecycleTransform
        ? [wordChunkingTransform, lifecycleTransform]
        : wordChunkingTransform
      : lifecycleTransform

    // Commit the provider-consumption boundary BEFORE dispatch. This awaited
    // write is load-bearing billing state: if Stop/revocation wins, the worker
    // reports not-started and never calls the provider.
    const dispatchBoundaryAt = Date.now()
    const dispatchAuthorized =
      await lifecycle.stream.startWork(dispatchBoundaryAt)
    if (!dispatchAuthorized) {
      await lifecycle.stream.onAbort(
        "provider dispatch not authorized",
        initialWorkDurationMs,
        {
          primary: { kind: "not-started" },
          title: { kind: "not-run" },
        }
      )
      throw new Error("Provider dispatch no longer authorized")
    }

    // Exact assistant-work start: durable authorization is committed and the
    // next operation begins provider consumption.
    streamStartMs = Date.now()
    streamStartPerfMs = performance.now()
    liveness.streamStarted()
    workDuration = createWorkDurationTracker({
      initialDurationMs: initialWorkDurationMs,
    })
    providerStreamStarted = true

    const runGeneration = (braintrustSpan: BraintrustTraceSpan) => {
      // Two anchors: `stream_start` begins at runtime construction;
      // `provider_request_started` begins at HTTP receipt.
      perf.record("stream_start", streamStartMs - turnStartedAtMs)
      perf.record(
        "provider_request_started",
        streamStartMs - requestReceivedAtMs
      )
      const budgetStopCondition =
        providerMaxOutputTokens === undefined
          ? undefined
          : ({ steps }: { steps: CompletedGenerationStep[] }) => {
              const used = completedOutputTokens(steps)
              return used === null || used >= providerMaxOutputTokens
            }
      return streamText({
        model: aiModel,
        instructions: enrichedSystemPrompt,
        messages: modelMessages,
        tools: tool.tools,
        stopWhen: budgetStopCondition
          ? [isStepCount(maxSteps), budgetStopCondition]
          : isStepCount(maxSteps),
        abortSignal: executionSignal,
        // Credential ownership decides funding, not response policy. Auto BYOK
        // omits the parameter; an explicit user budget applies to either key
        // source. Provider translation keeps fixed Anthropic reasoning from
        // being added twice to the platform reservation (ADR-0028).
        ...(providerMaxOutputTokens !== undefined
          ? { maxOutputTokens: providerMaxOutputTokens }
          : {}),
        // Request dimensions use Sentry because AI SDK 7 telemetry has no
        // per-call metadata field.
        telemetry: {
          isEnabled: true,
          functionId: "api.chat.streamText",
        },
        // Fires immediately before each provider call ATTEMPT — the anchor
        // the SDK's own `timeToFirstOutputMs` is measured from, re-taken per
        // retry (the SDK retries the whole call, notify included, so a 429
        // backoff moves this anchor too). Keep the latest attempt's until the
        // first step ends: that is the one the step's figures are relative
        // to, and it places the first output chunk on this process's clock
        // for the receipt's first-write delay without the retry gap inside.
        onLanguageModelCallStart: () => {
          if (
            liveness.stepCount() === 0 &&
            firstOutputReleasedPerfMs === null
          ) {
            firstCallStartPerfMs = performance.now()
          }
        },

        // Compose the Tool runtime's step gate with the remaining provider
        // output allowance. AI SDK maxOutputTokens is per model call, so each
        // later call receives only the unused turn budget. Missing usage stops
        // the loop through budgetStopCondition instead of guessing about spend.
        prepareStep:
          tool.prepareStep || providerMaxOutputTokens !== undefined
            ? async (options) => {
                const toolStep = await tool.prepareStep?.(options)
                if (providerMaxOutputTokens === undefined) return toolStep
                const used = completedOutputTokens(options.steps)
                return {
                  ...toolStep,
                  maxOutputTokens: Math.max(
                    1,
                    providerMaxOutputTokens -
                      (used === null ? providerMaxOutputTokens : used)
                  ),
                }
              }
            : undefined,

        // Per-step structured tracing: tool name, duration, token usage, success.
        onStepEnd: async (step) => {
          const { toolCalls, toolResults, usage, finishReason } = step
          // Liveness first: a tool-calls step arms the stall clock from the
          // step's end, so the tool-outcome recording below counts as quiet.
          liveness.stepEnded({
            finishReason,
            toolCallCount: toolCalls.length,
            toolNames: toolCalls.map((call) => call.toolName),
          })
          const stepNumber = liveness.stepCount()

          // The provider-timing source (ADR-0030): SDK step performance +
          // usage feed both the Generation stats and the run timing receipt.
          timing.recordStep(step)
          if (
            stepNumber === 1 &&
            step.performance.timeToFirstOutputMs !== undefined
          ) {
            perf.record(
              "provider_first_output",
              step.performance.timeToFirstOutputMs
            )
          }

          // Durable persistence of the step's tool invocations AND its token
          // usage — EVERY step, tool calls or not (ADR-0021): the per-step
          // usage accumulates on the run row as settlement evidence, so
          // abort/failure/reaper accounting never depends on the happy-path
          // onEnd aggregate. Status derivation lives inside the module, off
          // the bound ToolFacts. This callback does not backpressure the SDK;
          // the durable runtime drains the write before terminal settlement.
          lifecycle.stream.recordStep({
            stepNumber,
            usage: {
              inputTokens: usage?.inputTokens,
              outputTokens: usage?.outputTokens,
            },
            toolCalls,
            toolResults,
          })

          if (toolCalls.length === 0) return

          // Built-in Tool budget accounting plus Tool outcome recording — one
          // outcome per call, dispatched to the injected sinks. The runtime owns
          // assembly and the request-level outcome summary; the turn only
          // persists durable-run state below.
          await tool.onStepFinish({
            stepNumber,
            toolCalls,
            toolResults,
            usage,
            finishReason,
          })
        },

        ...(Object.keys(providerOptions).length > 0 && { providerOptions }),
        ...(Object.keys(requestHeaders).length > 0 && {
          headers: requestHeaders,
        }),
        // The binding's spreadable extras: the call-site approval gate + the
        // approval-persistence transform (its backpressure array
        // module-private). Guest returns `{}` — guest chats run ungated.
        ...lifecycle.streamTextExtras,
        // Evidence-gated text smoothing (ADR-0016), composed BEFORE the
        // lifecycle's approval-persistence transform so the durable tracker
        // and wire observe the same paced bytes. Unmeasured provider/model
        // pairs retain their raw text-delta behavior.
        ...(experimentalTransform
          ? { experimental_transform: experimentalTransform }
          : {}),

        onChunk: ({ chunk }) => {
          // Release time, read before the durable snapshot bookkeeping below.
          const releasedAtMs = Date.now()
          liveness.chunkReleased()
          lifecycle.stream.onChunk(chunk)
          // Liveness only — this callback sits downstream of the smoothing
          // transform, so any clock here would measure our own pacing.
          if (firstTextDeltaLatencyMs === null && chunk.type === "text-delta") {
            firstTextDeltaLatencyMs = releasedAtMs - streamStartMs
            perf.record("provider_first_text_delta", firstTextDeltaLatencyMs)
          }
          if (chunk.type === "reasoning-start") {
            reasoningActivity.start(chunk.id)
          } else if (chunk.type === "reasoning-end") {
            reasoningActivity.end(chunk.id)
          }
        },

        onError: (err: unknown) => {
          liveness.completed()
          reasoningActivity.close()
          closeWorkDuration()
          console.error(
            JSON.stringify({
              _tag: "chat_stream_provider_error",
              requestId,
              ...getSanitizedExceptionSummary(err),
            })
          )
          const publicError = normalizeTurnError(err)
          const errorMessage = publicError.message
          const errorType = classifyChatError(err)
          // Mark the durable run failed (guest: inert). The parent already
          // computed `errorMessage` for its telemetry below — pass the string.
          lifecycle.stream.noteStreamError(
            { message: errorMessage, recovery: publicError.recovery },
            currentWorkDurationMs(),
            buildTimingReceipt()
          )
          logBraintrustTraceMetadata(braintrustSpan, {
            ...braintrustMetadata,
            ...getBraintrustErrorMetadata(err),
            errorType,
          })

          if (isReplayShapeError(errorMessage)) {
            console.error(
              JSON.stringify({
                _tag: "replay_shape_error",
                chatId,
                provider: resolvedProvider,
                model,
                errorMessage,
                messageCount: validatedMessages.length,
                historyPartTypes: summarizeHistoryPartTypes(validatedMessages),
              })
            )
          }

          // Capture failed generations to PostHog for complete analytics
          if (phClient) {
            try {
              const latencyMs = Date.now() - startTime
              captureGeneration({
                distinctId: userId,
                traceId: chatId,
                model,
                provider: resolvedProvider,
                input: scrubForAnalytics(validatedMessages),
                output: null,
                latencyMs,
                isError: true,
                errorMessage,
                properties: {
                  isAuthenticated,
                },
              })
            } catch (captureErr) {
              console.error(
                JSON.stringify({
                  _tag: "posthog_error_capture_failed",
                  requestId,
                  ...getSanitizedExceptionSummary(captureErr),
                })
              )
            }
          }
        },

        onAbort: async (event) => {
          liveness.completed()
          reasoningActivity.close()
          closeWorkDuration()
          // Flush the latest snapshot, then mark the run aborted (guest:
          // inert) — carrying cancellation evidence: the finished-step usage
          // aggregate when any step completed, otherwise
          // started-without-usage, plus the title attempt tracker's state.
          await lifecycle.stream.onAbort(
            "stream aborted",
            currentWorkDurationMs(),
            {
              primary: aggregateAbortStepUsage(event?.steps ?? []) ?? {
                kind: "started-without-usage",
              },
              title: titleAttempt.current,
            },
            buildTimingReceipt()
          )
        },

        onEnd: async ({ text, usage, steps, finishReason }) => {
          liveness.completed()
          reasoningActivity.close()
          closeWorkDuration()
          const rawFinishReason = steps?.[steps.length - 1]?.rawFinishReason

          if (
            resolvedProvider === "anthropic" &&
            rawFinishReason === "pause_turn" &&
            phClient
          ) {
            try {
              phClient.capture({
                distinctId: "chat-runtime",
                event: "anthropic_pause_turn",
                properties: {
                  provider: resolvedProvider,
                  model,
                  searchToolsActive: shouldInjectSearch,
                },
              })
            } catch (captureErr) {
              // Analytics is observational and must never break stream finalization.
              console.error(
                JSON.stringify({
                  _tag: "posthog_pause_turn_capture_failed",
                  requestId,
                  ...getSanitizedExceptionSummary(captureErr),
                })
              )
            }
          }

          if (steps) {
            const resolvedByCallId: ToolInvocationMetadataByCallId = {}
            for (const step of steps) {
              for (const toolCall of step.toolCalls ?? []) {
                const resolved = toolMetadataByName[toolCall.toolName]
                if (resolved) {
                  resolvedByCallId[toolCall.toolCallId] = resolved
                }
              }
            }
            toolMetadataByCallId = resolvedByCallId
          }

          // Request-level Tool outcome aggregate — accumulated by the runtime as
          // each step's outcomes were recorded.
          const {
            totalToolCalls,
            failedToolCalls,
            timeoutToolCalls,
            budgetDeniedToolCalls,
          } = tool.outcomeSummary()

          const toolOutcome: ToolExecutionOutcome =
            totalToolCalls === 0
              ? "none"
              : budgetDeniedToolCalls > 0
                ? "budget_denied"
                : timeoutToolCalls > 0
                  ? "timeout"
                  : failedToolCalls > 0
                    ? "failure"
                    : "success"

          // Stream-onEnd half of the finish handoff: capture the facts as data
          // for `finalize` (the envelope-onEnd half). ai@7 `onEnd.usage`
          // aggregates across ALL steps (v6 `onFinish.usage` was the final step
          // only, undercounting multi-step tool turns); generation-run
          // accounting wants the aggregate. Guest: inert.
          lifecycle.stream.captureFinish({
            usage: {
              inputTokens: usage?.inputTokens,
              outputTokens: usage?.outputTokens,
              totalTokens:
                typeof usage?.totalTokens === "number"
                  ? usage.totalTokens
                  : undefined,
            },
            finishReason,
            toolCounts: { totalToolCalls, failedToolCalls },
          })

          const totalLatencyMs = Date.now() - streamStartMs
          const firstTokenLatencyMs = timing.firstOutputOffsetMs() ?? null
          logBraintrustTraceMetadata(braintrustSpan, {
            ...braintrustMetadata,
            finishReason: finishReason ?? null,
            toolOutcome,
            totalToolCalls,
            failedToolCalls,
            timeoutToolCalls,
            budgetDeniedToolCalls,
            firstTokenLatencyBucket:
              firstTokenLatencyMs === null
                ? null
                : bucketLatencyMs(firstTokenLatencyMs),
            totalLatencyBucket: bucketLatencyMs(totalLatencyMs),
            usage: {
              inputTokens: usage?.inputTokens ?? null,
              outputTokens: usage?.outputTokens ?? null,
            },
            reasoningDurationMs: reasoningActivity.getDurationMs() ?? null,
            workDurationMs: currentWorkDurationMs(),
          })
          Sentry.setTag("chat_finish_reason", finishReason ?? "unknown")
          Sentry.setTag("chat_error_type", "none")
          Sentry.setTag("chat_tool_outcome", toolOutcome)
          Sentry.setTag(
            "chat_total_latency_bucket",
            bucketLatencyMs(totalLatencyMs)
          )
          if (firstTokenLatencyMs !== null) {
            Sentry.setTag(
              "chat_first_token_latency_bucket",
              bucketLatencyMs(firstTokenLatencyMs)
            )
          }
          Sentry.setContext("chat_response", {
            requestId,
            finishReason,
            toolOutcome,
            totalToolCalls,
            failedToolCalls,
            timeoutToolCalls,
            budgetDeniedToolCalls,
            firstTokenLatencyMs,
            totalLatencyMs,
            reasoningDurationMs: reasoningActivity.getDurationMs() ?? null,
            workDurationMs: currentWorkDurationMs(),
            inputTokens: usage?.inputTokens,
            outputTokens: usage?.outputTokens,
          })
          if (totalLatencyMs >= slowRequestThresholdMs) {
            Sentry.captureMessage("chat_slow_request", {
              level: "warning",
              tags: {
                route: "api/chat",
                chat_provider: resolvedProvider,
                chat_model: model,
                chat_tool_outcome: toolOutcome,
                chat_finish_reason: finishReason ?? "unknown",
                chat_error_type: "none",
              },
              extra: {
                requestId,
                chatId,
                totalLatencyMs,
                firstTokenLatencyMs,
                thresholdMs: slowRequestThresholdMs,
                totalToolCalls,
                failedToolCalls,
                timeoutToolCalls,
                budgetDeniedToolCalls,
                inputTokens: usage?.inputTokens,
                outputTokens: usage?.outputTokens,
                isAuthenticated,
              },
            })
          }

          // Finish reason observability — log truncation (finishReason: "length")
          // so we can detect max_tokens exhaustion in dev and production.
          if (finishReason === "length") {
            console.warn(
              `[chat] Response truncated (finishReason: "length") — model: ${model}, ` +
                `outputTokens: ${usage?.outputTokens ?? "?"}, ` +
                `inputTokens: ${usage?.inputTokens ?? "?"}`
            )
          }
          if (process.env.NODE_ENV !== "production") {
            // Log both unified and raw finish reasons. The raw reason reveals
            // provider-specific signals (e.g. Anthropic's "pause_turn" vs
            // "end_turn") that the unified reason collapses into "stop".
            console.log(
              `[chat] finishReason: ${finishReason}` +
                `${rawFinishReason && rawFinishReason !== finishReason ? ` (raw: ${rawFinishReason})` : ""}, ` +
                `model: ${model}, ` +
                `tokens: ${usage?.inputTokens ?? "?"}in/${usage?.outputTokens ?? "?"}out, ` +
                `text: ${text?.length ?? 0} chars`
            )
          }

          if (
            process.env.NODE_ENV !== "production" &&
            resolvedProvider === "anthropic" &&
            hasAnyTools
          ) {
            console.log(
              `[chat] Anthropic tool usage — inputTokens: ${usage?.inputTokens ?? "?"}, ` +
                `toolCount: ${Object.keys(tool.tools).length}, ` +
                `tokenEfficient: ${"anthropic-beta" in requestHeaders}`
            )
          }

          // Manually capture LLM generation for PostHog analytics. This ensures
          // accurate output capture (withTracing has issues with streaming).
          if (phClient) {
            try {
              const latencyMs = Date.now() - startTime
              captureGeneration({
                distinctId: userId,
                traceId: chatId,
                model,
                provider: resolvedProvider,
                input: scrubForAnalytics(validatedMessages),
                output: scrubForAnalytics(text),
                inputTokens: usage?.inputTokens,
                outputTokens: usage?.outputTokens,
                latencyMs,
                properties: {
                  isAuthenticated,
                  finishReason,
                },
              })
            } catch (captureErr) {
              // Analytics is best-effort.
              console.error(
                JSON.stringify({
                  _tag: "posthog_generation_capture_failed",
                  requestId,
                  ...getSanitizedExceptionSummary(captureErr),
                })
              )
            }
          }
        },
      })
    }

    const result = withBraintrustTrace(
      {
        name: "POST /api/chat",
        metadata: braintrustMetadata,
        onError: (span, error) => {
          logBraintrustTraceMetadata(span, {
            ...braintrustMetadata,
            ...getBraintrustErrorMetadata(error),
            errorType: classifyChatError(error),
          })
        },
      },
      runGeneration
    )

    // Title generation is independent of answer generation: it starts once
    // durable prepare has accepted the first turn (or first-message edit), but
    // failure is absorbed so naming can never fail the conversation. Durable
    // chats receive an early transient CAS payload and also commit after the
    // response as a disconnect-safe backstop; guest chats apply it to IndexedDB.
    const guestTitleAbortController =
      durableTurn.mode === "guest" ? new AbortController() : null
    const titleSignal = guestTitleAbortController
      ? AbortSignal.any([executionSignal, guestTitleAbortController.signal])
      : executionSignal
    const titleTask = titleRequest
      ? generateChatTitle({
          generateText: deps.generateText,
          model: titleModel,
          routeId: titleRouteId,
          // The answer model just accepted this credential; if the catalog's
          // title route has been retired upstream (404), name the chat with it.
          fallback: { model: aiModel, routeId: route.routeId },
          userText: titleRequest.userText,
          abortSignal: titleSignal,
          // Cancellation evidence (ADR-0021): pin each concrete attempt so a
          // stopped title call settles at its input floor for the exact
          // attempted route, and a never-started one settles to zero.
          onAttemptStart: async ({ routeId, pricingRole }) => {
            titleAttempt.current = {
              kind: "started-without-usage",
              routeId,
              pricingRole,
            }
            const persisted = await lifecycle.stream.recordTitleUsageEvidence(
              titleAttempt.current
            )
            if (!persisted) {
              throw new Error("Title dispatch no longer authorized")
            }
          },
          onAttemptComplete: async (generated) => {
            titleAttempt.current = {
              kind: "actual",
              routeId: generated.routeId,
              pricingRole: generated.pricingRole,
              inputTokens: generated.usage.inputTokens,
              outputTokens: generated.usage.outputTokens,
            }
            await lifecycle.stream.recordTitleUsageEvidence(
              titleAttempt.current
            )
          },
        })
          .then((generated) => {
            titleAttempt.current = {
              kind: "actual",
              routeId: generated.routeId,
              pricingRole: generated.pricingRole,
              inputTokens: generated.usage.inputTokens,
              outputTokens: generated.usage.outputTokens,
            }
            return generated
          })
          .catch((error: unknown) => {
            // Stop, grant loss, and the provider deadline cancel the title
            // alongside the answer — a normal shutdown, not a title failure.
            // (A still-provisional chat re-requests a title on its next turn.)
            if (titleSignal.aborted) return null
            console.warn(
              JSON.stringify({
                _tag: "chat_title_generation_failed",
                requestId,
                chatId,
                provider: resolvedProvider,
                model,
                errorType: error instanceof Error ? error.name : typeof error,
              })
            )
            return null
          })
      : null

    // Title-call usage evidence for allowance settlement (ADR-0021):
    // "not-run" when no title was requested this turn; the observed usage
    // when the call finished; "unknown" when it failed or was cancelled (a
    // call may still have consumed tokens — settled at the estimate).
    const titleUsageForSettlement: Promise<TitleUsageForSettlement> = titleTask
      ? titleTask.then((generated) =>
          generated
            ? {
                routeId: generated.routeId,
                pricingRole: generated.pricingRole,
                ...generated.usage,
              }
            : ("unknown" as const)
        )
      : Promise.resolve("not-run" as const)

    if (
      titleTask &&
      titleRequest &&
      durableTurn.mode === "durable" &&
      convexToken
    ) {
      deps.after(async () => {
        const generated = await titleTask
        if (!generated) return
        try {
          await deps.fetchMutation(
            api.chats.applyGeneratedTitle,
            {
              chatId,
              title: generated.title,
              generation: titleRequest.generation,
            },
            { token: convexToken }
          )
        } catch (error) {
          console.warn(
            JSON.stringify({
              _tag: "chat_title_persistence_failed",
              requestId,
              chatId,
              errorType: error instanceof Error ? error.name : typeof error,
            })
          )
        }
      })
    }

    // Stream conversion owns UI-message completion; response construction owns
    // the HTTP envelope. Both completion callbacks share this closure (ADR-0006).
    const uiMessageStream = toUIMessageStream({
      stream: result.stream,
      ...lifecycle.envelope.identity(validatedMessages),
      sendReasoning: true,
      sendSources: true,
      messageMetadata: ({ part }) => {
        // Every stream part passes here, post-transform and in SDK order:
        // the receipt's released-output anchors (first-write delay, wire
        // stream window) are observed at this seam, not at the HTTP tap,
        // which only runs when the response consumer pulls. The window ends
        // at the released finish part, not the last output chunk, so it spans
        // the same tail (last delta → provider finish event) the SDK's
        // per-step response time does; otherwise pacing overhead reads
        // negative by exactly that tail.
        if (isOutputStreamPart(part)) {
          const now = performance.now()
          if (firstOutputReleasedPerfMs === null)
            firstOutputReleasedPerfMs = now
          lastOutputReleasedPerfMs = now
        } else if (
          part.type === "finish" &&
          firstOutputReleasedPerfMs !== null
        ) {
          lastOutputReleasedPerfMs = performance.now()
        }
        if (part.type === "start") {
          return {
            ...buildStartToolInvocationStreamMetadata(toolMetadataByName),
            // Provider provenance is required to prove that a later approval
            // response is continuing on the provider that created it. The
            // persistence projector drops this transient copy because the
            // durable message already owns `provider` as a first-class field.
            provider: resolvedProvider,
            // Applied per-turn effort (ADR-0026): stamped at start so the
            // badge shows while the turn streams; persisted by the projector.
            ...(appliedReasoningEffort !== undefined
              ? { reasoningEffort: appliedReasoningEffort }
              : {}),
            ...(appliedGenerationBudget !== undefined
              ? { generationBudget: appliedGenerationBudget }
              : {}),
          }
        }
        if (part.type === "finish") {
          closeWorkDuration()
          return buildFinishToolInvocationStreamMetadata({
            toolMetadataByCallId,
            reasoningDurationMs: reasoningActivity.getDurationMs() ?? null,
            workDurationMs: currentWorkDurationMs(),
            // Every step has ended by the time the finish part is converted.
            generationStats: timing.stats(),
          })
        }
        return undefined
      },
      // Settlement never rejects (ADR-0011): a persistence failure resolves a
      // degraded receipt — logged and captured inside the module — instead of
      // failing the response pipe and erasing a delivered answer.
      onEnd: async ({ responseMessage, isAborted, finishReason }) => {
        try {
          // Platform-funded completions wait for the (bounded, ≤8s) title
          // call's usage so the settlement charges the title at its actual
          // cost; BYOK/guest settles immediately — allowance is untouched.
          // Aborted turns do NOT wait: the title tracker's synchronous state
          // rides `terminalFacts` instead.
          const titleUsage =
            credential.source === "platform" && !isAborted
              ? await titleUsageForSettlement
              : undefined
          await lifecycle.envelope.settle({
            responseMessage,
            isAborted,
            finishReason,
            titleUsage,
            terminalFacts: { title: titleAttempt.current },
            timingReceipt: buildTimingReceipt(),
          })
        } finally {
          // Mirror the receipt's durations into the sampled perf log (guest
          // turns included) so the benchmark harness can gate the segments
          // this server owns. Settlement keeps its own span.
          if (perf.sampled) {
            const fields: Record<string, number> = {}
            for (const [key, value] of Object.entries(buildTimingReceipt())) {
              if (key !== "buildId" && typeof value === "number") {
                fields[key] = value
              }
            }
            perf.event("run_timing_receipt", fields)
          }
          // Settlement owns request-scoped teardown (see the factory-level
          // note): the stream is truly over here — reload or not — so MCP
          // clients and analytics flushes release now, not at after() time.
          turnSettled = true
          await disposeTurnResources()
        }
      },
      onError: (error: unknown) => {
        reasoningActivity.close()
        closeWorkDuration()
        console.error(
          JSON.stringify({
            _tag: "chat_stream_error",
            requestId,
            ...getSanitizedExceptionSummary(error),
          })
        )
        const errorType = classifyChatError(error)
        Sentry.captureException(sanitizeExceptionForTelemetry(error), {
          tags: {
            route: "api/chat",
            chat_model: model,
            chat_provider: resolvedProvider,
            chat_is_authenticated: String(isAuthenticated),
            chat_error_type: errorType,
            chat_error_has_tool_signal: getToolDimensionForError(errorType),
          },
          extra: {
            requestId,
            model,
            provider: resolvedProvider,
            errorType,
            isAuthenticated,
            messageCount: validatedMessages.length,
            chatVersion: normalizedChatVersion,
          },
        })
        return (lastPublicError ?? normalizeTurnError(error)).message
      },
    })

    const responseStream =
      titleTask && titleRequest
        ? createUIMessageStream({
            execute: async ({ writer }) => {
              let markAnswerFinished: () => void = () => {}
              const answerFinished = new Promise<null>((resolve) => {
                markAnswerFinished = () => resolve(null)
              })
              const observedAnswerStream = uiMessageStream.pipeThrough(
                new TransformStream<UIMessageChunk, UIMessageChunk>({
                  transform(chunk, controller) {
                    controller.enqueue(chunk)
                  },
                  flush() {
                    markAnswerFinished()
                  },
                })
              )
              writer.merge(observedAnswerStream)
              // Title generation never extends the answer stream lifetime.
              // Durable turns have an after() persistence backstop. Guests use
              // the existing deterministic fallback when the answer wins so
              // their IndexedDB chat still leaves its provisional title.
              const generatedTitle = await Promise.race([
                titleTask,
                answerFinished,
              ])
              if (durableTurn.mode === "guest" && generatedTitle === null) {
                guestTitleAbortController?.abort()
              }
              const title =
                generatedTitle?.title ??
                (durableTurn.mode === "guest"
                  ? fallbackChatTitle(titleRequest.userText)
                  : null)
              if (!title) return
              writer.write({
                type: "data-chatTitle",
                data: {
                  chatId,
                  title,
                  generation: titleRequest.generation,
                },
                transient: true,
              })
            },
          })
        : uiMessageStream

    // Receipt-anchored transport spans (sampled requests only): first chunk
    // enqueued toward the wire and stream close. An identity transform — no
    // chunk is inspected or retained; unsampled requests skip the extra hop.
    let observedResponseStream = perf.sampled
      ? (() => {
          let firstWriteRecorded = false
          return responseStream.pipeThrough(
            new TransformStream<UIMessageChunk, UIMessageChunk>({
              transform(chunk, controller) {
                if (!firstWriteRecorded) {
                  firstWriteRecorded = true
                  perf.record(
                    "server_first_stream_write",
                    Date.now() - requestReceivedAtMs
                  )
                }
                controller.enqueue(chunk)
              },
              flush() {
                perf.record(
                  "response_stream_closed",
                  Date.now() - requestReceivedAtMs
                )
              },
            })
          )
        })()
      : responseStream

    const streamRunId = durableTurn.getStreamRunId()
    if (streamRunId) {
      const original = lifecycle.envelope
        .identity(validatedMessages)
        .originalMessages.at(-1)
      const [responseBranch, retainedBranch] = observedResponseStream.tee()
      observedResponseStream = responseBranch
      // Connect independently so Redis availability never delays the response.
      const persistence = (async () => {
        const retained = await initializeRetainedChatStream({
          runId: streamRunId,
          baseMessage: original?.role === "assistant" ? original : undefined,
        })
        if (retained) await retained.consume(retainedBranch)
        else await consumeStream({ stream: retainedBranch })
      })().catch(async () => {
        if (!retainedBranch.locked) await consumeStream({ stream: retainedBranch })
        console.warn("chat_stream_replay_unavailable", { runId: streamRunId })
      })
      // Start now: after() alone would defer consumption until disconnect.
      deps.after(() => persistence)
    }

    return createUIMessageStreamResponse({
      headers: { "content-type": "text/event-stream; charset=utf-8" },
      stream: observedResponseStream,
      consumeSseStream: consumeStream,
    })
  }

  async function fail(err: unknown): Promise<void> {
    phase = "terminal"

    // Terminal teardown: MCP clients + analytics flushes. dispose() is
    // idempotent, so this is safe even if the after() backstop also runs.
    turnSettled = true
    await disposeTurnResources()

    // Finalize a failed durable run (guest: inert; pre-prepare: no-op). Legal at
    // any phase — the Generation run lifecycle's first-terminal-wins absorbs a
    // double terminal write. Never throws.
    const publicError = lastPublicError ?? normalizeTurnError(err)
    await durableTurn.fail({
      message: publicError.message,
      recovery: publicError.recovery,
    })

    const errorType = classifyChatError(err)
    Sentry.captureException(sanitizeExceptionForTelemetry(err), {
      tags: {
        route: "api/chat",
        chat_model: model,
        ...(provider ? { chat_provider: provider } : {}),
        chat_is_authenticated: String(isAuthenticated),
        chat_error_type: errorType,
        chat_error_has_tool_signal: getToolDimensionForError(errorType),
      },
      extra: {
        requestId,
        model,
        provider,
        errorType,
        isAuthenticated,
        messageCount: messages.length,
        mcpClientCount: toolRuntime?.mcpClientCount ?? openedMcpClientCount,
      },
    })
  }

  return { prepare, toResponse, fail }
}
