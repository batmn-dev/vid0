import { afterEach, describe, expect, it, vi } from "vitest"
import type { Doc, Id } from "./_generated/dataModel"
import type { MutationCtx } from "./_generated/server"
import {
  applyApprovalResponses,
  closeSupersededGenerationsForChat,
  createToolApprovalRequestForChat,
  denyPendingApprovalsForChat,
  generationRunWriteArgs,
  heartbeatGenerationRunForChat,
  markGenerationWorkStartedForChat,
  markGenerationRunAbortedForChat,
  markGenerationRunCompletedForChat,
  markGenerationRunFailedForChat,
  prepareGenerationForChat,
  prepareGenerationWithVerifiedAdmission,
  reapExpiredGenerationRunsPass,
  reapExpiredToolApprovalsPass,
  reapResolvedApprovalPausesPass,
  recordTitleUsageEvidenceForChat,
  recordToolInvocationsForChat,
  resolveToolCallDecision,
  stopGenerationRunForChat,
  updateAssistantSnapshotForChat,
} from "./chatRuntime"
import {
  APPROVAL_EXPIRY_MS,
  LEASE_DURATION_MS,
  RESOLVED_APPROVAL_CONTINUATION_GRACE_MS,
} from "./domain/generation_run_liveness"
import { getSelectedPathMessages } from "./domain/message_branches"
import {
  type AuthenticatedRunOwner,
  requireOwnedChat,
  requireOwnedChatByPublicId,
  requireOwnedToolApproval,
} from "./lib/auth"
import {
  CANCELLATION_SETTLEMENT_PROTOCOL_VERSION,
  signChatAdmissionProof,
} from "./lib/chatAdmissionProof"
import { TIMING_RECEIPT_ATTACH_WINDOW_MS } from "./lib/runTimingReceipt"
import { selectBranchForChat } from "./messages"

// The cores take the owner their builders inject (ADR-0003). These resolve it
// the same way the builders do, so every existing call site keeps its shape.
async function prepareAsOwner(
  ctx: MutationCtx,
  {
    chatId,
    ...args
  }: Parameters<typeof prepareGenerationForChat>[2] & { chatId: Id<"chats"> }
) {
  return prepareGenerationForChat(ctx, await requireOwnedChat(ctx, chatId), args)
}

async function prepareVerifiedAsOwner(
  ctx: MutationCtx,
  {
    chatId,
    ...args
  }: Parameters<typeof prepareGenerationWithVerifiedAdmission>[2] & {
    chatId: string
  },
  options?: Parameters<typeof prepareGenerationWithVerifiedAdmission>[3]
) {
  return prepareGenerationWithVerifiedAdmission(
    ctx,
    await requireOwnedChatByPublicId(ctx, chatId),
    args,
    options
  )
}

async function decideAsOwner(
  ctx: MutationCtx,
  { approvalId, ...args }: { approvalId: string; reason?: string },
  decision: "approved" | "denied"
) {
  return resolveToolCallDecision(
    ctx,
    await requireOwnedToolApproval(ctx, approvalId),
    args,
    decision
  )
}

type TableDocuments = {
  toolApprovalRequests: Doc<"toolApprovalRequests">[]
  generationRuns: Doc<"generationRuns">[]
  reaperCheckpoints: Doc<"reaperCheckpoints">[]
  messages: Doc<"messages">[]
  toolInvocations: Doc<"toolInvocations">[]
  users: Doc<"users">[]
  chats: Doc<"chats">[]
  projects: Doc<"projects">[]
  usageBuckets: Doc<"usageBuckets">[]
  usageReservations: Doc<"usageReservations">[]
  usageLedgerEntries: Doc<"usageLedgerEntries">[]
}

type TableName = keyof TableDocuments
type StoredDocument = TableDocuments[TableName][number]

type QueryBuilder = {
  eq: (fieldName: string, value: unknown) => QueryBuilder
  gt: (fieldName: string, value: unknown) => QueryBuilder
  lt: (fieldName: string, value: unknown) => QueryBuilder
  lte: (fieldName: string, value: unknown) => QueryBuilder
}

// Convex index-order rank: undefined < null < everything else. Enough to model
// the reaper's `.gt(field, undefined).lt(field, now)` range in the fake db.
function convexOrderRank(value: unknown): number {
  if (value === undefined) return 0
  if (value === null) return 1
  return 2
}

function convexOrderCompare(left: unknown, right: unknown): number {
  const rankDelta = convexOrderRank(left) - convexOrderRank(right)
  if (rankDelta !== 0) return rankDelta
  if (typeof left === "number" && typeof right === "number") {
    return left === right ? 0 : left < right ? -1 : 1
  }
  return 0
}

type MutationCtxOptions = {
  cloneReads?: boolean
}

function asId<Table extends TableName | "users" | "chats">(
  value: string
): Id<Table> {
  return value as Id<Table>
}

function cloneStoredDocument<Document extends StoredDocument>(
  document: Document
): Document {
  return structuredClone(document) as Document
}

function createMutationCtx(
  tablesInput: Partial<TableDocuments>,
  options: MutationCtxOptions = {}
) {
  const tables: TableDocuments = {
    toolApprovalRequests: [],
    generationRuns: [],
    reaperCheckpoints: [],
    messages: [],
    toolInvocations: [],
    users: [],
    chats: [],
    projects: [],
    usageBuckets: [],
    usageReservations: [],
    usageLedgerEntries: [],
    ...tablesInput,
  }
  const patches: Array<{
    id: string
    value: Record<string, unknown>
  }> = []
  const getCalls: string[] = []
  const deletes: string[] = []
  const inserts: Array<{
    tableName: TableName
    id: string
    value: Record<string, unknown>
  }> = []

  function findDocument(id: string): StoredDocument | null {
    for (const documents of Object.values(tables)) {
      const document = documents.find((candidate) => candidate._id === id)
      if (document) return document
    }
    return null
  }

  function readDocument<Document extends StoredDocument>(
    document: Document
  ): Document {
    return options.cloneReads ? cloneStoredDocument(document) : document
  }

  const ctx = {
    db: {
      get: async (id: string) => {
        getCalls.push(id)
        const document = findDocument(id)
        return document ? readDocument(document) : null
      },
      normalizeId: (tableName: TableName, id: string) => {
        return tables[tableName].some((document) => document._id === id)
          ? asId<TableName>(id)
          : null
      },
      query: (tableName: TableName) => ({
        withIndex: (
          indexName: string,
          buildQuery: (query: QueryBuilder) => unknown
        ) => {
          const filters = new Map<string, unknown>()
          const rangeFilters: Array<{
            fieldName: string
            op: "gt" | "lt" | "lte"
            value: unknown
          }> = []
          const query: QueryBuilder = {
            eq: (fieldName, value) => {
              filters.set(fieldName, value)
              return query
            },
            gt: (fieldName, value) => {
              rangeFilters.push({ fieldName, op: "gt", value })
              return query
            },
            lt: (fieldName, value) => {
              rangeFilters.push({ fieldName, op: "lt", value })
              return query
            },
            lte: (fieldName, value) => {
              rangeFilters.push({ fieldName, op: "lte", value })
              return query
            },
          }
          buildQuery(query)

          let results = (tables[tableName] as StoredDocument[]).filter(
            (document) => {
              const record = document as unknown as Record<string, unknown>
              for (const [fieldName, value] of filters) {
                if (record[fieldName] !== value) return false
              }
              for (const range of rangeFilters) {
                const comparison = convexOrderCompare(
                  record[range.fieldName],
                  range.value
                )
                if (range.op === "gt" && comparison <= 0) return false
                if (range.op === "lt" && comparison >= 0) return false
                if (range.op === "lte" && comparison > 0) return false
              }
              return true
            }
          )
          if (tableName === "generationRuns" && indexName === "by_status") {
            results = [...results].sort((left, right) => {
              const creationDelta = left._creationTime - right._creationTime
              return creationDelta !== 0
                ? creationDelta
                : String(left._id).localeCompare(String(right._id))
            })
          }

          const resultApi = {
            collect: async () =>
              results.map((document) => readDocument(document)),
            unique: async () => {
              expect(results.length).toBeLessThanOrEqual(1)
              return results[0] ? readDocument(results[0]) : null
            },
            order: (direction: "asc" | "desc") => {
              results = [...results].sort((a, b) => {
                const leftRecord = a as unknown as {
                  orderId?: number
                  sequence?: number
                }
                const rightRecord = b as unknown as {
                  orderId?: number
                  sequence?: number
                }
                const left = leftRecord.sequence ?? leftRecord.orderId ?? 0
                const right = rightRecord.sequence ?? rightRecord.orderId ?? 0
                return direction === "desc" ? right - left : left - right
              })
              return resultApi
            },
            first: async () => (results[0] ? readDocument(results[0]) : null),
            take: async (limit: number) =>
              results.slice(0, limit).map((document) => readDocument(document)),
            paginate: async ({
              cursor,
              numItems,
            }: {
              cursor: string | null
              numItems: number
            }) => {
              const cursorPosition = cursor
                ? (JSON.parse(cursor) as {
                    creationTime: number
                    id: string
                  })
                : null
              const startIndex =
                cursorPosition === null
                  ? 0
                  : results.findIndex((document) => {
                      if (
                        document._creationTime !== cursorPosition.creationTime
                      ) {
                        return (
                          document._creationTime > cursorPosition.creationTime
                        )
                      }
                      return String(document._id) > cursorPosition.id
                    })
              const normalizedStartIndex =
                startIndex === -1 ? results.length : startIndex
              const page = results.slice(
                normalizedStartIndex,
                normalizedStartIndex + numItems
              )
              const last = page.at(-1)
              return {
                page: page.map((document) => readDocument(document)),
                isDone: normalizedStartIndex + page.length >= results.length,
                continueCursor: last
                  ? JSON.stringify({
                      creationTime: last._creationTime,
                      id: String(last._id),
                    })
                  : (cursor ?? ""),
              }
            },
          }
          return resultApi
        },
      }),
      insert: async (tableName: TableName, value: Record<string, unknown>) => {
        const id = asId<TableName>(
          `${tableName}_${tables[tableName].length + 1}`
        )
        const document = {
          _id: id,
          _creationTime: Date.now(),
          ...value,
        } as StoredDocument
        ;(tables[tableName] as StoredDocument[]).push(document)
        inserts.push({ tableName, id, value })
        return id
      },
      patch: async (id: string, value: Record<string, unknown>) => {
        patches.push({ id, value })
        const document = findDocument(id)
        expect(document).not.toBeNull()
        Object.assign(document as unknown as Record<string, unknown>, value)
      },
      delete: async (id: string) => {
        deletes.push(id)
        for (const tableDocuments of Object.values(tables)) {
          const index = tableDocuments.findIndex(
            (candidate) => candidate._id === id
          )
          if (index !== -1) {
            tableDocuments.splice(index, 1)
            return
          }
        }
        throw new Error(`Document not found: ${id}`)
      },
    },
    auth: {
      getUserIdentity: async () => ({ subject: "workos_user_1" }),
    },
  } as unknown as MutationCtx

  return { ctx, getCalls, patches, deletes, inserts, tables }
}

/**
 * Build the `AuthenticatedRunOwner` a run-scoped core now receives — the same
 * `{ user, chat, run }` bundle `ownedGenerationRunMutation` injects in
 * production. Deriving all three from the run doc mirrors the builder's
 * transitive ownership (run → chat → owner), so tests exercise the cores'
 * logic without re-standing-up the auth path the builder is tested against once.
 */
async function runOwner(
  ctx: MutationCtx,
  runId: Id<"generationRuns">
): Promise<AuthenticatedRunOwner> {
  const run = await ctx.db.get(runId)
  if (!run) throw new Error(`runOwner: generation run ${runId} not found`)
  const chat = await ctx.db.get(run.chatId)
  if (!chat) throw new Error(`runOwner: chat ${run.chatId} not found`)
  const user = await ctx.db.get(chat.userId)
  if (!user) throw new Error(`runOwner: user ${chat.userId} not found`)
  return { user, chat, run }
}

function createOwnerFixture() {
  const userId = asId<"users">("user_1")
  const chatId = asId<"chats">("chat_1")
  const user: Doc<"users"> = {
    _id: userId,
    _creationTime: 1,
    workosUserId: "workos_user_1",
    email: "user@example.com",
  }
  const chat: Doc<"chats"> = {
    _id: chatId,
    _creationTime: 1,
    publicId: "chat-1-public",
    userId,
    public: false,
    pinned: false,
    updatedAt: 1,
  }

  return { user, chat, userId, chatId }
}

function createStoredMessage({
  id,
  chatId,
  userId,
  orderId,
  clientMessageId,
  role,
  content,
  createdAt,
}: {
  id: string
  chatId: Id<"chats">
  userId?: Id<"users">
  orderId: number
  clientMessageId?: string
  role: "user" | "assistant"
  content: string
  createdAt: number
}): Doc<"messages"> {
  return {
    _id: asId<"messages">(id),
    _creationTime: createdAt,
    chatId,
    orderId,
    clientMessageId,
    userId: role === "user" ? userId : undefined,
    role,
    content,
    parts: [{ type: "text", text: content }],
    status: "completed",
    createdAt,
    updatedAt: createdAt,
  }
}

function createAssistantRuntimeMessage({
  id,
  chatId,
  runId,
  orderId,
  content = "",
  parts = [],
  status = "streaming",
  createdAt = 1001,
}: {
  id: string
  chatId: Id<"chats">
  runId?: Id<"generationRuns">
  orderId: number
  content?: string
  parts?: unknown
  status?: Doc<"messages">["status"]
  createdAt?: number
}): Doc<"messages"> {
  return {
    _id: asId<"messages">(id),
    _creationTime: createdAt,
    chatId,
    orderId,
    role: "assistant",
    content,
    parts,
    status,
    requestId: runId ? "request_1" : undefined,
    generationRunId: runId,
    model: "gpt-5",
    provider: "openai",
    createdAt,
    updatedAt: createdAt,
  }
}

function createGenerationRun({
  id,
  chatId,
  userId,
  assistantMessageId,
  status = "streaming",
  updatedAt = 1001,
}: {
  id: string
  chatId: Id<"chats">
  userId: Id<"users">
  assistantMessageId?: Id<"messages">
  status?: Doc<"generationRuns">["status"]
  updatedAt?: number
}): Doc<"generationRuns"> {
  return {
    _id: asId<"generationRuns">(id),
    _creationTime: updatedAt,
    chatId,
    userId,
    requestId: "request_1",
    model: "gpt-5",
    provider: "openai",
    status,
    startedAt: updatedAt,
    updatedAt,
    activeStreamId: assistantMessageId,
    assistantMessageId,
  }
}

function createGenerationRunLinkageFixture() {
  const { user, chat, userId, chatId } = createOwnerFixture()
  const runId = asId<"generationRuns">("run_1")
  const otherRunId = asId<"generationRuns">("run_2")
  const messageId = asId<"messages">("message_1")
  const otherMessageId = asId<"messages">("message_2")
  const run = createGenerationRun({
    id: runId,
    chatId,
    userId,
    assistantMessageId: messageId,
  })
  const message = createAssistantRuntimeMessage({
    id: messageId,
    chatId,
    runId,
    orderId: 1,
  })
  const otherMessage = createAssistantRuntimeMessage({
    id: otherMessageId,
    chatId,
    runId: otherRunId,
    orderId: 2,
  })
  const tables: TableDocuments = {
    toolApprovalRequests: [],
    generationRuns: [run],
    reaperCheckpoints: [],
    messages: [message, otherMessage],
    toolInvocations: [],
    users: [user],
    chats: [chat],
    projects: [],
    usageBuckets: [],
    usageReservations: [],
    usageLedgerEntries: [],
  }

  return {
    user,
    chat,
    userId,
    chatId,
    runId,
    otherRunId,
    messageId,
    otherMessageId,
    run,
    message,
    otherMessage,
    tables,
  }
}

function createApprovalContinuationFixture(
  decisions: Array<{
    approvalId: string
    approved: boolean
    toolCallId: string
    toolName: string
  }>
) {
  const { user, chat, userId, chatId } = createOwnerFixture()
  const runId = asId<"generationRuns">("run_1")
  const messageId = asId<"messages">("message_1")
  const run: Doc<"generationRuns"> = {
    _id: runId,
    _creationTime: 1,
    chatId,
    userId,
    requestId: "request_1",
    model: "gpt-5",
    provider: "openai",
    status: "awaiting_approval",
    startedAt: 1,
    updatedAt: 1,
    activeStreamId: "message_1",
    assistantMessageId: messageId,
  }
  const message: Doc<"messages"> = {
    _id: messageId,
    _creationTime: 1,
    chatId,
    orderId: 1,
    role: "assistant",
    content: "",
    parts: decisions.map((decision) => ({
      type: `tool-${decision.toolName}`,
      toolCallId: decision.toolCallId,
      state: "approval-requested",
      input: {},
      approval: { id: decision.approvalId },
    })),
    status: "awaiting_approval",
    requestId: "request_1",
    generationRunId: runId,
    model: "gpt-5",
    provider: "openai",
    createdAt: 1,
    updatedAt: 1,
  }
  const requests: Doc<"toolApprovalRequests">[] = decisions.map(
    (decision, index) => ({
      _id: asId<"toolApprovalRequests">(`approval_request_${index + 1}`),
      _creationTime: 1,
      chatId,
      runId,
      assistantMessageId: messageId,
      userId,
      toolCallId: decision.toolCallId,
      toolName: decision.toolName,
      source: "mcp",
      riskClass: "write",
      approvalId: decision.approvalId,
      status: decision.approved ? "approved" : "denied",
      createdAt: 1,
      expiresAt: 60_000,
    })
  )
  const invocations: Doc<"toolInvocations">[] = decisions.map(
    (decision, index) => ({
      _id: asId<"toolInvocations">(`tool_invocation_${index + 1}`),
      _creationTime: 1,
      runId,
      chatId,
      messageId,
      toolCallId: decision.toolCallId,
      toolName: decision.toolName,
      source: "mcp",
      input: {},
      status: "pending_approval",
      createdAt: 1,
      updatedAt: 1,
    })
  )
  const tables = {
    toolApprovalRequests: requests,
    generationRuns: [run],
    messages: [message],
    toolInvocations: invocations,
  }
  const responses = decisions.map((decision) => ({
    messageId,
    approvalId: decision.approvalId,
    toolCallId: decision.toolCallId,
    toolName: decision.toolName,
    approved: decision.approved,
  }))

  return {
    owner: { user, chat },
    run,
    invocations,
    tables,
    responses,
  }
}

