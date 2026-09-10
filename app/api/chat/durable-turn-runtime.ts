import { createHash, randomBytes } from "node:crypto"
import { getConvexSiteUrl } from "@/app/api/_lib/convex-site-url"
import { api } from "@/convex/_generated/api"
import type { Doc, Id } from "@/convex/_generated/dataModel"
import type { GenerationRunHeartbeatResult } from "@/convex/chatRuntime"
import type { DurableWorkerPayloads } from "@/convex/chatRuntimeWorker"
import {
  HEARTBEAT_INTERVAL_MS,
  LEASE_DURATION_MS,
} from "@/convex/domain/generation_run_liveness"
import { sanitizeModelHistoryMessages } from "@/convex/domain/message_visibility"
import type {
  TerminalUsageEvidencePayload,
  TitleTerminalUsageEvidence,
} from "@/convex/domain/usage_accounting"
import {
  CANCELLATION_SETTLEMENT_PROTOCOL_VERSION,
  signChatAdmissionProof,
  type ChatAdmissionProofPayload,
} from "@/convex/lib/chatAdmissionProof"
import { projectPersistedMessageMetadata } from "@/convex/lib/messageMetadata"
import type { RunTimingReceipt } from "@/convex/lib/runTimingReceipt"
import type { ChatErrorRecovery } from "@/lib/chat-errors"
import type {
  ChatTurnEditRequest,
  ChatTurnRegenerationRequest,
} from "@/lib/chat-messages/chat-turn-contract"
import type { DurableMessageStatus } from "@/lib/chat-messages/durable-contract"
import { extractTextFromMessageParts } from "@/lib/chat-messages/parts"
import { durableStoredMessageToUiMessage } from "@/lib/chat-messages/ui-message-adapter"
import type { ModelReasoningEffort } from "@/lib/models/types"
import type { ChatPerfServerSession } from "@/lib/observability/chat-performance"
import type { ToolSource } from "@/lib/tools/types"
import { estimatePartialOutputTokens } from "@/lib/usage/terminal-usage-estimate"
import * as Sentry from "@sentry/nextjs"
import type {
  UIMessage as MessageAISDK,
  StreamTextTransform,
  TextStreamPart,
  ToolApprovalStatus,
  ToolSet,
  UIMessage,
} from "ai"
import { isToolUIPart, readUIMessageStream, toUIMessageStream } from "ai"
import { fetchMutation as defaultFetchMutation } from "convex/nextjs"
import { extractApprovalResponses } from "./approval-continuation"
import { PublicChatHttpError } from "./public-http-error"
import { toInvalidDurableRequestError } from "./utils"

// Owns durable preparation, snapshots, tool invocations, approvals, and turn
// settlement — the typed receipt that keeps answer delivery independent from
// terminal persistence (ADR-0011, superseding parts of ADR-0009). Guest turns
// use an inert adapter.
//
// Authority model: the user's Convex token and the server's signed admission
// proof authorize exactly one call — `prepareGeneration`. Every write after
// prepare travels over the Durable worker wire, authenticated by a run-scoped
// execution grant whose raw secret exists only in this process's memory. A
// mid-run user-token expiry cannot reject a worker write.

export type { DurableMessageStatus } from "@/lib/chat-messages/durable-contract"

type DurableFailure = string | { message: string; recovery?: ChatErrorRecovery }

function normalizeDurableFailure(failure: DurableFailure): {
  message: string
  recovery?: ChatErrorRecovery
} {
  return typeof failure === "string" ? { message: failure } : failure
}

// Edit/regeneration request shapes live on the Chat turn wire contract
// (lib/chat-messages/chat-turn-contract.ts) — declared once for the client
// builder and this consumer.

/**
 * The durable-turn slice of the admitted Chat turn. Everything but `provider`
 * crosses at construction (the convex token once, here); `provider` crosses at
 * `prepare({ provider })` because it is resolved mid-parent-prepare.
 */
export type DurableTurnInput = {
  chatId: string
  requestId: string
  model: string
  messages: MessageAISDK[]
  isAuthenticated: boolean
  convexToken: string | undefined
  edit?: ChatTurnEditRequest
  regeneration?: ChatTurnRegenerationRequest
  expectedVisibleMessageCount?: number
  tailMessageId?: string
  /** Read-only canonical input plan confirmed inside prepareGeneration. */
  generationInputHash?: string
  /**
   * Platform-usage reservation admitted with the route (ADR-0021). Crosses
   * into the signed admission proof and attaches to the run inside
   * prepareGeneration's transaction.
   */
  reservationId?: Id<"usageReservations">
}

// Durable worker wire — the post-prepare write channel (ADR-0011).

/**
 * The op list and per-op payloads have ONE source of truth: the shared
 * validator shapes in `convex/chatRuntime.ts` (`generationRunWriteArgs`),
 * projected to types by `convex/chatRuntimeWorker.ts`. Adding or renaming an
 * op or field there is a compile error at every call site here.
 */
export type DurableWorkerOp = keyof DurableWorkerPayloads

export type DurableWorkerCall = {
  [Op in DurableWorkerOp]: {
    op: Op
    args: DurableWorkerPayloads[Op] & { runId: Id<"generationRuns"> }
  }
}[DurableWorkerOp]

/**
 * The worker-write transport: one grant-authorized call to the Convex
 * /chat-turn/worker HTTP endpoint. This — not `fetchMutation` — is the test
 * seam for every post-prepare durable write; tests inject a recording fake.
 */
export type DurableWorkerWire = (call: DurableWorkerCall) => Promise<unknown>

/**
 * A worker-wire HTTP rejection, carrying the endpoint's typed grant-rejection
 * code when there is one. `grant_unauthorized` after prepare means the run
 * already reached an absorbing outcome and revoked its grant (aborted/failed):
 * the write is an idempotent no-op, not a failure.
 * `grant_expired` is deterministic — retrying cannot succeed.
 */
export class DurableWorkerWriteError extends Error {
  readonly status: number
  readonly grantRejection?: "grant_unauthorized" | "grant_expired"

  constructor(args: {
    op: string
    status: number
    detail: string
    grantRejection?: "grant_unauthorized" | "grant_expired"
  }) {
    super(
      `Durable worker write ${args.op} failed: ${args.status} ${args.detail}`.trim()
    )
    this.name = "DurableWorkerWriteError"
    this.status = args.status
    this.grantRejection = args.grantRejection
  }
}

function parseGrantRejectionCode(
  body: string
): "grant_unauthorized" | "grant_expired" | undefined {
  try {
    const parsed: unknown = JSON.parse(body)
    const code = (parsed as { code?: unknown } | null)?.code
    return code === "grant_unauthorized" || code === "grant_expired"
      ? code
      : undefined
  } catch {
    return undefined
  }
}

