import { ConvexError, v } from "convex/values"
import { CHAT_TURN_EXECUTION_BUDGET } from "../lib/chat-turn/execution-budget"
import { estimatePartialOutputTokens } from "../lib/usage/terminal-usage-estimate"
import type { Doc, Id } from "./_generated/dataModel"
import {
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server"
import {
  sanitizeRunTimingReceipt,
  TIMING_RECEIPT_ATTACH_WINDOW_MS,
  vRunTimingReceipt,
  type RunTimingReceipt,
} from "./lib/runTimingReceipt"
import {
  isIgnoredSignal,
  isSupersedableGenerationRunStatus,
  isSupersedableMessageStatus,
  resolveGenerationRunTransition,
  resolveTerminalAssistantMessageResolution,
  type AssistantMessageFacts,
  type LifecycleVerdict,
  type MessageResolution,
} from "./domain/generation_run_lifecycle"
import {
  APPROVAL_EXPIRY_MS,
  computeLeaseExpiresAt,
  computeLiveRunFreshUntil,
  isWorkerExecutingStatus,
  RESOLVED_APPROVAL_CONTINUATION_GRACE_MS,
} from "./domain/generation_run_liveness"
import {
  createMessageBranchWriter,
  planSelectedPathAfterUserMessage,
} from "./domain/message_branch_writes"
import {
  createBranchContext,
  getEffectiveParentIdFromContext,
  getSelectedPathMessagesFromContext,
  getSiblingMessagesFromContext,
} from "./domain/message_branches"
import {
  isTerminalGenerationRunStatus,
  isTerminalMessageStatus,
  type GenerationRunStatus,
} from "./domain/message_contract"
import {
  bucketPow2,
  logChatPerfConvex,
  shouldSampleChatPerfConvex,
} from "./domain/chat_perf"
import { extractTextFromMessageParts } from "./domain/message_parts"
import { MAX_STOP_OBSERVED_TEXT_CHARS } from "./domain/message_facts"
import {
  hasSemanticAssistantParts,
  isTerminalOutcomeStub,
  isVisibleChatMessage,
  projectModelHistoryMessages,
} from "./domain/message_visibility"
import { patchChatActivity } from "./domain/project_activity"
import {
  isChatActive,
  type AuthenticatedChatOwner,
  type AuthenticatedRunOwner,
  type AuthenticatedToolApprovalOwner,
} from "./lib/auth"
import {
  authenticatedQuery,
  ownedChatMutation,
  ownedChatQuery,
  ownedGenerationRunMutation,
  ownedToolApprovalMutation,
} from "./lib/authedFunctions"
import {
  CANCELLATION_SETTLEMENT_PROTOCOL_VERSION,
  verifyChatAdmissionProof,
  type CancellationSettlementProtocolVersion,
  type ChatAdmissionRouteReceipt,
} from "./lib/chatAdmissionProof"
import {
  vToolInvocationStreamMetadata,
  type PersistedMessageMetadata,
} from "./lib/messageMetadata"
import {
  vReasoningEffort,
  type PersistedReasoningEffort,
} from "./lib/reasoningEffort"
import { sha256Hex, timingSafeEqualHex } from "./lib/sha256"
import {
  vTerminalUsageEvidence,
  vTitleTerminalUsageEvidence,
} from "./lib/usageValidators"
import {
  computeUsageCredits,
  isValidTerminalUsageEvidence,
  type TerminalUsageEvidencePayload,
  type TitleTerminalUsageEvidence,
} from "./domain/usage_accounting"
import {
  attachReservationToRun,
  deferUsageSettlementForTerminalRun,
  settleUsageForTerminalRun,
  type TitleUsageEvidence,
} from "./usageAllowance"

const MAX_PREVIEW_LENGTH = 500
// Defense-in-depth ceiling above the product's current 20-step maximum. The
// worker grant is narrow, but it must not be able to grow a run document
// without bound by inventing step numbers.
const MAX_DURABLE_USAGE_STEPS = 64

const vToolSource = v.union(
  v.literal("builtin"),
  v.literal("third-party"),
  v.literal("mcp"),
  v.literal("platform")
)

const vToolInvocationStatus = v.union(
  v.literal("called"),
  v.literal("pending_approval"),
  v.literal("approved"),
  v.literal("denied"),
  v.literal("completed"),
  v.literal("failed")
)

const vUsage = v.object({
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  totalTokens: v.optional(v.number()),
})

const vRoutedTitleUsage = v.object({
  routeId: v.string(),
  pricingRole: v.union(v.literal("title"), v.literal("primary")),
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
})

/**
 * One declaration per generation-run write op. The grant-authorized worker
 * mutations (convex/chatRuntimeWorker.ts) spread these shapes, so a field
 * added or renamed here is a compile + validator change on the wire — the
 * Chat turn wire contract pattern.
 *
 * These ops have NO public user-token registrations. Post-prepare run writes
 * travel ONLY the Execution-grant worker wire (ADR-0011): since ADR-0021,
 * `markGenerationRunCompleted.usage` is the authoritative settlement input,
 * so a user-token twin would let a chat owner settle their own platform
 * reservation at a self-declared (near-zero) cost. The user token authorizes
 * admission (`prepareGeneration`) and Stop only; `stopGenerationRun` stays
 * public because it carries no usage input — settlement evidence still
 * arrives via the grant wire or the reaper's boundary rule.
 */
export const generationRunWriteArgs = {
  markGenerationWorkStarted: {
    messageId: v.id("messages"),
    startedAt: v.number(),
  },
  recordTitleUsageEvidence: {
    messageId: v.id("messages"),
    evidence: vTitleTerminalUsageEvidence,
  },
  updateAssistantSnapshot: {
    messageId: v.id("messages"),
    sequence: v.number(),
    textSnapshot: v.string(),
    partsSnapshot: v.any(),
    workSummaryDurationMs: v.optional(v.number()),
  },
  recordToolInvocations: {
    messageId: v.id("messages"),
    stepNumber: v.optional(v.number()),
    // Per-step token usage — durable evidence so abort/failure settlement
    // does not depend on the happy-path onEnd aggregate (ADR-0021).
    usage: v.optional(vUsage),
    invocations: v.array(
      v.object({
        toolCallId: v.string(),
        toolName: v.string(),
        source: vToolSource,
        input: v.optional(v.any()),
        output: v.optional(v.any()),
        error: v.optional(v.string()),
        status: vToolInvocationStatus,
        approvalRequestId: v.optional(v.string()),
      })
    ),
  },
  createToolApprovalRequest: {
    assistantMessageId: v.id("messages"),
    toolCallId: v.string(),
    toolName: v.string(),
    source: vToolSource,
    reason: v.optional(v.string()),
    riskClass: v.string(),
    inputPreview: v.optional(v.string()),
    approvalId: v.string(),
  },
  markGenerationRunCompleted: {
    messageId: v.id("messages"),
    content: v.string(),
    parts: v.any(),
    metadata: v.optional(vToolInvocationStreamMetadata),
    finishReason: v.optional(v.string()),
    usage: v.optional(vUsage),
    // Title-call evidence for allowance settlement (ADR-0021): new workers
    // bind observed usage to the executed route and one of the reservation's
    // two immutable pricing roles. The token-only object remains accepted
    // during the Convex-first deployment window for active old Next workers.
    // "not-run" means no title was requested; "unknown" means a call may have
    // run but its usage never arrived.
    titleUsage: v.optional(
      v.union(
        vRoutedTitleUsage,
        vUsage,
        v.literal("not-run"),
        v.literal("unknown")
      )
    ),
    totalToolCalls: v.optional(v.number()),
    failedToolCalls: v.optional(v.number()),
    // Run timing receipt (ADR-0030): rides every terminal write.
    timingReceipt: v.optional(vRunTimingReceipt),
  },
  markGenerationRunFailed: {
    messageId: v.optional(v.id("messages")),
    error: v.string(),
    errorRecovery: v.optional(
      v.literal("retry_with_shorter_generation_budget")
    ),
    workDurationMs: v.optional(v.number()),
    timingReceipt: v.optional(vRunTimingReceipt),
  },
  markGenerationRunAborted: {
    messageId: v.optional(v.id("messages")),
    reason: v.optional(v.string()),
    workDurationMs: v.optional(v.number()),
    timingReceipt: v.optional(vRunTimingReceipt),
    // Cancellation terminal-usage evidence (ADR-0021 cancellation
    // amendment): completed-step aggregates, partial-output estimate, and
    // title attempt facts, settled atomically when this worker still owns
    // the run. Optional when the turn has no platform reservation evidence.
    terminalUsage: v.optional(vTerminalUsageEvidence),
  },
  // The lease heartbeat carries no payload beyond the run identity
  // the wire adds; the server clock is authoritative.
  heartbeatGenerationRun: {},
  // Settlement-only terminal-usage receipt (ADR-0021 cancellation
  // amendment). UNLIKE every op above, this one does NOT authenticate
  // against the run's execution grant — a Stop/supersession revoked that —
  // but against the settlement digest the Stop transaction copied onto the
  // reservation. It can settle or release allowance for exactly this
  // run/reservation pair and nothing else.
  finalizeTerminalUsage: {
    reservationId: v.id("usageReservations"),
    terminalUsage: vTerminalUsageEvidence,
  },
  // Run timing receipt attach (ADR-0030). Like finalizeTerminalUsage, this
  // authenticates against a digest the absorbing terminal copied onto the run
  // (`timingReceiptGrantDigest`), not the revoked grant — see
  // chatRuntimeWorker. Content-free diagnostics only; it can patch nothing
  // but the receipt.
  attachRunTimingReceipt: {
    timingReceipt: vRunTimingReceipt,
  },
}

const vStoredMessage = v.object({
  id: v.string(),
  role: v.literal("user"),
  content: v.optional(v.string()),
  parts: v.any(),
})

const vEditIntent = v.object({
  editedMessageId: v.string(),
  editCutoffTimestamp: v.number(),
  expectedChatVersion: v.number(),
  replacementMessage: v.object({
    id: v.string(),
    role: v.literal("user"),
    content: v.string(),
    parts: v.any(),
  }),
  regenerateTitle: v.optional(v.boolean()),
})

const vRegenerationIntent = v.object({
  targetAssistantMessageId: v.string(),
  targetAssistantCreatedAt: v.number(),
  expectedChatVersion: v.number(),
  precedingUserMessageId: v.string(),
})

const vApprovalResponse = v.object({
  messageId: v.string(),
  approvalId: v.string(),
  toolCallId: v.string(),
  toolName: v.string(),
  approved: v.boolean(),
  reason: v.optional(v.string()),
})

type ApprovalResponse = {
  approved: boolean
  reason?: string
}

type StoredApprovalDecision = {
  status: "pending" | "approved" | "denied" | "expired"
  reason?: string
}

type CanonicalApprovalDecision = {
  status: "approved" | "denied"
  approved: boolean
  reason?: string
}

const ACTIVE_RUN_SCAN_LIMIT = 50

/**
 * Execution-grant lifetime (ADR-0011), budget-derived from route max,
 * settlement reserve, and slack. Must comfortably exceed the
 * longest legitimate turn plus settlement retries; it bounds how long a leaked
 * digest preimage could authorize idempotent worker writes. Expiry is the
 * backstop revocation; absorbing terminal transitions (aborted/failed) also
 * clear the grant fields eagerly via `applyLifecycleVerdict`.
 */
export const EXECUTION_GRANT_TTL_MS = CHAT_TURN_EXECUTION_BUDGET.grantTtlMs

const terminalToolInvocationStatuses = new Set<
  Doc<"toolInvocations">["status"]
>(["denied", "completed", "failed"])

/**
 * Absorbing terminal outcomes (`aborted`, `failed`) also revoke the execution
 * grant eagerly — nothing may overwrite them, so the grant authorizes nothing
 * but rejections from here on. `completed` keeps its
 * grant while the deliberate fail-over-completed convergence exists: the
 * fire-and-forget failure write must still land after a spurious completion.
 * `awaiting_approval` is a pause, not a settlement — the pausing worker's
 * final flush and completion downgrade still need the grant.
 */
function grantRevocationForStatus(
  status: GenerationRunStatus
): Partial<Doc<"generationRuns">> {
  return status === "aborted" || status === "failed"
    ? { grantDigest: undefined, grantExpiresAt: undefined }
    : {}
}

/**
 * Receipt-attach capability (ADR-0030). An absorbing terminal that revokes
 * the run grant WITHOUT carrying a Run timing receipt (user Stop,
 * supersession, reap) copies the grant digest onto the run for a bounded
 * window, so the stopped worker's later `attachRunTimingReceipt` —
 * authenticated against this copy, never the revoked grant — can still land
 * the receipt its own abort write would have carried. Single-use: the attach
 * clears it. A terminal that carries its receipt mints nothing.
 */
function timingReceiptAttachGrant(
  run: Doc<"generationRuns">,
  status: GenerationRunStatus,
  receipt: RunTimingReceipt | undefined,
  now: number
): Partial<Doc<"generationRuns">> {
  if (receipt || !run.grantDigest) return {}
  if (status !== "aborted" && status !== "failed") return {}
  return {
    timingReceiptGrantDigest: run.grantDigest,
    timingReceiptGrantExpiresAt: now + TIMING_RECEIPT_ATTACH_WINDOW_MS,
  }
}

/**
 * Lease fields clear at every terminal transition and at the approval pause:
 * a paused run is lease-free, so its liveness is the
 * pending unexpired approval, not a heartbeat.
 */
const LEASE_CLEAR: Partial<Doc<"generationRuns">> = {
  heartbeatAt: undefined,
  leaseExpiresAt: undefined,
}

function truncatePreview(value: unknown): string | undefined {
  if (value === undefined) return undefined
  let text: string
  if (typeof value === "string") {
    text = value
  } else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  if (text.length <= MAX_PREVIEW_LENGTH) return text
  return `${text.slice(0, MAX_PREVIEW_LENGTH)}...`
}

function nowMs(): number {
  return Date.now()
}

function isAssistantMessageLinkedToRun(
  message: Doc<"messages">,
  run: Doc<"generationRuns">
): boolean {
  return (
    message.generationRunId === run._id ||
    run.assistantMessageId === message._id ||
    run.activeStreamId === message._id
  )
}

async function requireAssistantMessageForRun(
  ctx: MutationCtx,
  run: Doc<"generationRuns">,
  messageId: Id<"messages">
): Promise<Doc<"messages">> {
  const message = await ctx.db.get(messageId)
  if (
    !message ||
    message.chatId !== run.chatId ||
    message.role !== "assistant" ||
    !isAssistantMessageLinkedToRun(message, run)
  ) {
    throw new Error("Assistant message not found for run")
  }
  return message
}

async function listMessages(ctx: QueryCtx | MutationCtx, chatId: Id<"chats">) {
  return await ctx.db
    .query("messages")
    .withIndex("by_chat_order", (q) => q.eq("chatId", chatId))
    .collect()
}

function findMessageByUiId(
  messages: Doc<"messages">[],
  messageId: string
): Doc<"messages"> | undefined {
  return messages.find(
    (message) =>
      message._id === messageId || message.clientMessageId === messageId
  )
}

function findMessageIndexByUiId(
  messages: Doc<"messages">[],
  messageId: string
): number {
  return messages.findIndex(
    (message) =>
      message._id === messageId || message.clientMessageId === messageId
  )
}

/**
 * Selected-path derivation for runtime consumers: one context serves the
 * whole call.
 */
function getSelectedPath(messages: Doc<"messages">[]) {
  return getSelectedPathMessagesFromContext(createBranchContext(messages))
}

function getVisibleSelectedMessages(messages: Doc<"messages">[]) {
  return getSelectedPath(messages).filter(isVisibleChatMessage)
}

function selectedMessagesMatchToken(
  selectedMessages: Doc<"messages">[],
  token: Required<Pick<SelectedPathToken, "expectedVisibleMessageCount">> &
    Pick<SelectedPathToken, "tailMessageId">
) {
  if (selectedMessages.length !== token.expectedVisibleMessageCount) {
    return false
  }

  const tailMessage = selectedMessages[selectedMessages.length - 1]
  const actualTailMessageId = tailMessage?._id

  return (
    token.tailMessageId === undefined ||
    actualTailMessageId === token.tailMessageId
  )
}

function validateSelectedPathToken(
  messages: Doc<"messages">[],
  token: SelectedPathToken
) {
  if (token.expectedVisibleMessageCount === undefined) {
    throw new Error("Selected path token required")
  }

  const selectedMessages = getVisibleSelectedMessages(messages)
  const requiredToken = {
    expectedVisibleMessageCount: token.expectedVisibleMessageCount,
    tailMessageId: token.tailMessageId,
  }

  if (selectedMessagesMatchToken(selectedMessages, requiredToken)) return

  const selectedMessagesBeforeTerminalStubs = selectedMessages.filter(
    (message) => !isTerminalOutcomeStub(message)
  )
  if (
    selectedMessagesBeforeTerminalStubs.length !== selectedMessages.length &&
    selectedMessagesMatchToken(
      selectedMessagesBeforeTerminalStubs,
      requiredToken
    )
  ) {
    return
  }

  throw new Error("Stale chat state: selected path changed")
}

async function validateSelectedPathTokenForChat(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  token: SelectedPathToken
) {
  validateSelectedPathToken(await listMessages(ctx, chatId), token)
}

// Resolves the semantic sibling an empty terminal placeholder reverts to,
// preferring the branch a regeneration forked from (regenerationSourceMessageId),
// else the latest. Pure over the messages array — the Generation run lifecycle
// consumes only the precomputed id, so branch logic stays out of the module.
function resolveFallbackSibling(
  messages: Doc<"messages">[],
  message: Doc<"messages">
): Id<"messages"> | null {
  const context = createBranchContext(messages)
  const parentMessageId = getEffectiveParentIdFromContext(context, message)
  const semanticSiblings = getSiblingMessagesFromContext(
    context,
    parentMessageId,
    message.role
  ).filter(
    (sibling) =>
      sibling._id !== message._id && hasSemanticAssistantParts(sibling)
  )
  const fallbackSibling =
    semanticSiblings.find(
      (sibling) => sibling._id === message.regenerationSourceMessageId
    ) ?? semanticSiblings.at(-1)
  return fallbackSibling?._id ?? null
}

// The assistant message a terminal transition resolves against, plus the facts
// the Generation run lifecycle needs. `messages` is the chat's message list,
// loaded only when the message is empty (matching the pre-extraction lazy read)
// and reused by delete-and-reselect so it is never read twice.
type ResolvedAssistantMessage = {
  message: Doc<"messages">
  messages: Doc<"messages">[] | null
  facts: AssistantMessageFacts
}

// Gather-phase counterpart to the module's resolve: reads the target message
// (messageId ?? run.assistantMessageId ?? run.activeStreamId), validates
// chatId/role linkage, and builds the AssistantMessageFacts. Returns null when
// no linked assistant message resolves — the module then treats the message half
// as a no-op and the run keeps its existing assistantMessageId.
async function gatherAssistantMessageFacts(
  ctx: MutationCtx,
  run: Doc<"generationRuns">,
  messageId?: Id<"messages">
): Promise<ResolvedAssistantMessage | null> {
  const activeStreamMessageId =
    run.activeStreamId === undefined
      ? null
      : ctx.db.normalizeId("messages", run.activeStreamId)
  const resolvedMessageId =
    messageId ?? run.assistantMessageId ?? activeStreamMessageId
  if (!resolvedMessageId) return null

  const message = await ctx.db.get(resolvedMessageId)
  // Linkage is required, not just chat membership: a caller-supplied messageId
  // naming a DIFFERENT assistant message in the same chat (a confused or
  // malicious worker payload) must not let markGenerationRunFailed/-Aborted
  // stamp that message with this run's terminal outcome. An unlinked target
  // resolves like a missing one — the run half still settles; the message half
  // is a no-op.
  if (
    !message ||
    message.chatId !== run.chatId ||
    message.role !== "assistant" ||
    !isAssistantMessageLinkedToRun(message, run)
  ) {
    return null
  }

  const isReusedForRegeneration =
    typeof run.startedAt === "number" && message.createdAt < run.startedAt
  // Projected-output invariant: `lastSnapshotSequence` is patched in the same
  // mutation as every accepted checkpoint (both branches of
  // updateAssistantSnapshotForChat) and sequences start at 1, so `> 0` is
  // equivalent to "at least one accepted checkpoint for this run".
  const hasSnapshotForRun = isReusedForRegeneration
    ? (run.lastSnapshotSequence ?? 0) > 0
    : false

  const hasSemanticParts = hasSemanticAssistantParts(message)
  let messages: Doc<"messages">[] | null = null
  let fallbackSiblingId: Id<"messages"> | null = null
  if (!hasSemanticParts) {
    messages = await listMessages(ctx, message.chatId)
    fallbackSiblingId = resolveFallbackSibling(messages, message)
  }

  return {
    message,
    messages,
    facts: {
      hasSemanticParts,
      isReusedForRegeneration,
      hasSnapshotForRun,
      fallbackSiblingId,
    },
  }
}

// Applies the message half of a verdict. Returns the surviving assistant message
// id, or undefined when the empty placeholder was deleted.
async function applyMessageResolution(
  ctx: MutationCtx,
  message: Doc<"messages">,
  resolution: MessageResolution,
  messages: Doc<"messages">[] | null,
  now: number
): Promise<Id<"messages"> | undefined> {
  switch (resolution.kind) {
    case "none":
      return message._id
    case "restore-completed":
      await ctx.db.patch(message._id, {
        status: "completed",
        error: undefined,
        errorRecovery: undefined,
        updatedAt: now,
      })
      return message._id
    case "stamp":
    case "keep-stub":
      await ctx.db.patch(message._id, {
        status: resolution.status,
        error: resolution.error,
        errorRecovery: undefined,
        updatedAt: now,
      })
      return message._id
    case "delete-and-reselect": {
      // Only re-select when the placeholder was the selected branch.
      if (message.selected === true && messages) {
        const sibling = messages.find(
          (candidate) => candidate._id === resolution.siblingId
        )
        if (sibling) {
          await createMessageBranchWriter(ctx, {
            chatId: message.chatId,
            now,
          }).select(sibling._id)
        }
      }
      await ctx.db.delete(message._id)
      return undefined
    }
  }
}

// Sidebar status projection — mirror a run's lifecycle phase onto its chat doc
// so every sidebar row derives its indicator from the chat it already subscribes
// to, with no separate query/store/hydrator
// (CONTEXT.md "Sidebar status projection"). These fields are owner-only;
// chats.getById/getPublicById strip them from non-owner reads.
//
// `queued`/`running`/`streaming` map to the live spinner (only the run-start
// claim ever writes them, inline below — `queued` is never persisted); the
// terminal arms clear the live phase, and `completed`/`failed` also stamp the
// Phase-2 mirror. Patching `liveRunStatus: undefined` removes the field (Convex
// `patch` semantics) — that is the "clear."
function chatStatusProjection(
  status: GenerationRunStatus,
  now: number
): Partial<Doc<"chats">> {
  switch (status) {
    case "queued":
    case "running":
    case "streaming":
      return { liveRunStatus: "streaming" }
    case "awaiting_approval":
      // The approval-pause handler stamps liveRunFreshUntil = approval expiry
      // itself (it knows the deadline); the projection leaves it alone.
      return { liveRunStatus: "awaiting" }
    case "completed":
      return {
        liveRunStatus: undefined,
        liveRunFreshUntil: undefined,
        lastRunEndedAt: now,
        lastRunStatus: "completed",
      }
    case "failed":
      return {
        liveRunStatus: undefined,
        liveRunFreshUntil: undefined,
        lastRunEndedAt: now,
        lastRunStatus: "failed",
      }
    case "aborted":
      // User Stop / supersede — no signal; only clear the live phase.
      return { liveRunStatus: undefined, liveRunFreshUntil: undefined }
  }
}

// Run-scoped guard: only the run that OWNS the chat's status slot (statusRunId)
// may project. statusRunId is KEPT after a terminal, so a same-run
// completed→failed convergence still applies; an OLDER run's late terminal is a
// no-op once a newer run has claimed the slot. Convex mutations are
// transactional, so this read-guard-then-patch is race-free.
async function projectRunStatusToChat(
  ctx: MutationCtx,
  run: Doc<"generationRuns">,
  status: GenerationRunStatus,
  now: number,
  // Extra owner-guarded chat fields riding the same projection write (the
  // approval pause stamps liveRunFreshUntil = approval expiry here).
  extra?: Partial<Doc<"chats">>
) {
  const chat = await ctx.db.get(run.chatId)
  if (
    !chat ||
    chat.statusRunId !== run._id ||
    !(await isChatActive(ctx, chat))
  ) {
    return // a newer run or deleting logical root owns the row → skip
  }
  await ctx.db.patch(run.chatId, {
    ...chatStatusProjection(status, now),
    ...extra,
  })
}

// Applies a transition verdict for the terminal-close paths (fail/abort/
// supersede): the message half (stamp / keep-stub / delete + reselect /
// restore-completed), then the run's shared terminal field set. Returns the
// resulting assistantMessageId (undefined when the linked placeholder was
// deleted). Call sites that write extra run fields keep them: completed's
// usage/toolCounts and approval-requested's minimal pause patch the run
// directly rather than routing through here.
async function applyLifecycleVerdict(
  ctx: MutationCtx,
  run: Doc<"generationRuns">,
  verdict: Extract<LifecycleVerdict, { kind: "transition" }>,
  resolved: ResolvedAssistantMessage | null,
  now: number,
  explicitWorkDurationMs?: number,
  terminalUsage?: TerminalUsageEvidencePayload,
  timingReceipt?: RunTimingReceipt
): Promise<Id<"messages"> | undefined> {
  // The accounting hooks below read PRE-terminal run facts (grant digest,
  // usage, boundary markers). Snapshot them before the terminal patch so the
  // grant revocation can never race the settlement-capability copy.
  const preTerminalRun: Doc<"generationRuns"> = { ...run }
  const workDurationMs = resolveWorkDurationMs(run, now, explicitWorkDurationMs)
  const receipt = sanitizeRunTimingReceipt(timingReceipt)
  let assistantMessageId = run.assistantMessageId
  if (resolved) {
    const survivingId = await applyMessageResolution(
      ctx,
      resolved.message,
      verdict.message,
      resolved.messages,
      now
    )
    assistantMessageId =
      survivingId ??
      (run.assistantMessageId === resolved.message._id
        ? undefined
        : run.assistantMessageId)

    if (survivingId && workDurationMs !== undefined) {
      await ctx.db.patch(survivingId, {
        metadata: {
          ...(resolved.message.metadata ?? {}),
          workDurationMs,
        },
      })
    }
  }

  await ctx.db.patch(run._id, {
    status: verdict.run.status,
    error: verdict.run.error,
    completedAt: verdict.run.settle ? now : undefined,
    updatedAt: now,
    ...(verdict.run.clearActiveStream ? { activeStreamId: undefined } : {}),
    ...(verdict.run.terminalReason
      ? { terminalReason: verdict.run.terminalReason }
      : {}),
    ...grantRevocationForStatus(verdict.run.status),
    ...LEASE_CLEAR,
    assistantMessageId,
    ...(workDurationMs !== undefined ? { workDurationMs } : {}),
    ...(receipt ? { timingReceipt: receipt } : {}),
    ...timingReceiptAttachGrant(run, verdict.run.status, receipt, now),
  })

  // Mirror the terminal phase onto the chat row (fail/abort/supersede all reach
  // here). Guarded by statusRunId, so a superseded/older run can't clear a newer
  // run's live spinner.
  await projectRunStatusToChat(ctx, run, verdict.run.status, now)

  // Allowance accounting rides the SAME transaction as the terminal commit
  // (ADR-0021): every lifecycle-verdict terminal (fail/abort/stop/supersede/
  // lease-expired/approval-expired/continuation-lost) applies the provider-
  // boundary rule — release before provider work structurally began, settle
  // observed or estimated usage after. Idempotent; BYOK/anonymous runs have
  // no reservation and no-op structurally.
  //
  // Cancellation amendment: a user Stop or supersession carries no usage
  // evidence by design, so instead of settling here it marks the reservation
  // accounting-pending — the stopped worker's settlement-only receipt or the
  // deadline reconciler finalizes from real evidence. The visible run is
  // already `aborted` above; only the reservation defers.
  if (verdict.run.settle) {
    const reason = verdict.run.terminalReason
    const deferred =
      (reason === "user_stop" || reason === "superseded") &&
      (await deferUsageSettlementForTerminalRun(ctx, preTerminalRun, reason, now))
    if (!deferred) {
      await settleUsageForTerminalRun(
        ctx,
        preTerminalRun,
        terminalUsage ? { terminal: terminalUsage } : {},
        verdict.run.terminalReason ?? verdict.run.status,
        verdict.run.terminalReason
      )
    }
  }

  return assistantMessageId
}

function resolveWorkDurationMs(
  run: Doc<"generationRuns">,
  now: number,
  explicit?: number
): number | undefined {
  if (explicit !== undefined && Number.isFinite(explicit)) {
    return Math.max(0, explicit)
  }
  // Only a worker-executing run has an active provider segment. Completion
  // freezes workDurationMs before an approval pause, so later Stop/reaper
  // settlement must not add the human wait from the retained start marker.
  if (run.workStartedAt === undefined || !isWorkerExecutingStatus(run.status)) {
    return run.workDurationMs
  }
  return (
    Math.max(0, run.workDurationMs ?? 0) + Math.max(0, now - run.workStartedAt)
  )
}

export async function closeSupersededGenerationsForChat(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  userId: Id<"users">,
  now: number
) {
  const runs = await ctx.db
    .query("generationRuns")
    .withIndex("by_chat_updated", (q) => q.eq("chatId", chatId))
    .order("desc")
    .take(ACTIVE_RUN_SCAN_LIMIT)

  const supersededRunIds = new Set<Id<"generationRuns">>()
  const supersededMessageIds = new Set<Id<"messages">>()
  const reason = "superseded by a new generation"

  for (const run of runs) {
    // Fast-path pre-filter with the lifecycle predicate. The supersede resolve
    // below is authoritative, but gathering facts for every run in the scan
    // window (most already terminal) would be wasteful — same predicate, same
    // answer, so a non-supersedable run never reaches the gather.
    if (!isSupersedableGenerationRunStatus(run.status)) continue
    if (run.userId !== undefined && run.userId !== userId) continue

    const resolved = await gatherAssistantMessageFacts(ctx, run, undefined)
    const verdict = resolveGenerationRunTransition(
      { runStatus: run.status, message: resolved?.facts ?? null },
      { kind: "supersede", reason }
    )
    if (verdict.kind === "ignore") continue

    supersededRunIds.add(run._id)
    const assistantMessageId = await applyLifecycleVerdict(
      ctx,
      run,
      verdict,
      resolved,
      now
    )
    if (assistantMessageId) supersededMessageIds.add(assistantMessageId)
  }

  const assistantMessages = await ctx.db
    .query("messages")
    .withIndex("by_chat_role", (q) =>
      q.eq("chatId", chatId).eq("role", "assistant")
    )
    .collect()

  for (const message of assistantMessages) {
    if (supersededMessageIds.has(message._id)) continue
    // Terminal statuses are settled turns — completed answers and first-class
    // failed/aborted stubs alike. The sweep must not delete or restate them;
    // it only closes out messages a live-looking run left behind.
    if (!isSupersedableMessageStatus(message.status)) continue

    // Orphan messages whose run fell outside the scan window: the terminal
    // policy runs with no reused-regeneration restore (there is no run in hand
    // to date the message against), so an empty message keeps/deletes and a
    // semantic one is stamped aborted — the pre-extraction split, unchanged.
    const hasSemantic = hasSemanticAssistantParts(message)
    let orphanMessages: Doc<"messages">[] | null = null
    let fallbackSiblingId: Id<"messages"> | null = null
    if (!hasSemantic) {
      orphanMessages = await listMessages(ctx, chatId)
      fallbackSiblingId = resolveFallbackSibling(orphanMessages, message)
    }
    const supersededMessageId = await applyMessageResolution(
      ctx,
      message,
      resolveTerminalAssistantMessageResolution(
        {
          hasSemanticParts: hasSemantic,
          isReusedForRegeneration: false,
          hasSnapshotForRun: false,
          fallbackSiblingId,
        },
        { status: "aborted", error: reason }
      ),
      orphanMessages,
      now
    )

    if (
      message.generationRunId &&
      !supersededRunIds.has(message.generationRunId)
    ) {
      const run = await ctx.db.get(message.generationRunId)
      if (run && run.chatId === chatId) {
        // The message half was already resolved above; the run closes via the
        // lifecycle's supersede rule like the in-window runs, with message:null
        // so the verdict does not restate it.
        const verdict = resolveGenerationRunTransition(
          { runStatus: run.status, message: null },
          { kind: "supersede", reason }
        )
        if (verdict.kind === "transition") {
          // Pre-terminal snapshot for the accounting hooks (see
          // applyLifecycleVerdict): the patch below revokes the grant the
          // deferral must copy.
          const preTerminalRun: Doc<"generationRuns"> = { ...run }
          await ctx.db.patch(run._id, {
            status: verdict.run.status,
            error: verdict.run.error,
            completedAt: verdict.run.settle ? now : undefined,
            updatedAt: now,
            activeStreamId: undefined,
            ...(verdict.run.terminalReason
              ? { terminalReason: verdict.run.terminalReason }
              : {}),
            ...grantRevocationForStatus(verdict.run.status),
            // Same receipt-attach capability as the in-window supersede
            // (ADR-0030): this run's worker may still be live and needs it to
            // land its partial receipt after the grant above is revoked.
            ...timingReceiptAttachGrant(
              run,
              verdict.run.status,
              undefined,
              now
            ),
            ...LEASE_CLEAR,
            assistantMessageId: supersededMessageId,
          })
          if (verdict.run.settle) {
            // Same deferral as the in-window supersede: cancellation-like
            // terminals mark accounting pending instead of settling blind.
            const deferred =
              verdict.run.terminalReason === "superseded" &&
              (await deferUsageSettlementForTerminalRun(
                ctx,
                preTerminalRun,
                "superseded",
                now
              ))
            if (!deferred) {
              await settleUsageForTerminalRun(
                ctx,
                preTerminalRun,
                {},
                "superseded",
                verdict.run.terminalReason
              )
            }
          }
        }
      }
    }
  }
}

type StoredUserMessage = {
  id: string
  role: "user"
  content?: string
  parts: unknown
}

type GenerationEditIntent = {
  editedMessageId: string
  editCutoffTimestamp: number
  expectedChatVersion: number
  replacementMessage: StoredUserMessage & { content: string }
  regenerateTitle?: boolean
}

type GenerationRegenerationIntent = {
  targetAssistantMessageId: string
  targetAssistantCreatedAt: number
  expectedChatVersion: number
  precedingUserMessageId: string
}

type SelectedPathToken = {
  expectedVisibleMessageCount?: number
  tailMessageId?: string
}

// The selected path token is validated by the caller BEFORE the supersede
// sweep runs (prepareGenerationForChat) — the token describes the client's
// rendered view, and the sweep may legitimately materialize a terminal stub
// the client could not have counted yet. Re-validating here after the sweep
// falsely rejected the first send following a reaped zombie run.
async function selectOrInsertLatestUserMessageForGeneration(
  ctx: MutationCtx,
  owner: AuthenticatedChatOwner,
  args: {
    requestId: string
    model: string
    provider: string
  },
  latestUserMessage: StoredUserMessage,
  now: number
) {
  const message = await createMessageBranchWriter(ctx, {
    chatId: owner.chat._id,
    now,
  }).writeUserMessage({
    clientMessageId: latestUserMessage.id,
    userId: owner.user._id,
    content:
      latestUserMessage.content ??
      extractTextFromMessageParts(latestUserMessage.parts),
    parts: latestUserMessage.parts,
    requestId: args.requestId,
    model: args.model,
    provider: args.provider,
  })
  return message._id
}

export async function applyRegenerationIntentForGeneration(
  ctx: MutationCtx,
  owner: AuthenticatedChatOwner,
  args: {
    requestId: string
    model: string
    provider: string
    runId: Id<"generationRuns">
    regeneration: GenerationRegenerationIntent
  },
  now: number
) {
  const currentMessages = await listMessages(ctx, owner.chat._id)
  const regenerationPlan = resolveRegenerationInputPlan(
    currentMessages,
    args.regeneration
  )

  await denyPendingApprovalsForChat(
    ctx,
    owner.chat._id,
    owner.user._id,
    "auto-denied: new generation started"
  )

  const assistantMessage = await createMessageBranchWriter(ctx, {
    chatId: owner.chat._id,
    now,
  }).writeAssistantPlaceholder({
    generationRunId: args.runId,
    requestId: args.requestId,
    model: args.model,
    provider: args.provider,
    replaces: regenerationPlan.targetMessage._id,
  })
  const assistantMessageId = assistantMessage._id

  return {
    assistantMessageId,
    messages: regenerationPlan.messages,
  }
}

function resolveRegenerationInputPlan(
  currentMessages: Doc<"messages">[],
  regeneration: GenerationRegenerationIntent
) {
  // Guard contract: count the RAW projection — the same derivation the
  // client read (messages.ts) rendered from — deliberately un-normalized.
  // Normalization happens inside the Message branch writer AFTER this guard;
  // a normalize-before-guard pass is the "falsely rejected after a rapid
  // multi-branch session" bug class.
  const selectedMessages = getVisibleSelectedMessages(currentMessages)
  if (selectedMessages.length !== regeneration.expectedChatVersion) {
    throw new Error("Chat changed since regeneration started")
  }

  const targetIndex = findMessageIndexByUiId(
    selectedMessages,
    regeneration.targetAssistantMessageId
  )
  if (targetIndex === -1) throw new Error("Regeneration target not found")

  const targetMessage = selectedMessages[targetIndex]
  if (!targetMessage || targetMessage.role !== "assistant") {
    throw new Error("Regeneration target must be an assistant message")
  }

  if (targetMessage.createdAt !== regeneration.targetAssistantCreatedAt) {
    throw new Error("Regeneration target version changed")
  }

  // Regeneration may target any assistant on the selected path, not just the
  // tail. A mid-conversation regen forks at the target's parent: the branch
  // writes below insert a new selected sibling and deselect the old subtree,
  // and the client renders the fork via the selected-path projection seam.
  // See CONTEXT.md "Chat turn" (edit/regenerate may target any prior message).
  let pairedUserIndex = -1
  for (let index = targetIndex - 1; index >= 0; index--) {
    if (selectedMessages[index]?.role === "user") {
      pairedUserIndex = index
      break
    }
  }
  if (pairedUserIndex === -1) {
    throw new Error("Regeneration preceding user message not found")
  }

  const requestedPrecedingUser = findMessageByUiId(
    selectedMessages,
    regeneration.precedingUserMessageId
  )
  const pairedUser = selectedMessages[pairedUserIndex]
  if (
    !requestedPrecedingUser ||
    !pairedUser ||
    requestedPrecedingUser.role !== "user" ||
    requestedPrecedingUser._id !== pairedUser._id
  ) {
    throw new Error("Regeneration preceding user message mismatch")
  }

  return {
    targetMessage,
    messages: projectModelHistoryMessages(
      selectedMessages.slice(0, pairedUserIndex + 1)
    ),
  }
}

export async function applyEditIntentForGeneration(
  ctx: MutationCtx,
  owner: AuthenticatedChatOwner,
  args: {
    requestId: string
    model: string
    provider: string
    edit: GenerationEditIntent
  },
  now: number
): Promise<number | undefined> {
  const currentMessages = await listMessages(ctx, owner.chat._id)
  const editPlan = resolveEditInputPlan(currentMessages, args.edit)

  await createMessageBranchWriter(ctx, {
    chatId: owner.chat._id,
    now,
  }).writeUserMessage({
    clientMessageId: args.edit.replacementMessage.id,
    userId: owner.user._id,
    content: args.edit.replacementMessage.content,
    parts: args.edit.replacementMessage.parts,
    requestId: args.requestId,
    model: args.model,
    provider: args.provider,
    replaces: editPlan.editedMessage?._id,
  })

  if (
    args.edit.regenerateTitle &&
    editPlan.isEditingFirstSelectedUserMessage &&
    owner.chat.titleSource !== "user"
  ) {
    const titleGeneration = (owner.chat.titleGeneration ?? 0) + 1
    await ctx.db.patch(owner.chat._id, {
      title: "New chat",
      titleSource: "provisional",
      titleGeneration,
    })
    return titleGeneration
  }

  return undefined
}

function resolveEditInputPlan(
  currentMessages: Doc<"messages">[],
  edit: GenerationEditIntent
) {
  // Same guard contract as the regeneration guard above: raw projection,
  // matching the client's rendered count; never normalize before guarding.
  const selectedMessages = getVisibleSelectedMessages(currentMessages)
  if (selectedMessages.length !== edit.expectedChatVersion) {
    throw new Error("Chat changed since edit started")
  }

  const editedMessage = findMessageByUiId(
    selectedMessages,
    edit.editedMessageId
  )
  const replacementMessage = currentMessages.find(
    (message) =>
      message.role === "user" &&
      message.clientMessageId === edit.replacementMessage.id
  )

  if (!editedMessage && !replacementMessage) {
    throw new Error("Edited message not found")
  }

  if (editedMessage && editedMessage.role !== "user") {
    throw new Error("Edited message must be a user message")
  }

  if (editedMessage && editedMessage.createdAt !== edit.editCutoffTimestamp) {
    throw new Error("Edited message version changed")
  }

  const firstSelectedUserMessage = selectedMessages.find(
    (message) => message.role === "user"
  )
  const isEditingFirstSelectedUserMessage =
    editedMessage !== undefined &&
    firstSelectedUserMessage?._id === editedMessage._id

  return {
    selectedMessages,
    editedMessage,
    replacementMessage,
    isEditingFirstSelectedUserMessage,
  }
}

function applyApprovalResponseToParts(
  parts: unknown,
  response: {
    approvalId: string
    toolCallId: string
    approved: boolean
    reason?: string
  }
): unknown {
  if (!Array.isArray(parts)) return parts

  return parts.map((part) => {
    if (!part || typeof part !== "object") return part
    const record = part as Record<string, unknown>
    if (record.toolCallId !== response.toolCallId) return part
    const approval = record.approval
    const approvalRecord =
      approval && typeof approval === "object"
        ? (approval as Record<string, unknown>)
        : null
    if (approvalRecord?.id !== response.approvalId) return part

    return {
      ...record,
      state: "approval-responded",
      approval: {
        id: response.approvalId,
        approved: response.approved,
        ...(response.reason ? { reason: response.reason } : {}),
      },
    }
  })
}

export function resolveCanonicalApprovalDecision(
  approval: StoredApprovalDecision,
  response: ApprovalResponse
): CanonicalApprovalDecision {
  // Rejections here are branded so the HTTP boundary answers with an
  // intentional 409 contract instead of redacting an unbranded Error to 500.
  // Expired and divergent decisions are CONTINUATION CONFLICTS — a winner
  // exists and this tab observes it through the projection, so the client
  // swallows them. A still-pending approval is NOT a conflict: no decision
  // ever landed (the resolve mutation failed or was skipped), nothing will
  // repaint, and the user must be told to decide again — its distinct brand
  // keeps it out of the client's swallow path.
  if (approval.status === "pending") {
    throw new ConvexError({
      code: "approval_unresolved",
      message: "Approval has not been resolved",
    })
  }
  if (approval.status === "expired") {
    throw new ConvexError({
      code: "approval_continuation_conflict",
      message: "Approval has expired",
    })
  }

  const approved = approval.status === "approved"
  if (response.approved !== approved) {
    throw new ConvexError({
      code: "approval_continuation_conflict",
      message: "Approval response does not match stored approval decision",
    })
  }

  return {
    status: approval.status,
    approved,
    reason: approval.reason,
  }
}

export async function denyPendingApprovalsForChat(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  userId: Id<"users">,
  reason: string
) {
  const pending = await ctx.db
    .query("toolApprovalRequests")
    .withIndex("by_chat_status", (q) =>
      q.eq("chatId", chatId).eq("status", "pending")
    )
    .collect()
  const now = nowMs()

  for (const request of pending) {
    if (request.userId !== userId) continue
    const run = await ctx.db.get(request.runId)
    const assistantMessages = await ctx.db
      .query("messages")
      .withIndex("by_chat_role", (q) =>
        q.eq("chatId", chatId).eq("role", "assistant")
      )
      .collect()
    const associatedMessages = assistantMessages.filter(
      (message) =>
        message._id === request.assistantMessageId ||
        message.generationRunId === request.runId
    )
    const invocationCandidates = await ctx.db
      .query("toolInvocations")
      .withIndex("by_run_tool_call", (q) =>
        q.eq("runId", request.runId).eq("toolCallId", request.toolCallId)
      )
      .collect()
    const runInvocations = await ctx.db
      .query("toolInvocations")
      .withIndex("by_run", (q) => q.eq("runId", request.runId))
      .collect()
    const invocationIds = new Set<Id<"toolInvocations">>()
    const associatedInvocations = [
      ...invocationCandidates,
      ...runInvocations,
    ].filter((invocation) => {
      if (invocationIds.has(invocation._id)) return false
      if (invocation.chatId !== chatId) return false
      const isAssociated =
        invocation.toolCallId === request.toolCallId ||
        invocation.approvalId === request._id ||
        invocation.approvalRequestId === request.approvalId
      if (!isAssociated) return false
      invocationIds.add(invocation._id)
      return true
    })

    await ctx.db.patch(request._id, {
      status: "denied",
      resolvedAt: now,
      resolvedByUserId: userId,
      reason,
    })

    for (const message of associatedMessages) {
      await ctx.db.patch(message._id, {
        parts: applyApprovalResponseToParts(message.parts, {
          approvalId: request.approvalId,
          toolCallId: request.toolCallId,
          approved: false,
          reason,
        }),
        ...(!isTerminalMessageStatus(message.status)
          ? { status: "aborted" as const, error: reason }
          : {}),
        updatedAt: now,
      })
    }

    for (const invocation of associatedInvocations) {
      if (terminalToolInvocationStatuses.has(invocation.status)) continue
      await ctx.db.patch(invocation._id, {
        status: "denied",
        approvalId: request._id,
        approvalRequestId: request.approvalId,
        completedAt: now,
        updatedAt: now,
      })
    }

    if (
      run &&
      run.chatId === chatId &&
      (run.userId === undefined || run.userId === userId)
    ) {
      // The run closes via the Generation run lifecycle's `abort` rule (a run
      // already terminal is left settled). Only the run patch routes through the
      // module — the message parts/status writes are the per-message loop above.
      const verdict = resolveGenerationRunTransition(
        { runStatus: run.status, message: null },
        { kind: "abort", reason }
      )
      if (verdict.kind === "transition") {
        await ctx.db.patch(request.runId, {
          status: verdict.run.status,
          error: verdict.run.error,
          completedAt: verdict.run.settle ? now : undefined,
          updatedAt: now,
          activeStreamId: undefined,
          ...(verdict.run.terminalReason
            ? { terminalReason: verdict.run.terminalReason }
            : {}),
          ...grantRevocationForStatus(verdict.run.status),
          ...LEASE_CLEAR,
        })
        if (verdict.run.settle) {
          await settleUsageForTerminalRun(
            ctx,
            run,
            {},
            "approvals_denied",
            verdict.run.terminalReason
          )
        }
      }
    }
  }
}

export async function applyApprovalResponses(
  ctx: MutationCtx,
  owner: AuthenticatedChatOwner,
  continuationProvider: string,
  responses: Array<{
    messageId: string
    approvalId: string
    toolCallId: string
    toolName: string
    approved: boolean
    reason?: string
  }>
): Promise<{
  message: Doc<"messages">
  /**
   * The run the resolved approvals PAUSED — the continuation-idempotency
   * anchor (its `continuationRunId` is checked and stamped by prepare's
   * continuation branch). Read from the approval rows, not the message's
   * `generationRunId`, which a prior continuation already re-pointed.
   */
  pausedRunId: Id<"generationRuns"> | null
  /**
   * True when THIS transaction's `approvals-resolved` close transitioned the
   * paused run — i.e. the pause was still live (`awaiting_approval`) when
   * this prepare began. False means the pause was already settled by an
   * earlier writer (a Stop that denied the approvals, a supersession, a
   * reap): the continuation branch must conflict rather than resurrect a
   * settled run.
   */
  pausedRunWasLive: boolean
} | null> {
  if (responses.length === 0) return null

  const messages = await listMessages(ctx, owner.chat._id)
  const messageById = new Map(messages.map((message) => [message._id, message]))
  let updatedMessage: Doc<"messages"> | null = null
  let pausedRunId: Id<"generationRuns"> | null = null
  const now = nowMs()
  const runDecisions = new Map<Id<"generationRuns">, { denied: boolean }>()

  for (const response of responses) {
    const approval = await ctx.db
      .query("toolApprovalRequests")
      .withIndex("by_approval", (q) => q.eq("approvalId", response.approvalId))
      .unique()

    if (
      !approval ||
      approval.chatId !== owner.chat._id ||
      approval.userId !== owner.user._id ||
      approval.toolCallId !== response.toolCallId ||
      approval.toolName !== response.toolName
    ) {
      throw new ConvexError({
        code: "approval_continuation_conflict",
        message: "Approval continuation does not match the paused tool call",
      })
    }

    // Approval responses continue the exact paused provider protocol. The
    // request's message metadata is client-controlled, so the authoritative
    // pin is the provider stored on the approval's generation run. Check it
    // before patching the message, invocation, approval, or run.
    const approvalRun = await ctx.db.get(approval.runId)
    if (
      !approvalRun ||
      approvalRun.chatId !== owner.chat._id ||
      approvalRun.provider !== continuationProvider
    ) {
      throw new ConvexError({
        code: "approval_provider_mismatch",
        message: "Approval continuation provider changed",
      })
    }

    const canonicalDecision = resolveCanonicalApprovalDecision(
      approval,
      response
    )
    const runDecision = runDecisions.get(approval.runId)
    runDecisions.set(approval.runId, {
      denied: (runDecision?.denied ?? false) || !canonicalDecision.approved,
    })
    pausedRunId = approval.runId

    const message = findMessageByUiId(messages, response.messageId)
    if (!message || message.chatId !== owner.chat._id) {
      // The continuation names a message this chat no longer has (branched
      // away, deleted, or client-fabricated). Client-supplied identity that
      // cannot be honored is a conflict contract, not a server fault.
      throw new ConvexError({
        code: "approval_continuation_conflict",
        message: "Approval continuation does not match a message in this chat",
      })
    }

    const currentMessage = messageById.get(message._id) ?? message
    const nextParts = applyApprovalResponseToParts(currentMessage.parts, {
      ...response,
      approved: canonicalDecision.approved,
      reason: canonicalDecision.reason,
    })
    await ctx.db.patch(message._id, {
      parts: nextParts,
      status: "streaming",
      updatedAt: now,
    })
    const refreshed = await ctx.db.get(message._id)
    updatedMessage = refreshed ?? {
      ...currentMessage,
      parts: nextParts,
      status: "streaming",
      updatedAt: now,
    }
    messageById.set(message._id, updatedMessage)

    const invocation = await ctx.db
      .query("toolInvocations")
      .withIndex("by_run_tool_call", (q) =>
        q.eq("runId", approval.runId).eq("toolCallId", response.toolCallId)
      )
      .unique()
    if (invocation) {
      await ctx.db.patch(invocation._id, {
        status: canonicalDecision.status,
        approvalId: approval._id,
        approvalRequestId: approval.approvalId,
        updatedAt: now,
      })
    }
  }

  let pausedRunWasLive = false
  for (const [runId, runDecision] of runDecisions) {
    const run = await ctx.db.get(runId)
    if (!run) continue
    // The continuation closes the paused run via the Generation run lifecycle's
    // `approvals-resolved` rule. A run already settled (a racing Stop aborted it
    // mid-approval) is left alone — the late resolution must not repaint it. The
    // continuation message stays "streaming" (patched above): it belongs to the
    // NEW continuation run's prepare, not this close.
    const verdict = resolveGenerationRunTransition(
      { runStatus: run.status, message: null },
      { kind: "approvals-resolved", anyDenied: runDecision.denied }
    )
    if (verdict.kind === "ignore") continue
    if (runId === pausedRunId) pausedRunWasLive = true
    await ctx.db.patch(runId, {
      status: verdict.run.status,
      completedAt: verdict.run.settle ? now : undefined,
      updatedAt: now,
      activeStreamId: undefined,
      ...(verdict.run.terminalReason
        ? { terminalReason: verdict.run.terminalReason }
        : {}),
      ...grantRevocationForStatus(verdict.run.status),
      ...LEASE_CLEAR,
    })
    // Normally settled at the approval pause (the completion-downgrade write);
    // this defensive call only lands when that settlement never arrived.
    if (verdict.run.settle) {
      await settleUsageForTerminalRun(
        ctx,
        run,
        {},
        "approvals_resolved",
        verdict.run.terminalReason
      )
    }
  }

  return updatedMessage
    ? { message: updatedMessage, pausedRunId, pausedRunWasLive }
    : null
}

type GenerationApprovalResponse = {
  messageId: string
  approvalId: string
  toolCallId: string
  toolName: string
  approved: boolean
  reason?: string
}

type GenerationInputPlanArgs = {
  expectedVisibleMessageCount?: number
  tailMessageId?: string
  latestUserMessage?: {
    id: string
    role: "user"
    content?: string
    parts: unknown
  }
  edit?: GenerationEditIntent
  regeneration?: GenerationRegenerationIntent
  approvalResponses?: GenerationApprovalResponse[]
}

export type GenerationInputPlan = {
  inputHash: string
  messages: Doc<"messages">[]
  pinnedProvider?: string
}

function validateGenerationInputIntent(args: GenerationInputPlanArgs): void {
  const approvalResponses = args.approvalResponses ?? []
  if (args.edit && args.regeneration) {
    throw new Error("Regeneration cannot be combined with edit generation")
  }
  if (args.regeneration && args.latestUserMessage) {
    throw new Error("Regeneration cannot include a latest user message")
  }
  if ((args.edit || args.regeneration) && approvalResponses.length > 0) {
    throw new Error("Generation cannot continue pending approvals")
  }
}

function generationInputHash(messages: Doc<"messages">[]): string {
  return sha256Hex(
    JSON.stringify([
      "generation-input-v1",
      messages.map((message) => [
        message.clientMessageId ?? String(message._id),
        message.role,
        message.content,
        message.parts,
      ]),
    ])
  )
}

async function planApprovalInput(
  ctx: QueryCtx | MutationCtx,
  owner: AuthenticatedChatOwner,
  messages: Doc<"messages">[],
  responses: GenerationApprovalResponse[],
  expectedProvider?: string
): Promise<{ messages: Doc<"messages">[]; pinnedProvider?: string }> {
  if (responses.length === 0) return { messages }

  let plannedMessages = messages
  let pinnedProvider: string | undefined
  for (const response of responses) {
    const approval = await ctx.db
      .query("toolApprovalRequests")
      .withIndex("by_approval", (q) => q.eq("approvalId", response.approvalId))
      .unique()
    if (
      !approval ||
      approval.chatId !== owner.chat._id ||
      approval.userId !== owner.user._id ||
      approval.toolCallId !== response.toolCallId ||
      approval.toolName !== response.toolName
    ) {
      throw new ConvexError({
        code: "approval_continuation_conflict",
        message: "Approval continuation does not match the paused tool call",
      })
    }

    const approvalRun = await ctx.db.get(approval.runId)
    if (!approvalRun || approvalRun.chatId !== owner.chat._id) {
      throw new ConvexError({
        code: "approval_provider_mismatch",
        message: "Approval continuation provider changed",
      })
    }
    if (
      (expectedProvider && approvalRun.provider !== expectedProvider) ||
      (pinnedProvider && approvalRun.provider !== pinnedProvider)
    ) {
      throw new ConvexError({
        code: "approval_provider_mismatch",
        message: "Approval continuation provider changed",
      })
    }
    pinnedProvider = approvalRun.provider

    const canonicalDecision = resolveCanonicalApprovalDecision(
      approval,
      response
    )
    const message = findMessageByUiId(plannedMessages, response.messageId)
    if (!message || message.chatId !== owner.chat._id) {
      throw new ConvexError({
        code: "approval_continuation_conflict",
        message: "Approval continuation does not match a message in this chat",
      })
    }
    plannedMessages = plannedMessages.map((candidate) =>
      candidate._id === message._id
        ? {
            ...candidate,
            parts: applyApprovalResponseToParts(candidate.parts, {
              ...response,
              approved: canonicalDecision.approved,
              reason: canonicalDecision.reason,
            }),
            status: "streaming" as const,
          }
        : candidate
    )
  }

  return { messages: plannedMessages, pinnedProvider }
}

/**
 * Read-only source of truth for the provider input of one durable turn. The
 * route reserves against this plan; `prepareGeneration` recomputes it inside
 * its transaction before any write and rejects a stale hash.
 */
export async function planGenerationInputForChat(
  ctx: QueryCtx | MutationCtx,
  owner: AuthenticatedChatOwner,
  args: GenerationInputPlanArgs,
  options: { continuationProvider?: string } = {}
): Promise<GenerationInputPlan> {
  validateGenerationInputIntent(args)
  const currentMessages = await listMessages(ctx, owner.chat._id)
  const approvalResponses = args.approvalResponses ?? []
  let modelHistory: Doc<"messages">[]
  let pinnedProvider: string | undefined

  if (args.regeneration) {
    modelHistory = resolveRegenerationInputPlan(
      currentMessages,
      args.regeneration
    ).messages
  } else if (args.edit) {
    const editPlan = resolveEditInputPlan(currentMessages, args.edit)
    modelHistory = projectModelHistoryMessages(
      planSelectedPathAfterUserMessage(currentMessages, {
        chatId: owner.chat._id,
        now:
          editPlan.editedMessage?.createdAt ??
          (currentMessages.at(-1)?.createdAt ?? 0) + 1,
        input: {
          clientMessageId: args.edit.replacementMessage.id,
          userId: owner.user._id,
          content: args.edit.replacementMessage.content,
          parts: args.edit.replacementMessage.parts,
          replaces: editPlan.editedMessage?._id,
        },
      })
    )
  } else if (approvalResponses.length > 0) {
    const approvalPlan = await planApprovalInput(
      ctx,
      owner,
      currentMessages,
      approvalResponses,
      options.continuationProvider
    )
    pinnedProvider = approvalPlan.pinnedProvider
    modelHistory = projectModelHistoryMessages(
      getSelectedPath(approvalPlan.messages)
    )
  } else if (args.latestUserMessage) {
    validateSelectedPathToken(currentMessages, {
      expectedVisibleMessageCount: args.expectedVisibleMessageCount,
      tailMessageId: args.tailMessageId,
    })
    modelHistory = projectModelHistoryMessages(
      planSelectedPathAfterUserMessage(currentMessages, {
        chatId: owner.chat._id,
        now: currentMessages.at(-1)?.createdAt ?? 0,
        input: {
          clientMessageId: args.latestUserMessage.id,
          userId: owner.user._id,
          content:
            args.latestUserMessage.content ??
            extractTextFromMessageParts(args.latestUserMessage.parts),
          parts: args.latestUserMessage.parts,
        },
      })
    )
  } else {
    modelHistory = projectModelHistoryMessages(getSelectedPath(currentMessages))
  }

  return {
    inputHash: generationInputHash(modelHistory),
    messages: modelHistory,
    ...(pinnedProvider ? { pinnedProvider } : {}),
  }
}

export const planGenerationInput = ownedChatQuery({
  args: {
    expectedVisibleMessageCount: v.optional(v.number()),
    tailMessageId: v.optional(v.string()),
    latestUserMessage: v.optional(vStoredMessage),
    edit: v.optional(vEditIntent),
    regeneration: v.optional(vRegenerationIntent),
    approvalResponses: v.optional(v.array(vApprovalResponse)),
  },
  returns: v.object({
    inputHash: v.string(),
    messages: v.array(v.any()),
    pinnedProvider: v.optional(v.string()),
  }),
  handler: async (ctx, args) =>
    planGenerationInputForChat(ctx, { chat: ctx.chat, user: ctx.user }, args),
})

type GenerationRouteReceipt = ChatAdmissionRouteReceipt

type PrepareGenerationForChatArgs = {
  requestId: string
  model: string
  provider: string
  /** Route-resolution receipt (ADR-0020); absent only for legacy callers. */
  route?: GenerationRouteReceipt
  /** Per-turn effort receipt (ADR-0026), verified by the admission proof. */
  reasoningEffort?: {
    requested?: PersistedReasoningEffort
    applied?: PersistedReasoningEffort
  }
  /** Total generation allowance receipt (ADR-0028). */
  generationBudget?: {
    requested?: number
    applied?: number
  }
  expectedVisibleMessageCount?: number
  tailMessageId?: string
  latestUserMessage?: {
    id: string
    role: "user"
    content?: string
    parts: unknown
  }
  edit?: GenerationEditIntent
  regeneration?: GenerationRegenerationIntent
  approvalResponses?: GenerationApprovalResponse[]
  /** Canonical durable-input plan hash confirmed before prepare mutates state. */
  generationInputHash?: string
  /** SHA-256 hex digest of the run-scoped worker secret (ADR-0011). */
  grantDigest?: string
  /**
   * Platform-usage reservation to attach to the run (ADR-0021). Verified by
   * the signed admission proof; present exactly when the route resolver
   * reserved platform allowance for this request. Attach happens inside this
   * transaction, so a platform-funded run can never exist unaccounted.
   */
  reservationId?: Id<"usageReservations">
  cancellationSettlementVersion?: CancellationSettlementProtocolVersion
}

export async function prepareGenerationForChat(
  ctx: MutationCtx,
  owner: AuthenticatedChatOwner,
  args: PrepareGenerationForChatArgs
) {
  const now = nowMs()
  const approvalResponses = args.approvalResponses ?? []

  validateGenerationInputIntent(args)
  if (args.generationInputHash) {
    const currentPlan = await planGenerationInputForChat(ctx, owner, args, {
      continuationProvider: args.provider,
    })
    if (!timingSafeEqualHex(currentPlan.inputHash, args.generationInputHash)) {
      throw new ConvexError({
        code: "generation_input_changed",
        message: "Chat changed after generation input was planned",
      })
    }
  }

  const latestUserMessage = args.edit
    ? args.edit.replacementMessage
    : args.regeneration
      ? undefined
      : args.latestUserMessage

  if (latestUserMessage && !args.edit) {
    await validateSelectedPathTokenForChat(ctx, owner.chat._id, {
      expectedVisibleMessageCount: args.expectedVisibleMessageCount,
      tailMessageId: args.tailMessageId,
    })
  }

  await closeSupersededGenerationsForChat(ctx, owner.chat._id, owner.user._id, now)

  const continuation = await applyApprovalResponses(
    ctx,
    owner,
    args.provider,
    approvalResponses
  )
  const continuationMessage = continuation?.message ?? null

  let titleGeneration: number | undefined

  if (latestUserMessage) {
    await denyPendingApprovalsForChat(
      ctx,
      owner.chat._id,
      owner.user._id,
      "auto-denied: new generation started"
    )

    if (args.edit) {
      titleGeneration = await applyEditIntentForGeneration(
        ctx,
        owner,
        {
          requestId: args.requestId,
          model: args.model,
          provider: args.provider,
          edit: args.edit,
        },
        now
      )
    } else {
      await selectOrInsertLatestUserMessageForGeneration(
        ctx,
        owner,
        args,
        latestUserMessage as StoredUserMessage,
        now
      )
      if (owner.chat.titleSource === "provisional") {
        titleGeneration = owner.chat.titleGeneration
      }
    }
  }

  const runId = await ctx.db.insert("generationRuns", {
    chatId: owner.chat._id,
    userId: owner.user._id,
    requestId: args.requestId,
    model: args.model,
    provider: args.provider,
    ...(args.route
      ? {
          routeId: args.route.routeId,
          credentialSource: args.route.credentialSource,
          routeReason: args.route.routeReason,
        }
      : {}),
    ...(args.reasoningEffort?.requested !== undefined
      ? { reasoningEffort: args.reasoningEffort.requested }
      : {}),
    ...(args.reasoningEffort?.applied !== undefined
      ? { appliedReasoningEffort: args.reasoningEffort.applied }
      : {}),
    ...(args.generationBudget?.requested !== undefined
      ? { requestedGenerationBudget: args.generationBudget.requested }
      : {}),
    ...(args.generationBudget?.applied !== undefined
      ? { appliedGenerationBudget: args.generationBudget.applied }
      : {}),
    status: "running",
    startedAt: now,
    updatedAt: now,
    // The lease is born at prepare; the worker's heartbeat loop
    // renews it; the reaper fails runs whose deadline lapses.
    heartbeatAt: now,
    leaseExpiresAt: computeLeaseExpiresAt(now),
    lastProgressAt: now,
    ...(args.grantDigest
      ? {
          grantDigest: args.grantDigest,
          grantExpiresAt: now + EXECUTION_GRANT_TTL_MS,
        }
      : {}),
    cancellationSettlementVersion:
      args.cancellationSettlementVersion ??
      CANCELLATION_SETTLEMENT_PROTOCOL_VERSION,
  })

  // Attach the platform-usage reservation to its run transactionally
  // (ADR-0021): fail closed — a reservation that cannot attach rolls back
  // the whole prepare, so a platform-funded run never executes unaccounted.
  if (args.reservationId) {
    await attachReservationToRun(ctx, {
      reservationId: args.reservationId,
      requestId: args.requestId,
      userId: owner.user._id,
      runId,
      now,
      cancellationSettlementVersion:
        args.cancellationSettlementVersion ??
        CANCELLATION_SETTLEMENT_PROTOCOL_VERSION,
    })
  }

  let assistantMessageId: Id<"messages">
  let includeAssistantInModelHistory = false
  let preparedModelHistory: Doc<"messages">[] | null = null
  let resumedOutputTokensBaseline: number | undefined

  if (args.regeneration) {
    const preparedRegeneration = await applyRegenerationIntentForGeneration(
      ctx,
      owner,
      {
        requestId: args.requestId,
        model: args.model,
        provider: args.provider,
        runId,
        regeneration: args.regeneration,
      },
      now
    )
    assistantMessageId = preparedRegeneration.assistantMessageId
    preparedModelHistory = preparedRegeneration.messages
  } else if (continuationMessage) {
    // Approval-continuation idempotency, layer 1 of 3:
    // the paused run records its continuation inside this transaction, so of
    // two racing auto-send continuations exactly ONE creates a run — the
    // second sees continuationRunId and gets a typed conflict the route maps
    // to a structured 409 the client swallows. Anchored on the APPROVALS' run
    // (the message's generationRunId is re-pointed by the first winner).
    const pausedRunId = continuation?.pausedRunId ?? null
    if (pausedRunId && pausedRunId !== runId) {
      const pausedRun = await ctx.db.get(pausedRunId)
      if (pausedRun && pausedRun.chatId === owner.chat._id) {
        if (pausedRun.continuationRunId !== undefined) {
          console.log(
            JSON.stringify({
              _tag: "run_continuation_conflict",
              chatId: owner.chat._id,
              pausedRunId,
              reason: "already-dispatched",
              winnerRunId: pausedRun.continuationRunId,
            })
          )
          throw new ConvexError({
            code: "approval_continuation_conflict",
            message: "Approval continuation already dispatched",
          })
        }
        // A continuation is legal only against a pause that was still live
        // when this prepare began; no approval can resurrect a stopped run.
        // `pausedRunWasLive` is stamped by
        // applyApprovalResponses above: its approvals-resolved close
        // transitioned the pause in THIS transaction. False means an earlier
        // writer (Stop denying the approvals, supersession, reap) already
        // settled it — a late auto-send POST must conflict, not create a new
        // streaming run that re-claims the chat slot, repaints the settled
        // assistant message, and re-approves invocations the Stop denied.
        // The ConvexError rolls back this whole transaction — approval
        // repaints included.
        if (!continuation?.pausedRunWasLive) {
          console.log(
            JSON.stringify({
              _tag: "run_continuation_conflict",
              chatId: owner.chat._id,
              pausedRunId,
              reason: "pause-settled",
              pausedRunStatus: pausedRun.status,
            })
          )
          throw new ConvexError({
            code: "approval_continuation_conflict",
            message: "Approval pause already settled",
          })
        }
        // Belt-and-suspenders slot check: a pause that lost the chat's status
        // slot to a newer run must not let its continuation's supersede sweep
        // abort that healthy run mid-stream.
        if (
          owner.chat.statusRunId !== undefined &&
          owner.chat.statusRunId !== pausedRunId
        ) {
          console.log(
            JSON.stringify({
              _tag: "run_continuation_conflict",
              chatId: owner.chat._id,
              pausedRunId,
              reason: "slot-moved",
              slotRunId: owner.chat.statusRunId,
            })
          )
          throw new ConvexError({
            code: "approval_continuation_conflict",
            message: "Approval pause no longer owns the chat's active run",
          })
        }
        await ctx.db.patch(pausedRunId, { continuationRunId: runId })
        await ctx.db.patch(runId, { continuedFromRunId: pausedRunId })
      }
    }
    assistantMessageId = continuationMessage._id
    includeAssistantInModelHistory = true
    // The reused message's existing parts were billed to the PAUSED run's
    // settled reservation. Freeze their partial-output estimate as this run's
    // baseline so cancellation settlement only ever charges the delta this
    // run produced (ADR-0021 cancellation amendment).
    resumedOutputTokensBaseline = estimatePartialOutputTokens(
      continuationMessage.parts
    )
    await ctx.db.patch(assistantMessageId, {
      generationRunId: runId,
      requestId: args.requestId,
      status: "streaming",
      updatedAt: now,
    })
  } else {
    const assistantMessage = await createMessageBranchWriter(ctx, {
      chatId: owner.chat._id,
      now,
    }).writeAssistantPlaceholder({
      generationRunId: runId,
      requestId: args.requestId,
      model: args.model,
      provider: args.provider,
    })
    assistantMessageId = assistantMessage._id
  }

  await ctx.db.patch(runId, {
    status: "streaming",
    assistantMessageId,
    activeStreamId: assistantMessageId,
    ...(resumedOutputTokensBaseline !== undefined &&
    resumedOutputTokensBaseline > 0
      ? { resumedOutputTokensBaseline }
      : {}),
    updatedAt: now,
  })
  // Claim the chat's status slot for this run (run start → live spinner). This
  // runs AFTER closeSupersededGenerationsForChat above, so the new run owns the
  // slot; the run-scoped guard then makes any older run's late terminal a no-op.
  // Direct write (not projectRunStatusToChat): claiming SETS statusRunId, so it
  // must not be gated on already owning the slot.
  await patchChatActivity(
    ctx,
    owner.chat,
    {
      liveRunStatus: "streaming",
      statusRunId: runId,
      // Written once here and overwritten only by an approval pause: the hard
      // ceiling no legitimate run outlives.
      liveRunFreshUntil: computeLiveRunFreshUntil(now),
    },
    now
  )

  const modelHistory =
    preparedModelHistory ??
    projectModelHistoryMessages(
      getSelectedPath(await listMessages(ctx, owner.chat._id)).filter(
        (message) =>
          includeAssistantInModelHistory || message._id !== assistantMessageId
      )
    )

  return {
    runId,
    assistantMessageId,
    messages: modelHistory,
    titleGeneration,
  }
}

type VerifiedPrepareGenerationArgs = PrepareGenerationForChatArgs & {
  cancellationSettlementVersion: CancellationSettlementProtocolVersion
  admissionIssuedAt: number
  admissionProof: string
}

export async function prepareGenerationWithVerifiedAdmission(
  ctx: MutationCtx,
  owner: AuthenticatedChatOwner,
  args: VerifiedPrepareGenerationArgs,
  options: { secret?: string; now?: number } = {}
) {
  const { admissionIssuedAt, admissionProof, ...prepareArgs } = args
  // The proof signs the client-minted publicId (ADR-0033); the builder already
  // resolved it to the owner-verified chat, so verify against that chat.
  const isVerified = verifyChatAdmissionProof(
    {
      chatId: owner.chat.publicId,
      requestId: args.requestId,
      model: args.model,
      provider: args.provider,
      route: args.route,
      reasoningEffort: args.reasoningEffort,
      generationBudget: args.generationBudget,
      grantDigest: args.grantDigest,
      reservationId: args.reservationId,
      cancellationSettlementVersion: args.cancellationSettlementVersion,
      generationInputHash: args.generationInputHash,
      issuedAt: admissionIssuedAt,
    },
    admissionProof,
    options
  )
  if (!isVerified) {
    throw new ConvexError({
      code: "admission_proof_invalid",
      message: "Chat admission proof is invalid or expired",
    })
  }
  return prepareGenerationForChat(ctx, owner, prepareArgs)
}

// `ownedChatMutation` declares the `chatId` arg (the client-minted publicId,
// ADR-0033) and resolves it to the owner-verified chat before this runs.
export const prepareGeneration = ownedChatMutation({
  args: {
    requestId: v.string(),
    model: v.string(),
    provider: v.string(),
    route: v.optional(
      v.object({
        routeId: v.string(),
        credentialSource: v.union(v.literal("platform"), v.literal("byok")),
        routeReason: v.union(
          v.literal("priority_byok"),
          v.literal("platform"),
          v.literal("fallback_byok"),
          v.literal("legacy_route_hint")
        ),
      })
    ),
    reasoningEffort: v.optional(
      v.object({
        requested: v.optional(vReasoningEffort),
        applied: v.optional(vReasoningEffort),
      })
    ),
    generationBudget: v.optional(
      v.object({
        requested: v.optional(v.number()),
        applied: v.optional(v.number()),
      })
    ),
    expectedVisibleMessageCount: v.optional(v.number()),
    tailMessageId: v.optional(v.string()),
    latestUserMessage: v.optional(vStoredMessage),
    edit: v.optional(vEditIntent),
    regeneration: v.optional(vRegenerationIntent),
    approvalResponses: v.optional(v.array(vApprovalResponse)),
    generationInputHash: v.optional(v.string()),
    grantDigest: v.optional(v.string()),
    reservationId: v.optional(v.id("usageReservations")),
    cancellationSettlementVersion: v.literal(
      CANCELLATION_SETTLEMENT_PROTOCOL_VERSION
    ),
    admissionIssuedAt: v.number(),
    admissionProof: v.string(),
  },
  handler: async (ctx, args) =>
    prepareGenerationWithVerifiedAdmission(
      ctx,
      { user: ctx.user, chat: ctx.chat },
      args
    ),
})

/**
 * Route-pin facts for an approval continuation (ADR-0020): the provider and
 * route the paused run executed on. The route resolver constrains its
 * candidates to this provider so a key added mid-pause can never re-route a
 * continuation; `applyApprovalResponses` keeps the fail-closed enforcement.
 * Owner-checked; returns null (never throws) so a stale approval id degrades
 * to the unpinned path, where the transactional check still decides.
 */
export const getApprovalRouteFacts = authenticatedQuery({
  args: { approvalId: v.string() },
  handler: async (ctx, { approvalId }) => {
    const approval = await ctx.db
      .query("toolApprovalRequests")
      .withIndex("by_approval", (q) => q.eq("approvalId", approvalId))
      .unique()
    if (!approval || approval.userId !== ctx.user._id) return null

    const run = await ctx.db.get(approval.runId)
    if (!run) return null

    return {
      provider: run.provider,
      routeId: run.routeId ?? null,
      model: run.model,
    }
  },
})

/**
 * Records the exact provider-consumption boundary for server-side duration
 * fallback. Approval continuations inherit the prior frozen total from the
 * reused assistant message; the human pause itself is excluded.
 */
export async function markGenerationWorkStartedForChat(
  ctx: MutationCtx,
  owner: AuthenticatedRunOwner,
  args: { messageId: Id<"messages">; startedAt: number }
) {
  const { run } = owner
  if (run.workStartedAt !== undefined) return
  await requireAssistantMessageForRun(ctx, run, args.messageId)
  const message = await ctx.db.get(args.messageId)
  const priorWorkDurationMs = Math.max(
    0,
    message?.metadata?.workDurationMs ?? 0
  )
  const now = nowMs()
  await ctx.db.patch(run._id, {
    // This mutation is the authority boundary. Do not let a worker-supplied
    // clock move durable billing evidence into the past or future.
    workStartedAt: now,
    workDurationMs: priorWorkDurationMs,
    updatedAt: now,
  })
  const reservation = await ctx.db
    .query("usageReservations")
    .withIndex("by_run", (q) => q.eq("generationRunId", run._id))
    .unique()
  if (reservation?.status === "reserved") {
    await ctx.db.patch(reservation._id, {
      providerMayHaveStarted: true,
      updatedAt: now,
    })
  }
}

/** Persist title evidence before dispatch and after provider completion. */
export async function recordTitleUsageEvidenceForChat(
  ctx: MutationCtx,
  owner: AuthenticatedRunOwner,
  args: {
    messageId: Id<"messages">
    evidence: TitleTerminalUsageEvidence
  }
) {
  const { run } = owner
  await requireAssistantMessageForRun(ctx, run, args.messageId)
  if (
    !isValidTerminalUsageEvidence({
      primary: { kind: "not-started" },
      title: args.evidence,
    })
  ) {
    throw new Error("Invalid title usage evidence")
  }

  // The first actual receipt is absorbing. A retry or compromised worker must
  // never replace completed evidence with a smaller charge.
  if (run.titleUsageEvidence?.kind === "actual") {
    if (
      args.evidence.kind === "actual" &&
      (args.evidence.routeId !== run.titleUsageEvidence.routeId ||
        args.evidence.inputTokens !== run.titleUsageEvidence.inputTokens ||
        args.evidence.outputTokens !== run.titleUsageEvidence.outputTokens ||
        args.evidence.pricingRole !== run.titleUsageEvidence.pricingRole)
    ) {
      console.warn("Conflicting title usage receipt ignored", {
        runId: run._id,
      })
    }
    return
  }

  const reservation = await ctx.db
    .query("usageReservations")
    .withIndex("by_run", (q) => q.eq("generationRunId", run._id))
    .unique()
  if (args.evidence.kind === "actual" && reservation) {
    const rate =
      args.evidence.pricingRole === "primary"
        ? reservation.pricingSnapshot.primary
        : (reservation.pricingSnapshot.title ??
          reservation.pricingSnapshot.primary)
    if (rate.routeId === args.evidence.routeId) {
      // Reject evidence that cannot be represented in integer accounting
      // before it can poison the durable fallback path.
      computeUsageCredits(rate, args.evidence)
    }
  }

  const now = nowMs()
  await ctx.db.patch(run._id, {
    titleUsageEvidence: args.evidence,
    updatedAt: now,
  })
  if (reservation?.status === "reserved") {
    await ctx.db.patch(reservation._id, {
      titleUsageEvidence: args.evidence,
      updatedAt: now,
    })
  }
}

export async function updateAssistantSnapshotForChat(
  ctx: MutationCtx,
  owner: AuthenticatedRunOwner,
  args: {
    messageId: Id<"messages">
    sequence: number
    textSnapshot: string
    partsSnapshot: unknown
    workSummaryDurationMs?: number
  }
) {
  const { run } = owner
  const message = await requireAssistantMessageForRun(ctx, run, args.messageId)

  // Sampled outcome telemetry: the
  // Convex-side mirror of the Next-side checkpoint counters, so
  // accepted-vs-rejected accounting closes end to end. Buckets/enums only.
  const perfSampled = shouldSampleChatPerfConvex()
  const logSnapshotOutcome = (
    outcome: "applied" | "deduped" | "stale" | "lost"
  ) => {
    if (!perfSampled) return
    let payloadBytes = args.textSnapshot.length
    try {
      payloadBytes += JSON.stringify(args.partsSnapshot).length
    } catch {
      // Size estimate only.
    }
    logChatPerfConvex("snapshot_write", {
      outcome,
      payloadBytesBucket: bucketPow2(payloadBytes),
    })
  }

  // A terminal run accepts no further snapshots. A streamer that lost the
  // abort/supersede race must become read-only here — its continued writes
  // to the run and message docs are what OCC-starve the next turn's
  // prepareGeneration on the same chat.
  if (isTerminalGenerationRunStatus(run.status)) {
    logSnapshotOutcome("lost")
    return { kind: "lost" as const, reason: "terminal" as const }
  }

  // Stale snapshots are rejected before persistence: a late lower-or-equal
  // sequence write cannot overwrite newer projected content.
  const lastSequence = run.lastSnapshotSequence ?? 0
  if (args.sequence <= lastSequence) {
    logSnapshotOutcome("stale")
    return { kind: "stale" as const, lastSequence }
  }

  // Write-storm guard: a checkpoint whose content is byte-identical to what the
  // message already carries advances the sequence but must not rewrite the
  // (potentially large) message doc. Historical storms wrote identical
  // ~7 KB checkpoints at ~59 ms cadence for minutes; the sequence guard cannot
  // reject them because sequences advance.
  const contentUnchanged =
    message.content === args.textSnapshot &&
    JSON.stringify(message.parts) === JSON.stringify(args.partsSnapshot) &&
    (args.workSummaryDurationMs === undefined ||
      message.metadata?.workSummaryDurationMs === args.workSummaryDurationMs)

  const now = nowMs()
  if (!isTerminalMessageStatus(message.status)) {
    // Status advances to "streaming" only while the worker still owns
    // execution. An awaiting_approval pause is lease-free, and
    // its liveness is the pending approval — the same worker's post-pause
    // final flush lands CONTENT here, but repainting the pause "streaming"
    // would strand the run outside both liveness regimes (no lease → the
    // reaper's expiry range skips it; no pending-approval status → the
    // approval reaper skips it): a permanent zombie if the completion
    // downgrade write never arrives.
    const workerExecuting = isWorkerExecutingStatus(run.status)
    if (!contentUnchanged) {
      await ctx.db.patch(args.messageId, {
        content: args.textSnapshot,
        parts: args.partsSnapshot,
        ...(args.workSummaryDurationMs !== undefined ? {
          metadata: { ...message.metadata, workSummaryDurationMs: args.workSummaryDurationMs },
        } : {}),
        ...(workerExecuting && { status: "streaming" as const }),
        updatedAt: now,
      })
    }
    await ctx.db.patch(run._id, {
      ...(workerExecuting && { status: "streaming" as const }),
      lastSnapshotSequence: args.sequence,
      lastProgressAt: now,
      updatedAt: now,
    })
  } else {
    // The message already settled (its half of a terminal is stamped) but the
    // run has not — record the accepted sequence so later stale writes still
    // reject pre-insert.
    await ctx.db.patch(run._id, {
      lastSnapshotSequence: args.sequence,
      lastProgressAt: now,
      updatedAt: now,
    })
  }
  logSnapshotOutcome(contentUnchanged ? "deduped" : "applied")
  return { kind: "applied" as const, deduped: contentUnchanged }
}

/**
 * The heartbeat's three-way discriminant: the runtime must
 * branch on it — `renewed` continues the loop, `paused` stops the loop
 * WITHOUT aborting (the approval worker's envelope finalize is still
 * legitimate), `lost` aborts provider consumption and stops all writes.
 */
export type GenerationRunHeartbeatResult =
  | { kind: "renewed"; leaseExpiresAt: number }
  | { kind: "paused" }
  | { kind: "lost"; reason: "terminal" | "unlinked" | "not-owner" }

/**
 * Renew the worker's lease. Heartbeats are worker-wire only and have no
 * user-token twin. Guards: exact run (the
 * grant), worker-executing status, run→message→chat linkage, and current
 * chat-slot ownership. Extends the run's lease fields only, never the chat
 * doc. Server clock, never a client timestamp.
 */
export async function heartbeatGenerationRunForChat(
  ctx: MutationCtx,
  owner: AuthenticatedRunOwner
): Promise<GenerationRunHeartbeatResult> {
  const { chat, run } = owner
  if (run.status === "awaiting_approval") return { kind: "paused" }
  if (!isWorkerExecutingStatus(run.status)) {
    return { kind: "lost", reason: "terminal" }
  }

  const activeStreamMessageId =
    run.activeStreamId === undefined
      ? null
      : ctx.db.normalizeId("messages", run.activeStreamId)
  const messageId = run.assistantMessageId ?? activeStreamMessageId
  const message = messageId ? await ctx.db.get(messageId) : null
  if (
    !message ||
    message.chatId !== run.chatId ||
    message.role !== "assistant" ||
    !isAssistantMessageLinkedToRun(message, run)
  ) {
    return { kind: "lost", reason: "unlinked" }
  }

  if (chat.statusRunId !== run._id) return { kind: "lost", reason: "not-owner" }

  const now = nowMs()
  const leaseExpiresAt = computeLeaseExpiresAt(now)
  await ctx.db.patch(run._id, {
    heartbeatAt: now,
    leaseExpiresAt,
    updatedAt: now,
  })
  return { kind: "renewed", leaseExpiresAt }
}

export async function markGenerationRunCompletedForChat(
  ctx: MutationCtx,
  owner: AuthenticatedRunOwner,
  args: {
    messageId: Id<"messages">
    content: string
    parts: unknown
    metadata?: PersistedMessageMetadata
    finishReason?: string
    usage?: {
      inputTokens?: number
      outputTokens?: number
      totalTokens?: number
    }
    titleUsage?: TitleUsageEvidence
    totalToolCalls?: number
    failedToolCalls?: number
    timingReceipt?: RunTimingReceipt
  }
) {
  const { run } = owner
  const timingReceipt = sanitizeRunTimingReceipt(args.timingReceipt)
  // The first-terminal-wins guard and the completed-vs-awaiting_approval shape
  // live in the Generation run lifecycle's `complete` rule. `hasPendingApprovals`
  // is fact-gathering for it; the message payload (content/parts/metadata/usage)
  // and the run's usage/toolCounts stay here — the module decides status only.
  // Gate before gathering: the ignore decision reads only the run status, and
  // the already-terminal case is the racing duplicate this guard exists for.
  if (isIgnoredSignal(run.status, "complete")) return
  const hasPendingApprovals =
    (await ctx.db
      .query("toolApprovalRequests")
      .withIndex("by_run_status", (q) =>
        q.eq("runId", run._id).eq("status", "pending")
      )
      .first()) !== null
  const verdict = resolveGenerationRunTransition(
    { runStatus: run.status, message: null },
    { kind: "complete", hasPendingApprovals }
  )
  if (verdict.kind === "ignore") return
  await requireAssistantMessageForRun(ctx, run, args.messageId)
  const now = nowMs()
  const status = verdict.message.status

  await ctx.db.patch(args.messageId, {
    content: args.content,
    parts: args.parts,
    metadata: args.metadata,
    status,
    finishReason: args.finishReason,
    usage: args.usage,
    error: undefined,
    errorRecovery: undefined,
    updatedAt: now,
  })
  await ctx.db.patch(run._id, {
    status: verdict.run.status,
    completedAt: verdict.run.settle ? now : undefined,
    updatedAt: now,
    finishReason: args.finishReason,
    // The onEnd aggregate is authoritative; when it is absent, keep the
    // per-step accumulated evidence instead of erasing it (ADR-0021).
    inputTokens: args.usage?.inputTokens ?? run.inputTokens,
    outputTokens: args.usage?.outputTokens ?? run.outputTokens,
    totalToolCalls: args.totalToolCalls,
    failedToolCalls: args.failedToolCalls,
    ...(args.metadata?.workDurationMs !== undefined
      ? { workDurationMs: Math.max(0, args.metadata.workDurationMs) }
      : {}),
    ...(timingReceipt ? { timingReceipt } : {}),
    activeStreamId: undefined,
    ...(verdict.run.terminalReason
      ? { terminalReason: verdict.run.terminalReason }
      : {}),
    // Both outcomes shed the lease: completed is terminal; the
    // awaiting_approval downgrade is the lease-free pause.
    ...LEASE_CLEAR,
  })
  // Completion patches the run directly (not via applyLifecycleVerdict), so the
  // projection is hooked here. verdict.run.status is "completed", or
  // "awaiting_approval" when the finish still has pending approvals.
  await projectRunStatusToChat(ctx, run, verdict.run.status, now)

  // Allowance settlement (ADR-0021): the provider invocation has ended on
  // BOTH outcomes — completed AND the awaiting_approval downgrade (an
  // approval continuation is a new request with its own reservation) — so
  // this run's usage settles now, with the aggregate the write carried.
  await settleUsageForTerminalRun(
    ctx,
    run,
    {
      // Only an aggregate that actually carries token counts is "actual"
      // evidence; an absent or empty one falls to the observed/estimated
      // boundary rule inside the helper (never a zero-cost "actual").
      ...(args.usage &&
      (typeof args.usage.inputTokens === "number" ||
        typeof args.usage.outputTokens === "number")
        ? {
            usage: {
              inputTokens: args.usage.inputTokens,
              outputTokens: args.usage.outputTokens,
            },
          }
        : {}),
      titleUsage: args.titleUsage ?? "unknown",
    },
    verdict.run.status === "awaiting_approval" ? "approval_pause" : "completed",
    verdict.run.terminalReason
  )
}

export async function markGenerationRunFailedForChat(
  ctx: MutationCtx,
  owner: AuthenticatedRunOwner,
  args: {
    messageId?: Id<"messages">
    error: string
    errorRecovery?: "retry_with_shorter_generation_budget"
    workDurationMs?: number
    timingReceipt?: RunTimingReceipt
  }
) {
  const { run } = owner
  const now = nowMs()
  // Failed may overwrite completed but never aborted — the Generation run
  // lifecycle's `fail` rule owns that convergence and the message half. Gate
  // before gathering: the ignore decision reads only the run status, and the
  // already-settled case is the racing duplicate this rule absorbs.
  if (isIgnoredSignal(run.status, "fail")) return
  const resolved = await gatherAssistantMessageFacts(ctx, run, args.messageId)
  const verdict = resolveGenerationRunTransition(
    { runStatus: run.status, message: resolved?.facts ?? null },
    { kind: "fail", error: args.error }
  )
  if (verdict.kind === "ignore") return
  const assistantMessageId = await applyLifecycleVerdict(
    ctx,
    run,
    verdict,
    resolved,
    now,
    args.workDurationMs,
    undefined,
    args.timingReceipt
  )
  await ctx.db.patch(run._id, { errorRecovery: args.errorRecovery })
  if (assistantMessageId) {
    await ctx.db.patch(assistantMessageId, {
      errorRecovery: args.errorRecovery,
    })
  }
}

export async function markGenerationRunAbortedForChat(
  ctx: MutationCtx,
  owner: AuthenticatedRunOwner,
  args: {
    messageId?: Id<"messages">
    reason?: string
    workDurationMs?: number
    terminalUsage?: TerminalUsageEvidencePayload
    timingReceipt?: RunTimingReceipt
  }
) {
  const { run } = owner
  const now = nowMs()
  // Malformed or negative token counts are rejected before any pricing math
  // (ADR-0021 cancellation amendment).
  if (args.terminalUsage && !isValidTerminalUsageEvidence(args.terminalUsage)) {
    throw new Error("Invalid terminal usage evidence")
  }
  // First-terminal-wins and the empty-placeholder policy both live in the
  // Generation run lifecycle's `abort` rule. Gate before gathering: the ignore
  // decision reads only the run status, and the double-terminal race (onAbort
  // vs envelope finish) is exactly where the gather reads would be wasted.
  if (isIgnoredSignal(run.status, "abort")) return
  const resolved = await gatherAssistantMessageFacts(ctx, run, args.messageId)
  const verdict = resolveGenerationRunTransition(
    { runStatus: run.status, message: resolved?.facts ?? null },
    { kind: "abort", reason: args.reason }
  )
  if (verdict.kind === "ignore") return
  await applyLifecycleVerdict(
    ctx,
    run,
    verdict,
    resolved,
    now,
    args.workDurationMs,
    args.terminalUsage,
    args.timingReceipt
  )
}

export async function createToolApprovalRequestForChat(
  ctx: MutationCtx,
  owner: AuthenticatedRunOwner,
  args: {
    assistantMessageId: Id<"messages">
    toolCallId: string
    toolName: string
    source: Doc<"toolApprovalRequests">["source"]
    reason?: string
    riskClass: string
    inputPreview?: string
    approvalId: string
  }
): Promise<Id<"toolApprovalRequests"> | null> {
  const { user, run } = owner

  const existing = await ctx.db
    .query("toolApprovalRequests")
    .withIndex("by_approval", (q) => q.eq("approvalId", args.approvalId))
    .unique()
  if (existing) {
    if (
      existing.chatId !== run.chatId ||
      existing.runId !== run._id ||
      existing.assistantMessageId !== args.assistantMessageId
    ) {
      throw new Error("Approval request does not belong to this run")
    }
  }

  // Bug fix: a late approval request landing on an already-settled run — a user
  // Stop that raced the stream's approval-persistence transform — must not
  // repaint the run awaiting_approval (not supersedable, it would zombie until
  // the next turn's deny-pending pass), nor insert a pending row that would feed
  // hasPendingApprovals on a future completion. The Generation run lifecycle's
  // `approval-requested` rule ignores terminal runs; on ignore we insert nothing
  // and return null. Both API-runtime callers fire-and-forget this write and
  // never consume the returned id, so null is a no-op for them.
  const verdict = resolveGenerationRunTransition(
    { runStatus: run.status, message: null },
    { kind: "approval-requested" }
  )
  if (verdict.kind === "ignore") return null

  await requireAssistantMessageForRun(ctx, run, args.assistantMessageId)
  if (existing) return existing._id

  const now = nowMs()
  const approvalExpiresAt = now + APPROVAL_EXPIRY_MS
  const approvalRequestId = await ctx.db.insert("toolApprovalRequests", {
    chatId: run.chatId,
    runId: run._id,
    assistantMessageId: args.assistantMessageId,
    userId: user._id,
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    source: args.source,
    reason: args.reason,
    riskClass: args.riskClass,
    inputPreview: truncatePreview(args.inputPreview),
    approvalId: args.approvalId,
    status: "pending",
    createdAt: now,
    expiresAt: approvalExpiresAt,
  })

  await ctx.db.patch(run._id, {
    status: verdict.run.status,
    updatedAt: now,
    lastProgressAt: now,
    // The pause is lease-free: liveness becomes the pending
    // unexpired approval; the same worker's final flush and completion
    // downgrade stay legal via the non-terminal content-write guard.
    ...LEASE_CLEAR,
  })
  await ctx.db.patch(args.assistantMessageId, {
    status: verdict.message.status,
    updatedAt: now,
  })
  // The approval-request pause patches the run directly (not via
  // applyLifecycleVerdict), so project the awaiting phase here — carrying the
  // pause's freshness deadline (the approval expiry) onto the chat doc.
  await projectRunStatusToChat(ctx, run, verdict.run.status, now, {
    liveRunFreshUntil: approvalExpiresAt,
  })

  return approvalRequestId
}

// Durable Stop is authenticated, idempotent, and explicitly run-scoped:
// it targets `(chatId, runId)`, never "the active run".

export type StopGenerationRunResult = {
  outcome: "stopped" | "already-terminal" | "not-current"
  status: GenerationRunStatus
  terminalReason?: Doc<"generationRuns">["terminalReason"]
}

function observedStopTextPatch(
  message: Doc<"messages">,
  observedText: string | undefined
): { content: string; parts: unknown[] } | null {
  if (
    observedText === undefined ||
    observedText.length > MAX_STOP_OBSERVED_TEXT_CHARS ||
    observedText.length <= message.content.length ||
    !observedText.startsWith(message.content)
  ) {
    return null
  }

  const storedParts: unknown = message.parts
  if (!Array.isArray(storedParts)) return null
  const parts: unknown[] = [...storedParts]
  const partsText = extractTextFromMessageParts(parts)
  if (partsText !== message.content) return null

  const suffix = observedText.slice(partsText.length)
  const lastPart = parts.at(-1)
  if (
    lastPart &&
    typeof lastPart === "object" &&
    "type" in lastPart &&
    lastPart.type === "text" &&
    "text" in lastPart &&
    typeof lastPart.text === "string"
  ) {
    parts[parts.length - 1] = { ...lastPart, text: lastPart.text + suffix }
  } else {
    parts.push({ type: "text", text: suffix })
  }

  // Keep Stop usable even when the optional display prefix exceeds doc limits.
  try {
    const size = new TextEncoder().encode(
      JSON.stringify({ ...message, content: observedText, parts })
    ).byteLength
    if (size > 768 * 1024) return null
  } catch {
    return null
  }
  return { content: observedText, parts }
}

export async function stopGenerationRunForChat(
  ctx: MutationCtx,
  owner: AuthenticatedRunOwner,
  options: { observedText?: string } = {}
): Promise<StopGenerationRunResult> {
  // Structural run ownership (CONTEXT.md "Authenticated handler"): the caller
  // resolves the chat THROUGH the run (`ownedGenerationRunMutation` /
  // `requireOwnedGenerationRun`), so a mismatched chat/run pair is
  // unrepresentable here — no hand-written cross-check.
  const { run } = owner

  // Idempotent second Stop / lost race against completion or failure: the
  // first committed terminal wins; return its canonical result.
  if (isTerminalGenerationRunStatus(run.status)) {
    return {
      outcome: "already-terminal",
      status: run.status,
      terminalReason: run.terminalReason,
    }
  }

  // A run that lost the chat's status slot is already terminal or is an
  // awaiting_approval run the next prepare's deny-pending pass closes. Never
  // stop the newer owner.
  if (owner.chat.statusRunId !== run._id) {
    return {
      outcome: "not-current",
      status: run.status,
      terminalReason: run.terminalReason,
    }
  }

  const now = nowMs()
  const reason = "stopped by user"
  const resolved = await gatherAssistantMessageFacts(ctx, run, undefined)
  const observedPatch = resolved
    ? observedStopTextPatch(resolved.message, options.observedText)
    : null
  const verdict = resolveGenerationRunTransition(
    {
      runStatus: run.status,
      message: resolved
        ? {
            ...resolved.facts,
            ...(observedPatch
              ? { hasSemanticParts: true, hasSnapshotForRun: true }
              : {}),
          }
        : null,
    },
    { kind: "stop", reason }
  )
  if (verdict.kind !== "transition") {
    return {
      outcome: "already-terminal",
      status: run.status,
      terminalReason: run.terminalReason,
    }
  }

  // Lifecycle apply: message half (partial content preserved / stub policy),
  // run terminal fields (user_stop + grant revocation + lease shed), and the
  // owner-guarded chat projection clear — one shared path.
  await applyLifecycleVerdict(ctx, run, verdict, resolved, now)
  await ctx.db.patch(run._id, {
    stopRequestedAt: now,
    stopRequestedBy: owner.user._id,
  })

  // Deny this run's pending approvals and settle its active tool records
  // without erasing completed evidence.
  const pendingApprovals = await ctx.db
    .query("toolApprovalRequests")
    .withIndex("by_run_status", (q) =>
      q.eq("runId", run._id).eq("status", "pending")
    )
    .collect()
  for (const approval of pendingApprovals) {
    await ctx.db.patch(approval._id, {
      status: "denied",
      resolvedAt: now,
      resolvedByUserId: owner.user._id,
      reason,
    })
  }
  const invocations = await ctx.db
    .query("toolInvocations")
    .withIndex("by_run", (q) => q.eq("runId", run._id))
    .collect()
  for (const invocation of invocations) {
    if (terminalToolInvocationStatuses.has(invocation.status)) continue
    await ctx.db.patch(invocation._id, {
      status: invocation.status === "pending_approval" ? "denied" : "failed",
      error: reason,
      completedAt: now,
      updatedAt: now,
    })
  }

  // Accounting above sees only worker evidence. This owned Stop may retain a
  // newer display prefix, without accepting client tools, metadata, or usage.
  if (observedPatch && resolved) {
    const stoppedMessage = await ctx.db.get(resolved.message._id)
    const patch = stoppedMessage
      ? observedStopTextPatch(stoppedMessage, options.observedText)
      : null
    if (patch) await ctx.db.patch(resolved.message._id, patch)
  }

  console.log(
    JSON.stringify({
      _tag: "run_stop_won",
      runId: run._id,
      chatId: run.chatId,
      fromStatus: run.status,
    })
  )

  return { outcome: "stopped", status: "aborted", terminalReason: "user_stop" }
}

export const stopGenerationRun = ownedGenerationRunMutation({
  args: { observedText: v.optional(v.string()) },
  handler: async (ctx, args) =>
    stopGenerationRunForChat(
      ctx,
      { user: ctx.user, chat: ctx.chat, run: ctx.run },
      args
    ),
})

/**
 * Approval resolution transitions only `pending → approved|denied`. A
 * conflicting second decision — the other tab already resolved
 * — returns the canonical existing resolution instead of overwriting it (the
 * old unconditional patch let a late deny repaint an earlier approve).
 */
export type ToolCallDecisionResult = {
  status: "approved" | "denied" | "expired"
  alreadyResolved: boolean
  /** The CANONICAL persisted reason — the winner's, not the caller's. */
  reason?: string
}

/**
 * The ONE transactional approval-expiry operation. Both a user decision at or
 * after the deadline and the cron reaper use it, so whichever transaction
 * commits first produces the same approval, invocation, run, message, and chat
 * projection. Removing the approval from the pending index without settling
 * the paused run would otherwise strand it forever outside the reaper.
 */
async function expireToolApprovalForChat(
  ctx: MutationCtx,
  approval: Doc<"toolApprovalRequests">,
  now: number,
  source: "decision" | "reaper"
): Promise<boolean> {
  if (approval.status !== "pending" || now < approval.expiresAt) {
    return false
  }

  await ctx.db.patch(approval._id, { status: "expired", resolvedAt: now })

  const run = await ctx.db.get(approval.runId)
  if (!run) return true
  const invocation = await ctx.db
    .query("toolInvocations")
    .withIndex("by_run_tool_call", (q) =>
      q.eq("runId", run._id).eq("toolCallId", approval.toolCallId)
    )
    .unique()
  if (invocation && !terminalToolInvocationStatuses.has(invocation.status)) {
    await ctx.db.patch(invocation._id, {
      status: "failed",
      error: "tool approval expired",
      completedAt: now,
      updatedAt: now,
    })
  }

  const resolved = await gatherAssistantMessageFacts(ctx, run, undefined)
  const verdict = resolveGenerationRunTransition(
    { runStatus: run.status, message: resolved?.facts ?? null },
    { kind: "approval-expired" }
  )
  if (verdict.kind === "transition") {
    await applyLifecycleVerdict(ctx, run, verdict, resolved, now)
    await settleAuxiliaryRecordsForTerminalRun(
      ctx,
      run,
      "tool approval expired",
      now
    )
  }
  console.log(
    JSON.stringify({
      _tag: source === "reaper" ? "run_stale_reaped" : "run_approval_expired",
      reason: "approval_expired",
      source,
      runId: run._id,
      chatId: run.chatId,
      approvalId: approval.approvalId,
    })
  )
  return true
}

export async function resolveToolCallDecision(
  ctx: MutationCtx,
  owner: AuthenticatedToolApprovalOwner,
  args: { reason?: string },
  decision: "approved" | "denied"
): Promise<ToolCallDecisionResult> {
  const { user, approval } = owner

  if (approval.status !== "pending") {
    return {
      status: approval.status as "approved" | "denied" | "expired",
      alreadyResolved: true,
      reason: approval.reason,
    }
  }

  const now = nowMs()

  // Expiry is checked TRANSACTIONALLY against the server clock, not left to
  // the cron: a decision racing in after `expiresAt` settles the row as
  // expired here — approving expired work must be impossible regardless of
  // reaper cadence.
  if (now >= approval.expiresAt) {
    await expireToolApprovalForChat(ctx, approval, now, "decision")
    return { status: "expired", alreadyResolved: true, reason: approval.reason }
  }

  await ctx.db.patch(approval._id, {
    status: decision,
    resolvedAt: now,
    resolvedByUserId: user._id,
    reason: args.reason ?? approval.reason,
  })
  return {
    status: decision,
    alreadyResolved: false,
    reason: args.reason ?? approval.reason,
  }
}

const toolCallDecisionArgs = { reason: v.optional(v.string()) }

const approvalOwner = (ctx: {
  user: Doc<"users">
  chat: Doc<"chats">
  run: Doc<"generationRuns">
  approval: Doc<"toolApprovalRequests">
}): AuthenticatedToolApprovalOwner => ({
  user: ctx.user,
  chat: ctx.chat,
  run: ctx.run,
  approval: ctx.approval,
})

export const approveToolCall = ownedToolApprovalMutation({
  args: toolCallDecisionArgs,
  handler: async (ctx, args) =>
    resolveToolCallDecision(ctx, approvalOwner(ctx), args, "approved"),
})

export const denyToolCall = ownedToolApprovalMutation({
  args: toolCallDecisionArgs,
  handler: async (ctx, args) =>
    resolveToolCallDecision(ctx, approvalOwner(ctx), args, "denied"),
})

export async function recordToolInvocationsForChat(
  ctx: MutationCtx,
  owner: AuthenticatedRunOwner,
  args: {
    messageId: Id<"messages">
    stepNumber?: number
    usage?: { inputTokens?: number; outputTokens?: number }
    invocations: Array<{
      toolCallId: string
      toolName: string
      source: Doc<"toolInvocations">["source"]
      input?: unknown
      output?: unknown
      error?: string
      status: Doc<"toolInvocations">["status"]
      approvalRequestId?: string
    }>
  }
) {
  const { run } = owner
  await requireAssistantMessageForRun(ctx, run, args.messageId)

  // A terminal run accepts no further tool-invocation writes — the same
  // read-only rule the snapshot path enforces. This was the one worker op that
  // still accepted writes after settlement. The
  // late writer here is a worker that lost the abort/supersede race flushing
  // its step records.
  if (isTerminalGenerationRunStatus(run.status)) return

  const now = nowMs()

  for (const invocation of args.invocations) {
    const existing = await ctx.db
      .query("toolInvocations")
      .withIndex("by_run_tool_call", (q) =>
        q.eq("runId", run._id).eq("toolCallId", invocation.toolCallId)
      )
      .unique()

    const approval = invocation.approvalRequestId
      ? await ctx.db
          .query("toolApprovalRequests")
          .withIndex("by_approval", (q) =>
            q.eq("approvalId", invocation.approvalRequestId!)
          )
          .unique()
      : null
    if (approval) {
      if (
        approval.chatId !== run.chatId ||
        approval.runId !== run._id ||
        approval.assistantMessageId !== args.messageId
      ) {
        throw new Error("Approval request does not belong to this run")
      }
    } else if (invocation.approvalRequestId) {
      throw new Error("Approval request not found for run")
    }

    const patch = {
      messageId: args.messageId,
      toolName: invocation.toolName,
      source: invocation.source,
      input: invocation.input,
      inputPreview: truncatePreview(invocation.input),
      output: invocation.output,
      outputPreview: truncatePreview(invocation.output),
      error: invocation.error ? truncatePreview(invocation.error) : undefined,
      status: invocation.status,
      approvalId: approval?._id,
      approvalRequestId: invocation.approvalRequestId,
      stepNumber: args.stepNumber,
      completedAt:
        invocation.status === "completed" ||
        invocation.status === "failed" ||
        invocation.status === "denied"
          ? now
          : undefined,
      updatedAt: now,
    }

    if (existing) {
      await ctx.db.patch(existing._id, patch)
    } else {
      await ctx.db.insert("toolInvocations", {
        runId: run._id,
        chatId: run.chatId,
        toolCallId: invocation.toolCallId,
        createdAt: now,
        ...patch,
      })
    }
  }

  // Per-step usage accumulation (ADR-0021): durable evidence for the abort/
  // failure/reaper settlement paths, which cannot rely on the happy-path
  // onEnd aggregate. The completion write replaces each accumulated token
  // count when the SDK's authoritative all-steps aggregate includes it;
  // otherwise it preserves the accumulated value.
  const stepInputTokens = args.usage?.inputTokens ?? 0
  const stepOutputTokens = args.usage?.outputTokens ?? 0
  if (
    !Number.isSafeInteger(stepInputTokens) ||
    stepInputTokens < 0 ||
    !Number.isSafeInteger(stepOutputTokens) ||
    stepOutputTokens < 0 ||
    (args.stepNumber !== undefined &&
      (!Number.isSafeInteger(args.stepNumber) ||
        args.stepNumber <= 0 ||
        args.stepNumber > MAX_DURABLE_USAGE_STEPS))
  ) {
    throw new Error("Invalid per-step usage evidence")
  }
  const hasStepUsage = stepInputTokens > 0 || stepOutputTokens > 0
  let usagePatch:
    | Pick<
        Doc<"generationRuns">,
        "inputTokens" | "outputTokens" | "usageSteps" | "lastUsageStepNumber"
      >
    | undefined

  if (hasStepUsage && args.stepNumber !== undefined) {
    const existingSteps = run.usageSteps ?? []
    const existingStep = existingSteps.find(
      (step) => step.stepNumber === args.stepNumber
    )
    if (
      existingStep &&
      ((existingStep.inputTokens ?? 0) !== stepInputTokens ||
        (existingStep.outputTokens ?? 0) !== stepOutputTokens)
    ) {
      console.warn(
        JSON.stringify({
          _tag: "generation_step_usage_conflict",
          runId: run._id,
          stepNumber: args.stepNumber,
        })
      )
    } else if (!existingStep) {
      if (existingSteps.length >= MAX_DURABLE_USAGE_STEPS) {
        throw new Error("Per-step usage evidence exceeds the durable step limit")
      }
      const usageSteps = [
        ...existingSteps,
        {
          stepNumber: args.stepNumber,
          ...(args.usage?.inputTokens !== undefined
            ? { inputTokens: args.usage.inputTokens }
            : {}),
          ...(args.usage?.outputTokens !== undefined
            ? { outputTokens: args.usage.outputTokens }
            : {}),
        },
      ].sort((left, right) => left.stepNumber - right.stepNumber)
      const sum = (field: "inputTokens" | "outputTokens") => {
        const total = usageSteps.reduce(
          (current, step) => current + BigInt(step[field] ?? 0),
          BigInt(0)
        )
        if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new RangeError("Per-step usage total exceeds safe integer range")
        }
        return Number(total)
      }
      usagePatch = {
        usageSteps,
        inputTokens: sum("inputTokens"),
        outputTokens: sum("outputTokens"),
        lastUsageStepNumber: Math.max(
          run.lastUsageStepNumber ?? 0,
          args.stepNumber
        ),
      }
    }
  } else if (hasStepUsage) {
    // Deployment compatibility for the pre-step-number worker contract.
    const inputTokens = BigInt(run.inputTokens ?? 0) + BigInt(stepInputTokens)
    const outputTokens =
      BigInt(run.outputTokens ?? 0) + BigInt(stepOutputTokens)
    if (
      inputTokens > BigInt(Number.MAX_SAFE_INTEGER) ||
      outputTokens > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new RangeError("Per-step usage total exceeds safe integer range")
    }
    usagePatch = {
      inputTokens: Number(inputTokens),
      outputTokens: Number(outputTokens),
      usageSteps: run.usageSteps,
      lastUsageStepNumber: run.lastUsageStepNumber,
    }
  }

  if (args.invocations.length > 0 || hasStepUsage) {
    // Accepted tool activity is progress evidence, not
    // liveness; the heartbeat alone renews the lease.
    let reservation: Doc<"usageReservations"> | null = null
    if (usagePatch) {
      reservation = await ctx.db
        .query("usageReservations")
        .withIndex("by_run", (q) => q.eq("generationRunId", run._id))
        .unique()
      if (reservation) {
        // Validate the priced total, not just each token field. A max-safe
        // token count can still overflow credits and must never become durable
        // evidence that every reconciler retry will reject forever.
        computeUsageCredits(reservation.pricingSnapshot.primary, {
          inputTokens: usagePatch.inputTokens,
          outputTokens: usagePatch.outputTokens,
        })
      }
    }
    await ctx.db.patch(run._id, {
      lastProgressAt: now,
      updatedAt: now,
      ...usagePatch,
    })
    if (usagePatch && reservation?.status === "reserved") {
      await ctx.db.patch(reservation._id, {
        observedInputTokens: usagePatch.inputTokens,
        observedOutputTokens: usagePatch.outputTokens,
        updatedAt: now,
      })
    }
  }
}