describe("prepareGenerationForChat", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("persists the route-resolution receipt beside the logical model", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { user, chat, chatId } = createOwnerFixture()
    const { ctx, tables } = createMutationCtx({
      users: [user],
      chats: [chat],
      messages: [],
    })

    const admission = {
      chatId: chat.publicId,
      requestId: "request_route_receipt",
      model: "claude-sonnet-5",
      provider: "openrouter",
      expectedVisibleMessageCount: 0,
      route: {
        routeId: "openrouter:anthropic/claude-sonnet-5",
        credentialSource: "byok" as const,
        routeReason: "priority_byok" as const,
      },
      generationBudget: { requested: 16_384, applied: 16_384 },
      latestUserMessage: {
        id: "user-new",
        role: "user" as const,
        content: "hi",
        parts: [{ type: "text", text: "hi" }],
      },
      grantDigest: "a".repeat(64),
      cancellationSettlementVersion:
        CANCELLATION_SETTLEMENT_PROTOCOL_VERSION,
      admissionIssuedAt: 1700000000000,
    }
    const secret = "test-chat-admission-secret-with-32-bytes"

    await prepareVerifiedAsOwner(
      ctx,
      {
        ...admission,
        admissionProof: signChatAdmissionProof(
          { ...admission, issuedAt: admission.admissionIssuedAt },
          secret
        ),
      },
      { secret, now: admission.admissionIssuedAt }
    )

    expect(tables.generationRuns).toHaveLength(1)
    expect(tables.generationRuns[0]).toMatchObject({
      model: "claude-sonnet-5",
      provider: "openrouter",
      routeId: "openrouter:anthropic/claude-sonnet-5",
      credentialSource: "byok",
      routeReason: "priority_byok",
      requestedGenerationBudget: 16_384,
      appliedGenerationBudget: 16_384,
    })
    // The assistant placeholder keeps the logical model + resolved provider.
    const assistant = tables.messages.find(
      (message) => message.role === "assistant"
    )
    expect(assistant).toMatchObject({
      model: "claude-sonnet-5",
      provider: "openrouter",
    })
  })

  it("rejects a stale generation-input hash before mutating chat history or runs", async () => {
    const { user, chat, chatId, userId } = createOwnerFixture()
    const existingMessage = createStoredMessage({
      id: "message_user_existing",
      chatId,
      userId,
      orderId: 0,
      clientMessageId: "user-existing",
      role: "user",
      content: "canonical history changed",
      createdAt: 1000,
    })
    const { ctx, tables } = createMutationCtx({
      users: [user],
      chats: [chat],
      messages: [existingMessage],
    })

    await expect(
      prepareAsOwner(ctx, {
        chatId,
        requestId: "request_stale_generation_input",
        model: "gpt-5-mini",
        provider: "openai",
        generationInputHash: "0".repeat(64),
      })
    ).rejects.toMatchObject({
      data: { code: "generation_input_changed" },
    })

    expect(tables.generationRuns).toHaveLength(0)
    expect(tables.messages).toEqual([existingMessage])
    expect(tables.chats[0]).toEqual(chat)
  })

  it("rejects a tampered route receipt before prepare writes", async () => {
    const { user, chat, chatId } = createOwnerFixture()
    const { ctx, tables } = createMutationCtx({
      users: [user],
      chats: [chat],
      messages: [],
    })
    const issuedAt = 1700000000000
    const secret = "test-chat-admission-secret-with-32-bytes"
    // The proof signs the client-minted publicId; ownership resolves first
    // (ownedChatMutation), so the owned chat must exist for the proof check
    // to be what rejects.
    const signed = {
      chatId: chat.publicId,
      requestId: "request_tampered_route",
      model: "claude-sonnet-5",
      provider: "openrouter",
      route: {
        routeId: "openrouter:anthropic/claude-sonnet-5",
        credentialSource: "byok" as const,
        routeReason: "priority_byok" as const,
      },
      grantDigest: "a".repeat(64),
      cancellationSettlementVersion:
        CANCELLATION_SETTLEMENT_PROTOCOL_VERSION,
      issuedAt,
    }

    await expect(
      prepareVerifiedAsOwner(
        ctx,
        {
          ...signed,
          route: { ...signed.route, credentialSource: "platform" },
          admissionIssuedAt: issuedAt,
          admissionProof: signChatAdmissionProof(signed, secret),
        },
        { secret, now: issuedAt }
      )
    ).rejects.toMatchObject({
      data: { code: "admission_proof_invalid" },
    })
    expect(tables.generationRuns).toHaveLength(0)
    expect(tables.messages).toHaveLength(0)
  })

  it("applies durable edit intent and creates the run in the same mutation path", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { user, chat, userId, chatId } = createOwnerFixture()
    chat.title = "Old generated title"
    chat.titleSource = "generated"
    chat.titleGeneration = 1
    const messages: Doc<"messages">[] = [
      createStoredMessage({
        id: "message_user_1",
        chatId,
        userId,
        orderId: 0,
        clientMessageId: "user-1",
        role: "user",
        content: "old text",
        createdAt: 1000,
      }),
      createStoredMessage({
        id: "message_assistant_1",
        chatId,
        orderId: 1,
        role: "assistant",
        content: "old answer",
        createdAt: 1001,
      }),
      createStoredMessage({
        id: "message_user_2",
        chatId,
        userId,
        orderId: 2,
        clientMessageId: "user-2",
        role: "user",
        content: "later text",
        createdAt: 1002,
      }),
      createStoredMessage({
        id: "message_assistant_2",
        chatId,
        orderId: 3,
        role: "assistant",
        content: "later answer",
        createdAt: 1003,
      }),
    ]
    const { ctx, deletes, tables } = createMutationCtx({
      users: [user],
      chats: [chat],
      messages,
    })

    const result = await prepareAsOwner(ctx, {
      chatId,
      requestId: "request_edit",
      model: "gpt-5",
      provider: "openai",
      edit: {
        editedMessageId: "user-1",
        editCutoffTimestamp: 1000,
        expectedChatVersion: 4,
        replacementMessage: {
          id: "replacement-user",
          role: "user",
          content: "new text",
          parts: [{ type: "text", text: "new text" }],
        },
        regenerateTitle: true,
      },
    })

    expect(deletes).toEqual([])
    expect(tables.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ])
    const replacement = tables.messages.find(
      (message) => message.clientMessageId === "replacement-user"
    )
    expect(replacement).toMatchObject({
      clientMessageId: "replacement-user",
      content: "new text",
      status: "completed",
      branchIndex: 1,
      selected: true,
    })
    expect(messages[0]).toMatchObject({
      selected: false,
    })
    expect(
      tables.messages.find(
        (message) => message._id === result.assistantMessageId
      )
    ).toMatchObject({
      parentMessageId: replacement?._id,
      branchIndex: 0,
      selected: true,
    })
    expect(tables.generationRuns[0]).toMatchObject({
      chatId,
      requestId: "request_edit",
      status: "streaming",
      assistantMessageId: result.assistantMessageId,
    })
    expect(chat).toMatchObject({
      title: "New chat",
      titleSource: "provisional",
      titleGeneration: 2,
      updatedAt: 1700000000000,
    })
    expect(result.titleGeneration).toBe(2)
    expect(result.messages.map((message) => message.clientMessageId)).toEqual([
      "replacement-user",
    ])
  })

  it("reconstructs history by _id and ignores later-message retitling", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { user, chat, userId, chatId } = createOwnerFixture()
    chat.title = "Existing generated title"
    chat.titleSource = "generated"
    chat.titleGeneration = 1
    const messages: Doc<"messages">[] = [
      createStoredMessage({
        id: "message_user_0",
        chatId,
        userId,
        orderId: 0,
        clientMessageId: "user-0",
        role: "user",
        content: "setup",
        createdAt: 900,
      }),
      createStoredMessage({
        id: "message_assistant_0",
        chatId,
        orderId: 1,
        role: "assistant",
        content: "setup answer",
        createdAt: 901,
      }),
      createStoredMessage({
        id: "message_user_1",
        chatId,
        userId,
        orderId: 2,
        clientMessageId: "user-1",
        role: "user",
        content: "old text",
        createdAt: 1000,
      }),
      createStoredMessage({
        id: "message_assistant_1",
        chatId,
        orderId: 3,
        role: "assistant",
        content: "old answer",
        createdAt: 1001,
      }),
      createStoredMessage({
        id: "message_user_2",
        chatId,
        userId,
        orderId: 4,
        clientMessageId: "user-2",
        role: "user",
        content: "stale later prompt",
        createdAt: 1002,
      }),
      createStoredMessage({
        id: "message_assistant_2",
        chatId,
        orderId: 5,
        role: "assistant",
        content: "stale later answer",
        createdAt: 1003,
      }),
    ]
    const { ctx, deletes, tables } = createMutationCtx({
      users: [user],
      chats: [chat],
      messages,
    })

    const result = await prepareAsOwner(ctx, {
      chatId,
      requestId: "request_edit",
      model: "gpt-5",
      provider: "openai",
      edit: {
        editedMessageId: "message_user_1",
        editCutoffTimestamp: 1000,
        expectedChatVersion: 6,
        replacementMessage: {
          id: "replacement-user",
          role: "user",
          content: "new text",
          parts: [{ type: "text", text: "new text" }],
        },
        regenerateTitle: true,
      },
    })

    expect(deletes).toEqual([])
    expect(result.messages.map((message) => message.content)).toEqual([
      "setup",
      "setup answer",
      "new text",
    ])
    expect(result.messages.map((message) => message.clientMessageId)).toEqual([
      "user-0",
      undefined,
      "replacement-user",
    ])
    expect(
      result.messages.some((message) => message.content.includes("stale later"))
    ).toBe(false)
    expect(tables.messages.map((message) => message.content)).toContain(
      "stale later prompt"
    )
    expect(tables.messages.map((message) => message.content)).toContain(
      "stale later answer"
    )
    expect(
      tables.messages.find((message) => message.clientMessageId === "user-1")
    ).toMatchObject({ selected: false })
    expect(
      tables.messages.find(
        (message) => message.clientMessageId === "replacement-user"
      )
    ).toMatchObject({
      parentMessageId: "message_assistant_0",
      selected: true,
    })
    expect(chat).toMatchObject({
      title: "Existing generated title",
      titleSource: "generated",
      titleGeneration: 1,
    })
    expect(result.titleGeneration).toBeUndefined()
  })

  it("keeps legacy descendants selectable after editing the first user message", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { user, chat, userId, chatId } = createOwnerFixture()
    const messages: Doc<"messages">[] = [
      createStoredMessage({
        id: "message_user_1",
        chatId,
        userId,
        orderId: 0,
        clientMessageId: "user-1",
        role: "user",
        content: "first prompt",
        createdAt: 1000,
      }),
      createStoredMessage({
        id: "message_assistant_1",
        chatId,
        orderId: 1,
        role: "assistant",
        content: "first answer",
        createdAt: 1001,
      }),
      createStoredMessage({
        id: "message_user_2",
        chatId,
        userId,
        orderId: 2,
        clientMessageId: "user-2",
        role: "user",
        content: "second prompt",
        createdAt: 1002,
      }),
      createStoredMessage({
        id: "message_assistant_2",
        chatId,
        orderId: 3,
        role: "assistant",
        content: "second answer",
        createdAt: 1003,
      }),
    ]
    const { ctx, tables } = createMutationCtx({
      users: [user],
      chats: [chat],
      messages,
    })

    await prepareAsOwner(ctx, {
      chatId,
      requestId: "request_edit",
      model: "gpt-5",
      provider: "openai",
      edit: {
        editedMessageId: "message_user_1",
        editCutoffTimestamp: 1000,
        expectedChatVersion: 4,
        replacementMessage: {
          id: "replacement-user-1",
          role: "user",
          content: "edited first prompt",
          parts: [{ type: "text", text: "edited first prompt" }],
        },
      },
    })

    await selectBranchForChat(ctx, {
      chatId,
      messageId: asId<"messages">("message_user_1"),
    })

    expect(
      getSelectedPathMessages(tables.messages).map((message) => message._id)
    ).toEqual([
      "message_user_1",
      "message_assistant_1",
      "message_user_2",
      "message_assistant_2",
    ])
  })

  it("does not double-insert duplicate replacement client message IDs", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { user, chat, userId, chatId } = createOwnerFixture()
    const messages: Doc<"messages">[] = [
      createStoredMessage({
        id: "message_user_1",
        chatId,
        userId,
        orderId: 0,
        clientMessageId: "user-1",
        role: "user",
        content: "old text",
        createdAt: 1000,
      }),
      createStoredMessage({
        id: "message_replacement",
        chatId,
        userId,
        orderId: 1,
        clientMessageId: "replacement-user",
        role: "user",
        content: "new text",
        createdAt: 1001,
      }),
      createStoredMessage({
        id: "message_later",
        chatId,
        orderId: 2,
        role: "assistant",
        content: "later answer",
        createdAt: 1002,
      }),
    ]
    const { ctx, tables } = createMutationCtx({
      users: [user],
      chats: [chat],
      messages,
    })

    await prepareAsOwner(ctx, {
      chatId,
      requestId: "request_edit",
      model: "gpt-5",
      provider: "openai",
      edit: {
        editedMessageId: "user-1",
        editCutoffTimestamp: 1000,
        expectedChatVersion: 3,
        replacementMessage: {
          id: "replacement-user",
          role: "user",
          content: "new text",
          parts: [{ type: "text", text: "new text" }],
        },
      },
    })

    expect(
      tables.messages.filter(
        (message) => message.clientMessageId === "replacement-user"
      )
    ).toHaveLength(1)
  })

  it("checks ownership before applying durable edit intent", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { user, chat, userId, chatId } = createOwnerFixture()
    const otherUserId = asId<"users">("user_2")
    chat.userId = otherUserId
    const messages: Doc<"messages">[] = [
      createStoredMessage({
        id: "message_user_1",
        chatId,
        userId,
        orderId: 0,
        clientMessageId: "user-1",
        role: "user",
        content: "old text",
        createdAt: 1000,
      }),
    ]
    const { ctx, deletes, tables } = createMutationCtx({
      users: [user],
      chats: [chat],
      messages,
    })

    await expect(
      prepareAsOwner(ctx, {
        chatId,
        requestId: "request_edit",
        model: "gpt-5",
        provider: "openai",
        edit: {
          editedMessageId: "user-1",
          editCutoffTimestamp: 1000,
          expectedChatVersion: 1,
          replacementMessage: {
            id: "replacement-user",
            role: "user",
            content: "new text",
            parts: [{ type: "text", text: "new text" }],
          },
        },
      })
    ).rejects.toThrow("Not authorized")

    expect(deletes).toEqual([])
    expect(tables.generationRuns).toEqual([])
    expect(tables.messages).toEqual(messages)
  })

  it("accepts normal sends when the selected path token matches", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { user, chat, userId, chatId } = createOwnerFixture()
    const messages: Doc<"messages">[] = [
      createStoredMessage({
        id: "message_user_1",
        chatId,
        userId,
        orderId: 0,
        clientMessageId: "user-1",
        role: "user",
        content: "prompt",
        createdAt: 1000,
      }),
      createStoredMessage({
        id: "message_assistant_1",
        chatId,
        orderId: 1,
        role: "assistant",
        content: "answer",
        createdAt: 1001,
      }),
    ]
    const { ctx, tables } = createMutationCtx({
      users: [user],
      chats: [chat],
      messages,
    })

    const result = await prepareAsOwner(ctx, {
      chatId,
      requestId: "request_followup",
      model: "gpt-5",
      provider: "openai",
      expectedVisibleMessageCount: 2,
      tailMessageId: "message_assistant_1",
      latestUserMessage: {
        id: "user-2",
        role: "user",
        content: "next prompt",
        parts: [{ type: "text", text: "next prompt" }],
      },
    })

    const insertedUser = tables.messages.find(
      (message) => message.clientMessageId === "user-2"
    )
    const insertedAssistant = tables.messages.find(
      (message) => message._id === result.assistantMessageId
    )

    expect(result.messages.map((message) => message.content)).toEqual([
      "prompt",
      "answer",
      "next prompt",
    ])
    expect(insertedUser).toMatchObject({
      parentMessageId: "message_assistant_1",
      branchIndex: 0,
      selected: true,
    })
    expect(insertedAssistant).toMatchObject({
      parentMessageId: insertedUser?._id,
      branchIndex: 0,
      selected: true,
      status: "streaming",
    })
  })

  for (const terminalStub of [
    {
      status: "failed" as const,
      error: "provider rejected",
      historyMarker:
        "[This response failed with an error before producing content.]",
    },
    {
      status: "aborted" as const,
      error: "stream aborted",
      historyMarker: "[This response was stopped before producing content.]",
    },
  ]) {
    it(`accepts normal sends when an unseen ${terminalStub.status} stub is the only token mismatch`, async () => {
      vi.spyOn(Date, "now").mockReturnValue(1700000000000)
      const { user, chat, userId, chatId } = createOwnerFixture()
      const assistantMessageId = asId<"messages">(
        `message_${terminalStub.status}_assistant`
      )
      const terminalAssistant = {
        ...createAssistantRuntimeMessage({
          id: assistantMessageId,
          chatId,
          orderId: 1,
          parts: [],
          content: "",
          status: terminalStub.status,
          createdAt: 1001,
        }),
        error: terminalStub.error,
      }
      const { ctx, tables } = createMutationCtx({
        users: [user],
        chats: [chat],
        messages: [
          createStoredMessage({
            id: "message_user_1",
            chatId,
            userId,
            orderId: 0,
            clientMessageId: "user-1",
            role: "user",
            content: "prompt",
            createdAt: 1000,
          }),
          terminalAssistant,
        ],
      })

      const result = await prepareAsOwner(ctx, {
        chatId,
        requestId: "request_followup",
        model: "gpt-5",
        provider: "openai",
        expectedVisibleMessageCount: 1,
        tailMessageId: "message_user_1",
        latestUserMessage: {
          id: "user-2",
          role: "user",
          content: "next prompt",
          parts: [{ type: "text", text: "next prompt" }],
        },
      })

      const insertedUser = tables.messages.find(
        (message) => message.clientMessageId === "user-2"
      )
      const insertedAssistant = tables.messages.find(
        (message) => message._id === result.assistantMessageId
      )

      expect(result.messages.map((message) => message.content)).toEqual([
        "prompt",
        terminalStub.historyMarker,
        "next prompt",
      ])
      expect(insertedUser).toMatchObject({
        parentMessageId: assistantMessageId,
        branchIndex: 0,
        selected: true,
      })
      expect(insertedAssistant).toMatchObject({
        parentMessageId: insertedUser?._id,
        branchIndex: 0,
        selected: true,
        status: "streaming",
      })
    })
  }

  it("rejects normal sends when the selected branch changed with the same visible count", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { user, chat, userId, chatId } = createOwnerFixture()
    const messages: Doc<"messages">[] = [
      createStoredMessage({
        id: "message_user_1",
        chatId,
        userId,
        orderId: 0,
        clientMessageId: "user-1",
        role: "user",
        content: "prompt",
        createdAt: 1000,
      }),
      {
        ...createStoredMessage({
          id: "message_assistant_old",
          chatId,
          orderId: 1,
          role: "assistant",
          content: "old answer",
          createdAt: 1001,
        }),
        parentMessageId: asId<"messages">("message_user_1"),
        branchIndex: 0,
        selected: false,
      },
      {
        ...createStoredMessage({
          id: "message_assistant_new",
          chatId,
          orderId: 2,
          role: "assistant",
          content: "new answer",
          createdAt: 1002,
        }),
        parentMessageId: asId<"messages">("message_user_1"),
        branchIndex: 1,
        selected: true,
      },
    ]
    const { ctx, tables } = createMutationCtx({
      users: [user],
      chats: [chat],
      messages,
    })

    await expect(
      prepareAsOwner(ctx, {
        chatId,
        requestId: "request_stale",
        model: "gpt-5",
        provider: "openai",
        expectedVisibleMessageCount: 2,
        tailMessageId: "message_assistant_old",
        latestUserMessage: {
          id: "user-2",
          role: "user",
          content: "next prompt",
          parts: [{ type: "text", text: "next prompt" }],
        },
      })
    ).rejects.toThrow("Stale chat state: selected path changed")

    expect(tables.generationRuns).toEqual([])
    expect(
      tables.messages.some((message) => message.clientMessageId === "user-2")
    ).toBe(false)
  })

  it("rejects stale normal sends before aborting the active run", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { user, chat, userId, chatId } = createOwnerFixture()
    const runId = asId<"generationRuns">("run_1")
    const activeAssistantId = asId<"messages">("message_assistant_new")
    const activeAssistant = {
      ...createAssistantRuntimeMessage({
        id: activeAssistantId,
        chatId,
        runId,
        orderId: 2,
        content: "streaming answer",
        parts: [{ type: "text", text: "streaming answer" }],
        createdAt: 1002,
      }),
      parentMessageId: asId<"messages">("message_user_1"),
      branchIndex: 1,
      selected: true,
    }
    const run = createGenerationRun({
      id: runId,
      chatId,
      userId,
      assistantMessageId: activeAssistantId,
    })
    const { ctx, deletes, patches, tables } = createMutationCtx({
      users: [user],
      chats: [chat],
      messages: [
        createStoredMessage({
          id: "message_user_1",
          chatId,
          userId,
          orderId: 0,
          clientMessageId: "user-1",
          role: "user",
          content: "prompt",
          createdAt: 1000,
        }),
        {
          ...createStoredMessage({
            id: "message_assistant_old",
            chatId,
            orderId: 1,
            role: "assistant",
            content: "old answer",
            createdAt: 1001,
          }),
          parentMessageId: asId<"messages">("message_user_1"),
          branchIndex: 0,
          selected: false,
        },
        activeAssistant,
      ],
      generationRuns: [run],
    })

    await expect(
      prepareAsOwner(ctx, {
        chatId,
        requestId: "request_stale",
        model: "gpt-5",
        provider: "openai",
        expectedVisibleMessageCount: 2,
        tailMessageId: "message_assistant_old",
        latestUserMessage: {
          id: "user-2",
          role: "user",
          content: "next prompt",
          parts: [{ type: "text", text: "next prompt" }],
        },
      })
    ).rejects.toThrow("Stale chat state: selected path changed")

    expect(patches).toEqual([])
    expect(deletes).toEqual([])
    expect(run).toMatchObject({
      status: "streaming",
      activeStreamId: activeAssistantId,
      assistantMessageId: activeAssistantId,
    })
    expect(activeAssistant).toMatchObject({ status: "streaming" })
    expect(
      tables.messages.some((message) => message.clientMessageId === "user-2")
    ).toBe(false)
  })

  it("applies durable regeneration intent by appending a selected assistant sibling", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { user, chat, userId, chatId } = createOwnerFixture()
    const messages: Doc<"messages">[] = [
      createStoredMessage({
        id: "message_user_1",
        chatId,
        userId,
        orderId: 0,
        clientMessageId: "user-1",
        role: "user",
        content: "first text",
        createdAt: 1000,
      }),
      createStoredMessage({
        id: "message_assistant_1",
        chatId,
        orderId: 1,
        role: "assistant",
        content: "first answer",
        createdAt: 1001,
      }),
      createStoredMessage({
        id: "message_user_2",
        chatId,
        userId,
        orderId: 2,
        clientMessageId: "user-2",
        role: "user",
        content: "second text",
        createdAt: 1002,
      }),
      createStoredMessage({
        id: "message_assistant_2",
        chatId,
        orderId: 3,
        role: "assistant",
        content: "old second answer",
        createdAt: 1003,
      }),
    ]
    const { ctx, inserts, tables } = createMutationCtx({
      users: [user],
      chats: [chat],
      messages,
    })

    const result = await prepareAsOwner(ctx, {
      chatId,
      requestId: "request_regen",
      model: "gpt-5",
      provider: "openai",
      regeneration: {
        targetAssistantMessageId: "message_assistant_2",
        targetAssistantCreatedAt: 1003,
        expectedChatVersion: 4,
        precedingUserMessageId: "user-2",
      },
    })

    expect(
      inserts.filter((insert) => insert.tableName === "messages")
    ).toContainEqual(expect.objectContaining({ id: result.assistantMessageId }))
    expect(tables.messages).toHaveLength(5)
    expect(messages[3]).toMatchObject({
      status: "completed",
      content: "old second answer",
      parts: [{ type: "text", text: "old second answer" }],
      selected: false,
    })
    expect(tables.messages[4]).toMatchObject({
      _id: result.assistantMessageId,
      orderId: 4,
      parentMessageId: "message_user_2",
      branchIndex: 1,
      selected: true,
      status: "streaming",
      requestId: "request_regen",
      generationRunId: result.runId,
    })
    expect(result.messages.map((message) => message._id)).toEqual([
      "message_user_1",
      "message_assistant_1",
      "message_user_2",
    ])
    expect(result.messages).not.toContainEqual(
      expect.objectContaining({ _id: "message_assistant_2" })
    )
  })

  it("applies durable regeneration intent to a mid-conversation assistant", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { user, chat, userId, chatId } = createOwnerFixture()
    const messages: Doc<"messages">[] = [
      createStoredMessage({
        id: "message_user_1",
        chatId,
        userId,
        orderId: 0,
        clientMessageId: "user-1",
        role: "user",
        content: "first text",
        createdAt: 1000,
      }),
      createStoredMessage({
        id: "message_assistant_1",
        chatId,
        orderId: 1,
        role: "assistant",
        content: "old first answer",
        createdAt: 1001,
      }),
      createStoredMessage({
        id: "message_user_2",
        chatId,
        userId,
        orderId: 2,
        clientMessageId: "user-2",
        role: "user",
        content: "second text",
        createdAt: 1002,
      }),
      createStoredMessage({
        id: "message_assistant_2",
        chatId,
        orderId: 3,
        role: "assistant",
        content: "second answer",
        createdAt: 1003,
      }),
    ]
    const { ctx, inserts, tables } = createMutationCtx({
      users: [user],
      chats: [chat],
      messages,
    })

    const result = await prepareAsOwner(ctx, {
      chatId,
      requestId: "request_regen",
      model: "gpt-5",
      provider: "openai",
      regeneration: {
        targetAssistantMessageId: "message_assistant_1",
        targetAssistantCreatedAt: 1001,
        expectedChatVersion: 4,
        precedingUserMessageId: "user-1",
      },
    })

    // Forks under the preceding user message; the old assistant is deselected.
    expect(
      inserts.filter((insert) => insert.tableName === "messages")
    ).toContainEqual(expect.objectContaining({ id: result.assistantMessageId }))
    expect(tables.messages).toHaveLength(5)
    expect(messages[1]).toMatchObject({
      content: "old first answer",
      selected: false,
    })
    expect(tables.messages[4]).toMatchObject({
      _id: result.assistantMessageId,
      parentMessageId: "message_user_1",
      branchIndex: 1,
      selected: true,
      status: "streaming",
      requestId: "request_regen",
      generationRunId: result.runId,
    })
    // The old continuation (user_2 → assistant_2) is retained as a deselected
    // sibling branch, not deleted.
    expect(tables.messages.map((message) => message._id)).toEqual(
      expect.arrayContaining(["message_user_2", "message_assistant_2"])
    )
    // Model prefix is everything up to and including the preceding user message.
    expect(result.messages.map((message) => message._id)).toEqual([
      "message_user_1",
    ])
  })

  it("keeps coherent history after regenerate then send another message", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { user, chat, userId, chatId } = createOwnerFixture()
    const targetAssistant = createStoredMessage({
      id: "message_assistant_1",
      chatId,
      orderId: 1,
      role: "assistant",
      content: "old answer",
      createdAt: 1001,
    })
    const { ctx, tables } = createMutationCtx({
      users: [user],
      chats: [chat],
      messages: [
        createStoredMessage({
          id: "message_user_1",
          chatId,
          userId,
          orderId: 0,
          clientMessageId: "user-1",
          role: "user",
          content: "prompt",
          createdAt: 1000,
        }),
        targetAssistant,
      ],
    })

    const regeneration = await prepareAsOwner(ctx, {
      chatId,
      requestId: "request_regen",
      model: "gpt-5",
      provider: "openai",
      regeneration: {
        targetAssistantMessageId: "message_assistant_1",
        targetAssistantCreatedAt: 1001,
        expectedChatVersion: 2,
        precedingUserMessageId: "user-1",
      },
    })

    const regeneratedAssistant = tables.messages.find(
      (message) => message._id === regeneration.assistantMessageId
    )
    Object.assign(regeneratedAssistant ?? {}, {
      content: "new answer",
      parts: [{ type: "text", text: "new answer" }],
      status: "completed",
    })

    const followUp = await prepareAsOwner(ctx, {
      chatId,
      requestId: "request_followup",
      model: "gpt-5",
      provider: "openai",
      expectedVisibleMessageCount: 2,
      tailMessageId: regeneration.assistantMessageId,
      latestUserMessage: {
        id: "user-2",
        role: "user",
        content: "next prompt",
        parts: [{ type: "text", text: "next prompt" }],
      },
    })

    expect(regeneration.messages.map((message) => message._id)).toEqual([
      "message_user_1",
    ])
    expect(followUp.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ])
    expect(
      followUp.messages.filter((message) => message.role === "assistant")
    ).toEqual([expect.objectContaining({ content: "new answer" })])
    expect(targetAssistant).toMatchObject({ selected: false })
    expect(regeneratedAssistant).toMatchObject({ selected: true })
    expect(
      tables.messages.filter((message) => message.role === "assistant")
    ).toHaveLength(3)
  })

  it("regenerates after a previously stopped turn, keeping the stopped stub as a first-class turn", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { user, chat, userId, chatId } = createOwnerFixture()
    const targetAssistant = createStoredMessage({
      id: "message_assistant_2",
      chatId,
      orderId: 3,
      role: "assistant",
      content: "old second answer",
      createdAt: 1003,
    })
    const { ctx, deletes, tables } = createMutationCtx({
      users: [user],
      chats: [chat],
      messages: [
        createStoredMessage({
          id: "message_user_1",
          chatId,
          userId,
          orderId: 0,
          clientMessageId: "user-1",
          role: "user",
          content: "first prompt",
          createdAt: 1000,
        }),
        createAssistantRuntimeMessage({
          id: "message_empty_assistant",
          chatId,
          orderId: 1,
          parts: [],
          content: "",
          status: "aborted",
          createdAt: 1001,
        }),
        createStoredMessage({
          id: "message_user_2",
          chatId,
          userId,
          orderId: 2,
          clientMessageId: "user-2",
          role: "user",
          content: "second prompt",
          createdAt: 1002,
        }),
        targetAssistant,
      ],
    })

    const result = await prepareAsOwner(ctx, {
      chatId,
      requestId: "request_regen",
      model: "gpt-5",
      provider: "openai",
      regeneration: {
        targetAssistantMessageId: "message_assistant_2",
        targetAssistantCreatedAt: 1003,
        // The aborted stub is a visible first-class turn now, counted by the
        // client's rendered path like any other message.
        expectedChatVersion: 4,
        precedingUserMessageId: "user-2",
      },
    })

    expect(deletes).toEqual([])
    expect(result.messages.map((message) => message._id)).toEqual([
      "message_user_1",
      "message_empty_assistant",
      "message_user_2",
    ])
    expect(result.messages[1]).toMatchObject({
      parts: [
        {
          type: "text",
          text: "[This response was stopped before producing content.]",
        },
      ],
    })
    expect(tables.messages.map((message) => message._id)).toEqual([
      "message_user_1",
      "message_empty_assistant",
      "message_user_2",
      "message_assistant_2",
      result.assistantMessageId,
    ])
    expect(targetAssistant).toMatchObject({
      status: "completed",
      content: "old second answer",
      selected: false,
    })
    expect(
      tables.messages.find(
        (message) => message._id === result.assistantMessageId
      )
    ).toMatchObject({
      parentMessageId: "message_user_2",
      selected: true,
      status: "streaming",
    })
  })

  it("rejects stale or unsupported durable regeneration intents", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { user, chat, userId, chatId } = createOwnerFixture()
    const messages: Doc<"messages">[] = [
      createStoredMessage({
        id: "message_user_1",
        chatId,
        userId,
        orderId: 0,
        clientMessageId: "user-1",
        role: "user",
        content: "first text",
        createdAt: 1000,
      }),
      createStoredMessage({
        id: "message_assistant_1",
        chatId,
        orderId: 1,
        role: "assistant",
        content: "first answer",
        createdAt: 1001,
      }),
      createStoredMessage({
        id: "message_user_2",
        chatId,
        userId,
        orderId: 2,
        clientMessageId: "user-2",
        role: "user",
        content: "second text",
        createdAt: 1002,
      }),
      createStoredMessage({
        id: "message_assistant_2",
        chatId,
        orderId: 3,
        role: "assistant",
        content: "second answer",
        createdAt: 1003,
      }),
    ]

    async function expectRegenerationRejected(
      regeneration: {
        targetAssistantMessageId: string
        targetAssistantCreatedAt: number
        expectedChatVersion: number
        precedingUserMessageId: string
      },
      message: string
    ) {
      const { ctx } = createMutationCtx({
        users: [user],
        chats: [chat],
        messages: messages.map((storedMessage) => ({ ...storedMessage })),
      })
      await expect(
        prepareAsOwner(ctx, {
          chatId,
          requestId: "request_regen",
          model: "gpt-5",
          provider: "openai",
          regeneration,
        })
      ).rejects.toThrow(message)
    }

    await expectRegenerationRejected(
      {
        targetAssistantMessageId: "message_assistant_2",
        targetAssistantCreatedAt: 1003,
        expectedChatVersion: 3,
        precedingUserMessageId: "user-2",
      },
      "Chat changed since regeneration started"
    )
    await expectRegenerationRejected(
      {
        targetAssistantMessageId: "message_assistant_2",
        targetAssistantCreatedAt: 9999,
        expectedChatVersion: 4,
        precedingUserMessageId: "user-2",
      },
      "Regeneration target version changed"
    )
    await expectRegenerationRejected(
      {
        targetAssistantMessageId: "user-2",
        targetAssistantCreatedAt: 1002,
        expectedChatVersion: 4,
        precedingUserMessageId: "user-1",
      },
      "Regeneration target must be an assistant message"
    )
    // The version guard still rejects a stale mid-conversation target (the
    // tail restriction is lifted, but optimistic concurrency is not).
    await expectRegenerationRejected(
      {
        targetAssistantMessageId: "message_assistant_1",
        targetAssistantCreatedAt: 9999,
        expectedChatVersion: 4,
        precedingUserMessageId: "user-1",
      },
      "Regeneration target version changed"
    )
    await expectRegenerationRejected(
      {
        targetAssistantMessageId: "message_assistant_2",
        targetAssistantCreatedAt: 1003,
        expectedChatVersion: 4,
        precedingUserMessageId: "user-1",
      },
      "Regeneration preceding user message mismatch"
    )
  })

  it("counts the edit version guard over the raw client view amid sparse branch state", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { user, chat, userId, chatId } = createOwnerFixture()

    // A rapid regenerate leaves sparse branch state behind: the old answer is
    // deselected while the regenerated sibling carries no branchIndex or
    // selected stamp yet. The client's expectedChatVersion counts the RAW
    // selected-path projection (the messages.ts read derivation). This pins
    // the guard to that same raw view — a write-side normalization pass
    // running BEFORE the guard (the pre-branch-writer shape) is the "edit
    // falsely rejected after a rapid multi-branch session" bug class.
    function sparseBranchMessages() {
      return [
        createStoredMessage({
          id: "message_user_1",
          chatId,
          userId,
          orderId: 0,
          clientMessageId: "user-1",
          role: "user",
          content: "prompt",
          createdAt: 1000,
        }),
        {
          ...createStoredMessage({
            id: "message_assistant_old",
            chatId,
            orderId: 1,
            role: "assistant",
            content: "old answer",
            createdAt: 1001,
          }),
          parentMessageId: asId<"messages">("message_user_1"),
          branchIndex: 0,
          selected: false,
        },
        {
          ...createStoredMessage({
            id: "message_assistant_new",
            chatId,
            orderId: 2,
            role: "assistant",
            content: "regenerated answer",
            createdAt: 1002,
          }),
          parentMessageId: asId<"messages">("message_user_1"),
          // Sparse on purpose: no branchIndex, no selected stamp yet.
        },
      ]
    }

    function editIntent(expectedChatVersion: number) {
      return {
        editedMessageId: "user-1",
        editCutoffTimestamp: 1000,
        expectedChatVersion,
        replacementMessage: {
          id: "replacement-user",
          role: "user" as const,
          content: "edited prompt",
          parts: [{ type: "text", text: "edited prompt" }],
        },
      }
    }

    // The raw projection renders [prompt, regenerated answer] → version 2.
    const accepted = createMutationCtx({
      users: [user],
      chats: [chat],
      messages: sparseBranchMessages(),
    })
    const result = await prepareAsOwner(accepted.ctx, {
      chatId,
      requestId: "request_edit",
      model: "gpt-5",
      provider: "openai",
      edit: editIntent(2),
    })
    expect(result.runId).toBeDefined()

    // A genuinely stale count still rejects.
    const rejected = createMutationCtx({
      users: [user],
      chats: [chat],
      messages: sparseBranchMessages(),
    })
    await expect(
      prepareAsOwner(rejected.ctx, {
        chatId,
        requestId: "request_edit",
        model: "gpt-5",
        provider: "openai",
        edit: editIntent(3),
      })
    ).rejects.toThrow("Chat changed since edit started")
  })

  it("retains previous assistant content when regeneration aborts or fails before first chunk", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)

    async function prepareRegenerationRun() {
      const { user, chat, userId, chatId } = createOwnerFixture()
      const targetAssistant = createStoredMessage({
        id: "message_assistant_1",
        chatId,
        orderId: 1,
        role: "assistant",
        content: "old answer",
        createdAt: 1001,
      })
      const harness = createMutationCtx({
        users: [user],
        chats: [chat],
        messages: [
          createStoredMessage({
            id: "message_user_1",
            chatId,
            userId,
            orderId: 0,
            clientMessageId: "user-1",
            role: "user",
            content: "prompt",
            createdAt: 1000,
          }),
          targetAssistant,
        ],
      })
      const result = await prepareAsOwner(harness.ctx, {
        chatId,
        requestId: "request_regen",
        model: "gpt-5",
        provider: "openai",
        regeneration: {
          targetAssistantMessageId: "message_assistant_1",
          targetAssistantCreatedAt: 1001,
          expectedChatVersion: 2,
          precedingUserMessageId: "user-1",
        },
      })
      return { ...harness, result, targetAssistant }
    }

    const aborted = await prepareRegenerationRun()
    await markGenerationRunAbortedForChat(
      aborted.ctx,
      await runOwner(aborted.ctx, aborted.result.runId),
      {
        messageId: aborted.result.assistantMessageId,
        reason: "stream aborted",
      }
    )
    expect(aborted.deletes).toEqual([aborted.result.assistantMessageId])
    expect(aborted.targetAssistant).toMatchObject({
      content: "old answer",
      parts: [{ type: "text", text: "old answer" }],
      status: "completed",
      selected: true,
    })

    const failed = await prepareRegenerationRun()
    await markGenerationRunFailedForChat(
      failed.ctx,
      await runOwner(failed.ctx, failed.result.runId),
      {
        messageId: failed.result.assistantMessageId,
        error: "provider failed",
      }
    )
    expect(failed.deletes).toEqual([failed.result.assistantMessageId])
    expect(failed.targetAssistant).toMatchObject({
      content: "old answer",
      parts: [{ type: "text", text: "old answer" }],
      status: "completed",
      selected: true,
    })
  })

  it("restores the regeneration target on empty abort when a newer sibling exists", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { user, chat, userId, chatId } = createOwnerFixture()
    const branchOne = {
      ...createStoredMessage({
        id: "message_assistant_1",
        chatId,
        orderId: 1,
        role: "assistant",
        content: "answer one",
        createdAt: 1001,
      }),
      parentMessageId: asId<"messages">("message_user_1"),
      branchIndex: 0,
      selected: true,
    }
    const branchTwo = {
      ...createStoredMessage({
        id: "message_assistant_2",
        chatId,
        orderId: 2,
        role: "assistant",
        content: "answer two",
        createdAt: 1002,
      }),
      parentMessageId: asId<"messages">("message_user_1"),
      branchIndex: 1,
      selected: false,
    }
    const { ctx, deletes } = createMutationCtx({
      users: [user],
      chats: [chat],
      messages: [
        createStoredMessage({
          id: "message_user_1",
          chatId,
          userId,
          orderId: 0,
          clientMessageId: "user-1",
          role: "user",
          content: "prompt",
          createdAt: 1000,
        }),
        branchOne,
        branchTwo,
      ],
    })

    // The user branch-navigated back to branch one before regenerating it.
    const result = await prepareAsOwner(ctx, {
      chatId,
      requestId: "request_regen",
      model: "gpt-5",
      provider: "openai",
      regeneration: {
        targetAssistantMessageId: "message_assistant_1",
        targetAssistantCreatedAt: 1001,
        expectedChatVersion: 2,
        precedingUserMessageId: "user-1",
      },
    })
    await markGenerationRunAbortedForChat(
      ctx,
      await runOwner(ctx, result.runId),
      {
        messageId: result.assistantMessageId,
        reason: "stream aborted",
      }
    )

    expect(deletes).toEqual([result.assistantMessageId])
    expect(branchOne).toMatchObject({ selected: true })
    expect(branchTwo).toMatchObject({ selected: false })
  })

  it("preserves partial regenerated assistant content on abort", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { user, chat, userId, chatId } = createOwnerFixture()
    const targetAssistant = createStoredMessage({
      id: "message_assistant_1",
      chatId,
      orderId: 1,
      role: "assistant",
      content: "old answer",
      createdAt: 1001,
    })
    const { ctx, tables } = createMutationCtx({
      users: [user],
      chats: [chat],
      messages: [
        createStoredMessage({
          id: "message_user_1",
          chatId,
          userId,
          orderId: 0,
          clientMessageId: "user-1",
          role: "user",
          content: "prompt",
          createdAt: 1000,
        }),
        targetAssistant,
      ],
    })
    const result = await prepareAsOwner(ctx, {
      chatId,
      requestId: "request_regen",
      model: "gpt-5",
      provider: "openai",
      regeneration: {
        targetAssistantMessageId: "message_assistant_1",
        targetAssistantCreatedAt: 1001,
        expectedChatVersion: 2,
        precedingUserMessageId: "user-1",
      },
    })

    const regeneratedAssistant = tables.messages.find(
      (message) => message._id === result.assistantMessageId
    )
    Object.assign(regeneratedAssistant ?? {}, {
      content: "partial new answer",
      parts: [{ type: "text", text: "partial new answer" }],
    })
    const regeneratedRun = tables.generationRuns.find(
      (run) => run._id === result.runId
    )
    if (!regeneratedRun) throw new Error("Expected regeneration run")
    regeneratedRun.lastSnapshotSequence = 1

    await markGenerationRunAbortedForChat(
      ctx,
      await runOwner(ctx, result.runId),
      {
        messageId: result.assistantMessageId,
        reason: "stream aborted",
      }
    )

    expect(regeneratedAssistant).toMatchObject({
      content: "partial new answer",
      parts: [{ type: "text", text: "partial new answer" }],
      status: "aborted",
      error: "stream aborted",
      selected: true,
    })
    expect(targetAssistant).toMatchObject({
      content: "old answer",
      status: "completed",
      selected: false,
    })
    expect(tables.messages.map((message) => message._id)).toEqual([
      "message_user_1",
      "message_assistant_1",
      result.assistantMessageId,
    ])
  })

  it("uses the run-level snapshot invariant to keep reused regeneration output on failure", async () => {
    const fixture = createGenerationRunLinkageFixture()
    fixture.run.startedAt = 2000
    fixture.run.lastSnapshotSequence = 3
    fixture.message.content = "partial regenerated answer"
    fixture.message.parts = [
      { type: "text", text: "partial regenerated answer" },
    ]
    const { ctx, deletes } = createMutationCtx(fixture.tables)

    await markGenerationRunFailedForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      {
        messageId: fixture.messageId,
        error: "provider failed",
        errorRecovery: "retry_with_shorter_generation_budget",
      }
    )

    expect(deletes).toEqual([])
    expect(fixture.message).toMatchObject({
      content: "partial regenerated answer",
      status: "failed",
      error: "provider failed",
      errorRecovery: "retry_with_shorter_generation_budget",
    })
    expect(fixture.run.errorRecovery).toBe(
      "retry_with_shorter_generation_budget"
    )
  })

  it("keeps and marks an empty assistant placeholder when a run aborts before the first chunk", async () => {
    // The stub IS the turn's durable outcome: deleting it made the turn
    // invisible (user bubble with no marker) and its user message got
    // re-sent as duplicate history. A fresh send has no sibling answer to
    // revert to, so the placeholder stays, marked aborted.
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { user, chat, userId, chatId } = createOwnerFixture()
    const runId = asId<"generationRuns">("run_1")
    const assistantMessageId = asId<"messages">("message_empty_assistant")
    const userMessage = createStoredMessage({
      id: "message_user_1",
      chatId,
      userId,
      orderId: 0,
      clientMessageId: "user-1",
      role: "user",
      content: "write something long",
      createdAt: 1000,
    })
    const assistantMessage = createAssistantRuntimeMessage({
      id: assistantMessageId,
      chatId,
      runId,
      orderId: 1,
      parts: [],
      content: "",
      status: "streaming",
    })
    const run = createGenerationRun({
      id: runId,
      chatId,
      userId,
      assistantMessageId,
    })
    const { ctx, deletes, tables } = createMutationCtx({
      users: [user],
      chats: [chat],
      messages: [userMessage, assistantMessage],
      generationRuns: [run],
    })

    await markGenerationRunAbortedForChat(ctx, await runOwner(ctx, runId), {
      messageId: assistantMessageId,
      reason: "stream aborted",
    })

    expect(deletes).toEqual([])
    expect(tables.messages.map((message) => message._id)).toEqual([
      "message_user_1",
      "message_empty_assistant",
    ])
    expect(assistantMessage).toMatchObject({
      status: "aborted",
      error: "stream aborted",
    })
    expect(run).toMatchObject({
      status: "aborted",
      error: "stream aborted",
      completedAt: 1700000000000,
      activeStreamId: undefined,
      assistantMessageId,
    })
  })

  it("converges to failed in both orders of the onError/envelope-finish race", async () => {
    // An errored stream fires BOTH the streamText onError (failed write) and
    // the response envelope's onFinish (completed write, isAborted false).
    // Whichever lands first, the run must settle failed — the envelope's
    // empty "completion" repainting a failed run is what hid the failed stub.
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)

    function makeFixture() {
      const { user, chat, userId, chatId } = createOwnerFixture()
      const runId = asId<"generationRuns">("run_1")
      const assistantMessageId = asId<"messages">("message_empty_assistant")
      const assistantMessage = createAssistantRuntimeMessage({
        id: assistantMessageId,
        chatId,
        runId,
        orderId: 1,
        parts: [],
        content: "",
        status: "streaming",
      })
      const run = createGenerationRun({
        id: runId,
        chatId,
        userId,
        assistantMessageId,
      })
      const { ctx } = createMutationCtx({
        users: [user],
        chats: [chat],
        messages: [
          createStoredMessage({
            id: "message_user_1",
            chatId,
            userId,
            orderId: 0,
            clientMessageId: "user-1",
            role: "user",
            content: "prompt",
            createdAt: 1000,
          }),
          assistantMessage,
        ],
        generationRuns: [run],
      })
      return { ctx, run, assistantMessage, runId, assistantMessageId }
    }

    // Order 1: failed lands first; the completed write must no-op.
    const first = makeFixture()
    await markGenerationRunFailedForChat(
      first.ctx,
      await runOwner(first.ctx, first.runId),
      {
        messageId: first.assistantMessageId,
        error: "provider rejected",
      }
    )
    await markGenerationRunCompletedForChat(
      first.ctx,
      await runOwner(first.ctx, first.runId),
      {
        messageId: first.assistantMessageId,
        content: "",
        parts: [],
      }
    )
    expect(first.run).toMatchObject({
      status: "failed",
      error: "provider rejected",
    })
    expect(first.assistantMessage).toMatchObject({ status: "failed" })

    // Order 2: completed lands first; the failed write must overwrite it.
    const second = makeFixture()
    await markGenerationRunCompletedForChat(
      second.ctx,
      await runOwner(second.ctx, second.runId),
      {
        messageId: second.assistantMessageId,
        content: "",
        parts: [],
      }
    )
    await markGenerationRunFailedForChat(
      second.ctx,
      await runOwner(second.ctx, second.runId),
      {
        messageId: second.assistantMessageId,
        error: "provider rejected",
      }
    )
    expect(second.run).toMatchObject({
      status: "failed",
      error: "provider rejected",
    })
    expect(second.assistantMessage).toMatchObject({ status: "failed" })

    // Aborted is settled: a late failure signal may not repaint a user Stop.
    const third = makeFixture()
    await markGenerationRunAbortedForChat(
      third.ctx,
      await runOwner(third.ctx, third.runId),
      {
        messageId: third.assistantMessageId,
        reason: "stream aborted",
      }
    )
    await markGenerationRunFailedForChat(
      third.ctx,
      await runOwner(third.ctx, third.runId),
      {
        messageId: third.assistantMessageId,
        error: "late failure",
      }
    )
    expect(third.run).toMatchObject({
      status: "aborted",
      error: "stream aborted",
    })
    expect(third.assistantMessage).toMatchObject({ status: "aborted" })
  })

  it("sanitizes a prior streaming empty placeholder before preparing the next generation", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { user, chat, userId, chatId } = createOwnerFixture()
    const runId = asId<"generationRuns">("run_1")
    const assistantMessageId = asId<"messages">("message_empty_assistant")
    const messages: Doc<"messages">[] = [
      createStoredMessage({
        id: "message_user_1",
        chatId,
        userId,
        orderId: 0,
        clientMessageId: "user-1",
        role: "user",
        content: "first prompt",
        createdAt: 1000,
      }),
      createAssistantRuntimeMessage({
        id: assistantMessageId,
        chatId,
        runId,
        orderId: 1,
        parts: [],
        content: "",
        status: "streaming",
      }),
    ]
    const run = createGenerationRun({
      id: runId,
      chatId,
      userId,
      assistantMessageId,
    })
    const { ctx, deletes, tables } = createMutationCtx({
      users: [user],
      chats: [chat],
      messages,
      generationRuns: [run],
    })

    const result = await prepareAsOwner(ctx, {
      chatId,
      requestId: "request_2",
      model: "gpt-5",
      provider: "openai",
      expectedVisibleMessageCount: 1,
      tailMessageId: "message_user_1",
      latestUserMessage: {
        id: "user-2",
        role: "user",
        content: "next prompt",
        parts: [{ type: "text", text: "next prompt" }],
      },
    })

    // The zombie placeholder is superseded, not erased: it stays as a
    // first-class aborted stub marking its turn's outcome, and projects into
    // model history as an explicit "never answered" marker instead of leaving
    // the first prompt looking fresh.
    expect(deletes).toEqual([])
    expect(run).toMatchObject({
      status: "aborted",
      activeStreamId: undefined,
      assistantMessageId: asId<"messages">("message_empty_assistant"),
    })
    expect(messages[1]).toMatchObject({
      status: "aborted",
      error: "superseded by a new generation",
    })
    expect(result.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ])
    expect(result.messages[1]).toMatchObject({
      parts: [
        {
          type: "text",
          text: "[This response was stopped before producing content.]",
        },
      ],
    })
    expect(
      result.messages.some(
        (message) => message.role === "assistant" && message.parts.length === 0
      )
    ).toBe(false)
    expect(tables.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ])
  })

  it("preserves a partial stopped assistant message in model history", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { user, chat, userId, chatId } = createOwnerFixture()
    const runId = asId<"generationRuns">("run_1")
    const assistantMessageId = asId<"messages">("message_partial_assistant")
    const partialAssistant = createAssistantRuntimeMessage({
      id: assistantMessageId,
      chatId,
      runId,
      orderId: 1,
      content: "partial answer",
      parts: [{ type: "text", text: "partial answer" }],
      status: "streaming",
    })
    const run = createGenerationRun({
      id: runId,
      chatId,
      userId,
      assistantMessageId,
    })
    const { ctx, deletes, tables } = createMutationCtx({
      users: [user],
      chats: [chat],
      messages: [
        createStoredMessage({
          id: "message_user_1",
          chatId,
          userId,
          orderId: 0,
          clientMessageId: "user-1",
          role: "user",
          content: "first prompt",
          createdAt: 1000,
        }),
        partialAssistant,
      ],
      generationRuns: [run],
    })

    const result = await prepareAsOwner(ctx, {
      chatId,
      requestId: "request_2",
      model: "gpt-5",
      provider: "openai",
      expectedVisibleMessageCount: 2,
      tailMessageId: "message_partial_assistant",
      latestUserMessage: {
        id: "user-2",
        role: "user",
        content: "next prompt",
        parts: [{ type: "text", text: "next prompt" }],
      },
    })

    expect(deletes).toEqual([])
    expect(partialAssistant).toMatchObject({
      status: "aborted",
      content: "partial answer",
      parts: [{ type: "text", text: "partial answer" }],
    })
    const insertedUser = tables.messages.find(
      (message) => message.clientMessageId === "user-2"
    )
    expect(result.messages.map((message) => message._id)).toEqual([
      "message_user_1",
      "message_partial_assistant",
      insertedUser?._id,
    ])
  })
})