export function createHttpDurableWorkerWire(options: {
  secret: string
  fetchImpl?: typeof fetch
}): DurableWorkerWire {
  const fetchImpl = options.fetchImpl ?? fetch
  return async ({ op, args }) => {
    const response = await fetchImpl(`${getConvexSiteUrl()}/chat-turn/worker`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.secret}`,
      },
      body: JSON.stringify({ op, args }),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw new DurableWorkerWriteError({
        op,
        status: response.status,
        detail,
        grantRejection: parseGrantRejectionCode(detail),
      })
    }
    return response.json().catch(() => undefined)
  }
}

/**
 * Injected dependencies. `fetchMutation` is the established Convex seam — after
 * ADR-0011 it carries exactly one call, the user-token `prepareGeneration`
 * admission. `workerWire` is the grant-authorized transport for every write
 * after prepare (defaults to the HTTP adapter over the module-minted secret).
 * `settleRetryDelaysMs` bounds terminal-write retries; tests pass `[0]`s.
 */
export type DurableTurnDeps = {
  fetchMutation: typeof defaultFetchMutation
  workerWire?: DurableWorkerWire
  settleRetryDelaysMs?: number[]
  /** Server-only admission signer; tests inject a deterministic fake. */
  admissionProofSigner?: (payload: ChatAdmissionProofPayload) => string
  /** Sampled chat-performance session; checkpoint counters only. */
  perf?: ChatPerfServerSession
}

/** Minimal Tool runtime view for approval persistence. */
export type ToolFacts = {
  metadata: { source(toolName: string): ToolSource }
  approvalFor(
    toolName: string
  ):
    { needsApproval?: boolean; reason?: string; riskClass?: string } | undefined
  toolApproval: Record<string, ToolApprovalStatus> | undefined
}

/**
 * The spreadable streamText extras: the call-site approval gate plus the
 * approval-persistence transform (its backpressure array module-private).
 * Guest returns `{}`.
 */
export type DurableStreamTextExtras = {
  toolApproval?: Record<string, ToolApprovalStatus>
  experimental_transform?: StreamTextTransform<ToolSet>
}

/**
 * Stream-onEnd half of the finish handoff, pushed synchronously as data
 * (`captureFinish`). ai@7 `usage` aggregates across ALL steps.
 */
export type StreamFinishFacts = {
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  finishReason: string | undefined
  toolCounts: { totalToolCalls: number; failedToolCalls: number }
}

/**
 * Cancellation-evidence facts the parent runtime hands the binding (ADR-0021
 * cancellation amendment). The parent supplies what only IT can observe —
 * finished-step aggregates from `onAbort.steps` and the title attempt
 * tracker's state; the binding adds the partial-output estimate from the
 * parts it holds and ships the normalized payload with the aborted terminal
 * write (or the settlement-only receipt when Stop already won).
 */
export type TerminalUsageFacts = {
  /**
   * The canonical evidence union (one contract, no drift). The parent never
   * sets `partialOutputTokens` — the binding owns that estimate and stamps it
   * in `toTerminalUsagePayload` from the parts it holds.
   */
  primary: TerminalUsageEvidencePayload["primary"]
  title: TitleTerminalUsageEvidence
}

/** One recorded step's tool activity — the durable-persistence view of it. */
export type DurableStepRecord = {
  stepNumber: number
  /**
   * The step's token usage (ADR-0021): accumulated onto the run row as
   * durable settlement evidence, so abort/failure/reaper accounting does not
   * depend on the happy-path onEnd aggregate. Fired for EVERY step, tool
   * calls or not.
   */
  usage?: { inputTokens?: number; outputTokens?: number }
  toolCalls: ReadonlyArray<{
    toolCallId: string
    toolName: string
    input?: unknown
  }>
  toolResults?: ReadonlyArray<{
    toolCallId: string
    output?: unknown
    isError?: boolean
  }>
}

/**
 * The settlement receipt (ADR-0011). Settlement NEVER rejects: a generated
 * answer's delivery is independent of terminal persistence. `confirmed` means
 * the run is durably settled — outcome `completed`/`aborted` when THIS write
 * landed it, `settled-elsewhere` when the grant was revoked by an earlier
 * absorbing terminal (Stop, supersession, failure, reap): the run is settled,
 * but with THAT writer's outcome — Convex, not this receipt, is the source of
 * truth for which. `degraded` means no terminal is known to have landed after
 * bounded retries — the answer content still survives via the final
 * pre-terminal snapshot, and the run remains live for the reaper/supersede
 * sweep to close honestly. `guest` marks the inert adapter.
 */
export type DurableSettlementReceipt =
  | {
      status: "confirmed"
      runId: string
      outcome: "completed" | "aborted" | "settled-elsewhere"
    }
  | { status: "degraded"; runId: string; reason: string }
  | { status: "guest" }

/**
 * The AI SDK lifecycle binding (ADR-0011, Design 2): both callback positions
 * stay visible in the parent's `toResponse()` closure (ADR-0006), grouped by
 * seam — `stream.*` for streamText callbacks, `envelope.*` for the UI-message
 * envelope. Settlement ordering, retries, and worker authority live behind it.
 */
export type DurableStreamBinding = {
  /** Spread into the streamText options object. */
  streamTextExtras: DurableStreamTextExtras
  /**
   * The streamText-callback half. Void methods do not backpressure the SDK,
   * but their terminal-relevant writes are drained before local settlement.
   */
  stream: {
    /** Begin persisting the provider-consumption boundary before response exposure. */
    /** Returns false when the durable boundary could not commit. The caller
     * must not dispatch the provider in that case. */
    startWork(startedAt: number): Promise<boolean>
    /** Persist title start/actual evidence. Start callers must not dispatch
     * when this returns false. */
    recordTitleUsageEvidence(
      evidence: TitleTerminalUsageEvidence
    ): Promise<boolean>
    onChunk(
      chunk: TextStreamPart<ToolSet>,
      workSummary?: WorkSummarySnapshot
    ): Promise<void> | void
    recordStep(step: DurableStepRecord): void
    noteStreamError(
      failure: DurableFailure,
      workDurationMs: number,
      timingReceipt?: RunTimingReceipt
    ): void
    /**
     * Flush the snapshot, then mark the run aborted — carrying terminal
     * usage evidence when the parent observed any. If a Stop/supersession
     * already settled the run elsewhere, the binding follows with the
     * settlement-only terminal-usage receipt.
     */
    onAbort(
      reason: string,
      workDurationMs: number,
      facts?: TerminalUsageFacts,
      timingReceipt?: RunTimingReceipt,
      /** Pre-answer duration resolved at abort; rides the flush below. */
      workSummaryDurationMs?: number
    ): Promise<void>
    /** Stream-onEnd half of the finish handoff (sync capture). */
    captureFinish(facts: StreamFinishFacts): void
  }
  /** The UI-message-envelope half. */
  envelope: {
    /**
     * Envelope identity: durable history + assistant-message-id factory, or
     * guest passthrough of the POST-validation array (why this is a method
     * taking `validatedMessages`, not a construction-time getter).
     */
    identity(validatedMessages: MessageAISDK[]): {
      originalMessages: UIMessage[]
      generateMessageId?: () => string
    }
    /**
     * Envelope-onEnd settlement. Internal ordering, load-bearing:
     * allSettled(approval + step writes) → flush → final full-parts snapshot
     * → markAborted | markCompleted (bounded retry). LOUD-FALLBACK CONTRACT: a
     * completed path without a prior `captureFinish()` emits
     * `durable_finish_handoff_missed` (warn + Sentry) BEFORE falling back to
     * `countToolParts`. NEVER rejects — persistence failure resolves a
     * `degraded` receipt instead of failing the response pipe (ADR-0011).
     */
    settle(outcome: {
      responseMessage: UIMessage
      isAborted: boolean
      finishReason?: string
      /**
       * Title-call evidence for allowance settlement (ADR-0021): observed
       * usage, "not-run" (no title requested), or "unknown" (a title call may
       * have run but its usage never arrived). Only meaningful for
       * platform-funded runs; ignored elsewhere.
       */
      titleUsage?: TitleUsageForSettlement
      /**
       * The title attempt tracker's state at settle time. Primary facts come
       * from the stream onAbort (aborts) or the captured finish (completed
       * settled-elsewhere) — the envelope only ever contributes title state.
       */
      terminalFacts?: Pick<TerminalUsageFacts, "title">
      /**
       * The run timing receipt as the parent observed it (ADR-0030). The
       * binding adds `settlementMs` and ships it with the terminal write.
       */
      timingReceipt?: RunTimingReceipt
    }): Promise<DurableSettlementReceipt>
  }
}

/** Convex-owned title-usage wire shape (ADR-0021), derived to prevent drift. */
export type TitleUsageForSettlement = NonNullable<
  DurableWorkerPayloads["markGenerationRunCompleted"]["titleUsage"]
>

export type DurableTurnRuntime = {
  /** Observability dimension only — callers MUST NOT branch on it. */
  readonly mode: "durable" | "guest"

  /**
   * Aborts when this worker can no longer legitimately execute the run: the
   * heartbeat answered `lost` (Stop, supersession, reaping) or heartbeat
   * transport died past its retry budget. The Chat turn runtime composes it
   * with the provider deadline so provider consumption stops promptly. Guest:
   * never aborts.
   */
  readonly executionAbortSignal: AbortSignal

  /**
   * The signals provider/tool consumption must respect, given the incoming
   * request's signal. Durable: the request signal is EXCLUDED — a client
   * disconnect (reload, tab close, navigation that drops the fetch) leaves
   * the worker streaming to durable settlement; Stop, supersession, and reaping
   * reach the worker through `executionAbortSignal` instead. Guest: the request
   * signal IS the lifecycle — nobody is left to receive or settle a
   * disconnected guest stream.
   */
  providerAbortSignals(requestSignal: AbortSignal): AbortSignal[]

  /**
   * Durable-prepare: `prepareGeneration` (approval-response extraction, the
   * regeneration×approvals 400, latest-user-message selection, the Convex
   * argument-validation → 400 mapping after the
   * `durable_prepare_argument_rejected` warn; concurrency-guard errors pass
   * through unmapped). Mints the execution grant: the digest rides the
   * admission call, the secret stays in process memory. Returns the canonical
   * model history — durable: sanitized server history; guest: sanitized
   * input. One-shot.
   */
  prepare(args: {
    provider: string
    /** Route-resolution receipt (ADR-0020), persisted on the run row. */
    route?: {
      routeId: string
      credentialSource: "platform" | "byok"
      routeReason:
        "priority_byok" | "platform" | "fallback_byok" | "legacy_route_hint"
    }
    /** Per-turn effort receipt (ADR-0026), signed into the admission proof
     * and persisted on the run row: what the user requested and what the
     * runtime actually applied after route clamping. */
    reasoningEffort?: {
      requested?: ModelReasoningEffort
      applied?: ModelReasoningEffort
    }
    /** Total generation allowance receipt (ADR-0028). */
    generationBudget?: {
      requested?: number
      applied?: number
    }
  }): Promise<MessageAISDK[]>

  /** The provisional title version authorized by durable prepare. Guest turns
   * return null and let the parent derive the first-turn version locally. */
  getTitleGeneration(): number | null

  /** Identity of the prepared execution, distinct from its reused message. */
  getStreamRunId(): string | null

  /**
   * Binds `ToolFacts` for the stream lifetime and returns the AI SDK
   * lifecycle binding. One-shot, after `prepare()`, before the stream starts.
   */
  bind(toolFacts: ToolFacts): DurableStreamBinding

  /**
   * Legal at ANY phase: pre-prepare (no run → no-op), mid-stream, or after
   * settlement (first-terminal-wins absorbs it). Never throws.
   */
  fail(failure: DurableFailure): Promise<void>
}

export type DurableUiMessage = UIMessage & {
  content: string
  createdAt: Date
  status: DurableMessageStatus
  metadata?: Record<string, unknown>
}

/**
 * Durable persistence is a property of the caller's auth (ADR-0033): a
 * signed-in caller with a Convex token runs the durable runtime; the chat id
 * itself carries no persistence class (guests mint the same shape).
 */
export function isDurableConvexChat(options: {
  isAuthenticated: boolean
  convexToken?: string
}): boolean {
  return Boolean(options.isAuthenticated && options.convexToken)
}

export function getLatestUserMessage(
  messages: UIMessage[]
): UIMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === "user") return message
  }
  return undefined
}

export function buildDurablePrepareIntent(input: {
  messages: UIMessage[]
  edit?: ChatTurnEditRequest
  regeneration?: ChatTurnRegenerationRequest
}) {
  const approvalResponses = extractApprovalResponses(input.messages)
  if (input.regeneration && approvalResponses.length > 0) {
    throw new PublicChatHttpError({
      message: "Regeneration cannot continue pending approvals",
      statusCode: 400,
      code: "INVALID_REQUEST",
    })
  }

  const latestUserMessage =
    input.edit || input.regeneration || approvalResponses.length > 0
      ? undefined
      : getLatestUserMessage(input.messages)

  return { approvalResponses, latestUserMessage }
}

export function toDurableUiMessage(message: Doc<"messages">): DurableUiMessage {
  const uiMessage = durableStoredMessageToUiMessage(message, {
    metadataMode: "runtime",
  })

  return {
    ...uiMessage,
    createdAt: new Date(message.createdAt),
    status: message.status,
  }
}

export function toDurableUiMessages(
  messages: Doc<"messages">[]
): DurableUiMessage[] {
  return messages.map(toDurableUiMessage)
}

export function countToolParts(message: UIMessage): {
  totalToolCalls: number
  failedToolCalls: number
} {
  let totalToolCalls = 0
  let failedToolCalls = 0
  for (const part of message.parts) {
    if (!isToolUIPart(part)) continue
    totalToolCalls++
    if (part.state === "output-error" || part.state === "output-denied") {
      failedToolCalls++
    }
  }
  return { totalToolCalls, failedToolCalls }
}

/** Serialize an unknown error for a structured warn `_tag` line. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The structured ops-log line every durable warn shares. */
function warnDurable(tag: string, fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({ _tag: tag, ...fields }))
}

function getRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null
  return value as Record<string, unknown>
}

function getStringField(
  value: Record<string, unknown> | null,
  field: string
): string | undefined {
  if (!value) return undefined
  const candidate = value[field]
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Durable snapshot tracker — throttled assistant-snapshot writes plus the
// final full-parts snapshot settlement takes before any terminal transition.

const WORKER_WRITE_TIMEOUT_MS = 10_000

class WorkerWriteTimeoutError extends Error {
  constructor(description: string, timeoutMs: number) {
    super(`Timed out ${description} after ${timeoutMs}ms`)
    this.name = "WorkerWriteTimeoutError"
  }
}

function withWorkerWriteTimeout<T>(
  write: Promise<T>,
  description: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new WorkerWriteTimeoutError(description, WORKER_WRITE_TIMEOUT_MS))
    }, WORKER_WRITE_TIMEOUT_MS)
  })

  return Promise.race([write, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout)
  })
}

/**
 * Let already-started worker writes settle before a terminal mutation revokes
 * their grant. The bound matches one worker-write timeout, so settlement never
 * waits forever on a transport that stopped responding.
 */
async function drainPendingWrites(
  pendingWrites: ReadonlyArray<Promise<unknown>>
): Promise<void> {
  if (pendingWrites.length === 0) return

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, WORKER_WRITE_TIMEOUT_MS)
    timer.unref?.()
    void Promise.allSettled(pendingWrites).then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export type SnapshotPersistArgs = {
  sequence: number
  textSnapshot: string
  partsSnapshot: unknown
  workSummaryDurationMs?: number
  /** Tentative tool-order onset; null clears one an earlier checkpoint sent. */
  workSummaryCandidateMs?: number | null
}

/** The work-summary tracker's view at a chunk (ADR-0041, C5). */
export type WorkSummarySnapshot = {
  /** Resolved pre-answer duration (rule 1, or rule 2 at stream end). */
  durationMs?: number
  /** Rule 2's tentative onset while the stream is still open. */
  candidateMs?: number
}

type DurableSnapshotTrackerOptions = {
  throttleMs?: number
  initialMessage?: UIMessage
  /**
   * Injected snapshot persister — the runtime hands in a worker-wire-backed
   * writer, so the tracker never sees a credential or a transport.
   */
  persist: (args: SnapshotPersistArgs) => Promise<unknown>
}

export function createDurableSnapshotTracker(
  options: DurableSnapshotTrackerOptions
) {
  const persistSnapshot = options.persist
  let text = ""
  let parts: UIMessage["parts"] = []
  let workSummaryDurationMs: number | undefined
  let workSummaryCandidateMs: number | undefined
  // Once a candidate has been sent, every later checkpoint states it
  // explicitly (number or null) so a clear reaches the message doc.
  let candidateNoted = false
  const workSummaryArgs = () => ({
    ...(workSummaryDurationMs !== undefined ? { workSummaryDurationMs } : {}),
    ...(candidateNoted
      ? {
          workSummaryCandidateMs:
            workSummaryDurationMs === undefined
              ? (workSummaryCandidateMs ?? null)
              : null,
        }
      : {}),
  })
  let sequence = 0
  let lastWriteAt = 0
  let writeInFlight: Promise<unknown> | null = null
  // Dirtiness is content-versioned, not a boolean: a persist loop re-runs only
  // when a chunk advanced the version past what the last completed write
  // captured. A shared `pending` flag let two overlapping flush() calls (the
  // streamText onAbort and the response-level onEnd both flush on Stop)
  // re-arm each other forever — neither flush resolved, markGenerationRunAborted
  // never ran, and snapshot writes continued at the write-latency rate.
  let contentVersion = 0
  let writtenVersion = 0

  const getParts = () => parts

  const persist = async (force = false) => {
    while (writtenVersion < contentVersion) {
      if (writeInFlight) {
        await writeInFlight
        continue
      }

      const now = Date.now()
      const throttleMs = options.throttleMs ?? 750
      if (!force && now - lastWriteAt < throttleMs) return

      lastWriteAt = now
      const versionAtWrite = contentVersion
      const currentSequence = ++sequence
      writeInFlight = withWorkerWriteTimeout(
        persistSnapshot({
          sequence: currentSequence,
          textSnapshot: text,
          partsSnapshot: getParts(),
          ...workSummaryArgs(),
        }),
        "writing assistant snapshot"
      )
        .then((written) => {
          writtenVersion = Math.max(writtenVersion, versionAtWrite)
          return written
        })
        .finally(() => {
          writeInFlight = null
        })

      await writeInFlight
    }
  }

  // Use the same SDK projection as the delivered stream: tool states, text
  // boundaries, and provider phase metadata must survive a live checkpoint.
  const input = new TransformStream<TextStreamPart<ToolSet>>()
  const writer = input.writable.getWriter()
  const reader = readUIMessageStream({
    message: options.initialMessage,
    stream: toUIMessageStream({
      stream: input.readable,
      originalMessages: options.initialMessage ? [options.initialMessage] : undefined,
      sendSources: true,
      sendReasoning: true,
    }),
    terminateOnError: true,
  }).getReader()
  const reduction = (async () => {
    while (true) {
      const next = await reader.read()
      if (next.done) return
      const message = next.value
      parts = message.parts
      text = extractTextFromMessageParts(parts)
      // Start chunks alone must not replace a useful durable checkpoint.
      if (workSummaryDurationMs === undefined && !candidateNoted && !parts.some((part) =>
        part.type === "text" || part.type === "reasoning"
          ? part.text.length > 0
          : part.type !== "step-start"
      )) continue
      contentVersion++
      void persist(false).catch(() => {})
    }
  })()
  void reduction.catch((error: unknown) => {
    void writer.abort(error).catch(() => {})
  })
  let writes = Promise.resolve()
  let closing: Promise<void> | undefined
  // The pre-answer duration and its candidate are metadata, not content:
  // recording a change advances the content version so the next checkpoint
  // (or a forced flush after a server-side abort) writes it even when text
  // and parts are unchanged, and so a cleared candidate reaches the doc.
  const noteWorkSummary = (summary: WorkSummarySnapshot | undefined) => {
    if (!summary) return
    if (summary.durationMs !== undefined && summary.durationMs !== workSummaryDurationMs) {
      workSummaryDurationMs = summary.durationMs
      contentVersion++
    }
    if (summary.candidateMs !== workSummaryCandidateMs) {
      workSummaryCandidateMs = summary.candidateMs
      if (summary.candidateMs !== undefined) candidateNoted = true
      if (candidateNoted) contentVersion++
    }
  }
  const onChunk = (chunk: TextStreamPart<ToolSet>, workSummary?: WorkSummarySnapshot) => {
    noteWorkSummary(workSummary)
    if (closing) return Promise.resolve()
    writes = writes.then(() => withWorkerWriteTimeout(
      writer.write(chunk), "reducing assistant snapshot chunk"
    )).catch((error: unknown) => {
      void writer.abort(error).catch(() => {})
      void reader.cancel(error).catch(() => {})
      throw error
    })
    // Snapshot failure cannot erase the response being delivered.
    void writes.catch(() => {})
    return writes.catch(() => {})
  }
  const drain = () => {
    closing ??= withWorkerWriteTimeout(
      (async () => {
        await writes
        await writer.close()
        await reduction
      })(),
      "draining assistant snapshot stream"
    ).catch(async (error: unknown) => {
      void writer.abort(error).catch(() => {})
      await reader.cancel(error).catch(() => {})
      throw error
    })
    return closing
  }

  /**
   * The content-survival write (ADR-0011): an unconditional snapshot carrying
   * the response message's COMPLETE parts, sequenced after every throttled write.
   * Settlement calls it BEFORE the terminal transition so a failed terminal
   * write can no longer erase an answer: the snapshot mutation also lands
   * content+parts on the assistant message doc. Rejections propagate to the
   * caller — settlement warns (`durable_final_snapshot_write_failed`) and
   * proceeds to the terminal write, whose receipt (not this snapshot) decides
   * confirmed vs degraded; on completion that write carries the same
   * content+parts itself.
   */
  const flushFinal = async (finalText: string, finalParts: unknown) => {
    await drain().catch(() => {})
    if (writeInFlight) await writeInFlight.catch(() => {})
    const currentSequence = ++sequence
    writtenVersion = contentVersion
    await withWorkerWriteTimeout(
      persistSnapshot({
        sequence: currentSequence,
        textSnapshot: finalText,
        partsSnapshot: finalParts,
        ...workSummaryArgs(),
      }),
      "writing assistant snapshot"
    )
  }

  return {
    onChunk,
    noteWorkSummary,
    flush: async () => {
      await drain()
      await persist(true)
    },
    flushFinal,
    get textSnapshot() {
      return text
    },
    get partsSnapshot() {
      return getParts()
    },
  }
}

// Approval-persistence transform — writes a tool-approval request before the
// approval chunk streams, so the client never renders an approval prompt that
// isn't yet durable.

export type ToolInvocationForPersistence = {
  toolCallId: string
  toolName: string
  source: ToolSource
  input?: unknown
  output?: unknown
  error?: string
  status:
    | "called"
    | "pending_approval"
    | "approved"
    | "denied"
    | "completed"
    | "failed"
  approvalRequestId?: string
}

type ToolApprovalRequestPersistenceArgs = {
  assistantMessageId: Id<"messages">
  toolCallId: string
  toolName: string
  source: ToolSource
  reason?: string
  riskClass: string
  inputPreview?: string
  approvalId: string
}

type RuntimeApprovalPersistenceTransformOptions = {
  chatId: string
  assistantMessageId: Id<"messages">
  /**
   * The Tool runtime facts — `source` for the persisted source, `approvalFor`
   * for the decision's `reason`/`riskClass`.
   */
  toolFacts: ToolFacts
  approvalWritePromises: Array<Promise<unknown>>
  requestId: string
  /** Worker-wire-backed persister injected by the runtime. */
  persistApprovalRequest: (
    args: ToolApprovalRequestPersistenceArgs
  ) => Promise<unknown>
}

export function createRuntimeApprovalPersistenceTransform({
  chatId,
  assistantMessageId,
  toolFacts,
  approvalWritePromises,
  requestId,
  persistApprovalRequest,
}: RuntimeApprovalPersistenceTransformOptions): StreamTextTransform<ToolSet> {
  return () =>
    new TransformStream<TextStreamPart<ToolSet>, TextStreamPart<ToolSet>>({
      async transform(chunk, controller) {
        if (chunk.type === "tool-approval-request") {
          const toolName = chunk.toolCall.toolName
          const decision = toolFacts.approvalFor(toolName)
          const source = toolFacts.metadata.source(toolName)
          const inputPreview = (() => {
            try {
              return JSON.stringify(chunk.toolCall.input).slice(0, 500)
            } catch {
              return String(chunk.toolCall.input).slice(0, 500)
            }
          })()

          const approvalWrite = (async () =>
            persistApprovalRequest({
              assistantMessageId,
              toolCallId: chunk.toolCall.toolCallId,
              toolName,
              source,
              reason: decision?.reason,
              riskClass: decision?.riskClass ?? "unknown",
              inputPreview,
              approvalId: chunk.approvalId,
            }))()

          approvalWritePromises.push(approvalWrite)

          try {
            await approvalWrite
          } catch (error) {
            warnDurable("tool_approval_request_write_failed", {
              requestId,
              chatId,
              toolCallId: chunk.toolCall.toolCallId,
              toolName,
              error: describeError(error),
            })
            throw error
          }
        }

        controller.enqueue(chunk)
      },
    })
}

// Guest adapter — the null object of durability. Identity passthrough, `{}`
// extras, no-op writes, zero network, `guest` receipt. "Guest chats run
// ungated" is structural.

export function createGuestDurableTurn(
  input: DurableTurnInput
): DurableTurnRuntime {
  return {
    mode: "guest",
    executionAbortSignal: new AbortController().signal,
    providerAbortSignals(requestSignal) {
      return [requestSignal]
    },
    async prepare() {
      return sanitizeModelHistoryMessages(input.messages) as MessageAISDK[]
    },
    getTitleGeneration() {
      return null
    },
    getStreamRunId() {
      return null
    },
    bind() {
      return {
        streamTextExtras: {},
        stream: {
          async startWork() {
            return true
          },
          async recordTitleUsageEvidence() {
            return true
          },
          onChunk() {},
          recordStep() {},
          noteStreamError() {},
          async onAbort() {},
          captureFinish() {},
        },
        envelope: {
          identity(validatedMessages) {
            return { originalMessages: validatedMessages }
          },
          async settle() {
            return { status: "guest" as const }
          },
        },
      }
    },
    async fail() {},
  }
}

// Convex adapter — the full durable timeline for one authenticated Chat turn.

export function createConvexDurableTurn(args: {
  input: DurableTurnInput & { convexToken: string }
  deps: DurableTurnDeps
}): DurableTurnRuntime {
  const { input, deps } = args
  const {
    chatId,
    requestId,
    model,
    messages,
    convexToken,
    edit,
    regeneration,
    expectedVisibleMessageCount,
    tailMessageId,
    generationInputHash,
    reservationId,
  } = input
  const { fetchMutation } = deps

  // The execution grant (ADR-0011): minted per turn, digest crosses to Convex
  // in the admission call, secret stays here. Never logged, never persisted.
  const grantSecret = randomBytes(32).toString("hex")
  const grantDigest = createHash("sha256").update(grantSecret).digest("hex")
  const wire: DurableWorkerWire =
    deps.workerWire ?? createHttpDurableWorkerWire({ secret: grantSecret })
  const settleRetryDelaysMs = deps.settleRetryDelaysMs ?? [250, 1000]
  const admissionProofSigner =
    deps.admissionProofSigner ?? signChatAdmissionProof

  // The durable run — assigned once at prepare(), then read by the timeline.
  let runId: Id<"generationRuns"> | null = null
  let assistantMessageId: Id<"messages"> | null = null
  let titleGeneration: number | null = null
  let originalMessages: DurableUiMessage[] = []
  let snapshotTracker: ReturnType<typeof createDurableSnapshotTracker> | null =
    null

  // onStepEnd cannot backpressure every AI SDK terminal callback, but its
  // usage write is settlement evidence. Keep the promises at turn scope so
  // abort, provider failure, and outer fail() all drain observed usage before
  // a terminal mutation revokes the execution grant.
  const stepWritePromises: Promise<unknown>[] = []

  // One-shot guards — programming errors, not ops events.
  let prepareCalled = false
  let bound = false

  // Grant-authority loss, discovered by ANY worker write. `grantAuthorityLost`
  // means Convex REVOKED the grant — an absorbing terminal (Stop, supersession,
  // failure, reap) landed elsewhere, so the run is settled and every later
  // write from this worker is moot: short-circuit them locally instead of
  // hammering the endpoint with 401s (the post-Stop write-storm noise).
  // `grantExpired` means the TTL lapsed — the run is NOT known settled, so
  // terminal writes still degrade honestly rather than claiming settlement.
  let grantAuthorityLost = false
  let grantExpired = false

  // Identity-checkable skip sentinel: a gated write resolves to THIS object.
  // Boolean boundary handlers and writeTerminal check it so a resolved skip
  // never reads as a landed write.
  const GRANT_GATED_SKIP = {
    ok: false as const,
    skipped: "grant_authority_lost" as const,
  }
  const isGrantGatedSkip = (value: unknown): boolean =>
    value === GRANT_GATED_SKIP

  const workerWrite = <Op extends DurableWorkerOp>(
    op: Op,
    opArgs: DurableWorkerPayloads[Op]
  ): Promise<unknown> => {
    if (!runId) {
      return Promise.reject(
        new Error("Durable turn runtime: worker write before prepare()")
      )
    }
    if (grantAuthorityLost || grantExpired) {
      return Promise.resolve(GRANT_GATED_SKIP)
    }
    // Safe by construction: the generic signature correlates `op` with its
    // payload; TS cannot carry that correlation into the union.
    const write = () =>
      wire({ op, args: { runId, ...opArgs } } as DurableWorkerCall)
    const perfSession = deps.perf
    // Every post-prepare write crosses this timing seam. Unsampled requests
    // return the raw promise; the snapshot rejection handler attaches at a
    // depth callers rely on, so the timing hop exists only when it can emit.
    if (!perfSession?.sampled) return write()
    const writeStartedAtMs = Date.now()
    const recordWrite = (ok: boolean) =>
      perfSession.event("durable_write", {
        op,
        durationMs: Date.now() - writeStartedAtMs,
        ok,
      })
    return write().then(
      (result) => {
        recordWrite(true)
        return result
      },
      (error: unknown) => {
        recordWrite(false)
        throw error
      }
    )
  }

  type TerminalWriteResult = "landed" | "settled-elsewhere" | "failed"

  // Each retried terminal op warns under its established tag so ops
  // vocabulary survives the wire migration; the op decides the tag.
  const TERMINAL_WRITE_FAILURE_TAGS = {
    markGenerationRunCompleted: "durable_completion_write_failed",
    markGenerationRunAborted: "durable_run_abort_write_failed",
  } as const

  /**
   * A terminal transition with bounded retry. NEVER throws. Three-way result:
   * `landed` — THIS write's outcome is the run's terminal; `settled-elsewhere`
   * — the grant was revoked, meaning an absorbing terminal (Stop,
   * supersession, failure, reap) already settled the run durably, but NOT
   * necessarily with this write's outcome (Convex is the source of truth —
   * claiming the requested outcome here would let a completion write report
   * "completed" over a landed failure); `failed` — nothing is known to have
   * landed after bounded retries, the degraded-receipt path.
   */
  const writeTerminal = async <
    Op extends keyof typeof TERMINAL_WRITE_FAILURE_TAGS,
  >(
    op: Op,
    opArgs: DurableWorkerPayloads[Op]
  ): Promise<TerminalWriteResult> => {
    const settledElsewhere = (reason?: string): TerminalWriteResult => {
      warnDurable("durable_terminal_write_rejected_settled", {
        requestId,
        chatId,
        runId,
        op,
        ...(reason && { reason }),
      })
      return "settled-elsewhere"
    }
    for (let attempt = 0; attempt <= settleRetryDelaysMs.length; attempt++) {
      // Re-checked EVERY iteration: authority loss or expiry can be
      // discovered by another write while this one sits in a retry delay.
      // Expiry stays "failed" — nothing is known settled there — and a
      // resolved skip sentinel below must never read as a landed write.
      if (grantExpired) return "failed"
      if (grantAuthorityLost) return settledElsewhere("grant-authority-lost")
      try {
        const written = await withWorkerWriteTimeout(
          workerWrite(op, opArgs),
          `writing terminal operation ${op}`
        )
        if (isGrantGatedSkip(written)) {
          if (grantExpired) return "failed"
          return settledElsewhere("grant-authority-lost")
        }
        return "landed"
      } catch (error) {
        // Absorbing outcomes revoke the grant, so
        // the benign double-terminal orders — the envelope's abort after the
        // stream's, or a spurious completion after a landed failure — now
        // reject at the grant gate instead of no-oping inside the handler.
        // The run IS settled; whether with THIS outcome only Convex knows.
        if (
          error instanceof DurableWorkerWriteError &&
          error.grantRejection === "grant_unauthorized"
        ) {
          noteGrantRejection("grant_unauthorized", op)
          return settledElsewhere()
        }
        warnDurable(TERMINAL_WRITE_FAILURE_TAGS[op], {
          requestId,
          chatId,
          runId,
          op,
          attempt: attempt + 1,
          error: describeError(error),
        })
        // Grant expiry is deterministic — the remaining retries cannot land.
        if (
          error instanceof DurableWorkerWriteError &&
          error.grantRejection === "grant_expired"
        ) {
          noteGrantRejection("grant_expired", op)
          return "failed"
        }
        if (attempt < settleRetryDelaysMs.length) {
          await sleep(settleRetryDelaysMs[attempt])
        }
      }
    }
    return "failed"
  }

  const markRunAborted = async (
    reason: string,
    workDurationMs?: number,
    terminalUsage?: TerminalUsageEvidencePayload,
    timingReceipt?: RunTimingReceipt
  ): Promise<TerminalWriteResult> => {
    const currentMessageId = assistantMessageId
    if (!runId || !currentMessageId) return "landed"
    return writeTerminal("markGenerationRunAborted", {
      messageId: currentMessageId,
      reason,
      workDurationMs,
      ...(terminalUsage ? { terminalUsage } : {}),
      ...(timingReceipt ? { timingReceipt } : {}),
    })
  }

  /**
   * Normalize parent-observed facts into the wire evidence payload: the
   * binding owns the partial-output estimate because it holds the parts (the
   * tracker's snapshot mid-stream, the response message's at settle).
   */
  const toTerminalUsagePayload = (
    facts: TerminalUsageFacts,
    parts: unknown
  ): TerminalUsageEvidencePayload => {
    const primary = facts.primary
    if (
      primary.kind === "completed-steps" ||
      primary.kind === "started-without-usage"
    ) {
      const partialOutputTokens = estimatePartialOutputTokens(parts)
      return {
        primary: {
          ...primary,
          ...(partialOutputTokens > 0 ? { partialOutputTokens } : {}),
        },
        title: facts.title,
      }
    }
    return { primary, title: facts.title }
  }

  // Settlement-only terminal-usage receipt (ADR-0021 cancellation
  // amendment): when a Stop/supersession settled the run elsewhere, the SAME
  // worker secret authorizes exactly one allowance finalization against the
  // reservation's settlement digest. One attempt, deliberately outside the
  // grant-gated workerWrite (authority loss is the very state this serves);
  // the deadline reconciler is the retry/failure backstop.
  let settlementReceiptAttempted = false
  const submitSettlementReceipt = async (
    terminalUsage: TerminalUsageEvidencePayload | undefined
  ): Promise<void> => {
    if (!runId || !reservationId || !terminalUsage) return
    if (settlementReceiptAttempted) return
    settlementReceiptAttempted = true
    try {
      const response = await withWorkerWriteTimeout(
        wire({
          op: "finalizeTerminalUsage",
          args: { runId, reservationId, terminalUsage },
        }),
        "writing terminal usage receipt"
      )
      const outcome = (
        response as { result?: { outcome?: string } } | undefined
      )?.result?.outcome
      console.log(
        JSON.stringify({
          _tag: "durable_terminal_usage_receipt",
          requestId,
          chatId,
          runId,
          reservationId,
          outcome: outcome ?? "unknown",
        })
      )
    } catch (error) {
      warnDurable("durable_terminal_usage_receipt_failed", {
        requestId,
        chatId,
        runId,
        reservationId,
        error: describeError(error),
      })
    }
  }

  // Run timing receipt attach (ADR-0030): when an absorbing terminal settled
  // this run elsewhere WITHOUT a receipt (user Stop, supersession), the same
  // worker secret authorizes exactly one receipt attach against the digest
  // that transaction copied onto the run. One attempt, outside the
  // grant-gated workerWrite (authority loss is the very state this serves);
  // the receipt is diagnostics, so a miss is logged, never retried.
  let timingReceiptAttachAttempted = false
  const submitTimingReceipt = async (
    timingReceipt: RunTimingReceipt | undefined
  ): Promise<void> => {
    if (!runId || !timingReceipt) return
    if (timingReceiptAttachAttempted) return
    timingReceiptAttachAttempted = true
    try {
      await withWorkerWriteTimeout(
        wire({
          op: "attachRunTimingReceipt",
          args: { runId, timingReceipt },
        }),
        "attaching run timing receipt"
      )
    } catch (error) {
      warnDurable("durable_timing_receipt_attach_failed", {
        requestId,
        chatId,
        runId,
        error: describeError(error),
      })
    }
  }

  // The most recent abort facts, kept so the envelope settle (which fires
  // after the stream onAbort on a Stop) reuses the richer step-aggregate
  // evidence instead of downgrading to started-without-usage.
  let lastTerminalFacts: TerminalUsageFacts | undefined

  // The heartbeat loop is recursive and non-overlapping: the next
  // beat is scheduled only after the previous one settles. Three-way branch:
  // renewed → continue; paused → stop the loop WITHOUT aborting (the approval
  // worker's envelope finalize is still legitimate); lost → abort provider
  // consumption. Transport failures get a bounded retry budget (two
  // consecutive tolerated, jittered retry); an explicit `lost` is never
  // retried. The loop also aborts if the last confirmed lease is about to
  // lapse — continuing to stream against an expired lease invites the reaper.
  const HEARTBEAT_TRANSPORT_RETRY_LIMIT = 2
  const executionAbortController = new AbortController()
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeatStopped = false
  let heartbeatTransportFailures = 0
  let lastConfirmedLeaseExpiresAt: number | null = null

  const stopHeartbeat = () => {
    heartbeatStopped = true
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  const loseExecution = (reason: string) => {
    stopHeartbeat()
    if (!executionAbortController.signal.aborted) {
      executionAbortController.abort(
        new DOMException(
          `Durable worker execution lost: ${reason}`,
          "AbortError"
        )
      )
    }
  }

  /**
   * A grant rejection from ANY worker write: stop executing, and gate every
   * later write locally (see `grantAuthorityLost`/`grantExpired`). Warned once
   * — the discovering site keeps its own established tag; repeats are the
   * post-Stop 401 storm this exists to remove.
   */
  const noteGrantRejection = (
    rejection: "grant_unauthorized" | "grant_expired",
    source: string
  ) => {
    const firstDiscovery = !grantAuthorityLost && !grantExpired
    if (rejection === "grant_expired") {
      grantExpired = true
    } else {
      grantAuthorityLost = true
    }
    if (firstDiscovery) {
      warnDurable("durable_worker_authority_revoked", {
        requestId,
        chatId,
        runId,
        rejection,
        source,
      })
    }
    loseExecution(`grant ${rejection}`)
  }

  /**
   * Shared discovery hook for the fire-and-forget write catches: EVERY worker
   * write path notes a grant rejection so the first discoverer — whichever
   * write it happens to be — gates the rest. Returns true when the error was
   * a grant rejection (callers skip their generic failure warn: the moot
   * write is covered by the single authority-revoked warn). Writes already
   * in flight when the flag flips can still each reject once — the gate
   * stops NEW writes, it cannot recall dispatched ones.
   */
  const noteIfGrantRejection = (error: unknown, source: string): boolean => {
    if (
      error instanceof DurableWorkerWriteError &&
      error.grantRejection !== undefined
    ) {
      noteGrantRejection(error.grantRejection, source)
      return true
    }
    return false
  }

  const scheduleHeartbeat = (delayMs: number) => {
    if (heartbeatStopped) return
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null
      void heartbeatOnce()
    }, delayMs)
    // Never hold the process open for a heartbeat.
    heartbeatTimer.unref?.()
  }

  const heartbeatOnce = async (): Promise<void> => {
    if (heartbeatStopped) return
    try {
      const response = await withWorkerWriteTimeout(
        workerWrite("heartbeatGenerationRun", {}),
        "writing heartbeat"
      )
      const result = (response as { result?: GenerationRunHeartbeatResult })
        ?.result
      if (heartbeatStopped) return
      if (result?.kind === "renewed") {
        // Reset only on a RECOGNIZED body: consecutive unparseable responses
        // (thrown below) must accumulate against the transport retry budget,
        // not reset it each round-trip.
        heartbeatTransportFailures = 0
        lastConfirmedLeaseExpiresAt = result.leaseExpiresAt
        scheduleHeartbeat(HEARTBEAT_INTERVAL_MS)
        return
      }
      if (result?.kind === "paused") {
        warnDurable("run_heartbeat_rejected", {
          requestId,
          chatId,
          runId,
          outcome: "paused",
        })
        stopHeartbeat()
        return
      }
      if (result?.kind === "lost") {
        warnDurable("run_heartbeat_rejected", {
          requestId,
          chatId,
          runId,
          outcome: "lost",
          reason: result.reason,
        })
        loseExecution(result.reason)
        return
      }
      // Unrecognizable 200 body: a proxy-truncated response or a mid-deploy
      // shape drift is TRANSPORT trouble, not an authoritative verdict —
      // only an explicit `lost` may abort a healthy generation. Falls through
      // to the bounded transport-retry budget below.
      throw new Error("unrecognized heartbeat response body")
    } catch (error) {
      // A grant rejection is an explicit settlement signal, not transport.
      if (
        error instanceof DurableWorkerWriteError &&
        error.grantRejection !== undefined
      ) {
        warnDurable("run_heartbeat_rejected", {
          requestId,
          chatId,
          runId,
          outcome: "lost",
          reason: error.grantRejection,
        })
        noteGrantRejection(error.grantRejection, "heartbeat")
        return
      }
      heartbeatTransportFailures += 1
      warnDurable("run_heartbeat_failed", {
        requestId,
        chatId,
        runId,
        consecutiveFailures: heartbeatTransportFailures,
        error: describeError(error),
      })
      const leaseNearlyLapsed =
        lastConfirmedLeaseExpiresAt !== null &&
        Date.now() >= lastConfirmedLeaseExpiresAt - HEARTBEAT_INTERVAL_MS / 2
      if (
        heartbeatTransportFailures > HEARTBEAT_TRANSPORT_RETRY_LIMIT ||
        leaseNearlyLapsed
      ) {
        loseExecution("heartbeat transport lost")
        return
      }
      // Bounded jittered retry, well inside the lease window.
      scheduleHeartbeat(2_000 + Math.floor(Math.random() * 1_000))
    }
  }

  const startHeartbeat = () => {
    // Prepare just wrote the initial lease; treat it as the first confirmation.
    lastConfirmedLeaseExpiresAt = Date.now() + LEASE_DURATION_MS
    scheduleHeartbeat(HEARTBEAT_INTERVAL_MS)
  }

  return {
    mode: "durable",
    executionAbortSignal: executionAbortController.signal,
    providerAbortSignals() {
      // Deliberately excludes the request signal: the durable worker outlives
      // its client, so reload/disconnect leaves the
      // stream settling server-side). Stop/supersession/reaping abort through
      // the execution signal via heartbeat `lost` or a grant rejection.
      return [executionAbortController.signal]
    },

    async prepare({ provider, route, reasoningEffort, generationBudget }) {
      if (prepareCalled) {
        throw new Error(
          "Durable turn runtime: prepare() may only be called once"
        )
      }
      prepareCalled = true

      const { approvalResponses, latestUserMessage } =
        buildDurablePrepareIntent({ messages, edit, regeneration })
      const admissionIssuedAt = Date.now()
      const admissionProof = admissionProofSigner({
        chatId,
        requestId,
        model,
        provider,
        route,
        reasoningEffort,
        generationBudget,
        grantDigest,
        reservationId,
        cancellationSettlementVersion: CANCELLATION_SETTLEMENT_PROTOCOL_VERSION,
        generationInputHash,
        issuedAt: admissionIssuedAt,
      })

      const generation = await fetchMutation(
        api.chatRuntime.prepareGeneration,
        {
          chatId,
          requestId,
          model,
          provider,
          route,
          reasoningEffort,
          generationBudget,
          expectedVisibleMessageCount,
          tailMessageId,
          latestUserMessage: latestUserMessage
            ? {
                id: latestUserMessage.id,
                role: "user" as const,
                content: getStringField(
                  getRecord(latestUserMessage as unknown),
                  "content"
                ),
                parts: latestUserMessage.parts,
              }
            : undefined,
          edit,
          regeneration,
          approvalResponses,
          generationInputHash,
          grantDigest,
          reservationId,
          cancellationSettlementVersion:
            CANCELLATION_SETTLEMENT_PROTOCOL_VERSION,
          admissionIssuedAt,
          admissionProof,
        },
        { token: convexToken }
      ).catch((error: unknown) => {
        // Approval-continuation idempotency, layer 2 of 3:
        // the losing auto-send continuation gets a structured 409 the client
        // recognizes and swallows — never a failed repaint.
        const conflictCode = (
          (error as { data?: { code?: unknown } } | null)?.data as
            { code?: unknown } | undefined
        )?.code
        if (conflictCode === "approval_continuation_conflict") {
          throw new PublicChatHttpError({
            message: "Approval continuation already dispatched",
            statusCode: 409,
            code: "APPROVAL_CONTINUATION_CONFLICT",
          })
        }
        if (conflictCode === "approval_provider_mismatch") {
          throw new PublicChatHttpError({
            message:
              "This approval belongs to a different provider. Switch back to the original model and try again.",
            statusCode: 409,
            code: "APPROVAL_PROVIDER_MISMATCH",
          })
        }
        // Unlike a continuation conflict, no winning decision exists to
        // observe through the projection — the client must surface this one.
        if (conflictCode === "approval_unresolved") {
          throw new PublicChatHttpError({
            message:
              "Your approval decision was not recorded. Approve or deny it again.",
            statusCode: 409,
            code: "APPROVAL_UNRESOLVED",
          })
        }
        if (conflictCode === "generation_input_changed") {
          throw new PublicChatHttpError({
            message:
              "This chat changed before generation started. Please try again.",
            statusCode: 409,
            code: "GENERATION_INPUT_CHANGED",
          })
        }
        // The wire contract only checks the id's UUID shape, so a crafted
        // request can still reach the durable contract with arguments Convex
        // rejects at validation. That is a request-shape fault: map it to the
        // route's 400 instead of a 500 that leaks Convex error internals.
        // Everything else (concurrency guards, transient failures) passes
        // through unchanged.
        const invalidRequest = toInvalidDurableRequestError(error)
        if (invalidRequest) {
          warnDurable("durable_prepare_argument_rejected", {
            requestId,
            chatId,
            error: describeError(error),
          })
          throw invalidRequest
        }
        throw error
      })

      const durableMessages = sanitizeModelHistoryMessages(
        toDurableUiMessages(generation.messages)
      )

      runId = generation.runId
      assistantMessageId = generation.assistantMessageId
      titleGeneration = generation.titleGeneration ?? null
      originalMessages = durableMessages
      const snapshotBase = {
        messageId: generation.assistantMessageId,
      }
      snapshotTracker = createDurableSnapshotTracker({
        initialMessage: durableMessages.at(-1)?.role === "assistant"
          ? durableMessages.at(-1)
          : undefined,
        persist: (snapshotArgs) => {
          // Checkpoint counters: attempts/accepted/lost/failed
          // plus cumulative payload bytes. Sizes and enums only — the
          // serialization happens only when this request is sampled.
          const perfSession = deps.perf
          if (perfSession?.sampled) {
            let payloadBytes = snapshotArgs.textSnapshot.length
            try {
              payloadBytes += JSON.stringify(snapshotArgs.partsSnapshot).length
            } catch {
              // Size estimate only; never fail a checkpoint for telemetry.
            }
            perfSession.counter("attempt", payloadBytes)
          }
          // Single two-handler then(): the rejection handler must attach at
          // the same microtask depth as the pre-instrumentation `.catch` —
          // revocation discovery aborts execution, and consumers observe that
          // abort immediately after the write settles.
          return workerWrite("updateAssistantSnapshot", {
            ...snapshotBase,
            ...snapshotArgs,
          }).then(
            (written) => {
              const result = (written as { result?: { deduped?: boolean } })
                ?.result
              perfSession?.counter(result?.deduped ? "deduped" : "accepted")
              return written
            },
            (error: unknown) => {
              // Snapshot writes discover revocation too (a Stop race lands
              // between beats). Unauthorized = the run settled elsewhere and its
              // content froze at that terminal — this write is moot, absorb it
              // instead of cascading write-failure noise. Expiry keeps
              // propagating: content survival is genuinely at risk there.
              if (
                error instanceof DurableWorkerWriteError &&
                error.grantRejection === "grant_unauthorized"
              ) {
                noteGrantRejection("grant_unauthorized", "assistant-snapshot")
                perfSession?.counter("authority_lost")
                return { ok: false, skipped: "grant_authority_lost" }
              }
              if (
                error instanceof DurableWorkerWriteError &&
                error.grantRejection === "grant_expired"
              ) {
                noteGrantRejection("grant_expired", "assistant-snapshot")
              }
              perfSession?.counter("failed")
              throw error
            }
          )
        },
      })

      // The lease was born inside prepareGeneration; the loop starts after a
      // successful prepare, keeps it fresh, and stops at settlement/pause/loss.
      startHeartbeat()

      console.log(
        JSON.stringify({
          _tag: "durable_chat_runtime_prepared",
          requestId,
          chatId,
          runId: generation.runId,
          assistantMessageId: generation.assistantMessageId,
          canonicalMessageCount: durableMessages.length,
          approvalResponseCount: approvalResponses.length,
          hasLatestUserMessage: Boolean(latestUserMessage),
          hasRegeneration: Boolean(regeneration),
          targetAssistantMessageId: regeneration?.targetAssistantMessageId,
        })
      )

      return durableMessages as MessageAISDK[]
    },

    getStreamRunId() {
      return runId
    },
    getTitleGeneration() {
      return titleGeneration
    },

    bind(toolFacts) {
      const currentRunId = runId
      const currentMessageId = assistantMessageId
      const tracker = snapshotTracker
      if (!currentRunId || !currentMessageId || !tracker) {
        throw new Error(
          "Durable turn runtime: bind() requires a completed prepare()"
        )
      }
      if (bound) {
        throw new Error("Durable turn runtime: bind() may only be called once")
      }
      bound = true

      const approvalWritePromises: Promise<unknown>[] = []
      let capturedFinish: StreamFinishFacts | undefined

      const streamTextExtras: DurableStreamTextExtras = {}
      // Call-site approval config (ai@7): the Tool runtime's decisions, durable
      // runs only — guest chats run ungated, matching the pre-v7 wrap-on-durable
      // behavior.
      if (toolFacts.toolApproval) {
        streamTextExtras.toolApproval = toolFacts.toolApproval
      }
      streamTextExtras.experimental_transform =
        createRuntimeApprovalPersistenceTransform({
          chatId,
          assistantMessageId: currentMessageId,
          toolFacts,
          approvalWritePromises,
          requestId,
          persistApprovalRequest: (approvalArgs) =>
            workerWrite("createToolApprovalRequest", approvalArgs).catch(
              (error: unknown) => {
                noteIfGrantRejection(error, "approval-request")
                throw error
              }
            ),
        })

      return {
        streamTextExtras,

        stream: {
          async startWork(startedAt) {
            try {
              const written = await withWorkerWriteTimeout(
                workerWrite("markGenerationWorkStarted", {
                  messageId: currentMessageId,
                  startedAt,
                }),
                "writing provider work start"
              )
              return !isGrantGatedSkip(written)
            } catch (error: unknown) {
              if (noteIfGrantRejection(error, "work-start")) return false
              warnDurable("durable_work_start_write_failed", {
                requestId,
                chatId,
                runId: currentRunId,
                error: describeError(error),
              })
              return false
            }
          },

          async recordTitleUsageEvidence(evidence) {
            try {
              const written = await withWorkerWriteTimeout(
                workerWrite("recordTitleUsageEvidence", {
                  messageId: currentMessageId,
                  evidence,
                }),
                "writing title usage evidence"
              )
              return !isGrantGatedSkip(written)
            } catch (error: unknown) {
              if (noteIfGrantRejection(error, "title-usage")) return false
              warnDurable("durable_title_usage_write_failed", {
                requestId,
                chatId,
                runId: currentRunId,
                error: describeError(error),
              })
              return false
            }
          },

          onChunk(chunk, summaryDurationMs) {
            return tracker.onChunk(chunk, summaryDurationMs)
          },

          recordStep({ stepNumber, usage, toolCalls, toolResults }) {
            const invocations: ToolInvocationForPersistence[] = toolCalls.map(
              (call) => {
                const result = toolResults?.find(
                  (candidate) => candidate.toolCallId === call.toolCallId
                )
                const isError = result ? Boolean(result.isError) : false
                const approvalDecision = toolFacts.approvalFor(call.toolName)
                return {
                  toolCallId: call.toolCallId,
                  toolName: call.toolName,
                  source: toolFacts.metadata.source(call.toolName),
                  input: call.input,
                  output: result?.output,
                  error: isError
                    ? String(result?.output ?? "Tool failed")
                    : undefined,
                  status: result
                    ? isError
                      ? "failed"
                      : "completed"
                    : approvalDecision?.needsApproval
                      ? "pending_approval"
                      : "called",
                }
              }
            )

            stepWritePromises.push(
              workerWrite("recordToolInvocations", {
                messageId: currentMessageId,
                stepNumber,
                ...(usage &&
                (typeof usage.inputTokens === "number" ||
                  typeof usage.outputTokens === "number")
                  ? {
                      usage: {
                        inputTokens: usage.inputTokens,
                        outputTokens: usage.outputTokens,
                      },
                    }
                  : {}),
                invocations,
              }).catch((error: unknown) => {
                if (noteIfGrantRejection(error, "tool-invocations")) return
                warnDurable("canonical_tool_invocation_write_failed", {
                  requestId,
                  chatId,
                  runId: currentRunId,
                  error: describeError(error),
                })
              })
            )
          },

          noteStreamError(failure, workDurationMs, timingReceipt) {
            const normalizedFailure = normalizeDurableFailure(failure)
            void (async () => {
              await drainPendingWrites(stepWritePromises)
              await workerWrite("markGenerationRunFailed", {
                messageId: currentMessageId,
                error: normalizedFailure.message,
                ...(normalizedFailure.recovery !== undefined
                  ? { errorRecovery: normalizedFailure.recovery }
                  : {}),
                workDurationMs,
                ...(timingReceipt ? { timingReceipt } : {}),
              })
            })().catch((error: unknown) => {
              if (noteIfGrantRejection(error, "stream-error")) return
              warnDurable("durable_run_failed_write_failed", {
                requestId,
                chatId,
                runId: currentRunId,
                error: describeError(error),
              })
            })
          },

          async onAbort(
            reason,
            workDurationMs,
            facts,
            timingReceipt,
            workSummaryDurationMs
          ) {
            tracker.noteWorkSummary({ durationMs: workSummaryDurationMs })
            await drainPendingWrites(stepWritePromises)
            await tracker.flush().catch(() => {})
            if (facts) lastTerminalFacts = facts
            const terminalUsage = facts
              ? toTerminalUsagePayload(facts, tracker.partsSnapshot)
              : undefined
            await markRunAborted(
              reason,
              workDurationMs,
              terminalUsage,
              timingReceipt
            )
            // Do not finalize a Stop/supersession receipt here: the title and
            // final response snapshot may still gain evidence before the
            // envelope settles. The envelope submits once with those fresher
            // facts; the deadline reconciler covers a missing envelope.
            // The run is settled (or unreachable); the envelope settle that
            // follows re-stops idempotently.
            stopHeartbeat()
          },

          captureFinish(facts) {
            capturedFinish = facts
          },
        },

        envelope: {
          identity() {
            return {
              originalMessages,
              generateMessageId: () => currentMessageId,
            }
          },

          async settle({
            responseMessage,
            isAborted,
            finishReason,
            titleUsage,
            terminalFacts,
            timingReceipt,
          }) {
            // Monotonic: the receipt's clock, like every other segment.
            const settleStartedAtMs = performance.now()
            // Settlement up to the terminal write (drain + final flush); the
            // write itself cannot be inside the receipt it carries.
            const receiptForTerminalWrite = (): RunTimingReceipt | undefined =>
              timingReceipt
                ? {
                    ...timingReceipt,
                    settlementMs:
                      Math.round(
                        (performance.now() - settleStartedAtMs) * 100
                      ) / 100,
                  }
                : undefined
            // Keep the heartbeat alive through bounded terminal retries; a
            // mid-retry reap would race the write. Then stop on every exit. A
            // degraded exit stops too: lease expiry is the honest convergence
            // path once retries are exhausted.
            try {
              // Unconfirmed terminal persistence degrades the receipt loudly
              // without failing an already delivered response.
              const degrade = (reason: string): DurableSettlementReceipt => {
                warnDurable("durable_settlement_degraded", {
                  requestId,
                  chatId,
                  runId: currentRunId,
                  reason,
                })
                Sentry.captureMessage("durable_settlement_degraded", {
                  level: "error",
                  tags: { chat_route: "/api/chat" },
                  extra: { requestId, chatId, runId: currentRunId, reason },
                })
                deps.perf?.counter("settlement_receipt_degraded")
                return {
                  status: "degraded" as const,
                  runId: currentRunId,
                  reason,
                }
              }

              // Bounded: settlement runs inside the route's reserve tail —
              // one worker-write timeout is the most any straggling approval
              // or step write may hold it (the writes carry their own catch
              // logging).
              // The losing timer is cancelled — the common already-settled
              // case must not pin the process for the full timeout.
              await drainPendingWrites([
                ...approvalWritePromises,
                ...stepWritePromises,
              ])
              await tracker.flush().catch(() => {})

              // Content survival before ANY terminal transition (ADR-0011): the
              // final snapshot is unconditional — abort included — and carries
              // the COMPLETE response parts, so a failed terminal write (or an
              // abort, whose terminal write never carries parts) leaves the
              // latest answer on the message doc, even if the last throttled
              // checkpoint preceded the final chunks.
              deps.perf?.counter("final_flush")
              await tracker
                .flushFinal(
                  extractTextFromMessageParts(responseMessage.parts),
                  responseMessage.parts
                )
                .catch((error: unknown) => {
                  warnDurable("durable_final_snapshot_write_failed", {
                    requestId,
                    chatId,
                    runId: currentRunId,
                    error: describeError(error),
                  })
                })

              if (isAborted) {
                const terminalMetadata = projectPersistedMessageMetadata(
                  responseMessage.metadata
                )
                // Prefer the stream onAbort's step-aggregate primary facts
                // (richer) with the envelope's title state (fresher — the
                // title call may have finished in between); the response
                // message's parts give the final partial-output estimate.
                const abortFacts: TerminalUsageFacts | undefined =
                  lastTerminalFacts || terminalFacts
                    ? {
                        primary: lastTerminalFacts?.primary ?? {
                          kind: "started-without-usage" as const,
                        },
                        title: terminalFacts?.title ??
                          lastTerminalFacts?.title ?? { kind: "not-run" },
                      }
                    : undefined
                const terminalUsage = abortFacts
                  ? toTerminalUsagePayload(abortFacts, responseMessage.parts)
                  : undefined
                const aborted = await markRunAborted(
                  "ui message stream aborted",
                  terminalMetadata?.workDurationMs,
                  terminalUsage,
                  receiptForTerminalWrite()
                )
                if (aborted === "failed") return degrade("abort write failed")
                if (aborted === "settled-elsewhere") {
                  await submitSettlementReceipt(terminalUsage)
                  await submitTimingReceipt(receiptForTerminalWrite())
                }
                deps.perf?.counter("settlement_receipt_confirmed")
                return {
                  status: "confirmed" as const,
                  runId: currentRunId,
                  outcome:
                    aborted === "landed"
                      ? ("aborted" as const)
                      : ("settled-elsewhere" as const),
                }
              }

              let toolCounts = capturedFinish?.toolCounts
              if (!toolCounts) {
                // The stream-onEnd half of the handoff never ran — the failure
                // mode ADR-0006 named. Land the completion write anyway
                // (part-counted), but LOUDLY so the bug surfaces instead of
                // hiding behind the fallback.
                warnDurable("durable_finish_handoff_missed", {
                  requestId,
                  chatId,
                  runId: currentRunId,
                })
                Sentry.captureMessage("durable_finish_handoff_missed", {
                  level: "warning",
                })
                toolCounts = countToolParts(responseMessage)
              }

              const completionReceipt = receiptForTerminalWrite()
              const landed = await writeTerminal("markGenerationRunCompleted", {
                messageId: currentMessageId,
                content: extractTextFromMessageParts(responseMessage.parts),
                parts: responseMessage.parts,
                metadata: projectPersistedMessageMetadata(
                  responseMessage.metadata
                ),
                finishReason: capturedFinish?.finishReason ?? finishReason,
                usage: capturedFinish?.usage,
                titleUsage,
                totalToolCalls: toolCounts.totalToolCalls,
                failedToolCalls: toolCounts.failedToolCalls,
                ...(completionReceipt
                  ? { timingReceipt: completionReceipt }
                  : {}),
              })

              if (landed === "failed") {
                return degrade("completion write failed after retries")
              }

              if (landed === "settled-elsewhere") {
                // A Stop won while the completion write was in flight. If its
                // reservation is accounting-pending, hand it the best possible
                // evidence — the authoritative all-steps aggregate.
                const usage = capturedFinish?.usage
                const actualEvidence: TerminalUsageEvidencePayload | undefined =
                  usage &&
                  (typeof usage.inputTokens === "number" ||
                    typeof usage.outputTokens === "number")
                    ? {
                        primary: {
                          kind: "actual",
                          inputTokens: usage.inputTokens,
                          outputTokens: usage.outputTokens,
                        },
                        title: terminalFacts?.title ?? { kind: "not-run" },
                      }
                    : terminalFacts
                      ? toTerminalUsagePayload(
                          {
                            primary: { kind: "started-without-usage" },
                            title: terminalFacts.title,
                          },
                          responseMessage.parts
                        )
                      : undefined
                await submitSettlementReceipt(actualEvidence)
                await submitTimingReceipt(completionReceipt)
              }

              deps.perf?.counter("settlement_receipt_confirmed")
              return {
                status: "confirmed" as const,
                runId: currentRunId,
                outcome:
                  landed === "landed"
                    ? ("completed" as const)
                    : ("settled-elsewhere" as const),
              }
            } finally {
              // Drain + final flush + terminal write, whatever the outcome.
              deps.perf?.record(
                "settlement_total",
                performance.now() - settleStartedAtMs
              )
              stopHeartbeat()
            }
          },
        },
      }
    },

    async fail(failure) {
      const normalizedFailure = normalizeDurableFailure(failure)
      const currentRunId = runId
      const currentMessageId = assistantMessageId
      if (!currentRunId || !currentMessageId) return
      // Write first (bounded), heartbeat stopped in finally: keeping the
      // lease alive through the ≤10 s write means a reaper tick cannot race
      // in and relabel this provider failure `lease_expired`; the bound —
      // not the ordering — is what prevents a stalled write from leaving
      // the loop renewing forever.
      try {
        await drainPendingWrites(stepWritePromises)
        await withWorkerWriteTimeout(
          workerWrite("markGenerationRunFailed", {
            messageId: currentMessageId,
            error: normalizedFailure.message,
            ...(normalizedFailure.recovery !== undefined
              ? { errorRecovery: normalizedFailure.recovery }
              : {}),
          }),
          "writing terminal operation markGenerationRunFailed"
        ).catch((writeError: unknown) => {
          if (noteIfGrantRejection(writeError, "fail")) return
          warnDurable("durable_run_failed_write_failed", {
            requestId,
            chatId,
            runId: currentRunId,
            error: describeError(writeError),
          })
        })
      } finally {
        stopHeartbeat()
      }
    },
  }
}

// Selecting factory — sync, pure. Internalizes `isDurableConvexChat`; returns
// the Convex adapter or the inert guest adapter. The caller never asks "is this
// turn durable"; the convex token crosses here, once.

export function createDurableTurnRuntime(args: {
  input: DurableTurnInput
  deps: DurableTurnDeps
}): DurableTurnRuntime {
  const { input, deps } = args
  if (
    isDurableConvexChat({
      isAuthenticated: input.isAuthenticated,
      convexToken: input.convexToken,
    }) &&
    input.convexToken
  ) {
    return createConvexDurableTurn({
      input: { ...input, convexToken: input.convexToken },
      deps,
    })
  }
  return createGuestDurableTurn(input)
}