// Reconciliation reapers are internal mutations
// (transactional, exactly-once per invocation — never actions), invoked by
// convex/crons.ts. Bounded per status per tick (REAPER_BATCH_LIMIT); the
// next tick finishes what this one left.
//
// Load-bearing range shape: Convex orders `undefined < null < all
// other values`, and documents missing an indexed field sort as `undefined` —
// so every expiry range MUST exclude `undefined` via `.gt(field, undefined)`
// or pre-heartbeat rows (no lease fields) would be falsely reaped.
//
// Deploy-boundary drain rule: enable these crons only after every
// in-flight run started by a pre-heartbeat deploy has drained. With the
// `undefined` exclusion this is belt-and-suspenders; pre-launch it is
// trivially satisfied (dev data is disposable).

// Modest by design: each reaped run also settles its auxiliary records
// (pending approvals + non-terminal tool invocations) inside the SAME
// transaction, so the per-tick write volume is candidates × per-run records.
// An oversized batch that trips Convex transaction limits fails atomically
// and would re-select the identical oldest candidates every tick — permanent
// starvation. 25 keeps a pathological backlog draining incrementally
// (25/status/tick at a 15 s cadence clears thousands per hour).
const REAPER_BATCH_LIMIT = 25

/**
 * Settle the auxiliary records a terminal run leaves behind: pending
 * approvals expire; non-terminal tool invocations fail. Partial assistant
 * content is preserved by the lifecycle's terminal message policy — never
 * erased here.
 * The per-run collects are unbounded queries over naturally bounded sets:
 * both tables are keyed by runId, and one run accrues at most a handful of
 * approvals and step-count-bounded invocations (maxSteps caps the stream).
 */