describe("generation run linkage validation", () => {
  it("rejects completion updates for assistant messages outside the run", async () => {
    const fixture = createGenerationRunLinkageFixture()
    const { ctx, patches } = createMutationCtx(fixture.tables)

    await expect(
      markGenerationRunCompletedForChat(
        ctx,
        await runOwner(ctx, fixture.runId),
        {
          messageId: fixture.otherMessageId,
          content: "done",
          parts: [{ type: "text", text: "done" }],
        }
      )
    ).rejects.toThrow("Assistant message not found for run")

    expect(patches).toEqual([])
    expect(fixture.run.status).toBe("streaming")
    expect(fixture.otherMessage.content).toBe("")
  })

  it("does not re-bump the chat's updatedAt when a run completes", async () => {
    // Per ADR-0005: a durable turn must
    // bump chats.updatedAt exactly once, at turn start (chatRuntime.ts:1257). The
    // chat has already re-ordered to the top of the sidebar by completion time, so
    // the run-complete path must NOT bump it again.
    const fixture = createGenerationRunLinkageFixture()
    const { ctx, patches } = createMutationCtx(fixture.tables)

    await markGenerationRunCompletedForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      {
        messageId: fixture.messageId,
        content: "done",
        parts: [{ type: "text", text: "done" }],
      }
    )

    // No write to the chat row on the completion path (one bump per turn): its
    // updatedAt is left exactly as it was at turn start.
    expect(patches.filter((patch) => patch.id === fixture.chatId)).toEqual([])
    expect(fixture.chat.updatedAt).toBe(1)

    // The run and assistant-message patches still fire.
    expect(fixture.run.status).toBe("completed")
    expect(fixture.message.status).toBe("completed")
    expect(fixture.message.content).toBe("done")
  })

  it("ignores a late approval request on a run a Stop already aborted (zombie-repaint fix)", async () => {
    // User Stop settles the run first; then a late approval-request write from
    // the stream's persistence transform arrives. It must not repaint the run
    // awaiting_approval nor accrue a pending row (which would feed
    // hasPendingApprovals on a future completion) — the Generation run
    // lifecycle's approval-requested rule ignores the terminal run.
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const fixture = createGenerationRunLinkageFixture()
    const { ctx } = createMutationCtx(fixture.tables)

    await markGenerationRunAbortedForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      {
        messageId: fixture.messageId,
        reason: "stream aborted",
      }
    )
    expect(fixture.run.status).toBe("aborted")

    const approvalRequestId = await createToolApprovalRequestForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      {
        assistantMessageId: fixture.messageId,
        toolCallId: "call_late",
        toolName: "send_email",
        source: "mcp",
        riskClass: "destructive",
        approvalId: "approval_late",
      }
    )

    expect(approvalRequestId).toBeNull()
    expect(fixture.tables.toolApprovalRequests).toEqual([])
    expect(fixture.run.status).toBe("aborted")
    expect(fixture.message).toMatchObject({
      status: "aborted",
      error: "stream aborted",
    })
  })

  it("ignores a late approval request after Stop deleted the empty regeneration placeholder", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { user, chat, userId, chatId } = createOwnerFixture()
    const targetAssistant = createStoredMessage({
      id: "message_assistant_1",
      chatId,
      orderId: 1,
      role: "assistant",
      content: "old answer",
      createdAt: 1001,
    })
    const { ctx, deletes, inserts, patches, tables } = createMutationCtx({
      users: [user],
      chats: [chat],
      messages: [
        createStoredMessage({
          id: "message_user_1",
          chatId,
          userId,
          orderId: 0,
          clientMessageId: "user-1",
          role: "user",
          content: "prompt",
          createdAt: 1000,
        }),
        targetAssistant,
      ],
    })

    const result = await prepareAsOwner(ctx, {
      chatId,
      requestId: "request_regen",
      model: "gpt-5",
      provider: "openai",
      regeneration: {
        targetAssistantMessageId: "message_assistant_1",
        targetAssistantCreatedAt: 1001,
        expectedChatVersion: 2,
        precedingUserMessageId: "user-1",
      },
    })
    await markGenerationRunAbortedForChat(
      ctx,
      await runOwner(ctx, result.runId),
      {
        messageId: result.assistantMessageId,
        reason: "stream aborted",
      }
    )
    expect(deletes).toEqual([result.assistantMessageId])
    expect(
      tables.messages.some(
        (message) => message._id === result.assistantMessageId
      )
    ).toBe(false)

    const insertCountBeforeApproval = inserts.length
    const patchCountBeforeApproval = patches.length
    const approvalRequestId = await createToolApprovalRequestForChat(
      ctx,
      await runOwner(ctx, result.runId),
      {
        assistantMessageId: result.assistantMessageId,
        toolCallId: "call_late",
        toolName: "send_email",
        source: "mcp",
        riskClass: "destructive",
        approvalId: "approval_late",
      }
    )

    const run = tables.generationRuns.find(
      (generationRun) => generationRun._id === result.runId
    )
    expect(approvalRequestId).toBeNull()
    expect(tables.toolApprovalRequests).toEqual([])
    expect(inserts).toHaveLength(insertCountBeforeApproval)
    expect(patches).toHaveLength(patchCountBeforeApproval)
    expect(run).toMatchObject({
      status: "aborted",
      assistantMessageId: undefined,
    })
    expect(targetAssistant).toMatchObject({
      content: "old answer",
      status: "completed",
      selected: true,
    })
  })

  it("rejects tool invocations for assistant messages outside the run", async () => {
    const fixture = createGenerationRunLinkageFixture()
    const { ctx, inserts, patches } = createMutationCtx(fixture.tables)

    await expect(
      recordToolInvocationsForChat(ctx, await runOwner(ctx, fixture.runId), {
        messageId: fixture.otherMessageId,
        invocations: [
          {
            toolCallId: "call_1",
            toolName: "send_email",
            source: "mcp",
            status: "called",
          },
        ],
      })
    ).rejects.toThrow("Assistant message not found for run")

    expect(inserts).toEqual([])
    expect(patches).toEqual([])
  })

  it("rejects tool invocations linked to another run's approval request", async () => {
    const fixture = createGenerationRunLinkageFixture()
    const approval: Doc<"toolApprovalRequests"> = {
      _id: asId<"toolApprovalRequests">("approval_request_1"),
      _creationTime: 1,
      chatId: fixture.chatId,
      runId: fixture.otherRunId,
      assistantMessageId: fixture.otherMessageId,
      userId: fixture.userId,
      toolCallId: "call_1",
      toolName: "send_email",
      source: "mcp",
      riskClass: "destructive",
      approvalId: "approval_1",
      status: "pending",
      createdAt: 1,
      expiresAt: 60_000,
    }
    const { ctx, inserts, patches } = createMutationCtx({
      ...fixture.tables,
      toolApprovalRequests: [approval],
    })

    await expect(
      recordToolInvocationsForChat(ctx, await runOwner(ctx, fixture.runId), {
        messageId: fixture.messageId,
        invocations: [
          {
            toolCallId: "call_1",
            toolName: "send_email",
            source: "mcp",
            status: "pending_approval",
            approvalRequestId: "approval_1",
          },
        ],
      })
    ).rejects.toThrow("Approval request does not belong to this run")

    expect(inserts).toEqual([])
    expect(patches).toEqual([])
  })

  it("rejects tool invocations once the run is terminal (post-settlement write)", async () => {
    // A terminal run is read-only to its old worker. recordToolInvocations was
    // the one worker op missing this guard.
    const fixture = createGenerationRunLinkageFixture()
    const { ctx, inserts } = createMutationCtx(fixture.tables)

    await markGenerationRunAbortedForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      { messageId: fixture.messageId, reason: "user stop" }
    )
    expect(fixture.run.status).toBe("aborted")

    await recordToolInvocationsForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      {
        messageId: fixture.messageId,
        invocations: [
          {
            toolCallId: "call_late",
            toolName: "send_email",
            source: "mcp",
            status: "called",
          },
        ],
      }
    )

    expect(fixture.tables.toolInvocations).toEqual([])
    expect(
      inserts.filter((insert) => insert.tableName === "toolInvocations")
    ).toEqual([])
  })

  it("cannot stamp a different assistant message in the same chat via fail/abort", async () => {
    // gatherAssistantMessageFacts enforces run→message linkage: a worker
    // payload naming another run's assistant message must not receive this
    // run's terminal outcome. The run half still settles.
    const fixture = createGenerationRunLinkageFixture()
    const { ctx } = createMutationCtx(fixture.tables)

    await markGenerationRunFailedForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      { messageId: fixture.otherMessageId, error: "provider exploded" }
    )

    expect(fixture.run.status).toBe("failed")
    // The unlinked message keeps its own state — no failed stamp, no error.
    expect(fixture.otherMessage.status).toBe("streaming")
    expect(fixture.otherMessage.error).toBeUndefined()
    // The run's own linked message is untouched too (the caller misnamed the
    // target, so the message half is a no-op, not a redirect).
    expect(fixture.message.status).toBe("streaming")
  })
})