async function settleAuxiliaryRecordsForTerminalRun(
  ctx: MutationCtx,
  run: Doc<"generationRuns">,
  error: string,
  now: number
) {
  const pendingApprovals = await ctx.db
    .query("toolApprovalRequests")
    .withIndex("by_run_status", (q) =>
      q.eq("runId", run._id).eq("status", "pending")
    )
    .collect()
  for (const approval of pendingApprovals) {
    await ctx.db.patch(approval._id, { status: "expired", resolvedAt: now })
  }

  const invocations = await ctx.db
    .query("toolInvocations")
    .withIndex("by_run", (q) => q.eq("runId", run._id))
    .collect()
  for (const invocation of invocations) {
    if (terminalToolInvocationStatuses.has(invocation.status)) continue
    await ctx.db.patch(invocation._id, {
      status: "failed",
      error,
      completedAt: now,
      updatedAt: now,
    })
  }
}

/**
 * Fail runs whose worker lease lapsed. Every candidate is validated inside
 * this transaction: the indexed read IS the transactional state (Convex
 * mutations are serializable — a concurrently renewing heartbeat conflicts
 * and one of the two retries against the other's committed state), and the
 * lifecycle's `lease-expired` rule re-checks worker-executing status. A
 * reaped run becomes failed/lease_expired — never fake-completed — with
 * partial content preserved.
 */