describe("execution grant revocation", () => {
  const GRANT = {
    grantDigest: "d".repeat(64),
    grantExpiresAt: 2_000_000,
  }

  it("clears the grant when a run reaches an absorbing outcome (aborted)", async () => {
    const fixture = createGenerationRunLinkageFixture()
    Object.assign(fixture.run, GRANT)
    const { ctx } = createMutationCtx(fixture.tables)

    await markGenerationRunAbortedForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      { messageId: fixture.messageId, reason: "user stop" }
    )

    expect(fixture.run.status).toBe("aborted")
    expect(fixture.run.grantDigest).toBeUndefined()
    expect(fixture.run.grantExpiresAt).toBeUndefined()
  })

  it("keeps the grant at completed so the fail-over-completed convergence stays writable", async () => {
    const fixture = createGenerationRunLinkageFixture()
    Object.assign(fixture.run, GRANT)
    const { ctx } = createMutationCtx(fixture.tables)

    await markGenerationRunCompletedForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      {
        messageId: fixture.messageId,
        content: "done",
        parts: [{ type: "text", text: "done" }],
      }
    )
    expect(fixture.run.status).toBe("completed")
    expect(fixture.run.grantDigest).toBe(GRANT.grantDigest)
    expect(fixture.run.grantExpiresAt).toBe(GRANT.grantExpiresAt)

    // The deliberate convergence: the late failure write still lands through
    // the retained grant, and reaching failed (absorbing) then revokes.
    await markGenerationRunFailedForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      { messageId: fixture.messageId, error: "stream errored" }
    )
    expect(fixture.run.status).toBe("failed")
    expect(fixture.run.grantDigest).toBeUndefined()
    expect(fixture.run.grantExpiresAt).toBeUndefined()
  })

  it("keeps the grant at the awaiting_approval pause (the worker's era is not over)", async () => {
    const fixture = createGenerationRunLinkageFixture()
    Object.assign(fixture.run, GRANT)
    const { ctx } = createMutationCtx(fixture.tables)

    await createToolApprovalRequestForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      {
        assistantMessageId: fixture.messageId,
        toolCallId: "call_1",
        toolName: "send_email",
        source: "mcp",
        riskClass: "destructive",
        approvalId: "approval_1",
      }
    )

    expect(fixture.run.status).toBe("awaiting_approval")
    expect(fixture.run.grantDigest).toBe(GRANT.grantDigest)
    expect(fixture.run.grantExpiresAt).toBe(GRANT.grantExpiresAt)
  })
})

describe("lease lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("prepare initializes the lease and the chat freshness ceiling", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { user, chat, userId, chatId } = createOwnerFixture()
    const { ctx, tables } = createMutationCtx({
      users: [user],
      chats: [chat],
      messages: [
        createStoredMessage({
          id: "message_user_1",
          chatId,
          userId,
          orderId: 0,
          clientMessageId: "user-1",
          role: "user",
          content: "prompt",
          createdAt: 1000,
        }),
      ],
    })

    const result = await prepareAsOwner(ctx, {
      chatId,
      requestId: "request_lease",
      model: "gpt-5",
      provider: "openai",
      latestUserMessage: {
        id: "user-2",
        role: "user",
        content: "hello",
        parts: [{ type: "text", text: "hello" }],
      },
      expectedVisibleMessageCount: 1,
    })

    const run = tables.generationRuns.find(
      (candidate) => candidate._id === result.runId
    )
    expect(run).toMatchObject({
      heartbeatAt: 1700000000000,
      leaseExpiresAt: 1700000000000 + LEASE_DURATION_MS,
      lastProgressAt: 1700000000000,
    })
    // Written once at prepare — the ceiling no legitimate run outlives.
    expect(chat.liveRunFreshUntil).toBeGreaterThan(1700000000000)
    expect(chat.statusRunId).toBe(result.runId)
  })

  it("heartbeat renews only worker-executing statuses and extends the run only", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const fixture = createGenerationRunLinkageFixture()
    fixture.chat.statusRunId = fixture.runId
    const { ctx, patches } = createMutationCtx(fixture.tables)

    const result = await heartbeatGenerationRunForChat(
      ctx,
      await runOwner(ctx, fixture.runId)
    )

    expect(result).toEqual({
      kind: "renewed",
      leaseExpiresAt: 1700000000000 + LEASE_DURATION_MS,
    })
    expect(fixture.run.heartbeatAt).toBe(1700000000000)
    expect(fixture.run.leaseExpiresAt).toBe(1700000000000 + LEASE_DURATION_MS)
    // Never touches the chat doc (§18 #4).
    expect(patches.filter((patch) => patch.id === fixture.chatId)).toEqual([])
  })

  it("heartbeat returns paused on the approval pause and lost on a terminal run", async () => {
    const paused = createGenerationRunLinkageFixture()
    paused.run.status = "awaiting_approval"
    const pausedCtx = createMutationCtx(paused.tables)
    expect(
      await heartbeatGenerationRunForChat(
        pausedCtx.ctx,
        await runOwner(pausedCtx.ctx, paused.runId)
      )
    ).toEqual({ kind: "paused" })
    expect(paused.run.heartbeatAt).toBeUndefined()

    const settled = createGenerationRunLinkageFixture()
    settled.run.status = "aborted"
    const settledCtx = createMutationCtx(settled.tables)
    expect(
      await heartbeatGenerationRunForChat(
        settledCtx.ctx,
        await runOwner(settledCtx.ctx, settled.runId)
      )
    ).toEqual({ kind: "lost", reason: "terminal" })
  })

  it("heartbeat returns lost when a newer run owns the chat status slot", async () => {
    const fixture = createGenerationRunLinkageFixture()
    fixture.chat.statusRunId = fixture.otherRunId
    const { ctx } = createMutationCtx(fixture.tables)

    expect(
      await heartbeatGenerationRunForChat(
        ctx,
        await runOwner(ctx, fixture.runId)
      )
    ).toEqual({ kind: "lost", reason: "not-owner" })
    expect(fixture.run.heartbeatAt).toBeUndefined()
  })

  it("terminal transitions shed the lease; the approval pause sheds it and stamps its expiry", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const aborted = createGenerationRunLinkageFixture()
    aborted.run.heartbeatAt = 1
    aborted.run.leaseExpiresAt = 2
    const abortedCtx = createMutationCtx(aborted.tables)
    await markGenerationRunAbortedForChat(
      abortedCtx.ctx,
      await runOwner(abortedCtx.ctx, aborted.runId),
      { messageId: aborted.messageId, reason: "user stop" }
    )
    expect(aborted.run.heartbeatAt).toBeUndefined()
    expect(aborted.run.leaseExpiresAt).toBeUndefined()

    const paused = createGenerationRunLinkageFixture()
    paused.run.heartbeatAt = 1
    paused.run.leaseExpiresAt = 2
    paused.chat.statusRunId = paused.runId
    const pausedCtx = createMutationCtx(paused.tables)
    await createToolApprovalRequestForChat(
      pausedCtx.ctx,
      await runOwner(pausedCtx.ctx, paused.runId),
      {
        assistantMessageId: paused.messageId,
        toolCallId: "call_1",
        toolName: "send_email",
        source: "mcp",
        riskClass: "destructive",
        approvalId: "approval_1",
      }
    )
    expect(paused.run.heartbeatAt).toBeUndefined()
    expect(paused.run.leaseExpiresAt).toBeUndefined()
    const approval = paused.tables.toolApprovalRequests[0]
    expect(approval.expiresAt).toBe(1700000000000 + APPROVAL_EXPIRY_MS)
    // The pause's freshness ceiling becomes the approval's own expiry.
    expect(paused.chat.liveRunFreshUntil).toBe(approval.expiresAt)
  })
})