export async function reapExpiredGenerationRunsPass(
  ctx: MutationCtx
): Promise<{ reaped: number }> {
  {
    const now = nowMs()
    let reaped = 0
    for (const status of ["running", "streaming"] as const) {
      const candidates = await ctx.db
        .query("generationRuns")
        .withIndex("by_status_lease_expires", (q) =>
          q
            .eq("status", status)
            .gt("leaseExpiresAt", undefined)
            .lt("leaseExpiresAt", now)
        )
        .take(REAPER_BATCH_LIMIT)
      for (const run of candidates) {
        // Belt-and-suspenders re-validation of the fields the range implies.
        if (run.leaseExpiresAt === undefined || run.leaseExpiresAt >= now) {
          continue
        }
        const chat = await ctx.db.get(run.chatId)
        if (!chat || !(await isChatActive(ctx, chat))) continue
        const currentRun = await ctx.db.get(run._id)
        if (!currentRun) continue
        const resolved = await gatherAssistantMessageFacts(
          ctx,
          currentRun,
          undefined
        )
        const verdict = resolveGenerationRunTransition(
          { runStatus: currentRun.status, message: resolved?.facts ?? null },
          { kind: "lease-expired" }
        )
        if (verdict.kind !== "transition") continue
        await applyLifecycleVerdict(ctx, currentRun, verdict, resolved, now)
        await settleAuxiliaryRecordsForTerminalRun(
          ctx,
          currentRun,
          "generation worker lease expired",
          now
        )
        reaped++
        console.log(
          JSON.stringify({
            _tag: "run_stale_reaped",
            runId: run._id,
            chatId: run.chatId,
            status,
            heartbeatAt: run.heartbeatAt,
            leaseExpiresAt: run.leaseExpiresAt,
            ageMs: run.startedAt === undefined ? null : now - run.startedAt,
          })
        )
      }
    }
    return { reaped }
  }
}