describe("reapers", () => {
  const NOW = 1700000000000

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function makeExpiredStreamingFixture() {
    const fixture = createGenerationRunLinkageFixture()
    fixture.chat.statusRunId = fixture.runId
    fixture.chat.liveRunStatus = "streaming"
    fixture.chat.liveRunFreshUntil = NOW + 1
    fixture.run.grantDigest = "d".repeat(64)
    fixture.run.grantExpiresAt = NOW + 400_000
    fixture.run.heartbeatAt = NOW - 60_000
    fixture.run.leaseExpiresAt = NOW - 15_000
    fixture.message.content = "partial answer"
    fixture.message.parts = [{ type: "text", text: "partial answer" }]
    return fixture
  }

  it("fails an expired streaming run: lease_expired, partial content preserved, chat projection cleared", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    const fixture = makeExpiredStreamingFixture()
    const { ctx } = createMutationCtx(fixture.tables)

    const result = await reapExpiredGenerationRunsPass(ctx)

    expect(result).toEqual({ reaped: 1 })
    expect(fixture.run).toMatchObject({
      status: "failed",
      terminalReason: "lease_expired",
      heartbeatAt: undefined,
      leaseExpiresAt: undefined,
      // Absorbing outcome → grant revoked.
      grantDigest: undefined,
      grantExpiresAt: undefined,
    })
    // Honest failure, content intact.
    expect(fixture.message.status).toBe("failed")
    expect(fixture.message.content).toBe("partial answer")
    // The owner's chat projection cleared and marked failed.
    expect(fixture.chat.liveRunStatus).toBeUndefined()
    expect(fixture.chat.liveRunFreshUntil).toBeUndefined()
    expect(fixture.chat.lastRunStatus).toBe("failed")
  })

  it("does not reap an expired run whose parent project is tombstoned", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    const fixture = makeExpiredStreamingFixture()
    const project: Doc<"projects"> = {
      _id: asId<"projects">("project_deleting"),
      _creationTime: 1,
      userId: fixture.userId,
      name: "Deleting project",
      updatedAt: 1,
      pinned: false,
      deletingAt: NOW - 1,
    }
    fixture.chat.projectId = project._id
    fixture.tables.projects.push(project)
    const { ctx } = createMutationCtx(fixture.tables)

    await expect(reapExpiredGenerationRunsPass(ctx)).resolves.toEqual({
      reaped: 0,
    })
    expect(fixture.run.status).toBe("streaming")
    expect(fixture.message.status).toBe("streaming")
  })

  it("never matches fresh leases, lease-less rows, or the approval pause", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    const fresh = createGenerationRunLinkageFixture()
    fresh.run.leaseExpiresAt = NOW + 30_000

    // A pre-heartbeat row: active-looking, NO lease fields (race #36).
    const legacy = createGenerationRun({
      id: "run_legacy",
      chatId: fresh.chatId,
      userId: fresh.userId,
      status: "streaming",
    })
    // A paused run holds no lease and must never be lease-reaped.
    const paused = createGenerationRun({
      id: "run_paused",
      chatId: fresh.chatId,
      userId: fresh.userId,
      status: "awaiting_approval",
    })
    fresh.tables.generationRuns.push(legacy, paused)
    const { ctx } = createMutationCtx(fresh.tables)

    const result = await reapExpiredGenerationRunsPass(ctx)

    expect(result).toEqual({ reaped: 0 })
    expect(fresh.run.status).toBe("streaming")
    expect(legacy.status).toBe("streaming")
    expect(paused.status).toBe("awaiting_approval")
  })

  it("a reaped run cannot clear a newer owner's chat projection", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    const fixture = makeExpiredStreamingFixture()
    // A newer run claimed the slot; the reaped run's projection must no-op.
    fixture.chat.statusRunId = fixture.otherRunId
    const { ctx } = createMutationCtx(fixture.tables)

    await reapExpiredGenerationRunsPass(ctx)

    expect(fixture.run.status).toBe("failed")
    expect(fixture.chat.liveRunStatus).toBe("streaming")
    expect(fixture.chat.liveRunFreshUntil).toBe(NOW + 1)
  })

  it("settles the reaped run's pending approvals and active tool records", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    const fixture = makeExpiredStreamingFixture()
    fixture.tables.toolApprovalRequests.push({
      _id: asId<"toolApprovalRequests">("approval_request_1"),
      _creationTime: 1,
      chatId: fixture.chatId,
      runId: fixture.runId,
      assistantMessageId: fixture.messageId,
      userId: fixture.userId,
      toolCallId: "call_1",
      toolName: "send_email",
      source: "mcp",
      riskClass: "destructive",
      approvalId: "approval_1",
      status: "pending",
      createdAt: 1,
      expiresAt: NOW + 1000,
    })
    fixture.tables.toolInvocations.push({
      _id: asId<"toolInvocations">("tool_invocation_1"),
      _creationTime: 1,
      runId: fixture.runId,
      chatId: fixture.chatId,
      messageId: fixture.messageId,
      toolCallId: "call_1",
      toolName: "send_email",
      source: "mcp",
      status: "called",
      createdAt: 1,
      updatedAt: 1,
    })
    const { ctx } = createMutationCtx(fixture.tables)

    await reapExpiredGenerationRunsPass(ctx)

    expect(fixture.tables.toolApprovalRequests[0]).toMatchObject({
      status: "expired",
      resolvedAt: NOW,
    })
    expect(fixture.tables.toolInvocations[0]).toMatchObject({
      status: "failed",
      completedAt: NOW,
    })
  })

  it("expires an unattended approval pause: approval_expired on the paused run", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    const fixture = createGenerationRunLinkageFixture()
    fixture.chat.statusRunId = fixture.runId
    fixture.run.status = "awaiting_approval"
    fixture.message.content = "content tail"
    fixture.message.parts = [{ type: "text", text: "content tail" }]
    fixture.tables.toolApprovalRequests.push(
      {
        _id: asId<"toolApprovalRequests">("approval_request_1"),
        _creationTime: 1,
        chatId: fixture.chatId,
        runId: fixture.runId,
        assistantMessageId: fixture.messageId,
        userId: fixture.userId,
        toolCallId: "call_1",
        toolName: "send_email",
        source: "mcp",
        riskClass: "destructive",
        approvalId: "approval_1",
        status: "pending",
        createdAt: 1,
        expiresAt: NOW - 1,
      },
      {
        // This approval is still fresh, but the triggering expiry makes its
        // shared run terminal, so it must settle in the same transaction.
        _id: asId<"toolApprovalRequests">("approval_request_2"),
        _creationTime: 2,
        chatId: fixture.chatId,
        runId: fixture.runId,
        assistantMessageId: fixture.messageId,
        userId: fixture.userId,
        toolCallId: "call_2",
        toolName: "write_file",
        source: "mcp",
        riskClass: "destructive",
        approvalId: "approval_2",
        status: "pending",
        createdAt: 2,
        expiresAt: NOW + 60_000,
      }
    )
    fixture.tables.toolInvocations.push(
      {
        _id: asId<"toolInvocations">("tool_invocation_1"),
        _creationTime: 1,
        runId: fixture.runId,
        chatId: fixture.chatId,
        messageId: fixture.messageId,
        toolCallId: "call_1",
        toolName: "send_email",
        source: "mcp",
        status: "pending_approval",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        _id: asId<"toolInvocations">("tool_invocation_2"),
        _creationTime: 2,
        runId: fixture.runId,
        chatId: fixture.chatId,
        messageId: fixture.messageId,
        toolCallId: "call_2",
        toolName: "write_file",
        source: "mcp",
        status: "called",
        createdAt: 2,
        updatedAt: 2,
      }
    )
    const { ctx } = createMutationCtx(fixture.tables)

    const result = await reapExpiredToolApprovalsPass(ctx)

    expect(result).toEqual({ expired: 1 })
    expect(
      fixture.tables.toolApprovalRequests.map((approval) => ({
        status: approval.status,
        resolvedAt: approval.resolvedAt,
      }))
    ).toEqual([
      { status: "expired", resolvedAt: NOW },
      { status: "expired", resolvedAt: NOW },
    ])
    expect(
      fixture.tables.toolInvocations.map((invocation) => ({
        status: invocation.status,
        error: invocation.error,
        completedAt: invocation.completedAt,
      }))
    ).toEqual([
      {
        status: "failed",
        error: "tool approval expired",
        completedAt: NOW,
      },
      {
        status: "failed",
        error: "tool approval expired",
        completedAt: NOW,
      },
    ])
    expect(fixture.run).toMatchObject({
      status: "failed",
      terminalReason: "approval_expired",
    })
    expect(fixture.message.content).toBe("content tail")
  })

  it("does not reap an expired approval whose parent project is tombstoned", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    const fixture = createGenerationRunLinkageFixture()
    const project: Doc<"projects"> = {
      _id: asId<"projects">("project_deleting"),
      _creationTime: 1,
      userId: fixture.userId,
      name: "Deleting project",
      updatedAt: 1,
      pinned: false,
      deletingAt: NOW - 1,
    }
    fixture.chat.projectId = project._id
    fixture.tables.projects.push(project)
    fixture.run.status = "awaiting_approval"
    const approval: Doc<"toolApprovalRequests"> = {
      _id: asId<"toolApprovalRequests">("approval_request_1"),
      _creationTime: 1,
      chatId: fixture.chatId,
      runId: fixture.runId,
      assistantMessageId: fixture.messageId,
      userId: fixture.userId,
      toolCallId: "call_1",
      toolName: "send_email",
      source: "mcp",
      riskClass: "destructive",
      approvalId: "approval_1",
      status: "pending",
      createdAt: 1,
      expiresAt: NOW - 1,
    }
    fixture.tables.toolApprovalRequests.push(approval)
    const { ctx } = createMutationCtx(fixture.tables)

    await expect(reapExpiredToolApprovalsPass(ctx)).resolves.toEqual({
      expired: 0,
    })
    expect(approval.status).toBe("pending")
    expect(fixture.run.status).toBe("awaiting_approval")
  })

  it("the approval reaper never touches an unexpired pending approval", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    const fixture = createGenerationRunLinkageFixture()
    fixture.run.status = "awaiting_approval"
    fixture.tables.toolApprovalRequests.push({
      _id: asId<"toolApprovalRequests">("approval_request_fresh"),
      _creationTime: 1,
      chatId: fixture.chatId,
      runId: fixture.runId,
      assistantMessageId: fixture.messageId,
      userId: fixture.userId,
      toolCallId: "call_fresh",
      toolName: "send_email",
      source: "mcp",
      riskClass: "destructive",
      approvalId: "approval_fresh",
      status: "pending",
      createdAt: 1,
      expiresAt: NOW + 60_000,
    })
    const { ctx } = createMutationCtx(fixture.tables)

    const result = await reapExpiredToolApprovalsPass(ctx)

    expect(result).toEqual({ expired: 0 })
    expect(fixture.tables.toolApprovalRequests[0]?.status).toBe("pending")
    expect(fixture.run.status).toBe("awaiting_approval")
  })
})

describe("approval-continuation idempotency", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function makePausedWorld() {
    const fixture = createApprovalContinuationFixture([
      {
        approvalId: "approval_1",
        approved: true,
        toolCallId: "call_1",
        toolName: "read_file",
      },
    ])
    const { user, chat } = fixture.owner
    const tables: Partial<TableDocuments> = {
      ...fixture.tables,
      users: [user],
      chats: [chat],
    }
    return { fixture, user, chat, tables }
  }

  it("exactly one continuation run: the second prepare gets the typed conflict", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { fixture, chat, tables } = makePausedWorld()
    const { ctx, tables: world } = createMutationCtx(tables)

    const first = await prepareAsOwner(ctx, {
      chatId: chat._id,
      requestId: "request_continuation_1",
      model: "gpt-5",
      provider: "openai",
      approvalResponses: fixture.responses,
    })

    const pausedRun = world.generationRuns.find(
      (run) => run._id === fixture.run._id
    )
    const continuationRun = world.generationRuns.find(
      (run) => run._id === first.runId
    )
    expect(pausedRun?.continuationRunId).toBe(first.runId)
    expect(continuationRun?.continuedFromRunId).toBe(fixture.run._id)

    // The losing tab's auto-send re-prepares with the same (now-resolved)
    // approval state — rejected with the typed conflict, creating nothing.
    await expect(
      prepareAsOwner(ctx, {
        chatId: chat._id,
        requestId: "request_continuation_2",
        model: "gpt-5",
        provider: "openai",
        approvalResponses: fixture.responses,
      })
    ).rejects.toThrow("Approval continuation already dispatched")
    expect(pausedRun?.continuationRunId).toBe(first.runId)
  })

  it("a late continuation cannot resurrect a Stop-settled pause (race #16)", async () => {
    // The user approved (the click resolved the approval row), then Stopped
    // before the auto-send POST landed: the Stop aborted the pause. The late
    // continuation prepare must CONFLICT — not create a new streaming run
    // linked to the aborted pause, re-claim the chat slot, and repaint the
    // Stop-settled assistant message back to streaming.
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { fixture, chat, tables } = makePausedWorld()
    fixture.run.status = "aborted"
    fixture.run.terminalReason = "user_stop"
    for (const approval of fixture.tables.toolApprovalRequests ?? []) {
      approval.status = "approved"
      approval.resolvedAt = 1699999999000
    }
    const { ctx, tables: world } = createMutationCtx(tables)
    const runCountBefore = world.generationRuns.length

    await expect(
      prepareAsOwner(ctx, {
        chatId: chat._id,
        requestId: "request_late_continuation",
        model: "gpt-5",
        provider: "openai",
        approvalResponses: fixture.responses,
      })
    ).rejects.toThrow("Approval pause already settled")

    // The pause keeps its Stop terminal and never records a continuation.
    // (Real Convex also rolls back this transaction's interim writes; the
    // fake ctx only proves the typed conflict fired before any commit.)
    expect(fixture.run.status).toBe("aborted")
    expect(fixture.run.continuationRunId).toBeUndefined()
    expect(world.generationRuns.length).toBeGreaterThanOrEqual(runCountBefore)
  })

  it("a continuation whose pause lost the chat slot to a newer run conflicts (no supersede of the healthy run)", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { fixture, chat, tables } = makePausedWorld()
    // A newer, healthy run owns the chat's status slot.
    chat.statusRunId = asId<"generationRuns">("run_newer")

    const { ctx } = createMutationCtx(tables)

    await expect(
      prepareAsOwner(ctx, {
        chatId: chat._id,
        requestId: "request_displaced_continuation",
        model: "gpt-5",
        provider: "openai",
        approvalResponses: fixture.responses,
      })
    ).rejects.toThrow("Approval pause no longer owns the chat's active run")
  })
})

describe("resolved-approvals-without-continuation reaper", () => {
  const NOW = 1700000000000
  const GRACE = RESOLVED_APPROVAL_CONTINUATION_GRACE_MS

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // A stranded pause: the approvals resolved (default: at exactly the grace
  // boundary, the earliest eligible instant) but no continuation prepare ever
  // ran. The pause still owns the chat's status slot, as it would after a
  // crash with no further sends.
  function makeStrandedWorld({
    approved = true,
    resolvedAt = NOW - GRACE,
  }: { approved?: boolean; resolvedAt?: number } = {}) {
    const fixture = createApprovalContinuationFixture([
      {
        approvalId: "approval_1",
        approved,
        toolCallId: "call_1",
        toolName: "read_file",
      },
    ])
    for (const approval of fixture.tables.toolApprovalRequests) {
      approval.resolvedAt = resolvedAt
    }
    const { user, chat } = fixture.owner
    chat.statusRunId = fixture.run._id
    chat.liveRunStatus = "awaiting"
    chat.liveRunFreshUntil = NOW + APPROVAL_EXPIRY_MS
    const tables: Partial<TableDocuments> = {
      ...fixture.tables,
      users: [user],
      chats: [chat],
    }
    return { fixture, user, chat, tables }
  }

  it("settles an approved strand at the grace boundary: failed/continuation_lost, tools settled, projection cleared", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    const { fixture, chat, tables } = makeStrandedWorld()
    const { ctx } = createMutationCtx(tables)

    const result = await reapResolvedApprovalPausesPass(ctx)

    expect(result).toEqual({ settled: 1 })
    expect(fixture.run).toMatchObject({
      status: "failed",
      terminalReason: "continuation_lost",
      error: "approval continuation was not dispatched",
      completedAt: NOW,
    })
    // The approved-but-never-executed invocation settles failed; the approval
    // row keeps its canonical approved decision (audit trail, not erased).
    expect(fixture.invocations[0]).toMatchObject({
      status: "failed",
      error: "approval continuation was not dispatched",
      completedAt: NOW,
    })
    expect(fixture.tables.toolApprovalRequests[0]?.status).toBe("approved")
    // The message keeps its tool part and is stamped with the honest terminal.
    expect(fixture.tables.messages[0]?.status).toBe("failed")
    // The pause still owned the slot, so the owner projection clears + signals.
    expect(chat.liveRunStatus).toBeUndefined()
    expect(chat.liveRunFreshUntil).toBeUndefined()
    expect(chat.lastRunStatus).toBe("failed")
  })

  it("a denied strand settles aborted; a pause that lost the chat slot cannot clear the newer owner's projection", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    const { fixture, chat, tables } = makeStrandedWorld({ approved: false })
    // Next-send slot transfer already happened: a newer run owns the slot.
    chat.statusRunId = asId<"generationRuns">("run_newer")
    chat.liveRunStatus = "streaming"
    const { ctx } = createMutationCtx(tables)

    const result = await reapResolvedApprovalPausesPass(ctx)

    expect(result).toEqual({ settled: 1 })
    expect(fixture.run).toMatchObject({
      status: "aborted",
      terminalReason: "continuation_lost",
    })
    expect(chat.liveRunStatus).toBe("streaming")
  })

  it("never touches a within-grace, still-pending, undated, or already-continued pause", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    const pendingWorld = makeStrandedWorld()
    for (const approval of pendingWorld.fixture.tables.toolApprovalRequests) {
      approval.status = "pending"
      approval.resolvedAt = undefined
    }
    const undatedWorld = makeStrandedWorld()
    for (const approval of undatedWorld.fixture.tables.toolApprovalRequests) {
      approval.resolvedAt = undefined
    }
    const continuedWorld = makeStrandedWorld()
    continuedWorld.fixture.run.continuationRunId =
      asId<"generationRuns">("run_cont")
    const scenarios = [
      // Resolved one tick after the earliest eligible instant — still in grace.
      makeStrandedWorld({ resolvedAt: NOW - GRACE + 1 }),
      // A pending row: the user or the approval reaper still owns the pause.
      pendingWorld,
      // Resolved but undated: undefined is EXCLUDED, never "old enough"
      // (the §18 #6 undefined rule applied to this pass's expiry comparison).
      undatedWorld,
      // A stamped continuation means a prepare owns the close.
      continuedWorld,
    ]
    for (const world of scenarios) {
      const { ctx } = createMutationCtx(world.tables)
      await expect(reapResolvedApprovalPausesPass(ctx)).resolves.toEqual({
        settled: 0,
      })
      expect(world.fixture.run.status).toBe("awaiting_approval")
      expect(world.chat.liveRunStatus).toBe("awaiting")
    }
  })

  it("scans past a batch-limit-sized prefix of ineligible pauses (no starvation)", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    const { fixture, chat, tables } = makeStrandedWorld()
    // 30 older awaiting pauses that are permanently ineligible for THIS pass
    // (no approval rows). A scan capped at REAPER_BATCH_LIMIT (25) would
    // never reach the eligible strand behind them.
    const blockers = Array.from({ length: 30 }, (_, index) =>
      createGenerationRun({
        id: `run_blocker_${index}`,
        chatId: chat._id,
        userId: fixture.owner.user._id,
        status: "awaiting_approval",
        updatedAt: index - 30,
      })
    )
    tables.generationRuns = [...blockers, ...(tables.generationRuns ?? [])]
    const { ctx } = createMutationCtx(tables)

    const result = await reapResolvedApprovalPausesPass(ctx)

    expect(result).toEqual({ settled: 1 })
    expect(fixture.run.status).toBe("failed")
    for (const blocker of blockers) {
      expect(blocker.status).toBe("awaiting_approval")
    }
  })

  it("advances its durable cursor past a saturated prefix across cron ticks", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    const { fixture, chat, tables } = makeStrandedWorld()
    const blockerCount = 205
    const blockers = Array.from({ length: blockerCount }, (_, index) =>
      createGenerationRun({
        id: `run_saturated_blocker_${index}`,
        chatId: chat._id,
        userId: fixture.owner.user._id,
        status: "awaiting_approval",
        updatedAt: index - blockerCount,
      })
    )
    tables.generationRuns = [...blockers, ...(tables.generationRuns ?? [])]
    const { ctx, tables: world } = createMutationCtx(tables)

    // Tick 1 examines the oldest 200-row page. Every row is permanently
    // ineligible (no approval records), but the durable cursor advances.
    await expect(reapResolvedApprovalPausesPass(ctx)).resolves.toEqual({
      settled: 0,
    })
    expect(fixture.run.status).toBe("awaiting_approval")
    expect(world.reaperCheckpoints).toHaveLength(1)
    expect(world.reaperCheckpoints[0]?.cursor).toEqual(expect.any(String))

    // Tick 2 resumes after that page and reaches the eligible strand behind
    // the remaining blockers. The final page wraps the next sweep to null.
    await expect(reapResolvedApprovalPausesPass(ctx)).resolves.toEqual({
      settled: 1,
    })
    expect(fixture.run.status).toBe("failed")
    expect(world.reaperCheckpoints[0]?.cursor).toBeUndefined()
    expect(
      blockers.every((blocker) => blocker.status === "awaiting_approval")
    ).toBe(true)
  })

  it("holds the cursor when the settlement budget stops mid-page", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    const { user, chat, userId, chatId } = createOwnerFixture()
    const runs = Array.from({ length: 26 }, (_, index) =>
      createGenerationRun({
        id: `run_eligible_${index}`,
        chatId,
        userId,
        status: "awaiting_approval",
        updatedAt: index + 1,
      })
    )
    const approvals: Doc<"toolApprovalRequests">[] = runs.map((run, index) => ({
      _id: asId<"toolApprovalRequests">(`approval_eligible_${index}`),
      _creationTime: index + 1,
      chatId,
      runId: run._id,
      assistantMessageId: asId<"messages">(`message_missing_${index}`),
      userId,
      toolCallId: `call_${index}`,
      toolName: "read_file",
      source: "mcp",
      riskClass: "read",
      approvalId: `approval_${index}`,
      status: "approved",
      createdAt: 1,
      expiresAt: 60_000,
      resolvedAt: NOW - GRACE,
    }))
    const { ctx, tables } = createMutationCtx({
      users: [user],
      chats: [chat],
      generationRuns: runs,
      toolApprovalRequests: approvals,
    })

    await expect(reapResolvedApprovalPausesPass(ctx)).resolves.toEqual({
      settled: 25,
    })
    expect(
      runs.filter((run) => run.status === "awaiting_approval")
    ).toHaveLength(1)
    expect(tables.reaperCheckpoints[0]?.cursor).toBeUndefined()

    await expect(reapResolvedApprovalPausesPass(ctx)).resolves.toEqual({
      settled: 1,
    })
    expect(runs.every((run) => run.status === "failed")).toBe(true)
  })

  it("anchors the grace on the LAST resolvedAt across multiple approvals", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    const fixture = createApprovalContinuationFixture([
      {
        approvalId: "approval_1",
        approved: true,
        toolCallId: "call_1",
        toolName: "read_file",
      },
      {
        approvalId: "approval_2",
        approved: true,
        toolCallId: "call_2",
        toolName: "write_file",
      },
    ])
    const [first, second] = fixture.tables.toolApprovalRequests
    first!.resolvedAt = NOW - GRACE - 60_000 // long past the grace
    second!.resolvedAt = NOW - GRACE + 1 // resolved a tick too recently
    const { user, chat } = fixture.owner
    const tables: Partial<TableDocuments> = {
      ...fixture.tables,
      users: [user],
      chats: [chat],
    }
    const { ctx } = createMutationCtx(tables)

    // The newest resolution gates the whole pause — one old approval must not
    // make a freshly-resolved sibling eligible.
    await expect(reapResolvedApprovalPausesPass(ctx)).resolves.toEqual({
      settled: 0,
    })
    expect(fixture.run.status).toBe("awaiting_approval")

    second!.resolvedAt = NOW - GRACE
    await expect(reapResolvedApprovalPausesPass(ctx)).resolves.toEqual({
      settled: 1,
    })
    expect(fixture.run.status).toBe("failed")
  })

  it("commit order A — reaper first: the late continuation prepare gets the typed pause-settled conflict", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    const { fixture, chat, tables } = makeStrandedWorld()
    const { ctx, tables: world } = createMutationCtx(tables)

    await expect(reapResolvedApprovalPausesPass(ctx)).resolves.toEqual({
      settled: 1,
    })
    const runCountAfterReap = world.generationRuns.length

    // The crashed tab comes back and fires the stale auto-send continuation.
    await expect(
      prepareAsOwner(ctx, {
        chatId: chat._id,
        requestId: "request_late_continuation",
        model: "gpt-5",
        provider: "openai",
        approvalResponses: fixture.responses,
      })
    ).rejects.toThrow("Approval pause already settled")

    // The reaped terminal is never resurrected and records no continuation.
    expect(fixture.run.status).toBe("failed")
    expect(fixture.run.terminalReason).toBe("continuation_lost")
    expect(fixture.run.continuationRunId).toBeUndefined()
    expect(world.generationRuns.length).toBeGreaterThanOrEqual(
      runCountAfterReap
    )
  })

  it("commit order B — continuation prepare first: the reaper leaves the settled pause and its continuation intact", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    const { fixture, chat, tables } = makeStrandedWorld()
    const { ctx, tables: world } = createMutationCtx(tables)

    const continuation = await prepareAsOwner(ctx, {
      chatId: chat._id,
      requestId: "request_continuation",
      model: "gpt-5",
      provider: "openai",
      approvalResponses: fixture.responses,
    })
    expect(fixture.run.continuationRunId).toBe(continuation.runId)

    await expect(reapResolvedApprovalPausesPass(ctx)).resolves.toEqual({
      settled: 0,
    })
    expect(fixture.run.status).toBe("completed")
    const continuationRun = world.generationRuns.find(
      (run) => run._id === continuation.runId
    )
    expect(continuationRun?.status).toBe("streaming")
  })
})

describe("pending-only approval resolution", () => {
  const EXPIRY = 1700000000000

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function makeApprovalWorld({
    expiresAt = EXPIRY,
    status = "pending",
    reason,
  }: {
    expiresAt?: number
    status?: Doc<"toolApprovalRequests">["status"]
    reason?: string
  } = {}) {
    const fixture = createGenerationRunLinkageFixture()
    fixture.chat.statusRunId = fixture.runId
    fixture.chat.liveRunStatus = "awaiting"
    fixture.chat.liveRunFreshUntil = expiresAt
    fixture.run.status = "awaiting_approval"
    fixture.message.status = "awaiting_approval"
    const approval: Doc<"toolApprovalRequests"> = {
      _id: asId<"toolApprovalRequests">("approval_request_1"),
      _creationTime: 1,
      chatId: fixture.chatId,
      runId: fixture.runId,
      assistantMessageId: fixture.messageId,
      userId: fixture.userId,
      toolCallId: "call_1",
      toolName: "send_email",
      source: "mcp",
      riskClass: "destructive",
      approvalId: "approval_1",
      status,
      reason,
      createdAt: 1,
      expiresAt,
    }
    fixture.tables.toolApprovalRequests.push(approval)
    const invocation: Doc<"toolInvocations"> = {
      _id: asId<"toolInvocations">("tool_invocation_1"),
      _creationTime: 1,
      runId: fixture.runId,
      chatId: fixture.chatId,
      messageId: fixture.messageId,
      toolCallId: "call_1",
      toolName: "send_email",
      source: "mcp",
      status: "pending_approval",
      createdAt: 1,
      updatedAt: 1,
    }
    fixture.tables.toolInvocations.push(invocation)
    const world = createMutationCtx(fixture.tables)
    return { ...fixture, approval, invocation, ...world }
  }

  it("rejects a decision when the parent project is tombstoned", async () => {
    vi.spyOn(Date, "now").mockReturnValue(EXPIRY - 1)
    const world = makeApprovalWorld()
    const project: Doc<"projects"> = {
      _id: asId<"projects">("project_deleting"),
      _creationTime: 1,
      userId: world.userId,
      name: "Deleting project",
      updatedAt: 1,
      pinned: false,
      deletingAt: EXPIRY - 2,
    }
    world.chat.projectId = project._id
    world.tables.projects.push(project)

    await expect(
      decideAsOwner(
        world.ctx,
        { approvalId: "approval_1" },
        "approved"
      )
    ).rejects.toThrow("Approval not found")
    expect(world.approval.status).toBe("pending")
  })

  it.each([
    {
      first: "approved" as const,
      firstReason: "Approved in tab A",
      second: "denied" as const,
      secondReason: "Denied in tab B",
    },
    {
      first: "denied" as const,
      firstReason: "Denied in tab A",
      second: "approved" as const,
      secondReason: "Approved in tab B",
    },
  ])(
    "keeps the first $first decision and reason canonical when a $second click loses",
    async ({ first, firstReason, second, secondReason }) => {
      vi.spyOn(Date, "now").mockReturnValue(EXPIRY - 1)
      const { ctx, approval } = makeApprovalWorld()

      const winner = await decideAsOwner(
        ctx,
        { approvalId: "approval_1", reason: firstReason },
        first
      )
      const loser = await decideAsOwner(
        ctx,
        { approvalId: "approval_1", reason: secondReason },
        second
      )

      expect(winner).toEqual({
        status: first,
        alreadyResolved: false,
        reason: firstReason,
      })
      expect(loser).toEqual({
        status: first,
        alreadyResolved: true,
        reason: firstReason,
      })
      expect(approval).toMatchObject({ status: first, reason: firstReason })
    }
  )

  it("allows a decision just before expiry and leaves nothing for the reaper", async () => {
    vi.spyOn(Date, "now").mockReturnValue(EXPIRY - 1)
    const { ctx, approval, run } = makeApprovalWorld()

    const decision = await decideAsOwner(
      ctx,
      { approvalId: "approval_1", reason: "Approved in time" },
      "approved"
    )
    expect(decision.status).toBe("approved")
    expect(run.status).toBe("awaiting_approval")

    vi.spyOn(Date, "now").mockReturnValue(EXPIRY)
    expect(await reapExpiredToolApprovalsPass(ctx)).toEqual({ expired: 0 })
    expect(approval.status).toBe("approved")
  })

  it.each([
    ["exactly at expiry", EXPIRY],
    ["after expiry but before reaping", EXPIRY + 1],
  ])("expires atomically %s", async (_label, now) => {
    vi.spyOn(Date, "now").mockReturnValue(now)
    const { ctx, tables, approval, invocation, run, message, chat } =
      makeApprovalWorld()
    const siblingApproval: Doc<"toolApprovalRequests"> = {
      _id: asId<"toolApprovalRequests">("approval_request_2"),
      _creationTime: 2,
      chatId: approval.chatId,
      runId: approval.runId,
      assistantMessageId: approval.assistantMessageId,
      userId: approval.userId,
      toolCallId: "call_2",
      toolName: "write_file",
      source: "mcp",
      riskClass: "destructive",
      approvalId: "approval_2",
      status: "pending",
      createdAt: 2,
      expiresAt: EXPIRY + 60_000,
    }
    const siblingInvocation: Doc<"toolInvocations"> = {
      _id: asId<"toolInvocations">("tool_invocation_2"),
      _creationTime: 2,
      runId: approval.runId,
      chatId: approval.chatId,
      messageId: approval.assistantMessageId,
      toolCallId: "call_2",
      toolName: "write_file",
      source: "mcp",
      status: "called",
      createdAt: 2,
      updatedAt: 2,
    }
    tables.toolApprovalRequests.push(siblingApproval)
    tables.toolInvocations.push(siblingInvocation)

    const result = await decideAsOwner(
      ctx,
      { approvalId: "approval_1" },
      "approved"
    )

    expect(result).toMatchObject({ status: "expired", alreadyResolved: true })
    expect(approval).toMatchObject({ status: "expired", resolvedAt: now })
    expect(invocation.status).toBe("failed")
    expect(siblingApproval).toMatchObject({
      status: "expired",
      resolvedAt: now,
    })
    expect(siblingInvocation).toMatchObject({
      status: "failed",
      error: "tool approval expired",
      completedAt: now,
    })
    expect(run).toMatchObject({
      status: "failed",
      terminalReason: "approval_expired",
    })
    expect(message.status).toBe("failed")
    expect(chat.liveRunStatus).toBeUndefined()
  })

  it("converges when the reaper commits before a losing decision", async () => {
    vi.spyOn(Date, "now").mockReturnValue(EXPIRY)
    const { ctx, approval, run } = makeApprovalWorld()

    expect(await reapExpiredToolApprovalsPass(ctx)).toEqual({ expired: 1 })
    const loser = await decideAsOwner(
      ctx,
      { approvalId: "approval_1", reason: "Too late" },
      "denied"
    )

    expect(loser).toEqual({
      status: "expired",
      alreadyResolved: true,
      reason: undefined,
    })
    expect(approval.status).toBe("expired")
    expect(run.terminalReason).toBe("approval_expired")
  })

  it("converges when decision-side expiry commits before the reaper", async () => {
    vi.spyOn(Date, "now").mockReturnValue(EXPIRY)
    const { ctx, approval, run } = makeApprovalWorld()

    await decideAsOwner(ctx, { approvalId: "approval_1" }, "approved")
    expect(await reapExpiredToolApprovalsPass(ctx)).toEqual({ expired: 0 })
    expect(approval.status).toBe("expired")
    expect(run.terminalReason).toBe("approval_expired")
  })
})

describe("assistant work-duration lifecycle", () => {
  it("records the provider boundary once and carries approval-pause work", async () => {
    vi.spyOn(Date, "now").mockReturnValue(20_000)
    const fixture = createGenerationRunLinkageFixture()
    fixture.message.metadata = {
      reasoningDurationMs: 436,
      workDurationMs: 2400,
    }
    const { ctx } = createMutationCtx(fixture.tables)
    const owner = { user: fixture.user, chat: fixture.chat, run: fixture.run }

    await markGenerationWorkStartedForChat(ctx, owner, {
      messageId: fixture.messageId,
      startedAt: 999_000,
    })
    await markGenerationWorkStartedForChat(ctx, owner, {
      messageId: fixture.messageId,
      startedAt: 99_000,
    })

    expect(fixture.run).toMatchObject({
      workStartedAt: 20_000,
      workDurationMs: 2400,
    })
  })

  it.each([
    ["failed", 5300],
    ["aborted", 6100],
  ] as const)("persists %s terminal work without overwriting reasoning", async (outcome, workDurationMs) => {
    const fixture = createGenerationRunLinkageFixture()
    fixture.message.content = "partial"
    fixture.message.parts = [{ type: "text", text: "partial" }]
    fixture.message.metadata = { reasoningDurationMs: 436 }
    const { ctx } = createMutationCtx(fixture.tables)
    const owner = { user: fixture.user, chat: fixture.chat, run: fixture.run }

    if (outcome === "failed") {
      await markGenerationRunFailedForChat(ctx, owner, {
        messageId: fixture.messageId,
        error: "provider failed",
        workDurationMs,
      })
    } else {
      await markGenerationRunAbortedForChat(ctx, owner, {
        messageId: fixture.messageId,
        reason: "stream aborted",
        workDurationMs,
      })
    }

    expect(fixture.message.metadata).toEqual({
      reasoningDurationMs: 436,
      workDurationMs,
    })
    expect(fixture.run.workDurationMs).toBe(workDurationMs)
  })
})

describe("stopGenerationRun", () => {
  const NOW = 1700000000000

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function makeStoppableFixture() {
    const fixture = createGenerationRunLinkageFixture()
    fixture.chat.statusRunId = fixture.runId
    fixture.chat.liveRunStatus = "streaming"
    fixture.chat.liveRunFreshUntil = NOW + 100_000
    fixture.run.grantDigest = "d".repeat(64)
    fixture.run.grantExpiresAt = NOW + 400_000
    fixture.run.heartbeatAt = NOW - 5_000
    fixture.run.leaseExpiresAt = NOW + 40_000
    fixture.run.workStartedAt = NOW - 3600
    fixture.run.workDurationMs = 2400
    fixture.message.content = "partial answer"
    fixture.message.parts = [{ type: "text", text: "partial answer" }]
    fixture.message.metadata = { reasoningDurationMs: 436 }
    return fixture
  }

  it("retains the displayed prefix ahead of the next checkpoint without replacing server parts", async () => {
    const fixture = makeStoppableFixture()
    const tool = {
      type: "tool-web_search",
      toolCallId: "call_1",
      state: "output-available",
      output: { result: "server" },
    }
    const text = {
      type: "text",
      text: "1.",
      providerMetadata: { google: { thoughtSignature: "server-signature" } },
    }
    fixture.message.content = "1."
    fixture.message.parts = [tool, text]
    const observedText = "1." + "x".repeat(164)
    const { ctx } = createMutationCtx(fixture.tables)

    await stopGenerationRunForChat(ctx, fixture, { observedText })

    expect(fixture.message.content).toBe(observedText)
    expect(fixture.message.parts).toEqual([tool, { ...text, text: observedText }])
    expect(fixture.message.status).toBe("aborted")
    expect(fixture.message.metadata?.reasoningDurationMs).toBe(436)
    expect(fixture.run.grantDigest).toBeUndefined()
  })

  it("retains visible text before the first checkpoint instead of deleting the empty sibling", async () => {
    const fixture = makeStoppableFixture()
    fixture.message.content = ""
    fixture.message.parts = []
    fixture.otherMessage.content = "prior answer"
    fixture.otherMessage.parts = [{ type: "text", text: "prior answer" }]
    fixture.otherMessage.status = "completed"
    const { ctx, deletes } = createMutationCtx(fixture.tables)

    await stopGenerationRunForChat(ctx, fixture, { observedText: "visible prefix" })

    expect(fixture.message).toMatchObject({
      content: "visible prefix",
      parts: [{ type: "text", text: "visible prefix" }],
      status: "aborted",
    })
    expect(deletes).not.toContain(fixture.messageId)
    expect(fixture.otherMessage.content).toBe("prior answer")
  })

  it.each([
    "partial",
    "different answer",
    "partial answer" + "x".repeat(128 * 1024),
  ])(
    "ignores stale, divergent, or oversized observed text while still stopping",
    async (observedText) => {
      const fixture = makeStoppableFixture()
      const { ctx } = createMutationCtx(fixture.tables)

      await stopGenerationRunForChat(ctx, fixture, { observedText })

      expect(fixture.message.content).toBe("partial answer")
      expect(fixture.message.status).toBe("aborted")
    }
  )

  it.each(["completed", "newer-run"] as const)(
    "does not merge observed text after %s won",
    async (winner) => {
      const fixture = makeStoppableFixture()
      if (winner === "completed") {
        fixture.run.status = "completed"
        fixture.message.status = "completed"
      } else fixture.chat.statusRunId = fixture.otherRunId
      const { ctx, patches } = createMutationCtx(fixture.tables)

      await stopGenerationRunForChat(ctx, fixture, {
        observedText: "partial answer extended",
      })

      expect(fixture.message.content).toBe("partial answer")
      expect(patches).toEqual([])
    }
  )

  it("stops the exact run: user_stop, audit, content preserved, approvals denied, tools settled", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    const fixture = makeStoppableFixture()
    fixture.tables.toolApprovalRequests.push({
      _id: asId<"toolApprovalRequests">("approval_request_1"),
      _creationTime: 1,
      chatId: fixture.chatId,
      runId: fixture.runId,
      assistantMessageId: fixture.messageId,
      userId: fixture.userId,
      toolCallId: "call_1",
      toolName: "send_email",
      source: "mcp",
      riskClass: "destructive",
      approvalId: "approval_1",
      status: "pending",
      createdAt: 1,
      expiresAt: NOW + 1000,
    })
    fixture.tables.toolInvocations.push(
      {
        _id: asId<"toolInvocations">("tool_invocation_1"),
        _creationTime: 1,
        runId: fixture.runId,
        chatId: fixture.chatId,
        messageId: fixture.messageId,
        toolCallId: "call_1",
        toolName: "send_email",
        source: "mcp",
        status: "pending_approval",
        createdAt: 1,
        updatedAt: 1,
      },
      {
        _id: asId<"toolInvocations">("tool_invocation_2"),
        _creationTime: 1,
        runId: fixture.runId,
        chatId: fixture.chatId,
        messageId: fixture.messageId,
        toolCallId: "call_2",
        toolName: "web_search",
        source: "builtin",
        status: "completed",
        createdAt: 1,
        updatedAt: 1,
      }
    )
    const { ctx } = createMutationCtx(fixture.tables)

    const result = await stopGenerationRunForChat(ctx, {
      user: fixture.user,
      chat: fixture.chat,
      run: fixture.run,
    })

    expect(result).toEqual({
      outcome: "stopped",
      status: "aborted",
      terminalReason: "user_stop",
    })
    expect(fixture.run).toMatchObject({
      status: "aborted",
      terminalReason: "user_stop",
      stopRequestedAt: NOW,
      stopRequestedBy: fixture.userId,
      grantDigest: undefined,
      leaseExpiresAt: undefined,
      workDurationMs: 6000,
      // The Stop carried no run timing receipt, so the revoked grant's digest
      // is copied into the single-use attach capability (ADR-0030) the
      // stopped worker's receipt will authenticate against.
      timingReceiptGrantDigest: "d".repeat(64),
      timingReceiptGrantExpiresAt: NOW + TIMING_RECEIPT_ATTACH_WINDOW_MS,
    })
    expect(fixture.message.status).toBe("aborted")
    expect(fixture.message.content).toBe("partial answer")
    expect(fixture.message.metadata).toEqual({
      reasoningDurationMs: 436,
      workDurationMs: 6000,
    })
    expect(fixture.tables.toolApprovalRequests[0]).toMatchObject({
      status: "denied",
      resolvedByUserId: fixture.userId,
    })
    // pending_approval → denied; completed evidence untouched.
    expect(
      fixture.tables.toolInvocations.map((invocation) => invocation.status)
    ).toEqual(["denied", "completed"])
    expect(fixture.chat.liveRunStatus).toBeUndefined()
    expect(fixture.chat.liveRunFreshUntil).toBeUndefined()
  })

  it("promotes the checkpointed tool-order candidate into the pre-answer duration on Stop", async () => {
    // The client's Stop mutation is the run's terminal; the worker can write
    // nothing afterwards. The part order is complete, so the candidate the
    // last checkpoint carried is the value (ADR-0041, C5).
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    const fixture = makeStoppableFixture()
    fixture.message.metadata = { reasoningDurationMs: 436, workSummaryCandidateMs: 4400 }
    const { ctx } = createMutationCtx(fixture.tables)

    await stopGenerationRunForChat(ctx, {
      user: fixture.user,
      chat: fixture.chat,
      run: fixture.run,
    })

    expect(fixture.message.status).toBe("aborted")
    expect(fixture.message.metadata).toEqual({
      reasoningDurationMs: 436,
      workSummaryDurationMs: 4400,
      workDurationMs: 6000,
    })
  })

  it("is idempotent: the second Stop returns the canonical terminal result", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    const fixture = makeStoppableFixture()
    const { ctx } = createMutationCtx(fixture.tables)
    const owner = {
      user: fixture.user,
      chat: fixture.chat,
      run: fixture.run,
    }

    await stopGenerationRunForChat(ctx, owner)
    const second = await stopGenerationRunForChat(ctx, owner)

    expect(second).toEqual({
      outcome: "already-terminal",
      status: "aborted",
      terminalReason: "user_stop",
    })
  })

  it("does not count approval wait as work when stopping a paused run", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW)
    const fixture = makeStoppableFixture()
    fixture.run.status = "awaiting_approval"
    fixture.run.workDurationMs = 2400
    fixture.message.status = "awaiting_approval"
    fixture.message.metadata = {
      reasoningDurationMs: 436,
      workDurationMs: 2400,
    }
    const { ctx } = createMutationCtx(fixture.tables)

    await stopGenerationRunForChat(ctx, {
      user: fixture.user,
      chat: fixture.chat,
      run: fixture.run,
    })

    expect(fixture.run.workDurationMs).toBe(2400)
    expect(fixture.message.metadata).toEqual({
      reasoningDurationMs: 436,
      workDurationMs: 2400,
    })
  })

  it("returns not-current for a run that lost the chat slot — the newer owner is never touched", async () => {
    const fixture = makeStoppableFixture()
    fixture.chat.statusRunId = fixture.otherRunId
    const newerRun = createGenerationRun({
      id: "run_2",
      chatId: fixture.chatId,
      userId: fixture.userId,
      assistantMessageId: fixture.otherMessageId,
    })
    fixture.tables.generationRuns.push(newerRun)
    const { ctx } = createMutationCtx(fixture.tables)

    const result = await stopGenerationRunForChat(ctx, {
      user: fixture.user,
      chat: fixture.chat,
      run: fixture.run,
    })

    expect(result.outcome).toBe("not-current")
    expect(fixture.run.status).toBe("streaming")
    expect(newerRun.status).toBe("streaming")
  })
})