export const reapExpiredGenerationRuns = internalMutation({
  args: {},
  handler: async (ctx) => reapExpiredGenerationRunsPass(ctx),
})

/**
 * Expire approval pauses nobody resolved. The pending approval row settles as
 * `expired`; its run (if still paused) fails with `approval_expired` through
 * the lifecycle rule, preserving the pre-approval content tail.
 */
export async function reapExpiredToolApprovalsPass(
  ctx: MutationCtx
): Promise<{ expired: number }> {
  {
    const now = nowMs()
    let expired = 0
    const candidates = await ctx.db
      .query("toolApprovalRequests")
      .withIndex("by_status_expires", (q) =>
        q.eq("status", "pending").lte("expiresAt", now)
      )
      .take(REAPER_BATCH_LIMIT)
    for (const approval of candidates) {
      if (approval.expiresAt > now) continue
      const run = await ctx.db.get(approval.runId)
      if (!run) continue
      const chat = await ctx.db.get(run.chatId)
      if (!chat || !(await isChatActive(ctx, chat))) continue
      const currentApproval = await ctx.db.get(approval._id)
      if (
        currentApproval &&
        (await expireToolApprovalForChat(ctx, currentApproval, now, "reaper"))
      ) {
        expired++
      }
    }
    return { expired }
  }
}

export const reapExpiredToolApprovals = internalMutation({
  args: {},
  handler: async (ctx) => reapExpiredToolApprovalsPass(ctx),
})

/**
 * Settle awaiting_approval runs whose approvals are ALL resolved but whose
 * continuation never dispatched (the client crashed or reloaded before
 * auto-send, or a historical strand). Such a pause sits outside both other
 * reapers — no lease (the pause sheds it) and no pending approval (the rows
 * resolved) — and outside next-turn convergence too: deny-pending only touches
 * pending rows and the supersede sweep never reaches a pause, so without this
 * pass it looks awaiting forever.
 *
 * Eligibility is transactional and fail-closed:
 *  - at least one approval row, none pending (a pending row means the user or
 *    the approval reaper still owns the pause);
 *  - no `continuationRunId` (a stamped continuation means a prepare owns the
 *    close — unreachable while still paused, but never fight it);
 *  - every resolution carries a defined `resolvedAt`, and the NEWEST one is
 *    older than the grace window. An undated resolution is excluded, never
 *    treated as infinitely old — the same `undefined` rule applied to this
 *    pass's expiry comparison (`undefined` must not classify as "expired").
 *
 * The grace window (measured from the last `resolvedAt`) keeps the live
 * approve → auto-send → prepare path unraced; a continuation that still
 * arrives after the reap hits the existing `pausedRunWasLive` conflict (the
 * lifecycle's continuation-lost rule only ever touches awaiting_approval, so
 * a Stop-settled or already-continued run is untouchable). The chat
 * projection stays statusRunId-guarded, so a pause that already transferred
 * the slot to a next send cannot clear the newer run's status.
 */