describe("updateAssistantSnapshotForChat", () => {
  it("keeps the observed summary duration through abort without changing total work", async () => {
    const fixture = createGenerationRunLinkageFixture()
    const { ctx } = createMutationCtx(fixture.tables)
    const owner = await runOwner(ctx, fixture.runId)
    await updateAssistantSnapshotForChat(ctx, owner, {
      messageId: fixture.messageId,
      sequence: 1,
      textSnapshot: "Answer",
      partsSnapshot: [{ type: "text", text: "Answer", providerMetadata: {
        openai: { phase: "final_answer" },
      } }],
      workSummaryDurationMs: 1200,
    })
    await markGenerationRunAbortedForChat(ctx, owner, {
      messageId: fixture.messageId,
      reason: "stream aborted",
      workDurationMs: 2500,
    })
    expect(fixture.message.metadata).toMatchObject({
      workSummaryDurationMs: 1200,
      workDurationMs: 2500,
    })
  })

  it("stores the tool-order candidate, clears it on null, and drops it once the duration resolves", async () => {
    const fixture = createGenerationRunLinkageFixture()
    const { ctx } = createMutationCtx(fixture.tables)
    const owner = await runOwner(ctx, fixture.runId)
    const parts = [{ type: "text", text: "Answer" }]
    await updateAssistantSnapshotForChat(ctx, owner, {
      messageId: fixture.messageId, sequence: 1, textSnapshot: "Answer", partsSnapshot: parts,
      workSummaryCandidateMs: 4400,
    })
    expect(fixture.message.metadata).toMatchObject({ workSummaryCandidateMs: 4400 })
    // Same content, cleared candidate: still a write (the guard compares metadata).
    const cleared = await updateAssistantSnapshotForChat(ctx, owner, {
      messageId: fixture.messageId, sequence: 2, textSnapshot: "Answer", partsSnapshot: parts,
      workSummaryCandidateMs: null,
    })
    expect(cleared).toMatchObject({ kind: "applied" })
    expect(fixture.message.metadata).not.toHaveProperty("workSummaryCandidateMs")
    await updateAssistantSnapshotForChat(ctx, owner, {
      messageId: fixture.messageId, sequence: 3, textSnapshot: "Answer", partsSnapshot: parts,
      workSummaryCandidateMs: 5000,
    })
    await updateAssistantSnapshotForChat(ctx, owner, {
      messageId: fixture.messageId, sequence: 4, textSnapshot: "Answer", partsSnapshot: parts,
      workSummaryDurationMs: 5000,
    })
    expect(fixture.message.metadata).toMatchObject({ workSummaryDurationMs: 5000 })
    expect(fixture.message.metadata).not.toHaveProperty("workSummaryCandidateMs")
  })

  it("applies a checkpoint without retaining a routine snapshot row", async () => {
    const fixture = createGenerationRunLinkageFixture()
    const { ctx, inserts } = createMutationCtx(fixture.tables)

    const result = await updateAssistantSnapshotForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      {
        messageId: fixture.messageId,
        sequence: 1,
        textSnapshot: "partial",
        partsSnapshot: [{ type: "text", text: "partial" }],
      }
    )

    expect(result).toEqual({ kind: "applied", deduped: false })
    expect(inserts).toEqual([])
    expect(fixture.message.content).toBe("partial")
    expect(fixture.message.status).toBe("streaming")
    expect(fixture.run.status).toBe("streaming")
  })

  it("rejects late lower-sequence snapshots before persistence", async () => {
    // The run's lastSnapshotSequence is the authority, so a stale write leaves
    // neither a message nor a run patch behind.
    const fixture = createGenerationRunLinkageFixture()
    fixture.message.content = "newer"
    fixture.message.parts = [{ type: "text", text: "newer" }]
    fixture.run.lastSnapshotSequence = 2
    const { ctx, inserts, patches } = createMutationCtx(fixture.tables)

    const result = await updateAssistantSnapshotForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      {
        messageId: fixture.messageId,
        sequence: 1,
        textSnapshot: "stale",
        partsSnapshot: [{ type: "text", text: "stale" }],
      }
    )

    expect(result).toEqual({ kind: "stale", lastSequence: 2 })
    expect(inserts).toEqual([])
    expect(patches).toEqual([])
    expect(fixture.message.content).toBe("newer")
    expect(fixture.message.parts).toEqual([{ type: "text", text: "newer" }])
  })

  it("rejects an equal-sequence duplicate before insertion", async () => {
    const fixture = createGenerationRunLinkageFixture()
    fixture.run.lastSnapshotSequence = 3
    const { ctx, inserts } = createMutationCtx(fixture.tables)

    const result = await updateAssistantSnapshotForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      {
        messageId: fixture.messageId,
        sequence: 3,
        textSnapshot: "dup",
        partsSnapshot: [{ type: "text", text: "dup" }],
      }
    )

    expect(result).toEqual({ kind: "stale", lastSequence: 3 })
    expect(inserts).toEqual([])
  })

  it("records the accepted sequence and progress on the run", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const fixture = createGenerationRunLinkageFixture()
    const { ctx } = createMutationCtx(fixture.tables)

    const result = await updateAssistantSnapshotForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      {
        messageId: fixture.messageId,
        sequence: 5,
        textSnapshot: "partial",
        partsSnapshot: [{ type: "text", text: "partial" }],
      }
    )

    expect(result).toEqual({ kind: "applied", deduped: false })
    expect(fixture.run.lastSnapshotSequence).toBe(5)
    expect(fixture.run.lastProgressAt).toBe(1700000000000)
    vi.restoreAllMocks()
  })

  it("advances the run without rewriting byte-identical message content", async () => {
    const firstNow = 1700000000000
    const secondNow = firstNow + 1
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(firstNow)
      .mockReturnValueOnce(secondNow)
    const fixture = createGenerationRunLinkageFixture()
    const { ctx, patches } = createMutationCtx(fixture.tables)
    const checkpoint = {
      messageId: fixture.messageId,
      textSnapshot: "same partial",
      partsSnapshot: [{ type: "text", text: "same partial" }],
    }

    const first = await updateAssistantSnapshotForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      { ...checkpoint, sequence: 1 }
    )
    const firstMessageUpdatedAt = fixture.message.updatedAt
    const second = await updateAssistantSnapshotForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      { ...checkpoint, sequence: 2 }
    )

    expect(first).toEqual({ kind: "applied", deduped: false })
    expect(second).toEqual({ kind: "applied", deduped: true })
    expect(fixture.message.updatedAt).toBe(firstMessageUpdatedAt)
    expect(fixture.run.lastSnapshotSequence).toBe(2)
    expect(
      patches.filter((patch) => patch.id === fixture.messageId)
    ).toHaveLength(1)
    expect(patches.filter((patch) => patch.id === fixture.runId)).toHaveLength(
      2
    )
    vi.restoreAllMocks()
  })

  it("lands content on an awaiting_approval pause WITHOUT repainting it streaming", async () => {
    // The pause is lease-free: the same worker's post-pause final flush must
    // land the content tail, but flipping the run back to
    // "streaming" without a lease would strand it outside both liveness
    // regimes — no lease for the run reaper, no pending status for the
    // approval reaper — a permanent zombie if the completion downgrade never
    // arrives.
    const fixture = createGenerationRunLinkageFixture()
    fixture.run.status = "awaiting_approval"
    fixture.run.heartbeatAt = undefined
    fixture.run.leaseExpiresAt = undefined
    fixture.message.status = "awaiting_approval"
    const { ctx, inserts } = createMutationCtx(fixture.tables)

    const result = await updateAssistantSnapshotForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      {
        messageId: fixture.messageId,
        sequence: 4,
        textSnapshot: "tail after pause",
        partsSnapshot: [{ type: "text", text: "tail after pause" }],
      }
    )

    expect(result).toEqual({ kind: "applied", deduped: false })
    expect(inserts).toEqual([])
    expect(fixture.message.content).toBe("tail after pause")
    expect(fixture.message.status).toBe("awaiting_approval")
    expect(fixture.run.status).toBe("awaiting_approval")
    expect(fixture.run.lastSnapshotSequence).toBe(4)
    expect(fixture.run.leaseExpiresAt).toBeUndefined()
  })

  it("becomes a no-op once the run is terminal (post-Stop write storm)", async () => {
    // A streamer that lost the abort/supersede race must not keep inserting
    // snapshots or patching the run/message docs — that write pressure is what
    // OCC-starved the next turn's prepareGeneration after a Stop.
    const fixture = createGenerationRunLinkageFixture()
    fixture.run.status = "aborted"
    const { ctx, inserts, patches } = createMutationCtx(fixture.tables)

    await updateAssistantSnapshotForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      {
        messageId: fixture.messageId,
        sequence: 2,
        textSnapshot: "late write",
        partsSnapshot: [{ type: "text", text: "late write" }],
      }
    )

    expect(inserts).toEqual([])
    expect(patches).toEqual([])
    expect(fixture.message.content).toBe("")
  })
})

describe("applyApprovalResponses", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("aborts a run when any approval response for that run is denied", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const fixture = createApprovalContinuationFixture([
      {
        approvalId: "approval_denied",
        approved: false,
        toolCallId: "call_denied",
        toolName: "delete_file",
      },
      {
        approvalId: "approval_approved",
        approved: true,
        toolCallId: "call_approved",
        toolName: "read_file",
      },
    ])
    const { ctx, patches } = createMutationCtx(fixture.tables)

    await applyApprovalResponses(
      ctx,
      fixture.owner,
      "openai",
      fixture.responses
    )

    expect(fixture.run).toMatchObject({
      status: "aborted",
      completedAt: 1700000000000,
      updatedAt: 1700000000000,
      activeStreamId: undefined,
    })
    expect(fixture.invocations.map((invocation) => invocation.status)).toEqual([
      "denied",
      "approved",
    ])
    expect(patches.filter((patch) => patch.id === fixture.run._id)).toEqual([
      {
        id: fixture.run._id,
        value: {
          status: "aborted",
          completedAt: 1700000000000,
          updatedAt: 1700000000000,
          activeStreamId: undefined,
          // Absorbing outcome: the grant revokes and the lease sheds in the
          // same transaction.
          grantDigest: undefined,
          grantExpiresAt: undefined,
          heartbeatAt: undefined,
          leaseExpiresAt: undefined,
        },
      },
    ])
  })

  it("completes a run when all approval responses for that run are approved", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const fixture = createApprovalContinuationFixture([
      {
        approvalId: "approval_1",
        approved: true,
        toolCallId: "call_1",
        toolName: "read_file",
      },
      {
        approvalId: "approval_2",
        approved: true,
        toolCallId: "call_2",
        toolName: "list_files",
      },
    ])
    const { ctx } = createMutationCtx(fixture.tables)

    await applyApprovalResponses(
      ctx,
      fixture.owner,
      "openai",
      fixture.responses
    )

    expect(fixture.run).toMatchObject({
      status: "completed",
      completedAt: 1700000000000,
      updatedAt: 1700000000000,
      activeStreamId: undefined,
    })
  })

  it("preserves earlier approval responses when multiple responses patch one message", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const fixture = createApprovalContinuationFixture([
      {
        approvalId: "approval_denied",
        approved: false,
        toolCallId: "call_denied",
        toolName: "delete_file",
      },
      {
        approvalId: "approval_approved",
        approved: true,
        toolCallId: "call_approved",
        toolName: "read_file",
      },
    ])
    const { ctx } = createMutationCtx(fixture.tables, { cloneReads: true })

    await applyApprovalResponses(
      ctx,
      fixture.owner,
      "openai",
      fixture.responses
    )

    expect(fixture.tables.messages[0]?.parts).toEqual([
      {
        type: "tool-delete_file",
        toolCallId: "call_denied",
        state: "approval-responded",
        input: {},
        approval: {
          id: "approval_denied",
          approved: false,
        },
      },
      {
        type: "tool-read_file",
        toolCallId: "call_approved",
        state: "approval-responded",
        input: {},
        approval: {
          id: "approval_approved",
          approved: true,
        },
      },
    ])
  })

  it("does not repaint a run a racing Stop already aborted (zombie-repaint fix)", async () => {
    // The paused run was settled aborted by a user Stop before the approval
    // continuation landed. Resolving the approvals must NOT flip the aborted run
    // back to completed — the Generation run lifecycle's approvals-resolved rule
    // ignores an already-terminal run.
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const fixture = createApprovalContinuationFixture([
      {
        approvalId: "approval_1",
        approved: true,
        toolCallId: "call_1",
        toolName: "read_file",
      },
    ])
    fixture.run.status = "aborted"
    fixture.run.completedAt = 1699999999999
    fixture.run.activeStreamId = undefined
    const { ctx, patches } = createMutationCtx(fixture.tables)

    await applyApprovalResponses(
      ctx,
      fixture.owner,
      "openai",
      fixture.responses
    )

    expect(fixture.run).toMatchObject({
      status: "aborted",
      completedAt: 1699999999999,
    })
    // The run is left untouched — no close patch fires against the settled run.
    expect(patches.filter((patch) => patch.id === fixture.run._id)).toEqual([])
  })

  it("rejects a provider-switched continuation before mutating approval state", async () => {
    const fixture = createApprovalContinuationFixture([
      {
        approvalId: "approval_1",
        approved: true,
        toolCallId: "call_1",
        toolName: "read_file",
      },
    ])
    const { ctx, patches } = createMutationCtx(fixture.tables)

    await expect(
      applyApprovalResponses(ctx, fixture.owner, "google", fixture.responses)
    ).rejects.toMatchObject({
      data: { code: "approval_provider_mismatch" },
    })
    expect(patches).toEqual([])
    expect(fixture.run.status).toBe("awaiting_approval")
    expect(fixture.tables.messages[0]?.status).toBe("awaiting_approval")
  })

  it("brands a divergent duplicate decision as a continuation conflict, not a server fault", async () => {
    // Two tabs decide the SAME approval differently: the loser's POST carries
    // the opposite decision. That is a race, not an internal error — an
    // unbranded throw here would be redacted to 500 at the HTTP boundary
    // instead of the intentional 409 contract the client already handles.
    const fixture = createApprovalContinuationFixture([
      {
        approvalId: "approval_1",
        approved: true,
        toolCallId: "call_1",
        toolName: "read_file",
      },
    ])
    const { ctx, patches } = createMutationCtx(fixture.tables)
    const divergent = [{ ...fixture.responses[0]!, approved: false }]

    await expect(
      applyApprovalResponses(ctx, fixture.owner, "openai", divergent)
    ).rejects.toMatchObject({
      data: { code: "approval_continuation_conflict" },
    })
    expect(patches).toEqual([])
    expect(fixture.run.status).toBe("awaiting_approval")
  })

  it("rejects a same-id continuation with a different tool identity", async () => {
    const fixture = createApprovalContinuationFixture([
      {
        approvalId: "approval_1",
        approved: true,
        toolCallId: "call_1",
        toolName: "read_file",
      },
    ])
    const { ctx, patches } = createMutationCtx(fixture.tables)
    const mismatched = [{ ...fixture.responses[0]!, toolName: "send_email" }]

    await expect(
      applyApprovalResponses(ctx, fixture.owner, "openai", mismatched)
    ).rejects.toMatchObject({
      data: { code: "approval_continuation_conflict" },
    })
    expect(patches).toEqual([])
    expect(fixture.run.status).toBe("awaiting_approval")
    expect(fixture.tables.messages[0]?.status).toBe("awaiting_approval")
  })

  it("brands a continuation against a still-pending approval as unresolved, not a conflict", async () => {
    // No decision ever landed, so there is no winning tab whose run the
    // client could observe — the conflict brand (which the client swallows)
    // would silence a failed resolve. The distinct code surfaces it.
    const fixture = createApprovalContinuationFixture([
      {
        approvalId: "approval_1",
        approved: true,
        toolCallId: "call_1",
        toolName: "read_file",
      },
    ])
    fixture.tables.toolApprovalRequests[0]!.status = "pending"
    const { ctx, patches } = createMutationCtx(fixture.tables)

    await expect(
      applyApprovalResponses(ctx, fixture.owner, "openai", fixture.responses)
    ).rejects.toMatchObject({
      data: { code: "approval_unresolved" },
    })
    expect(patches).toEqual([])
    expect(fixture.run.status).toBe("awaiting_approval")
  })
})

describe("denyPendingApprovalsForChat", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("closes the approval request, run, assistant message, and invocation", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)

    const chatId = asId<"chats">("chat_1")
    const userId = asId<"users">("user_1")
    const otherUserId = asId<"users">("user_2")
    const runId = asId<"generationRuns">("run_1")
    const messageId = asId<"messages">("message_1")
    const requestId = asId<"toolApprovalRequests">("approval_request_1")
    const invocationId = asId<"toolInvocations">("tool_invocation_1")

    const request: Doc<"toolApprovalRequests"> = {
      _id: requestId,
      _creationTime: 1,
      chatId,
      runId,
      assistantMessageId: messageId,
      userId,
      toolCallId: "call_1",
      toolName: "send_email",
      source: "mcp",
      reason: "Needs approval",
      riskClass: "destructive",
      approvalId: "approval_1",
      status: "pending",
      createdAt: 1,
      expiresAt: 60_000,
    }
    const otherUserRequest: Doc<"toolApprovalRequests"> = {
      ...request,
      _id: asId<"toolApprovalRequests">("approval_request_2"),
      userId: otherUserId,
      approvalId: "approval_2",
      toolCallId: "call_2",
    }
    const run: Doc<"generationRuns"> = {
      _id: runId,
      _creationTime: 1,
      chatId,
      userId,
      requestId: "request_1",
      model: "gpt-5",
      provider: "openai",
      status: "awaiting_approval",
      startedAt: 1,
      updatedAt: 1,
      activeStreamId: "message_1",
      assistantMessageId: messageId,
    }
    const message: Doc<"messages"> = {
      _id: messageId,
      _creationTime: 1,
      chatId,
      orderId: 1,
      role: "assistant",
      content: "",
      parts: [
        {
          type: "tool-send_email",
          toolCallId: "call_1",
          state: "approval-requested",
          input: { to: "person@example.com" },
          approval: { id: "approval_1" },
        },
      ],
      status: "awaiting_approval",
      requestId: "request_1",
      generationRunId: runId,
      model: "gpt-5",
      provider: "openai",
      createdAt: 1,
      updatedAt: 1,
    }
    const invocation: Doc<"toolInvocations"> = {
      _id: invocationId,
      _creationTime: 1,
      runId,
      chatId,
      messageId,
      toolCallId: "call_1",
      toolName: "send_email",
      source: "mcp",
      input: { to: "person@example.com" },
      inputPreview: '{"to":"person@example.com"}',
      status: "pending_approval",
      createdAt: 1,
      updatedAt: 1,
    }
    const unrelatedInvocation: Doc<"toolInvocations"> = {
      ...invocation,
      _id: asId<"toolInvocations">("tool_invocation_2"),
      toolCallId: "call_unrelated",
      status: "called",
    }
    const tables = {
      toolApprovalRequests: [request, otherUserRequest],
      generationRuns: [run],
      messages: [message],
      toolInvocations: [invocation, unrelatedInvocation],
    }
    const { ctx, patches } = createMutationCtx(tables)

    await denyPendingApprovalsForChat(
      ctx,
      chatId,
      userId,
      "auto-denied: new generation started"
    )

    expect(request).toMatchObject({
      status: "denied",
      resolvedAt: 1700000000000,
      resolvedByUserId: userId,
      reason: "auto-denied: new generation started",
    })
    expect(otherUserRequest.status).toBe("pending")
    expect(message).toMatchObject({
      status: "aborted",
      error: "auto-denied: new generation started",
      updatedAt: 1700000000000,
    })
    expect(message.parts).toEqual([
      {
        type: "tool-send_email",
        toolCallId: "call_1",
        state: "approval-responded",
        input: { to: "person@example.com" },
        approval: {
          id: "approval_1",
          approved: false,
          reason: "auto-denied: new generation started",
        },
      },
    ])
    expect(invocation).toMatchObject({
      status: "denied",
      approvalId: requestId,
      approvalRequestId: "approval_1",
      completedAt: 1700000000000,
      updatedAt: 1700000000000,
    })
    expect(unrelatedInvocation.status).toBe("called")
    expect(run).toMatchObject({
      status: "aborted",
      error: "auto-denied: new generation started",
      completedAt: 1700000000000,
      updatedAt: 1700000000000,
      activeStreamId: undefined,
    })
    expect(patches.map((patch) => patch.id)).toEqual([
      requestId,
      messageId,
      invocationId,
      runId,
    ])
  })
})

describe("chat status projection", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("claims the chat's status slot at run start (streaming + statusRunId)", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { user, chat, userId, chatId } = createOwnerFixture()
    const messages: Doc<"messages">[] = [
      createStoredMessage({
        id: "message_user_1",
        chatId,
        userId,
        orderId: 0,
        clientMessageId: "user-1",
        role: "user",
        content: "prompt",
        createdAt: 1000,
      }),
      createStoredMessage({
        id: "message_assistant_1",
        chatId,
        orderId: 1,
        role: "assistant",
        content: "answer",
        createdAt: 1001,
      }),
    ]
    const { ctx } = createMutationCtx({
      users: [user],
      chats: [chat],
      messages,
    })

    const result = await prepareAsOwner(ctx, {
      chatId,
      requestId: "request_followup",
      model: "gpt-5",
      provider: "openai",
      expectedVisibleMessageCount: 2,
      tailMessageId: "message_assistant_1",
      latestUserMessage: {
        id: "user-2",
        role: "user",
        content: "next prompt",
        parts: [{ type: "text", text: "next prompt" }],
      },
    })

    // Claimed AFTER the (no-op here) supersede pass, so the new run owns the slot.
    expect(chat).toMatchObject({
      liveRunStatus: "streaming",
      statusRunId: result.runId,
    })
  })

  it("projects awaiting when the owning run requests a tool approval", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const fixture = createGenerationRunLinkageFixture()
    // Simulate the run-start claim: this run owns the chat's status slot.
    fixture.chat.statusRunId = fixture.runId
    fixture.chat.liveRunStatus = "streaming"
    const { ctx } = createMutationCtx(fixture.tables)

    await createToolApprovalRequestForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      {
        assistantMessageId: fixture.messageId,
        toolCallId: "call_1",
        toolName: "send_email",
        source: "mcp",
        riskClass: "destructive",
        approvalId: "approval_1",
      }
    )

    expect(fixture.chat.liveRunStatus).toBe("awaiting")
    expect(fixture.chat.statusRunId).toBe(fixture.runId)
  })

  it("clears live and writes the completed mirror when the owning run completes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const fixture = createGenerationRunLinkageFixture()
    fixture.chat.statusRunId = fixture.runId
    fixture.chat.liveRunStatus = "streaming"
    const { ctx } = createMutationCtx(fixture.tables)

    await markGenerationRunCompletedForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      {
        messageId: fixture.messageId,
        content: "done",
        parts: [{ type: "text", text: "done" }],
      }
    )

    expect(fixture.chat.liveRunStatus).toBeUndefined()
    expect(fixture.chat).toMatchObject({
      lastRunStatus: "completed",
      lastRunEndedAt: 1700000000000,
    })
    // statusRunId is KEPT after a terminal so a same-run convergence still applies.
    expect(fixture.chat.statusRunId).toBe(fixture.runId)
  })

  it("writes the failed mirror when the owning run fails", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const fixture = createGenerationRunLinkageFixture()
    fixture.chat.statusRunId = fixture.runId
    fixture.chat.liveRunStatus = "streaming"
    const { ctx } = createMutationCtx(fixture.tables)

    await markGenerationRunFailedForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      { messageId: fixture.messageId, error: "provider rejected" }
    )

    expect(fixture.chat.liveRunStatus).toBeUndefined()
    expect(fixture.chat).toMatchObject({
      lastRunStatus: "failed",
      lastRunEndedAt: 1700000000000,
    })
  })

  it("leaves the mirror unchanged on abort (aborted carries no signal)", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const fixture = createGenerationRunLinkageFixture()
    fixture.chat.statusRunId = fixture.runId
    fixture.chat.liveRunStatus = "streaming"
    // A prior, already-seen completed run left a mirror.
    fixture.chat.lastRunEndedAt = 1699999999000
    fixture.chat.lastRunStatus = "completed"
    const { ctx } = createMutationCtx(fixture.tables)

    await markGenerationRunAbortedForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      { messageId: fixture.messageId, reason: "stream aborted" }
    )

    // Only the live phase clears; the terminal mirror is untouched (a user Stop
    // must not strand a stale unread, and it writes no new signal).
    expect(fixture.chat.liveRunStatus).toBeUndefined()
    expect(fixture.chat).toMatchObject({
      lastRunEndedAt: 1699999999000,
      lastRunStatus: "completed",
    })
  })

  it("ignores a terminal projection from a run that no longer owns the slot (run-id guard)", async () => {
    // Run A completes, run B claims the slot, then A's late `fail` lands. The
    // lifecycle lets fail overwrite completed, so A's run transition is real —
    // but the guard must keep it from clobbering B's live row.
    vi.spyOn(Date, "now").mockReturnValue(1700000000000)
    const { user, chat, userId, chatId } = createOwnerFixture()
    const runAId = asId<"generationRuns">("run_a")
    const runBId = asId<"generationRuns">("run_b")
    const messageAId = asId<"messages">("message_a")
    const runA = createGenerationRun({
      id: runAId,
      chatId,
      userId,
      assistantMessageId: messageAId,
      status: "completed",
    })
    const messageA = createAssistantRuntimeMessage({
      id: messageAId,
      chatId,
      runId: runAId,
      orderId: 1,
      status: "completed",
      content: "A answer",
      parts: [{ type: "text", text: "A answer" }],
    })
    // Run B has claimed the chat's status slot.
    chat.statusRunId = runBId
    chat.liveRunStatus = "streaming"
    const { ctx } = createMutationCtx({
      users: [user],
      chats: [chat],
      messages: [messageA],
      generationRuns: [runA],
    })

    await markGenerationRunFailedForChat(ctx, await runOwner(ctx, runAId), {
      messageId: messageAId,
      error: "late failure",
    })

    // A's run itself transitions to failed (fail may overwrite completed)...
    expect(runA.status).toBe("failed")
    // ...but B still owns the row: the guard made A's projection a no-op.
    expect(chat).toMatchObject({
      liveRunStatus: "streaming",
      statusRunId: runBId,
    })
    expect(chat.lastRunStatus).toBeUndefined()
  })
})