/**
 * Candidate scan window for the resolved-approvals pass — deliberately wider
 * than the settle budget. Unlike the lease/approval reapers, whose index
 * ranges select only eligible rows, this pass's eligibility (no pending
 * approval, dated resolutions, grace elapsed) is only decidable per candidate
 * — so legitimately ineligible pauses (users still deciding, resolutions
 * inside the grace) sit in the `by_status` prefix. A scan capped at the
 * settle budget would let 25 such rows curtain off every eligible strand
 * behind them permanently. Examining an ineligible candidate costs a handful
 * of reads; settling remains bounded by REAPER_BATCH_LIMIT.
 */
const RESOLVED_PAUSE_SCAN_LIMIT = 8 * REAPER_BATCH_LIMIT
const RESOLVED_PAUSE_REAPER_CHECKPOINT = "resolved_approval_pauses_by_status_v1"

export async function reapResolvedApprovalPausesPass(
  ctx: MutationCtx
): Promise<{ settled: number }> {
  const now = nowMs()
  let settled = 0
  const checkpoint = await ctx.db
    .query("reaperCheckpoints")
    .withIndex("by_name", (q) => q.eq("name", RESOLVED_PAUSE_REAPER_CHECKPOINT))
    .unique()
  const scanCursor = checkpoint?.cursor ?? null
  const candidatesPage = await ctx.db
    .query("generationRuns")
    .withIndex("by_status", (q) => q.eq("status", "awaiting_approval"))
    .paginate({
      cursor: scanCursor,
      numItems: RESOLVED_PAUSE_SCAN_LIMIT,
      maximumRowsRead: RESOLVED_PAUSE_SCAN_LIMIT,
    })
  let scanned = 0
  let pageFullyExamined = true
  for (const candidate of candidatesPage.page) {
    if (settled >= REAPER_BATCH_LIMIT) {
      pageFullyExamined = false
      break
    }
    scanned++
    const run = await ctx.db.get(candidate._id)
    if (!run || run.status !== "awaiting_approval") continue
    if (run.continuationRunId !== undefined) continue
    const chat = await ctx.db.get(run.chatId)
    if (!chat || !(await isChatActive(ctx, chat))) continue

    // Prefix read on by_run_status: ALL approval rows for the run, any status.
    const approvals = await ctx.db
      .query("toolApprovalRequests")
      .withIndex("by_run_status", (q) => q.eq("runId", run._id))
      .collect()
    if (approvals.length === 0) continue
    let anyPending = false
    let anyDenied = false
    let anyUndated = false
    let latestResolvedAt = 0
    for (const approval of approvals) {
      if (approval.status === "pending") {
        anyPending = true
        break
      }
      if (approval.status !== "approved") anyDenied = true
      if (approval.resolvedAt === undefined) {
        anyUndated = true
        continue
      }
      latestResolvedAt = Math.max(latestResolvedAt, approval.resolvedAt)
    }
    if (anyPending || anyUndated) continue
    if (now < latestResolvedAt + RESOLVED_APPROVAL_CONTINUATION_GRACE_MS) {
      continue
    }

    const resolved = await gatherAssistantMessageFacts(ctx, run, undefined)
    const verdict = resolveGenerationRunTransition(
      { runStatus: run.status, message: resolved?.facts ?? null },
      { kind: "continuation-lost", anyDenied }
    )
    if (verdict.kind !== "transition") continue
    await applyLifecycleVerdict(ctx, run, verdict, resolved, now)
    await settleAuxiliaryRecordsForTerminalRun(
      ctx,
      run,
      "approval continuation was not dispatched",
      now
    )
    settled++
    console.log(
      JSON.stringify({
        _tag: "run_stale_reaped",
        reason: "continuation_lost",
        runId: run._id,
        chatId: run.chatId,
        anyDenied,
        latestResolvedAt,
        ageMs: now - latestResolvedAt,
      })
    )
  }

  // Advance only after examining the whole page. If 25 eligible rows consume
  // the settlement budget partway through, hold the input cursor: those rows
  // leave by_status after this transaction, so the next tick re-opens the same
  // page without skipping its unexamined tail. A fully examined final page
  // wraps to the beginning, allowing rows inserted behind the cursor to join
  // the next sweep.
  const nextCursor = pageFullyExamined
    ? candidatesPage.isDone
      ? undefined
      : candidatesPage.continueCursor
    : checkpoint?.cursor
  const checkpointPatch = {
    cursor: nextCursor,
    updatedAt: now,
  }
  if (checkpoint) {
    await ctx.db.patch(checkpoint._id, checkpointPatch)
  } else {
    await ctx.db.insert("reaperCheckpoints", {
      name: RESOLVED_PAUSE_REAPER_CHECKPOINT,
      ...checkpointPatch,
    })
  }

  if (!pageFullyExamined) {
    console.info(
      JSON.stringify({
        _tag: "resolved_pause_settle_budget_exhausted",
        scanned,
        settled,
        cursorHeld: true,
      })
    )
  }
  return { settled }
}

export const reapResolvedApprovalPauses = internalMutation({
  args: {},
  handler: async (ctx) => reapResolvedApprovalPausesPass(ctx),
})