describe("allowance settlement rides terminal transitions (ADR-0021)", () => {
  const pricingSnapshot = {
    revision: "rev-test",
    currency: "USD" as const,
    primary: {
      modelId: "gpt-5",
      routeId: "gpt-5",
      providerId: "openai",
      upstreamModelId: "gpt-5",
      inputCreditsPerMTok: 750_000,
      outputCreditsPerMTok: 4_500_000,
    },
  }

  function createAllowanceFixture(options: { workStartedAt?: number } = {}) {
    const { user, chat, userId, chatId } = createOwnerFixture()
    const runId = asId<"generationRuns">("run_1")
    const messageId = asId<"messages">("message_1")
    const run = {
      ...createGenerationRun({
        id: "run_1",
        chatId,
        userId,
        assistantMessageId: messageId,
      }),
      cancellationSettlementVersion: 1 as const,
      ...(options.workStartedAt !== undefined
        ? { workStartedAt: options.workStartedAt }
        : {}),
    }
    const message = createAssistantRuntimeMessage({
      id: "message_1",
      chatId,
      runId,
      orderId: 1,
    })
    const bucket = {
      _id: asId<"usageBuckets">("bucket_1"),
      _creationTime: 1,
      userId,
      bucketKind: "included" as const,
      periodKey: "2026-08",
      periodStart: 0,
      periodEnd: 10_000_000,
      planId: "free-v1",
      grantedCredits: 1_000_000,
      availableCredits: 900_000,
      reservedCredits: 100_000,
      spentCredits: 0,
      status: "active" as const,
      createdAt: 1,
      updatedAt: 1,
    } satisfies Doc<"usageBuckets">
    const reservation = {
      _id: asId<"usageReservations">("reservation_1"),
      _creationTime: 1,
      userId,
      requestId: "request_1",
      bucketId: bucket._id,
      generationRunId: runId,
      chatId: String(chatId),
      modelId: "gpt-5",
      routeId: "gpt-5",
      providerId: "openai",
      status: "reserved" as const,
      cancellationSettlementVersion: 1 as const,
      providerMayHaveStarted: options.workStartedAt !== undefined,
      estimatedCredits: 100_000,
      reservedCredits: 100_000,
      titleEstimatedCredits: 500,
      pricingSnapshot,
      payloadFingerprint: "fp",
      reservedAt: 1,
      updatedAt: 1,
    } satisfies Doc<"usageReservations">

    const tables: TableDocuments = {
      toolApprovalRequests: [],
      generationRuns: [run],
      reaperCheckpoints: [],
      messages: [message],
      toolInvocations: [],
      users: [user],
      chats: [chat],
      projects: [],
      usageBuckets: [bucket],
      usageReservations: [reservation],
      usageLedgerEntries: [],
    }
    return { tables, runId, messageId, chatId, userId, chat, run }
  }

  it("completion settles actual aggregate usage against the reservation", async () => {
    const fixture = createAllowanceFixture({ workStartedAt: 1_000 })
    const { ctx, tables } = createMutationCtx(fixture.tables)

    await markGenerationRunCompletedForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      {
        messageId: fixture.messageId,
        content: "done",
        parts: [{ type: "text", text: "done" }],
        usage: { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 },
        titleUsage: "not-run",
      }
    )

    // 750 input + 450 output credits at the fixture rates.
    expect(tables.usageReservations[0]).toMatchObject({
      status: "settled",
      settlementBasis: "actual",
      actualCredits: 1_200,
    })
    expect(tables.usageBuckets[0]).toMatchObject({
      availableCredits: 998_800,
      reservedCredits: 0,
      spentCredits: 1_200,
    })
  })

  it("a pre-provider-work failure releases the full reservation", async () => {
    const fixture = createAllowanceFixture() // no workStartedAt
    const { ctx, tables } = createMutationCtx(fixture.tables)

    await markGenerationRunFailedForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      { messageId: fixture.messageId, error: "provider rejected the key" }
    )

    expect(tables.usageReservations[0]).toMatchObject({ status: "released" })
    expect(tables.usageBuckets[0]).toMatchObject({
      availableCredits: 1_000_000,
      reservedCredits: 0,
      spentCredits: 0,
    })
  })

  it("a user Stop marks accounting pending instead of charging the estimate", async () => {
    // Cancellation amendment: Stop commits aborted/user_stop and revokes the
    // run grant immediately, but the reservation stays HELD — the stopped
    // worker's receipt or the deadline reconciler settles from evidence.
    const fixture = createAllowanceFixture({ workStartedAt: 1_000 })
    fixture.tables.generationRuns[0] = {
      ...fixture.tables.generationRuns[0]!,
      grantDigest: "grant-digest-1",
      grantExpiresAt: Date.now() + 60_000,
    }
    fixture.chat.statusRunId = fixture.runId
    fixture.tables.messages[0].content = "1."
    fixture.tables.messages[0].parts = [{ type: "text", text: "1." }]
    const { ctx, tables } = createMutationCtx(fixture.tables)

    const result = await stopGenerationRunForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      { observedText: "1." + "x".repeat(164) }
    )
    expect(result.outcome).toBe("stopped")
    // Visible terminality + normal-authority revocation are immediate…
    expect(tables.generationRuns[0]).toMatchObject({
      status: "aborted",
      terminalReason: "user_stop",
      grantDigest: undefined,
    })
    // …while accounting defers: still reserved (blocking overspend), with
    // the settlement-only capability copied before revocation.
    expect(tables.usageReservations[0]).toMatchObject({
      status: "reserved",
      settlementGrantDigest: "grant-digest-1",
      providerMayHaveStarted: true,
      terminalEstimatedOutputTokens: 1,
    })
    expect(tables.messages[0].content).toHaveLength(166)
    expect(
      tables.usageReservations[0]!.settlementDeadlineAt
    ).toBeGreaterThan(Date.now())
    expect(tables.usageBuckets[0]).toMatchObject({
      reservedCredits: 100_000,
      spentCredits: 0,
    })
    expect(
      tables.usageLedgerEntries.filter(
        (entry) => entry.type === "settle" || entry.type === "release"
      )
    ).toHaveLength(0)
  })

  it("a worker abort carrying terminal evidence settles from it atomically", async () => {
    const fixture = createAllowanceFixture({ workStartedAt: 1_000 })
    const { ctx, tables } = createMutationCtx(fixture.tables)

    await markGenerationRunAbortedForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      {
        messageId: fixture.messageId,
        reason: "stream aborted",
        terminalUsage: {
          primary: {
            kind: "completed-steps",
            inputTokens: 1_000,
            outputTokens: 100,
          },
          title: { kind: "not-run" },
        },
      }
    )

    expect(tables.usageReservations[0]).toMatchObject({
      status: "settled",
      settlementBasis: "observed_partial",
      actualCredits: 1_200,
      titleSettlementBasis: "not_run",
    })
  })

  it("releases when the worker proves provider dispatch never happened", async () => {
    const fixture = createAllowanceFixture({ workStartedAt: 1_000 })
    const { ctx, tables } = createMutationCtx(fixture.tables)

    await markGenerationRunAbortedForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      {
        messageId: fixture.messageId,
        reason: "provider dispatch not authorized",
        terminalUsage: {
          primary: { kind: "not-started" },
          title: { kind: "not-run" },
        },
      }
    )

    expect(tables.usageReservations[0]).toMatchObject({ status: "released" })
    expect(tables.usageBuckets[0]).toMatchObject({
      availableCredits: 1_000_000,
      reservedCredits: 0,
      spentCredits: 0,
    })
  })

  it("rejects malformed terminal evidence before any state change", async () => {
    const fixture = createAllowanceFixture({ workStartedAt: 1_000 })
    const { ctx, tables } = createMutationCtx(fixture.tables)

    await expect(
      markGenerationRunAbortedForChat(ctx, await runOwner(ctx, fixture.runId), {
        messageId: fixture.messageId,
        terminalUsage: {
          primary: { kind: "actual", inputTokens: -5 },
          title: { kind: "not-run" },
        },
      })
    ).rejects.toThrow("Invalid terminal usage evidence")
    expect(tables.generationRuns[0]!.status).toBe("streaming")
    expect(tables.usageReservations[0]!.status).toBe("reserved")
  })

  it("a post-provider-work abort without usage settles the estimate", async () => {
    const fixture = createAllowanceFixture({ workStartedAt: 1_000 })
    const { ctx, tables } = createMutationCtx(fixture.tables)

    await markGenerationRunAbortedForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      { messageId: fixture.messageId, reason: "stopped by user" }
    )

    expect(tables.usageReservations[0]).toMatchObject({
      status: "settled",
      settlementBasis: "estimated_after_unknown_usage",
      actualCredits: 100_000,
    })
    expect(tables.usageBuckets[0]).toMatchObject({
      availableCredits: 900_000,
      spentCredits: 100_000,
      reservedCredits: 0,
    })
  })

  it("duplicate terminal delivery cannot double-charge", async () => {
    const fixture = createAllowanceFixture({ workStartedAt: 1_000 })
    const { ctx, tables } = createMutationCtx(fixture.tables)

    await markGenerationRunCompletedForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      {
        messageId: fixture.messageId,
        content: "done",
        parts: [{ type: "text", text: "done" }],
        usage: { inputTokens: 1_000, outputTokens: 100 },
        titleUsage: "not-run",
      }
    )
    // The deliberate failed-over-completed convergence still must not
    // re-charge: the reservation settled once, the second settle is absorbed.
    await markGenerationRunFailedForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      { messageId: fixture.messageId, error: "late envelope failure" }
    )

    expect(
      tables.usageLedgerEntries.filter((entry) => entry.type === "settle")
    ).toHaveLength(1)
    expect(tables.usageBuckets[0]).toMatchObject({ spentCredits: 1_200 })
  })

  it("an approval pause settles the paused run's usage", async () => {
    const fixture = createAllowanceFixture({ workStartedAt: 1_000 })
    fixture.tables.toolApprovalRequests.push({
      _id: asId<"toolApprovalRequests">("approval_1"),
      _creationTime: 1,
      chatId: fixture.chatId,
      runId: fixture.runId,
      assistantMessageId: fixture.messageId,
      userId: fixture.userId,
      toolCallId: "call_1",
      toolName: "search",
      source: "mcp",
      riskClass: "unknown",
      approvalId: "appr_1",
      status: "pending",
      createdAt: 1,
      expiresAt: 60_000,
    })
    const { ctx, tables } = createMutationCtx(fixture.tables)

    await markGenerationRunCompletedForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      {
        messageId: fixture.messageId,
        content: "paused",
        parts: [{ type: "text", text: "paused" }],
        usage: { inputTokens: 1_000, outputTokens: 100 },
        titleUsage: "not-run",
      }
    )

    expect(tables.generationRuns[0]!.status).toBe("awaiting_approval")
    expect(tables.usageReservations[0]).toMatchObject({
      status: "settled",
      settlementBasis: "actual",
      terminalReason: "approval_pause",
    })
  })

  it("the lease reaper settles a dead worker's reservation at the input floor", async () => {
    // Cancellation amendment: a reaped lease has no worker to report usage,
    // so it settles from durable facts — the estimated input floor, with ZERO
    // title (invariant 7: no evidence a title attempt ever started) — never
    // the legacy full-reservation charge.
    const fixture = createAllowanceFixture({ workStartedAt: 1_000 })
    fixture.tables.generationRuns[0] = {
      ...fixture.tables.generationRuns[0]!,
      heartbeatAt: 1_000,
      leaseExpiresAt: Date.now() - 60_000,
    }
    fixture.tables.usageReservations[0] = {
      ...fixture.tables.usageReservations[0]!,
      estimatedInputTokens: 2_000,
    }
    const { ctx, tables } = createMutationCtx(fixture.tables)

    const { reaped } = await reapExpiredGenerationRunsPass(ctx)
    expect(reaped).toBe(1)
    // 2_000 input × 0.75 = 1_500. Far below the 100k reserve.
    expect(tables.usageReservations[0]).toMatchObject({
      status: "settled",
      settlementBasis: "estimated_input_floor",
      titleSettlementBasis: "not_run",
      actualCredits: 1_500,
    })
  })

  it("per-step usage accumulates as durable settlement evidence", async () => {
    const fixture = createAllowanceFixture({ workStartedAt: 1_000 })
    const { ctx, tables } = createMutationCtx(fixture.tables)

    await recordToolInvocationsForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      {
        messageId: fixture.messageId,
        stepNumber: 1,
        usage: { inputTokens: 600, outputTokens: 40 },
        invocations: [],
      }
    )
    await recordToolInvocationsForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      {
        messageId: fixture.messageId,
        stepNumber: 2,
        usage: { inputTokens: 400, outputTokens: 60 },
        invocations: [],
      }
    )
    expect(tables.generationRuns[0]).toMatchObject({
      inputTokens: 1_000,
      outputTokens: 100,
    })

    // A mid-stream abort now settles from the accumulated evidence, plus the
    // conservative title estimate.
    await markGenerationRunAbortedForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      { messageId: fixture.messageId, reason: "stopped by user" }
    )
    expect(tables.usageReservations[0]).toMatchObject({
      status: "settled",
      settlementBasis: "observed_partial",
      actualCredits: 1_200 + 500,
    })
  })

  it("mirrors durable title start and actual usage onto the reservation", async () => {
    const fixture = createAllowanceFixture({ workStartedAt: 1_000 })
    const { ctx, tables } = createMutationCtx(fixture.tables)

    await recordTitleUsageEvidenceForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      {
        messageId: fixture.messageId,
        evidence: {
          kind: "started-without-usage",
          routeId: "gpt-5",
          pricingRole: "primary",
        },
      }
    )
    await recordTitleUsageEvidenceForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      {
        messageId: fixture.messageId,
        evidence: {
          kind: "actual",
          routeId: "gpt-5",
          pricingRole: "primary",
          inputTokens: 100,
          outputTokens: 5,
        },
      }
    )
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await recordTitleUsageEvidenceForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      {
        messageId: fixture.messageId,
        evidence: {
          kind: "actual",
          routeId: "gpt-5",
          pricingRole: "primary",
          inputTokens: 1,
          outputTokens: 0,
        },
      }
    )

    const expected = {
      kind: "actual",
      routeId: "gpt-5",
      pricingRole: "primary",
      inputTokens: 100,
      outputTokens: 5,
    }
    expect(tables.generationRuns[0]?.titleUsageEvidence).toEqual(expected)
    expect(tables.usageReservations[0]?.titleUsageEvidence).toEqual(expected)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it("per-step usage is order-independent and retry-idempotent", async () => {
    // Step 2 can commit before step 1 because writes do not backpressure the
    // SDK. Both must count exactly once, including a later retry of step 2.
    const fixture = createAllowanceFixture({ workStartedAt: 1_000 })
    const { ctx, tables } = createMutationCtx(fixture.tables)

    const stepTwo = {
      messageId: fixture.messageId,
      stepNumber: 2,
      usage: { inputTokens: 600, outputTokens: 40 },
      invocations: [],
    }
    const stepOne = {
      messageId: fixture.messageId,
      stepNumber: 1,
      usage: { inputTokens: 400, outputTokens: 60 },
      invocations: [],
    }
    await recordToolInvocationsForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      stepTwo
    )
    await recordToolInvocationsForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      stepOne
    )
    await recordToolInvocationsForChat(
      ctx,
      await runOwner(ctx, fixture.runId),
      stepTwo
    )
    expect(tables.generationRuns[0]).toMatchObject({
      inputTokens: 1_000,
      outputTokens: 100,
      lastUsageStepNumber: 2,
      usageSteps: [
        { stepNumber: 1, inputTokens: 400, outputTokens: 60 },
        { stepNumber: 2, inputTokens: 600, outputTokens: 40 },
      ],
    })
    expect(tables.usageReservations[0]).toMatchObject({
      observedInputTokens: 1_000,
      observedOutputTokens: 100,
    })
  })

  it("rejects unpriceable step evidence before it becomes durable", async () => {
    const fixture = createAllowanceFixture({ workStartedAt: 1_000 })
    const { ctx, tables } = createMutationCtx(fixture.tables)

    await expect(
      recordToolInvocationsForChat(
        ctx,
        await runOwner(ctx, fixture.runId),
        {
          messageId: fixture.messageId,
          stepNumber: 1,
          usage: { outputTokens: Number.MAX_SAFE_INTEGER },
          invocations: [],
        }
      )
    ).rejects.toThrow("exceeds safe integer accounting range")
    expect(tables.generationRuns[0]?.usageSteps).toBeUndefined()
    expect(tables.usageReservations[0]?.observedOutputTokens).toBeUndefined()
  })

  it("bounds adversarial durable step growth", async () => {
    const fixture = createAllowanceFixture({ workStartedAt: 1_000 })
    const { ctx, tables } = createMutationCtx(fixture.tables)

    await expect(
      recordToolInvocationsForChat(
        ctx,
        await runOwner(ctx, fixture.runId),
        {
          messageId: fixture.messageId,
          stepNumber: 65,
          usage: { inputTokens: 1 },
          invocations: [],
        }
      )
    ).rejects.toThrow("Invalid per-step usage evidence")
    expect(tables.generationRuns[0]?.usageSteps).toBeUndefined()
  })
})

describe("generation-run write trust boundary (ADR-0011 / ADR-0021)", () => {
  it("registers every post-prepare run write only as a grant-authorized internal mutation", async () => {
    const runtimeModule: Record<string, unknown> = await import("./chatRuntime")
    const workerModule: Record<string, unknown> = await import(
      "./chatRuntimeWorker"
    )
    const writeOps = Object.keys(generationRunWriteArgs)
    expect(writeOps.length).toBeGreaterThan(0)

    for (const op of writeOps) {
      // No user-token twin may exist: `markGenerationRunCompleted.usage` is
      // the authoritative allowance-settlement input, so any public
      // registration would let a chat owner settle their own platform
      // reservation at a self-declared (near-zero) cost.
      expect(op in runtimeModule, `${op} must not be user-token callable`).toBe(
        false
      )
      const workerFn = workerModule[op] as
        | { isMutation?: boolean; isInternal?: boolean; isPublic?: boolean }
        | undefined
      expect(
        workerFn?.isMutation === true && workerFn.isInternal === true,
        `${op} must be a grant-authorized internal mutation on the worker wire`
      ).toBe(true)
      expect(workerFn?.isPublic).toBeUndefined()
    }

    // Stop stays user-callable by design: it carries no usage or settlement
    // input, and settlement evidence still arrives via the grant wire or the
    // reaper's boundary rule.
    const stop = runtimeModule.stopGenerationRun as { isPublic?: boolean }
    expect(stop.isPublic).toBe(true)
  })
})

describe("closeSupersededGenerationsForChat", () => {
  const NOW = 1700000000000

  it("mints the receipt-attach capability when an orphan message's live run is superseded", async () => {
    const { user, chat, userId, chatId } = createOwnerFixture()
    const liveRunId = asId<"generationRuns">("run_orphan")
    const messageId = asId<"messages">("message_orphan")
    // 50 newer terminal runs (ACTIVE_RUN_SCAN_LIMIT) push the live run out of
    // the scan window, so its message reaches the orphan branch.
    const fillers = Array.from({ length: 50 }, (_, index) =>
      createGenerationRun({
        id: `run_done_${index}`,
        chatId,
        userId,
        status: "completed",
        updatedAt: 2000 + index,
      })
    )
    const liveRun: Doc<"generationRuns"> = {
      ...createGenerationRun({
        id: liveRunId,
        chatId,
        userId,
        assistantMessageId: messageId,
        updatedAt: 1000,
      }),
      grantDigest: "d".repeat(64),
      grantExpiresAt: NOW + 60_000,
    }
    const message = createAssistantRuntimeMessage({
      id: messageId,
      chatId,
      runId: liveRunId,
      orderId: 1,
      content: "partial",
      parts: [{ type: "text", text: "partial" }],
    })
    const { ctx } = createMutationCtx({
      users: [user],
      chats: [chat],
      messages: [message],
      generationRuns: [...fillers, liveRun],
    })

    await closeSupersededGenerationsForChat(ctx, chatId, userId, NOW)

    expect(message.status).toBe("aborted")
    expect(liveRun).toMatchObject({
      status: "aborted",
      terminalReason: "superseded",
      grantDigest: undefined,
      timingReceiptGrantDigest: "d".repeat(64),
      timingReceiptGrantExpiresAt: NOW + TIMING_RECEIPT_ATTACH_WINDOW_MS,
    })
  })
})
