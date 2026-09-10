import { api } from "@/convex/_generated/api"
import { SYSTEM_PROMPT_DEFAULT } from "@/lib/config"
import { getAllModels } from "@/lib/models"
import * as retainedChatStream from "@/lib/chat-stream/server"
import {
  resolveReasoningEffort,
  shapeRequest,
} from "@/lib/openproviders/request-shaping"
import { prepareToolRuntime } from "@/lib/tools/runtime"
import * as Sentry from "@sentry/nextjs"
import {
  APICallError,
  convertToModelMessages,
  safeValidateUIMessages,
  toUIMessageStream,
  validateUIMessages,
  type LanguageModelUsage,
  type StepResultPerformance,
  type TextStreamPart,
  type ToolSet,
} from "ai"
import { getFunctionName } from "convex/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { adaptHistoryForProvider } from "./adapters"
import {
  createChatTurnRuntime,
  type ChatTurnDeps,
  type ChatTurnInput,
} from "./chat-turn-runtime"
import type {
  DurableWorkerCall,
  DurableWorkerWire,
} from "./durable-turn-runtime"
import { prepareTextFilePartsForModelInput } from "./text-file-parts"

// --- mock the heavy collaborators so a whole turn runs without HTTP or a model.
// The Chat turn runtime's interface IS the test surface: inject streamText +
// fetchMutation and drive the stream callbacks directly.

vi.mock("@sentry/nextjs", () => ({
  setTag: vi.fn(),
  setContext: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  startSpan: vi.fn((_opts: unknown, cb: () => unknown) => cb()),
}))

vi.mock("@/lib/models", () => ({
  getAllModels: vi.fn(),
}))

vi.mock("@/lib/openproviders/create-language-model", () => ({
  createLanguageModel: vi.fn(() => ({})),
}))

vi.mock("@/lib/openproviders/request-shaping", () => ({
  shapeRequest: vi.fn(() => ({ providerOptions: {}, headers: {} })),
  resolveReasoningEffort: vi.fn(() => ({})),
}))

vi.mock("@/lib/tools/runtime", () => ({
  prepareToolRuntime: vi.fn(),
}))

vi.mock("./adapters", () => ({
  adaptHistoryForProvider: vi.fn(),
}))

vi.mock("./text-file-parts", () => ({
  getTextFilePartReferences: vi.fn(() => []),
  prepareTextFilePartsForModelInput: vi.fn(),
}))

vi.mock("@/lib/observability/braintrust", () => ({
  getBraintrustStreamText: vi.fn(),
  withBraintrustTrace: vi.fn((_opts: unknown, cb: (span: null) => unknown) =>
    cb(null)
  ),
  hashBraintrustIdentifier: vi.fn(async () => "hash"),
  logBraintrustTraceMetadata: vi.fn(),
  getBraintrustErrorMetadata: vi.fn(() => ({})),
  flushBraintrust: vi.fn(async () => {}),
}))

vi.mock("@/lib/posthog", () => ({
  captureGeneration: vi.fn(),
  flushPostHog: vi.fn(async () => {}),
  getPostHogClient: vi.fn(() => null),
}))

vi.mock("@/lib/posthog/scrub", () => ({
  scrubForAnalytics: vi.fn((x: unknown) => x),
}))

vi.mock("@/convex/lib/messageMetadata", () => ({
  projectPersistedMessageMetadata: vi.fn((m: unknown) => m ?? {}),
}))

vi.mock("ai", async (importActual) => {
  const actual = await importActual<typeof import("ai")>()
  return {
    ...actual,
    validateUIMessages: vi.fn(
      async ({ messages }: { messages: unknown[] }) => messages
    ),
    safeValidateUIMessages: vi.fn(actual.safeValidateUIMessages),
    convertToModelMessages: vi.fn(async () => []),
    toUIMessageStream: vi.fn(actual.toUIMessageStream),
  }
})

const SERVER_CHAT_ID = "convexchatid000000000000"

function makeToolRuntime(overrides: Record<string, unknown> = {}) {
  return {
    tools: {},
    hasTools: false,
    metadata: {
      toInvocationMetadataByName: () => ({}),
      source: () => "mcp",
    },
    policySummary: {
      capabilities: {
        search: false,
        extract: false,
        code: false,
        mcp: false,
        platform: false,
      },
      capabilityReasons: {},
      userTier: "free",
      keyMode: undefined,
      keyModeReason: "none",
      totalTools: 0,
      earlyAllowedCount: 0,
      lateAllowedCount: 0,
      searchInjected: false,
    },
    toolCounts: { builtIn: 0, thirdParty: 0, content: 0, mcp: 0, total: 0 },
    mcpServerCount: 0,
    mcpClientCount: 0,
    approvalDecisionsByToolName: new Map(),
    approvalFor: () => undefined,
    toolApproval: undefined,
    prepareStep: undefined,
    onStepFinish: vi.fn(async () => {}),
    outcomeSummary: () => ({
      totalToolCalls: 0,
      failedToolCalls: 0,
      timeoutToolCalls: 0,
      budgetDeniedToolCalls: 0,
    }),
    dispose: vi.fn(async () => {}),
    ...overrides,
  }
}

function makeInput(overrides: Partial<ChatTurnInput> = {}): ChatTurnInput {
  const model = overrides.model ?? "test-model"
  return {
    messages: [
      { id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] },
    ] as ChatTurnInput["messages"],
    chatId: SERVER_CHAT_ID,
    model,
    systemPrompt: "sys",
    enableSearch: false,
    chatVersion: 1,
    requestId: "req-1",
    userId: "user-1",
    anonymousId: undefined,
    isAuthenticated: true,
    convexToken: "tok",
    credential: {
      provider: "anthropic",
      apiKey: "byok-key",
      source: "byok",
    },
    route: {
      modelId: model,
      routeId: model,
      providerId: "anthropic",
      upstreamModelId: model,
      credentialSource: "byok",
      routeReason: "priority_byok",
    },
    ...overrides,
  }
}

type StreamHarness = {
  streamText: ReturnType<typeof vi.fn>
  captured: { streamOpts?: any; responseOpts?: any }
}

function makeStreamHarness(): StreamHarness {
  const captured: { streamOpts?: any; responseOpts?: any } = {}
  vi.mocked(toUIMessageStream).mockImplementation((responseOpts: any) => {
    captured.responseOpts = responseOpts
    return new ReadableStream({
      start(controller) {
        controller.close()
      },
    })
  })
  const streamText = vi.fn((opts: any) => {
    captured.streamOpts = opts
    return {
      // The runtime passes this raw model stream to the standalone UI-message
      // converter above, then builds the Response through the real
      // createUIMessageStreamResponse. The converter's inert stream keeps the
      // HTTP envelope side-effect free while exposing its lifecycle options.
      stream: new ReadableStream(),
    }
  })
  return { streamText, captured }
}

// Convex's generated `api` is a proxy, so function references are not
// identity-stable across reads — match by stable function name instead.
function sameRef(a: unknown, b: unknown): boolean {
  try {
    return (
      getFunctionName(a as Parameters<typeof getFunctionName>[0]) ===
      getFunctionName(b as Parameters<typeof getFunctionName>[0])
    )
  } catch {
    return false
  }
}

function makeFetchMutation() {
  return vi.fn(async (ref: unknown) => {
    if (sameRef(ref, api.chatRuntime.prepareGeneration)) {
      return {
        runId: "run1",
        assistantMessageId: "msg1",
        messages: [],
      }
    }
    return undefined
  })
}

function findCall(fetchMutation: ReturnType<typeof vi.fn>, ref: unknown) {
  return fetchMutation.mock.calls.find((call) => sameRef(call[0], ref))
}

// Post-prepare durable writes travel the Durable worker wire (ADR-0011), not
// fetchMutation — the recording wire is their test seam.
type RecordingWire = DurableWorkerWire & { calls: DurableWorkerCall[] }

function makeWorkerWire(
  responders: Partial<
    Record<string, (args: Record<string, unknown>) => unknown>
  > = {}
): RecordingWire {
  const calls: DurableWorkerCall[] = []
  const wire = (async (call: DurableWorkerCall) => {
    calls.push(call)
    const responder = responders[call.op]
    if (responder) return responder(call.args)
    return undefined
  }) as RecordingWire
  wire.calls = calls
  return wire
}

function wireCall<Op extends DurableWorkerCall["op"]>(
  wire: RecordingWire,
  op: Op
) {
  return wire.calls.find(
    (call): call is Extract<DurableWorkerCall, { op: Op }> => call.op === op
  )
}

function makeDeps(
  harness: StreamHarness,
  fetchMutation: ReturnType<typeof vi.fn>,
  overrides: Partial<ChatTurnDeps> = {}
) {
  return {
    streamText: harness.streamText as unknown as ChatTurnDeps["streamText"],
    generateText: vi.fn(async () => ({
      text: "Greeting Exchange",
    })) as unknown as ChatTurnDeps["generateText"],
    fetchMutation: fetchMutation as unknown as ChatTurnDeps["fetchMutation"],
    fetchQuery: vi.fn(async () => []) as unknown as ChatTurnDeps["fetchQuery"],
    after: vi.fn() as unknown as ChatTurnDeps["after"],
    getPostHogClient: (() =>
      null) as unknown as ChatTurnDeps["getPostHogClient"],
    durableWorkerWire: makeWorkerWire(),
    durableSettleRetryDelaysMs: [0],
    chatAdmissionProofSigner: () => "f".repeat(64),
    ...overrides,
  }
}

function notAbortedSignal(): AbortSignal {
  // A REAL signal: toResponse composes it via AbortSignal.any (worker-loss +
  // provider-deadline), which rejects plain-object fakes.
  return new AbortController().signal
}

async function readStream<T>(stream: ReadableStream<T>): Promise<T[]> {
  const chunks: T[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return chunks
    chunks.push(value)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  const preparedMessages = makeInput().messages
  vi.mocked(getAllModels).mockResolvedValue([
    { id: "test-model", provider: "anthropic", tools: false },
  ] as unknown as Awaited<ReturnType<typeof getAllModels>>)
  vi.mocked(prepareToolRuntime).mockResolvedValue(
    makeToolRuntime() as unknown as Awaited<
      ReturnType<typeof prepareToolRuntime>
    >
  )
  vi.mocked(adaptHistoryForProvider).mockResolvedValue({
    messages: preparedMessages,
    stats: {
      originalMessageCount: 0,
      adaptedMessageCount: 0,
      droppedMessages: 0,
      partsDropped: {},
      partsTransformed: {},
      partsPreserved: {},
      totalPartsOriginal: 0,
      totalPartsAdapted: 0,
      providerIdsStripped: 0,
    },
    warnings: [],
  })
  vi.mocked(prepareTextFilePartsForModelInput).mockResolvedValue({
    messages: preparedMessages,
    convertedCount: 0,
    failedCount: 0,
    truncatedCount: 0,
    skippedCount: 0,
  } as unknown as Awaited<ReturnType<typeof prepareTextFilePartsForModelInput>>)
})

describe("createChatTurnRuntime — prepare()", () => {
  it.each([
    {
      provider: "openai",
      hasTools: true,
      systemPrompt: undefined,
      enriched: true,
    },
    {
      provider: "openai",
      hasTools: true,
      systemPrompt: SYSTEM_PROMPT_DEFAULT,
      enriched: true,
    },
    {
      provider: "openai",
      hasTools: true,
      systemPrompt: "Respond without progress updates.",
      enriched: false,
    },
    {
      provider: "openai",
      hasTools: false,
      systemPrompt: undefined,
      enriched: false,
    },
    {
      provider: "anthropic",
      hasTools: true,
      systemPrompt: undefined,
      enriched: false,
    },
  ] as const)(
    "requests real progress only for default OpenAI tool turns ($provider, tools=$hasTools, enriched=$enriched)",
    async ({ provider, hasTools, systemPrompt, enriched }) => {
      vi.mocked(getAllModels).mockResolvedValue([
        { id: "test-model", provider, tools: hasTools },
      ] as unknown as Awaited<ReturnType<typeof getAllModels>>)
      vi.mocked(prepareToolRuntime).mockResolvedValue(
        makeToolRuntime({ hasTools }) as unknown as Awaited<
          ReturnType<typeof prepareToolRuntime>
        >
      )
      const input = makeInput({ systemPrompt })
      input.credential.provider = provider
      input.route.providerId = provider
      const harness = makeStreamHarness()
      const runtime = createChatTurnRuntime({
        input,
        deps: makeDeps(harness, makeFetchMutation()),
      })
      await runtime.prepare()
      await runtime.toResponse(notAbortedSignal())

      const instructions = harness.captured.streamOpts.instructions
      if (enriched) {
        expect(instructions).toContain(SYSTEM_PROMPT_DEFAULT)
        expect(instructions).toContain(
          "Before using tools, briefly explain what you will check."
        )
      } else {
        expect(instructions).toBe(systemPrompt ?? SYSTEM_PROMPT_DEFAULT)
      }
    }
  )

  it("throws a 401 MISSING_API_KEY when neither a BYOK nor an env key exists", async () => {
    const harness = makeStreamHarness()
    const fetchMutation = makeFetchMutation()
    const runtime = createChatTurnRuntime({
      input: makeInput({
        credential: { provider: "anthropic" },
      }),
      deps: makeDeps(harness, fetchMutation),
    })

    await expect(runtime.prepare()).rejects.toMatchObject({
      statusCode: 401,
      code: "MISSING_API_KEY",
    })
  })

  it("passes authoritative platform key provenance to the Tool runtime", async () => {
    const runtime = createChatTurnRuntime({
      input: makeInput({
        credential: {
          provider: "anthropic",
          apiKey: "platform-key",
          source: "platform",
        },
      }),
      deps: makeDeps(makeStreamHarness(), makeFetchMutation()),
    })

    await runtime.prepare()

    expect(prepareToolRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ providerToolKeyMode: "platform" })
    )
  })

  it("keeps Claude's fixed-budget search request and receipts honest", async () => {
    const actualRequestShaping = await vi.importActual<
      typeof import("@/lib/openproviders/request-shaping")
    >("@/lib/openproviders/request-shaping")
    vi.mocked(resolveReasoningEffort).mockImplementationOnce(
      actualRequestShaping.resolveReasoningEffort
    )
    vi.mocked(shapeRequest).mockImplementationOnce(
      actualRequestShaping.shapeRequest
    )
    vi.mocked(getAllModels).mockResolvedValue([
      {
        id: "test-model",
        provider: "Anthropic",
        providerId: "anthropic",
        tools: true,
        reasoningText: true,
        thinkingMode: "adaptive",
        effortLevels: ["low", "medium", "high", "max"],
        searchThinkingDowngrade: true,
      },
    ] as unknown as Awaited<ReturnType<typeof getAllModels>>)
    const toolRuntime = makeToolRuntime({ hasTools: true })
    toolRuntime.policySummary.searchInjected = true
    vi.mocked(prepareToolRuntime).mockResolvedValue(
      toolRuntime as unknown as Awaited<ReturnType<typeof prepareToolRuntime>>
    )
    const harness = makeStreamHarness()
    const fetchMutation = makeFetchMutation()
    const runtime = createChatTurnRuntime({
      input: makeInput({ reasoningEffort: "high", enableSearch: true }),
      deps: makeDeps(harness, fetchMutation),
    })

    await runtime.prepare()
    await runtime.toResponse(notAbortedSignal())

    expect(resolveReasoningEffort).toHaveBeenCalledWith(
      expect.objectContaining({ searchThinkingDowngrade: true }),
      "high",
      { platformFunded: false, searchToolsActive: true }
    )
    expect(harness.captured.streamOpts.providerOptions).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 10000 } },
    })
    expect(harness.captured.streamOpts).not.toHaveProperty("maxOutputTokens")
    const prepareArgs = findCall(
      fetchMutation,
      api.chatRuntime.prepareGeneration
    )?.[1]
    expect(prepareArgs).toEqual(
      expect.objectContaining({ reasoningEffort: { requested: "high" } })
    )
    expect(prepareArgs).not.toHaveProperty("reasoningEffort.applied")
    expect(
      harness.captured.responseOpts.messageMetadata({ part: { type: "start" } })
    ).not.toHaveProperty("reasoningEffort")
  })

  it("translates platform fixed thinking without double-adding headroom", async () => {
    vi.mocked(getAllModels).mockResolvedValue([
      {
        id: "test-model",
        provider: "Anthropic",
        providerId: "anthropic",
        reasoningText: true,
        thinkingMode: "enabled",
        thinkingBudget: 10_000,
        maxOutput: 64_000,
      },
    ] as unknown as Awaited<ReturnType<typeof getAllModels>>)
    const harness = makeStreamHarness()
    const fetchMutation = makeFetchMutation()
    const runtime = createChatTurnRuntime({
      input: makeInput({
        credential: {
          provider: "anthropic",
          apiKey: "platform-key",
          source: "platform",
        },
        route: {
          modelId: "test-model",
          routeId: "test-model",
          providerId: "anthropic",
          upstreamModelId: "test-model",
          credentialSource: "platform",
          routeReason: "platform",
        },
      }),
      deps: makeDeps(harness, fetchMutation),
    })

    await runtime.prepare()
    await runtime.toResponse(notAbortedSignal())

    expect(harness.captured.streamOpts.maxOutputTokens).toBe(8_192)
    expect(
      findCall(fetchMutation, api.chatRuntime.prepareGeneration)?.[1]
    ).toEqual(
      expect.objectContaining({
        generationBudget: { applied: 18_192 },
      })
    )
  })

  it("applies an explicit BYOK generation budget", async () => {
    vi.mocked(getAllModels).mockResolvedValue([
      {
        id: "test-model",
        provider: "OpenRouter",
        providerId: "openrouter",
        maxOutput: 65_536,
      },
    ] as unknown as Awaited<ReturnType<typeof getAllModels>>)
    const harness = makeStreamHarness()
    const fetchMutation = makeFetchMutation()
    const runtime = createChatTurnRuntime({
      input: makeInput({
        generationBudget: 16_384,
        credential: {
          provider: "openrouter",
          apiKey: "byok-key",
          source: "byok",
        },
        route: {
          modelId: "test-model",
          routeId: "test-model",
          providerId: "openrouter",
          upstreamModelId: "openai/gpt-5.2-pro",
          credentialSource: "byok",
          routeReason: "priority_byok",
        },
      }),
      deps: makeDeps(harness, fetchMutation),
    })

    await runtime.prepare()
    await runtime.toResponse(notAbortedSignal())

    expect(harness.captured.streamOpts.maxOutputTokens).toBe(16_384)
    expect(
      findCall(fetchMutation, api.chatRuntime.prepareGeneration)?.[1]
    ).toEqual(
      expect.objectContaining({
        generationBudget: { requested: 16_384, applied: 16_384 },
      })
    )
  })

  it("records the concrete default without sending a wire override", async () => {
    vi.mocked(resolveReasoningEffort).mockReturnValueOnce({
      appliedReasoningEffort: "medium",
    })
    const fetchMutation = makeFetchMutation()
    const runtime = createChatTurnRuntime({
      input: makeInput({
        reasoningEffort: "high",
        credential: {
          provider: "anthropic",
          apiKey: "platform-key",
          source: "platform",
        },
        route: {
          modelId: "test-model",
          routeId: "test-model",
          providerId: "anthropic",
          upstreamModelId: "test-model",
          credentialSource: "platform",
          routeReason: "platform",
        },
      }),
      deps: makeDeps(makeStreamHarness(), fetchMutation),
    })

    await runtime.prepare()

    expect(
      findCall(fetchMutation, api.chatRuntime.prepareGeneration)?.[1]
    ).toEqual(
      expect.objectContaining({
        reasoningEffort: { requested: "high", applied: "medium" },
      })
    )
    expect(vi.mocked(shapeRequest).mock.calls.at(-1)?.[1]).not.toHaveProperty(
      "wireReasoningEffort"
    )
  })

  it("passes the resolved route id separately from the logical model id for history adaptation", async () => {
    const routeId = "openrouter:openai/gpt-4.1"
    vi.mocked(getAllModels).mockResolvedValue([
      { id: routeId, provider: "OpenRouter", tools: true },
    ] as unknown as Awaited<ReturnType<typeof getAllModels>>)

    const runtime = createChatTurnRuntime({
      input: makeInput({
        model: "gpt-4.1",
        credential: {
          provider: "openrouter",
          apiKey: "byok-key",
          source: "byok",
        },
        route: {
          modelId: "gpt-4.1",
          routeId,
          providerId: "openrouter",
          upstreamModelId: "openai/gpt-4.1",
          credentialSource: "byok",
          routeReason: "priority_byok",
        },
      }),
      deps: makeDeps(makeStreamHarness(), makeFetchMutation()),
    })

    await runtime.prepare()

    expect(adaptHistoryForProvider).toHaveBeenCalledWith(
      expect.any(Array),
      "openrouter",
      expect.objectContaining({
        targetModelId: "gpt-4.1",
        targetRouteId: routeId,
      })
    )
  })

  it("rejects a provider-switched approval before durable prepare mutates state", async () => {
    const { anthropic } = await import("@ai-sdk/anthropic")
    vi.mocked(prepareToolRuntime).mockResolvedValue(
      makeToolRuntime({
        tools: {
          web_search: anthropic.tools.webSearch_20250305(),
        },
        hasTools: true,
      }) as unknown as Awaited<ReturnType<typeof prepareToolRuntime>>
    )
    const fetchMutation = makeFetchMutation()
    const runtime = createChatTurnRuntime({
      input: makeInput({
        messages: [
          {
            id: "foreign-approval",
            role: "assistant",
            metadata: { provider: "openai" },
            parts: [
              {
                type: "tool-web_search",
                state: "approval-responded",
                toolCallId: "foreign-call-id",
                providerExecuted: true,
                input: {},
                approval: { id: "foreign-approval-id", approved: true },
              },
            ],
          },
        ] as ChatTurnInput["messages"],
      }),
      deps: makeDeps(makeStreamHarness(), fetchMutation),
    })

    await expect(runtime.prepare()).rejects.toMatchObject({
      statusCode: 409,
      code: "APPROVAL_PROVIDER_MISMATCH",
    })
    expect(fetchMutation).not.toHaveBeenCalled()
  })

  it("rejects an approval when no durable run can authenticate its provenance", async () => {
    const { anthropic } = await import("@ai-sdk/anthropic")
    vi.mocked(prepareToolRuntime).mockResolvedValue(
      makeToolRuntime({
        tools: {
          web_search: anthropic.tools.webSearch_20250305(),
        },
        hasTools: true,
      }) as unknown as Awaited<ReturnType<typeof prepareToolRuntime>>
    )
    const fetchMutation = makeFetchMutation()
    const runtime = createChatTurnRuntime({
      input: makeInput({
        chatId: "local-anonymous-chat",
        isAuthenticated: false,
        convexToken: undefined,
        anonymousId: "anonymous-user",
        messages: [
          {
            id: "untrusted-approval",
            role: "assistant",
            metadata: { provider: "anthropic" },
            parts: [
              {
                type: "tool-web_search",
                state: "approval-responded",
                toolCallId: "untrusted-call-id",
                providerExecuted: true,
                input: { query: "query" },
                approval: { id: "untrusted-approval-id", approved: true },
              },
            ],
          },
        ] as ChatTurnInput["messages"],
      }),
      deps: makeDeps(makeStreamHarness(), fetchMutation),
    })

    await expect(runtime.prepare()).rejects.toMatchObject({
      statusCode: 409,
      code: "APPROVAL_CONTINUATION_UNVERIFIABLE",
    })
    expect(fetchMutation).not.toHaveBeenCalled()
  })

  it("throws a 400 INVALID_REQUEST error when the model is unknown", async () => {
    vi.mocked(getAllModels).mockResolvedValue(
      [] as unknown as Awaited<ReturnType<typeof getAllModels>>
    )
    const runtime = createChatTurnRuntime({
      input: makeInput(),
      deps: makeDeps(makeStreamHarness(), makeFetchMutation()),
    })

    const error = await runtime.prepare().then(
      () => null,
      (e) => e
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("not found")
    expect(error).toMatchObject({
      statusCode: 400,
      code: "INVALID_REQUEST",
    })
  })

  it("validates UI messages before converting them to model messages", async () => {
    const runtime = createChatTurnRuntime({
      input: makeInput(),
      deps: makeDeps(makeStreamHarness(), makeFetchMutation()),
    })
    await runtime.prepare()

    const validateOrder =
      vi.mocked(validateUIMessages).mock.invocationCallOrder[0]
    const convertOrder = vi.mocked(convertToModelMessages).mock
      .invocationCallOrder[0]
    expect(validateOrder).toBeGreaterThan(0)
    expect(convertOrder).toBeGreaterThan(0)
    expect(validateOrder).toBeLessThan(convertOrder)
    // Boundary 1 is STRUCTURAL: the current turn's tool registry must never
    // judge historical provider-native tool outputs (cross-provider
    // `web_search` schemas are incompatible).
    expect(vi.mocked(validateUIMessages).mock.calls[0]?.[0]).not.toHaveProperty(
      "tools"
    )
  })

  it("fails closed at Boundary 2 without flattening multimodal history", async () => {
    const multimodal = [
      {
        id: "u-multimodal",
        role: "user",
        parts: [
          { type: "text", text: "Inspect this image" },
          {
            type: "file",
            mediaType: "image/png",
            url: "https://example.com/image.png",
          },
        ],
      },
    ] as ChatTurnInput["messages"]
    vi.mocked(prepareTextFilePartsForModelInput).mockResolvedValue({
      messages: multimodal,
      convertedCount: 0,
      failedCount: 0,
      truncatedCount: 0,
      skippedCount: 0,
    })
    vi.mocked(adaptHistoryForProvider).mockResolvedValue({
      messages: multimodal,
      stats: {
        originalMessageCount: 1,
        adaptedMessageCount: 1,
        droppedMessages: 0,
        partsDropped: {},
        partsTransformed: {},
        partsPreserved: { text: 1, file: 1 },
        totalPartsOriginal: 2,
        totalPartsAdapted: 2,
        providerIdsStripped: 0,
      },
      warnings: [],
    })
    vi.mocked(safeValidateUIMessages).mockResolvedValueOnce({
      success: false,
      error: new Error(
        'Type validation failed: Value: {"file":"PRIVATE_FILE_SENTINEL"}'
      ),
    })

    const runtime = createChatTurnRuntime({
      input: makeInput(),
      deps: makeDeps(makeStreamHarness(), makeFetchMutation()),
    })

    await expect(runtime.prepare()).rejects.toMatchObject({
      name: "ModelBoundReplayInvariantError",
      message: "Model-bound replay invariant failed",
    })
    expect(convertToModelMessages).not.toHaveBeenCalled()
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      "chat_model_bound_validation_failed",
      expect.not.objectContaining({
        extra: expect.objectContaining({
          errorContext: expect.anything(),
        }),
      })
    )
  })

  it("enforces non-empty history at structural Boundary 1", async () => {
    const actualAi = await vi.importActual<typeof import("ai")>("ai")
    vi.mocked(validateUIMessages).mockImplementationOnce(
      actualAi.validateUIMessages as never
    )
    const runtime = createChatTurnRuntime({
      input: makeInput(),
      deps: makeDeps(makeStreamHarness(), makeFetchMutation()),
    })

    await expect(runtime.prepare()).rejects.toThrow(
      "Messages array must not be empty"
    )
    expect(prepareTextFilePartsForModelInput).not.toHaveBeenCalled()
  })

  it("lowers foreign hosted web_search history instead of failing validation (cross-provider regression)", async () => {
    // Anthropic's array output cannot be validated against OpenAI's object
    // schema before provider-specific history lowering.
    const actualAi = await vi.importActual<typeof import("ai")>("ai")
    vi.mocked(validateUIMessages).mockImplementationOnce(
      actualAi.validateUIMessages as never
    )
    // Pass-through seams so the lowered history is observable at adaptation.
    vi.mocked(prepareTextFilePartsForModelInput).mockImplementation(
      async (messages: unknown) =>
        ({
          messages,
          convertedCount: 0,
          failedCount: 0,
          truncatedCount: 0,
          skippedCount: 0,
        }) as never
    )
    vi.mocked(adaptHistoryForProvider).mockImplementation(
      async (messages: unknown) =>
        ({
          messages,
          stats: {
            originalMessageCount: 0,
            adaptedMessageCount: 0,
            droppedMessages: 0,
            partsDropped: {},
            partsTransformed: {},
            partsPreserved: {},
            totalPartsOriginal: 0,
            totalPartsAdapted: 0,
            providerIdsStripped: 0,
          },
          warnings: [],
        }) as never
    )
    const { openai } = await import("@ai-sdk/openai")
    vi.mocked(prepareToolRuntime).mockResolvedValue(
      makeToolRuntime({
        tools: { web_search: openai.tools.webSearch({}) },
        hasTools: true,
      }) as unknown as Awaited<ReturnType<typeof prepareToolRuntime>>
    )

    const ENCRYPTED = "ENCRYPTED_CONTENT_SENTINEL"
    const fetchMutation = vi.fn(async (ref: unknown) => {
      if (sameRef(ref, api.chatRuntime.prepareGeneration)) {
        return {
          runId: "run1",
          assistantMessageId: "msg2",
          messages: [
            {
              _id: "doc1",
              role: "user",
              content: "search for batman merch",
              parts: [{ type: "text", text: "search for batman merch" }],
              createdAt: Date.now() - 2000,
              status: "completed",
              metadata: {},
              provider: "anthropic",
            },
            {
              _id: "doc2",
              role: "assistant",
              content: "Here is what I found.",
              parts: [
                { type: "step-start" },
                {
                  type: "tool-web_search",
                  state: "output-available",
                  toolCallId: "srvtoolu_abc123",
                  providerExecuted: true,
                  input: { query: "batman merch" },
                  output: [
                    {
                      type: "web_search_result",
                      url: "https://example.com/merch",
                      title: "Merch",
                      pageAge: null,
                      encryptedContent: ENCRYPTED,
                    },
                  ],
                },
                { type: "text", text: "Here is what I found." },
              ],
              createdAt: Date.now() - 1000,
              status: "completed",
              metadata: {},
              provider: "anthropic",
            },
          ],
        }
      }
      return undefined
    })

    const runtime = createChatTurnRuntime({
      input: makeInput(),
      deps: makeDeps(makeStreamHarness(), fetchMutation),
    })

    // Pre-fix this rejected with AI_TypeValidationError; the raw message
    // (embedding the full output value) then reached the HTTP 500 body.
    await expect(runtime.prepare()).resolves.toBeUndefined()

    // The lowering ran BEFORE adaptation: the adapter saw citation text, not
    // the foreign hosted tool part, and no opaque payload survived.
    const adapterInput = vi.mocked(adaptHistoryForProvider).mock
      .calls[0]?.[0] as unknown as Array<{ parts: Array<{ type: string }> }>
    expect(adapterInput).toBeDefined()
    const adapterInputJson = JSON.stringify(adapterInput)
    expect(adapterInputJson).not.toContain("tool-web_search")
    expect(adapterInputJson).not.toContain(ENCRYPTED)
    expect(adapterInputJson).not.toContain("srvtoolu_")
    expect(adapterInputJson).toContain("https://example.com/merch")

    // Boundary 2 accepted the lowered history — conversion ran, no plaintext
    // degradation.
    expect(vi.mocked(convertToModelMessages)).toHaveBeenCalled()
  })

  it("rejects a second prepare() — the runtime is one-shot", async () => {
    const runtime = createChatTurnRuntime({
      input: makeInput(),
      deps: makeDeps(makeStreamHarness(), makeFetchMutation()),
    })
    await runtime.prepare()
    await expect(runtime.prepare()).rejects.toThrow("only be called once")
  })
})

describe("createChatTurnRuntime — generated titles", () => {
  it("drains the retained tee if setup throws before taking its reader", async () => {
    const initialize = vi.spyOn(retainedChatStream, "initializeRetainedChatStream").mockRejectedValueOnce(new Error("setup failed"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const harness = makeStreamHarness()
    let source!: ReadableStreamDefaultController<import("ai").UIMessageChunk>
    vi.mocked(toUIMessageStream).mockImplementationOnce(() => new ReadableStream({
      start(controller) { source = controller },
    }))
    const afterCallbacks: Array<() => unknown> = []
    const runtime = createChatTurnRuntime({
      input: makeInput(),
      deps: makeDeps(harness, makeFetchMutation(), {
        after: ((callback: () => unknown) => { afterCallbacks.push(callback) }) as ChatTurnDeps["after"],
      }),
    })
    try {
      await runtime.prepare()
      const response = await runtime.toResponse(notAbortedSignal())
      const responseBody = response.text()
      let settled = false
      const persistence = Promise.all(afterCallbacks.map((callback) => callback())).then(() => { settled = true })
      await vi.waitFor(() => expect(initialize).toHaveBeenCalled())
      expect(settled).toBe(false)
      source.enqueue({ type: "start", messageId: "assistant" })
      source.close()
      await persistence
      await responseBody
      expect(warn).toHaveBeenCalledWith("chat_stream_replay_unavailable", { runId: "run1" })
    } finally {
      initialize.mockRestore()
      warn.mockRestore()
    }
  })

  it("persists an accepted durable first-turn title through the versioned mutation", async () => {
    const harness = makeStreamHarness()
    const fetchMutation = vi.fn(async (ref: unknown) => {
      if (sameRef(ref, api.chatRuntime.prepareGeneration)) {
        return {
          runId: "run1",
          assistantMessageId: "msg1",
          messages: [],
          titleGeneration: 1,
        }
      }
      return undefined
    })
    const afterCallbacks: Array<() => unknown> = []
    const generateText = vi.fn(async () => ({
      text: "Friendly Greeting",
    }))
    const deps = makeDeps(harness, fetchMutation, {
      generateText: generateText as unknown as ChatTurnDeps["generateText"],
      after: vi.fn((callback: () => unknown) => {
        afterCallbacks.push(callback)
      }) as unknown as ChatTurnDeps["after"],
    })
    const runtime = createChatTurnRuntime({ input: makeInput(), deps })

    await runtime.prepare()
    await runtime.toResponse(notAbortedSignal())
    for (const callback of afterCallbacks) await callback()

    expect(generateText).toHaveBeenCalledTimes(1)
    expect(findCall(fetchMutation, api.chats.applyGeneratedTitle)?.[1]).toEqual(
      {
        chatId: SERVER_CHAT_ID,
        title: "Friendly Greeting",
        generation: 1,
      }
    )
  })

  it("settles retired-title fallback usage against the resolved answer route", async () => {
    const answerRouteId = "openrouter:google/gemini-3.1-flash-lite"
    const titleRouteId = "openrouter:google/gemini-2.5-flash-lite"
    vi.mocked(getAllModels).mockResolvedValue([
      {
        id: answerRouteId,
        provider: "OpenRouter",
        providerId: "openrouter",
        catalogStatus: "visible",
        reasoningText: true,
        speed: "Medium",
        inputCost: 1,
        outputCost: 1,
        tools: false,
      },
      {
        id: titleRouteId,
        provider: "OpenRouter",
        providerId: "openrouter",
        catalogStatus: "visible",
        reasoningText: false,
        speed: "Fast",
        tags: ["cheap"],
        inputCost: 0.1,
        outputCost: 0.2,
        tools: false,
      },
    ] as unknown as Awaited<ReturnType<typeof getAllModels>>)
    const retired = new APICallError({
      message: "This model is no longer available.",
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 404,
    })
    const generateText = vi
      .fn()
      .mockRejectedValueOnce(retired)
      .mockResolvedValueOnce({
        text: "Fallback Route Attribution",
        usage: { inputTokens: 90, outputTokens: 4 },
      })
    const harness = makeStreamHarness()
    const fetchMutation = vi.fn(async (ref: unknown) => {
      if (sameRef(ref, api.chatRuntime.prepareGeneration)) {
        return {
          runId: "run1",
          assistantMessageId: "msg1",
          messages: [],
          titleGeneration: 1,
        }
      }
      return undefined
    })
    const wire = makeWorkerWire()
    const runtime = createChatTurnRuntime({
      input: makeInput({
        model: "gemini-3.1-flash-lite",
        credential: {
          provider: "openrouter",
          apiKey: "platform-key",
          source: "platform",
        },
        route: {
          modelId: "gemini-3.1-flash-lite",
          routeId: answerRouteId,
          providerId: "openrouter",
          upstreamModelId: "google/gemini-3.1-flash-lite",
          credentialSource: "platform",
          routeReason: "platform",
        },
      }),
      deps: makeDeps(harness, fetchMutation, {
        generateText: generateText as unknown as ChatTurnDeps["generateText"],
        durableWorkerWire: wire,
      }),
    })

    await runtime.prepare()
    const response = await runtime.toResponse(notAbortedSignal())
    await response.text()
    await harness.captured.streamOpts.onEnd({
      text: "answer",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      steps: [],
      finishReason: "stop",
    })
    await harness.captured.responseOpts.onEnd({
      responseMessage: {
        id: "msg1",
        role: "assistant",
        parts: [{ type: "text", text: "answer" }],
        metadata: {},
      },
      isAborted: false,
      finishReason: "stop",
    })

    expect(generateText).toHaveBeenCalledTimes(2)
    expect(
      wireCall(wire, "markGenerationRunCompleted")?.args.titleUsage
    ).toEqual({
      routeId: answerRouteId,
      pricingRole: "primary",
      inputTokens: 90,
      outputTokens: 4,
    })
  })

  it("streams a transient title update for a guest first turn", async () => {
    const harness = makeStreamHarness()
    const fetchMutation = makeFetchMutation()
    const deps = makeDeps(harness, fetchMutation, {
      generateText: vi.fn(async () => ({
        text: "Greeting Exchange",
      })) as unknown as ChatTurnDeps["generateText"],
    })
    const runtime = createChatTurnRuntime({
      input: makeInput({
        chatId: "local-chat-1",
        userId: "guest-1",
        anonymousId: "guest-1",
        isAuthenticated: false,
        convexToken: undefined,
      }),
      deps,
    })

    await runtime.prepare()
    const response = await runtime.toResponse(notAbortedSignal())

    await expect(response.text()).resolves.toContain('"type":"data-chatTitle"')
    expect(
      findCall(fetchMutation, api.chats.applyGeneratedTitle)
    ).toBeUndefined()
  })

  it("closes a guest stream without waiting for a slower title request", async () => {
    const harness = makeStreamHarness()
    let titleSignal: AbortSignal | undefined
    const generateText = vi.fn(
      ({ abortSignal }: { abortSignal?: AbortSignal }) =>
        new Promise(() => {
          titleSignal = abortSignal
        })
    )
    const runtime = createChatTurnRuntime({
      input: makeInput({
        chatId: "local-chat-1",
        userId: "guest-1",
        anonymousId: "guest-1",
        isAuthenticated: false,
        convexToken: undefined,
      }),
      deps: makeDeps(harness, makeFetchMutation(), {
        generateText: generateText as unknown as ChatTurnDeps["generateText"],
      }),
    })

    await runtime.prepare()
    const response = await runtime.toResponse(notAbortedSignal())

    const body = await response.text()
    expect(body).toContain('"type":"data-chatTitle"')
    expect(body).toContain("Greeting Exchange")
    expect(titleSignal?.aborted).toBe(true)
  })
})

describe("createChatTurnRuntime — evidence-gated word chunking", () => {
  it.each([
    {
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      source: "byok",
      expectedTransform: true,
    },
    {
      provider: "anthropic",
      model: "claude-sonnet-5",
      source: "byok",
      expectedTransform: false,
    },
    {
      provider: "google",
      model: "gemini-3.5-flash",
      source: "byok",
      expectedTransform: true,
    },
    {
      provider: "google",
      model: "gemini-3.5-flash",
      source: "platform",
      expectedTransform: true,
    },
    {
      provider: "google",
      model: "gemini-3.1-pro-preview",
      source: "byok",
      expectedTransform: false,
    },
    {
      provider: "openrouter",
      model: "gemini-3.5-flash",
      source: "byok",
      expectedTransform: false,
    },
    {
      provider: "openai",
      model: "gpt-5-mini",
      source: "byok",
      expectedTransform: false,
    },
  ] as const)(
    "sets smoothing to $expectedTransform for $provider $model via $source",
    async ({ provider, model, source, expectedTransform }) => {
      vi.mocked(getAllModels).mockResolvedValue([
        { id: model, provider, tools: false },
      ] as unknown as Awaited<ReturnType<typeof getAllModels>>)
      const harness = makeStreamHarness()
      const runtime = createChatTurnRuntime({
        input: makeInput({
          chatId: "local-guest-chat",
          model,
          chatVersion: 2,
          userId: "anonymous-user",
          anonymousId: "anonymous-user",
          isAuthenticated: false,
          convexToken: undefined,
          credential: { provider, apiKey: "test-key", source },
          route: {
            modelId: model,
            routeId: model,
            providerId: provider,
            upstreamModelId: model,
            credentialSource: source,
            routeReason: source === "byok" ? "priority_byok" : "platform",
          },
        }),
        deps: makeDeps(harness, makeFetchMutation()),
      })

      await runtime.prepare()
      await runtime.toResponse(notAbortedSignal())

      if (expectedTransform) {
        expect(harness.captured.streamOpts.experimental_transform).toEqual(
          expect.any(Function)
        )
      } else {
        expect(harness.captured.streamOpts).not.toHaveProperty(
          "experimental_transform"
        )
      }
    }
  )
})

describe("createChatTurnRuntime — durable completion handoff", () => {
  it("does not dispatch until the durable work-start boundary commits", async () => {
    const harness = makeStreamHarness()
    let releaseWorkStart: (() => void) | undefined
    const workStartPending = new Promise<void>((resolve) => {
      releaseWorkStart = resolve
    })
    const wire = makeWorkerWire({
      markGenerationWorkStarted: () => workStartPending,
    })
    const runtime = createChatTurnRuntime({
      input: makeInput(),
      deps: makeDeps(harness, makeFetchMutation(), {
        durableWorkerWire: wire,
      }),
    })

    await runtime.prepare()
    let responseReturned = false
    const responsePending = runtime
      .toResponse(notAbortedSignal())
      .then((response) => {
        responseReturned = true
        return response
      })

    try {
      await vi.waitFor(() => {
        expect(wireCall(wire, "markGenerationWorkStarted")).toBeDefined()
      })
      await vi.waitFor(() => {
        expect(responseReturned).toBe(false)
      })
    } finally {
      releaseWorkStart?.()
    }

    await expect(responsePending).resolves.toBeInstanceOf(Response)
  })

  it("never calls the provider when the durable dispatch boundary fails", async () => {
    const harness = makeStreamHarness()
    const wire = makeWorkerWire({
      markGenerationWorkStarted: () => {
        throw new Error("boundary unavailable")
      },
    })
    const runtime = createChatTurnRuntime({
      input: makeInput(),
      deps: makeDeps(harness, makeFetchMutation(), {
        durableWorkerWire: wire,
      }),
    })

    await runtime.prepare()
    await expect(runtime.toResponse(notAbortedSignal())).rejects.toThrow(
      "Provider dispatch no longer authorized"
    )
    expect(harness.streamText).not.toHaveBeenCalled()
    expect(wireCall(wire, "markGenerationRunAborted")?.args).toMatchObject({
      terminalUsage: {
        primary: { kind: "not-started" },
        title: { kind: "not-run" },
      },
    })
  })

  it("never calls the provider when the start write commits but its acknowledgement is lost", async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const harness = makeStreamHarness()
      const wire = makeWorkerWire({
        // The request reached Convex, but the transport never delivered its
        // response. The worker must time out without dispatching the provider.
        markGenerationWorkStarted: () => new Promise<never>(() => {}),
      })
      const runtime = createChatTurnRuntime({
        input: makeInput(),
        deps: makeDeps(harness, makeFetchMutation(), {
          durableWorkerWire: wire,
        }),
      })

      await runtime.prepare()
      const response = expect(
        runtime.toResponse(notAbortedSignal())
      ).rejects.toThrow("Provider dispatch no longer authorized")
      await vi.advanceTimersByTimeAsync(10_000)
      await response

      expect(harness.streamText).not.toHaveBeenCalled()
      expect(wireCall(wire, "markGenerationRunAborted")?.args).toMatchObject({
        terminalUsage: {
          primary: { kind: "not-started" },
          title: { kind: "not-run" },
        },
      })
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it("completes with durableFinal tool counts from streamText onEnd, not the countToolParts fallback", async () => {
    const harness = makeStreamHarness()
    const fetchMutation = makeFetchMutation()
    const wire = makeWorkerWire()
    // Two tool calls, one failed — the streamText onEnd freezes these into
    // durableFinal*. The response message carries NO tool parts, so the
    // countToolParts fallback would yield {0,0}; seeing {2,1} on the completion
    // write proves the cross-callback handoff is intact.
    vi.mocked(prepareToolRuntime).mockResolvedValue(
      makeToolRuntime({
        outcomeSummary: () => ({
          totalToolCalls: 2,
          failedToolCalls: 1,
          timeoutToolCalls: 0,
          budgetDeniedToolCalls: 0,
        }),
        toolApproval: { risky_tool: "user-approval" },
      }) as unknown as Awaited<ReturnType<typeof prepareToolRuntime>>
    )
    const runtime = createChatTurnRuntime({
      input: makeInput(),
      deps: makeDeps(harness, fetchMutation, { durableWorkerWire: wire }),
    })

    await runtime.prepare()
    await runtime.toResponse(notAbortedSignal())

    // Durable run: the Tool runtime's call-site approval config reaches
    // streamText (guest runs omit it — the spread is durable-gated).
    expect(harness.captured.streamOpts.toolApproval).toEqual({
      risky_tool: "user-approval",
    })

    // Writer: streamText onEnd freezes durableFinal*.
    await harness.captured.streamOpts.onEnd({
      text: "final answer",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      steps: [],
      finishReason: "stop",
    })
    // Reader: the response-level onEnd performs markGenerationRunCompleted.
    await harness.captured.responseOpts.onEnd({
      responseMessage: {
        id: "msg1",
        role: "assistant",
        parts: [{ type: "text", text: "final answer" }],
        metadata: {},
      },
      isAborted: false,
      finishReason: "stop",
    })

    const completed = wireCall(wire, "markGenerationRunCompleted")
    expect(completed).toBeDefined()
    expect(completed!.args).toMatchObject({
      runId: "run1",
      messageId: "msg1",
      content: "final answer",
      finishReason: "stop",
      totalToolCalls: 2,
      failedToolCalls: 1,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    })
    // The user token authorizes admission only. Post-prepare run writes have
    // no public registrations at all (pinned in convex/chatRuntime.test.ts),
    // so the only user-token mutations a turn may send are admission and the
    // title persist.
    const nonAdmissionCalls = fetchMutation.mock.calls.filter(
      (call) =>
        !sameRef(call[0], api.chatRuntime.prepareGeneration) &&
        !sameRef(call[0], api.chats.applyGeneratedTitle)
    )
    expect(nonAdmissionCalls).toEqual([])
  })

  it("marks the run aborted (not completed) when the response stream is aborted", async () => {
    const harness = makeStreamHarness()
    const fetchMutation = makeFetchMutation()
    const wire = makeWorkerWire()
    const runtime = createChatTurnRuntime({
      input: makeInput(),
      deps: makeDeps(harness, fetchMutation, { durableWorkerWire: wire }),
    })

    await runtime.prepare()
    await runtime.toResponse(notAbortedSignal())

    await harness.captured.responseOpts.onEnd({
      responseMessage: {
        id: "msg1",
        role: "assistant",
        parts: [],
        metadata: {},
      },
      isAborted: true,
      finishReason: "stop",
    })

    const aborted = wireCall(wire, "markGenerationRunAborted")
    expect(aborted).toBeDefined()
    expect(aborted!.args).toMatchObject({
      runId: "run1",
      messageId: "msg1",
      reason: "ui message stream aborted",
    })
    expect(wireCall(wire, "markGenerationRunCompleted")).toBeUndefined()
  })

  it("does not reject stream abort cleanup when the abort write fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const harness = makeStreamHarness()
      const wire = makeWorkerWire({
        markGenerationRunAborted: () => {
          throw new Error("convex unavailable")
        },
      })
      const runtime = createChatTurnRuntime({
        input: makeInput(),
        deps: makeDeps(harness, makeFetchMutation(), {
          durableWorkerWire: wire,
        }),
      })

      await runtime.prepare()
      await runtime.toResponse(notAbortedSignal())

      await expect(
        harness.captured.streamOpts.onAbort()
      ).resolves.toBeUndefined()

      const aborted = wireCall(wire, "markGenerationRunAborted")
      expect(aborted?.args).toMatchObject({
        runId: "run1",
        messageId: "msg1",
        reason: "stream aborted",
      })

      const logLine = warn.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes("durable_run_abort_write_failed"))
      expect(logLine).toBeDefined()
      expect(JSON.parse(logLine ?? "{}")).toMatchObject({
        _tag: "durable_run_abort_write_failed",
        requestId: "req-1",
        chatId: SERVER_CHAT_ID,
        runId: "run1",
        error: "convex unavailable",
      })
    } finally {
      warn.mockRestore()
    }
  })

  it("a zero-step abort reports started-without-usage, never zero actual usage", async () => {
    // AI SDK 7 exposes only previously FINISHED steps at abort — an empty
    // array is not evidence of zero provider usage (ADR-0021 amendment).
    const harness = makeStreamHarness()
    const wire = makeWorkerWire()
    const runtime = createChatTurnRuntime({
      input: makeInput(),
      deps: makeDeps(harness, makeFetchMutation(), { durableWorkerWire: wire }),
    })
    await runtime.prepare()
    await runtime.toResponse(notAbortedSignal())

    await harness.captured.streamOpts.onAbort({ steps: [] })

    const aborted = wireCall(wire, "markGenerationRunAborted")
    expect(aborted?.args.terminalUsage).toMatchObject({
      primary: { kind: "started-without-usage" },
      title: { kind: "not-run" },
    })
  })

  it("an abort after finished steps aggregates their usage once", async () => {
    const harness = makeStreamHarness()
    const wire = makeWorkerWire()
    const runtime = createChatTurnRuntime({
      input: makeInput(),
      deps: makeDeps(harness, makeFetchMutation(), { durableWorkerWire: wire }),
    })
    await runtime.prepare()
    await runtime.toResponse(notAbortedSignal())

    await harness.captured.streamOpts.onAbort({
      steps: [
        { usage: { inputTokens: 300, outputTokens: 20 } },
        { usage: { inputTokens: 200, outputTokens: 5 } },
      ],
    })

    const aborted = wireCall(wire, "markGenerationRunAborted")
    expect(aborted?.args.terminalUsage).toMatchObject({
      primary: { kind: "completed-steps", inputTokens: 500, outputTokens: 25 },
    })
  })

  it("fail() persists one context-normalized error with the assistant message", async () => {
    // The route's outer catch path: a post-prepare error must reach
    // markGenerationRunFailed with the run AND its placeholder message id —
    // the durable layer keeps that placeholder as the turn's visible failed
    // stub, so losing the id here would orphan the turn again.
    const harness = makeStreamHarness()
    const wire = makeWorkerWire()
    const runtime = createChatTurnRuntime({
      input: makeInput(),
      deps: makeDeps(harness, makeFetchMutation(), {
        durableWorkerWire: wire,
      }),
    })

    await runtime.prepare()
    const error = new Error("402 payment required")
    error.stack = `${error.stack}\n    at googleTransport (server.js:1:1)`
    await runtime.fail(error)

    const failed = wireCall(wire, "markGenerationRunFailed")
    expect(failed?.args).toMatchObject({
      runId: "run1",
      messageId: "msg1",
      error:
        "Your Anthropic API account has insufficient credits or requires payment. Check Anthropic billing or update your API key in settings.",
    })
  })
})

describe("createChatTurnRuntime — reasoning lifecycle timing", () => {
  it("emits pre-answer duration at the explicit final boundary and preserves total work", async () => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(0)
    try {
      const harness = makeStreamHarness()
      const runtime = createChatTurnRuntime({
        input: makeInput({ isAuthenticated: false, convexToken: undefined }),
        deps: makeDeps(harness, makeFetchMutation()),
      })
      await runtime.prepare()
      await runtime.toResponse(notAbortedSignal())
      dateNow.mockReturnValue(1200)
      const part = { type: "text-start", id: "answer", providerMetadata: {
        openai: { phase: "final_answer" },
      } }
      await harness.captured.streamOpts.onChunk({ chunk: part })
      expect(harness.captured.responseOpts.messageMetadata({ part })).toEqual({
        workSummaryDurationMs: 1200,
      })
      dateNow.mockReturnValue(3000)
      expect(harness.captured.responseOpts.messageMetadata({ part: { type: "finish" } }))
        .toMatchObject({ workSummaryDurationMs: 1200, workDurationMs: 3000 })
    } finally {
      dateNow.mockRestore()
    }
  })

  it("keeps the tool-order pre-answer duration when the stream aborts after answer onset (Stop)", async () => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(0)
    try {
      const harness = makeStreamHarness()
      vi.mocked(toUIMessageStream).mockImplementation((opts: any) => {
        if (opts.messageMetadata) harness.captured.responseOpts = opts
        // Drain the durable snapshot tracker's reduction input so its chunk
        // writes never backpressure; this test asserts the abort flush.
        void opts.stream?.pipeTo(new WritableStream()).catch(() => {})
        return new ReadableStream({
          start(controller) {
            controller.close()
          },
        })
      })
      const wire = makeWorkerWire()
      const runtime = createChatTurnRuntime({
        input: makeInput(),
        deps: makeDeps(harness, makeFetchMutation(), { durableWorkerWire: wire }),
      })
      await runtime.prepare()
      await runtime.toResponse(notAbortedSignal())

      dateNow.mockReturnValue(1000)
      harness.captured.streamOpts.onChunk({
        chunk: { type: "tool-call", toolCallId: "c1", toolName: "web_search", input: {} },
      })
      dateNow.mockReturnValue(4400)
      harness.captured.streamOpts.onChunk({
        chunk: { type: "text-start", id: "answer" },
      })
      harness.captured.streamOpts.onChunk({
        chunk: { type: "text-delta", id: "answer", text: "As of today" },
      })
      // Unpublished while streaming: a later tool call could still arrive.
      expect(
        harness.captured.responseOpts.messageMetadata({
          part: { type: "text-delta", id: "answer", text: "x" },
        })
      ).toBeUndefined()

      // Stop: no finish chunk ever comes. The onAbort flush is the last
      // snapshot the terminal run accepts, so the value must ride it.
      dateNow.mockReturnValue(9000)
      await harness.captured.streamOpts.onAbort({ steps: [] })

      const snapshots = wire.calls.filter(
        (call) => call.op === "updateAssistantSnapshot"
      )
      expect(snapshots.at(-1)?.args).toMatchObject({
        workSummaryDurationMs: 4400,
      })
      expect(wireCall(wire, "markGenerationRunAborted")?.args).toMatchObject({
        workDurationMs: 9000,
      })
    } finally {
      dateNow.mockRestore()
    }
  })

  it("persists the union of explicit reasoning intervals and ignores deltas as starts", async () => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(0)
    try {
      const harness = makeStreamHarness()
      const runtime = createChatTurnRuntime({
        input: makeInput(),
        deps: makeDeps(harness, makeFetchMutation()),
      })

      await runtime.prepare()
      await runtime.toResponse(notAbortedSignal())

      dateNow.mockReturnValue(50)
      harness.captured.streamOpts.onChunk({
        chunk: { type: "reasoning-delta", id: "metadata-only", delta: "" },
      })

      dateNow.mockReturnValue(100)
      harness.captured.streamOpts.onChunk({
        chunk: { type: "reasoning-start", id: "a" },
      })
      dateNow.mockReturnValue(200)
      harness.captured.streamOpts.onChunk({
        chunk: { type: "reasoning-start", id: "b" },
      })
      dateNow.mockReturnValue(300)
      harness.captured.streamOpts.onChunk({
        chunk: { type: "reasoning-end", id: "a" },
      })
      dateNow.mockReturnValue(500)
      harness.captured.streamOpts.onChunk({
        chunk: { type: "reasoning-end", id: "b" },
      })
      dateNow.mockReturnValue(700)
      harness.captured.streamOpts.onChunk({
        chunk: { type: "reasoning-start", id: "c" },
      })
      dateNow.mockReturnValue(900)
      await harness.captured.streamOpts.onEnd({
        text: "done",
        usage: {},
        steps: [],
        finishReason: "stop",
      })

      expect(
        harness.captured.responseOpts.messageMetadata({
          part: { type: "finish" },
        })
      ).toMatchObject({ reasoningDurationMs: 600, workDurationMs: 900 })
    } finally {
      dateNow.mockRestore()
    }
  })
})

describe("createChatTurnRuntime — UI-message metadata", () => {
  const toolMetadata = {
    displayName: "Lookup",
    source: "mcp" as const,
    serviceName: "Test service",
    readOnly: true,
  }
  const usage = {
    inputTokens: 1,
    inputTokenDetails: {
      noCacheTokens: 1,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens: 1,
    outputTokenDetails: {
      textTokens: 1,
      reasoningTokens: 0,
    },
    totalTokens: 2,
  } satisfies LanguageModelUsage
  const stepPerformance = {
    effectiveOutputTokensPerSecond: 1,
    outputTokensPerSecond: 1,
    inputTokensPerSecond: 1,
    effectiveTotalTokensPerSecond: 2,
    stepTimeMs: 1,
    responseTimeMs: 1,
    toolExecutionMs: {},
    timeToFirstOutputMs: 1,
  } satisfies StepResultPerformance

  it("keeps start/finish metadata and returns undefined for ordinary stream parts", async () => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(0)
    try {
      vi.mocked(prepareToolRuntime).mockResolvedValue(
        makeToolRuntime({
          metadata: {
            toInvocationMetadataByName: () => ({ lookup: toolMetadata }),
            source: () => "mcp",
          },
        }) as unknown as Awaited<ReturnType<typeof prepareToolRuntime>>
      )
      const harness = makeStreamHarness()
      const runtime = createChatTurnRuntime({
        input: makeInput(),
        deps: makeDeps(harness, makeFetchMutation()),
      })

      await runtime.prepare()
      await runtime.toResponse(notAbortedSignal())
      const messageMetadata: (options: {
        part: TextStreamPart<ToolSet>
      }) => unknown = harness.captured.responseOpts.messageMetadata

      expect(messageMetadata({ part: { type: "start" } })).toEqual({
        toolMetadataByName: { lookup: toolMetadata },
        provider: "anthropic",
      })

      const toolCall = {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "lookup",
        input: {},
        dynamic: true,
      } satisfies TextStreamPart<ToolSet>
      const ordinaryParts = [
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", text: "hello" },
        { type: "text-end", id: "text-1" },
        { type: "reasoning-start", id: "reasoning-1" },
        {
          type: "reasoning-delta",
          id: "reasoning-1",
          text: "private reasoning",
        },
        { type: "reasoning-end", id: "reasoning-1" },
        {
          type: "tool-input-start",
          id: "call-1",
          toolName: "lookup",
        },
        {
          type: "tool-input-delta",
          id: "call-1",
          delta: '{"query":',
        },
        { type: "tool-input-end", id: "call-1" },
        toolCall,
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "lookup",
          input: {},
          output: { ok: true },
          dynamic: true,
        },
        {
          type: "tool-error",
          toolCallId: "call-1",
          toolName: "lookup",
          input: {},
          error: new Error("tool failed"),
          dynamic: true,
        },
        {
          type: "tool-approval-request",
          approvalId: "approval-1",
          toolCall,
        },
        {
          type: "tool-approval-response",
          approvalId: "approval-1",
          toolCall,
          approved: true,
        },
        {
          type: "tool-output-denied",
          toolCallId: "call-1",
          toolName: "lookup",
        },
        {
          type: "source",
          sourceType: "url",
          id: "source-1",
          url: "https://example.com",
        },
        {
          type: "file",
          file: {
            base64: "",
            uint8Array: new Uint8Array(),
            mediaType: "text/plain",
          },
        },
        {
          type: "reasoning-file",
          file: {
            base64: "",
            uint8Array: new Uint8Array(),
            mediaType: "text/plain",
          },
        },
        { type: "custom", kind: "test.fixture" },
        { type: "start-step", request: {}, warnings: [] },
        {
          type: "finish-step",
          response: {
            id: "response-1",
            timestamp: new Date(0),
            modelId: "test-model",
          },
          usage,
          performance: stepPerformance,
          finishReason: "stop",
          rawFinishReason: "end_turn",
          providerMetadata: undefined,
        },
        { type: "error", error: new Error("model failed") },
        { type: "abort" },
        { type: "raw", rawValue: {} },
      ] satisfies TextStreamPart<ToolSet>[]

      for (const part of ordinaryParts) {
        expect(messageMetadata({ part })).toBeUndefined()
      }

      dateNow.mockReturnValue(100)
      harness.captured.streamOpts.onChunk({
        chunk: { type: "reasoning-start", id: "reasoning-1" },
      })
      dateNow.mockReturnValue(250)
      harness.captured.streamOpts.onChunk({
        chunk: { type: "reasoning-end", id: "reasoning-1" },
      })
      await harness.captured.streamOpts.onEnd({
        text: "done",
        usage: {},
        steps: [
          {
            rawFinishReason: "end_turn",
            toolCalls: [{ toolCallId: "call-1", toolName: "lookup" }],
          },
        ],
        finishReason: "stop",
      })

      expect(
        messageMetadata({
          part: {
            type: "finish",
            finishReason: "stop",
            rawFinishReason: "end_turn",
            totalUsage: usage,
          },
        })
      ).toEqual({
        toolMetadataByCallId: { "call-1": toolMetadata },
        reasoningDurationMs: 150,
        workDurationMs: 250,
      })
    } finally {
      dateNow.mockRestore()
    }
  })

  it("emits no intermediate message-metadata records for ordinary converted parts", async () => {
    const harness = makeStreamHarness()
    const runtime = createChatTurnRuntime({
      input: makeInput(),
      deps: makeDeps(harness, makeFetchMutation()),
    })
    await runtime.prepare()
    await runtime.toResponse(notAbortedSignal())

    const actualAi = await vi.importActual<typeof import("ai")>("ai")
    const actualAiTest =
      await vi.importActual<typeof import("ai/test")>("ai/test")
    const makeTextResult = () =>
      actualAi.streamText({
        model: new actualAiTest.MockLanguageModelV4({
          doStream: async () => ({
            stream: actualAiTest.simulateReadableStream({
              chunks: [
                { type: "stream-start" as const, warnings: [] },
                { type: "reasoning-start" as const, id: "reasoning-1" },
                {
                  type: "reasoning-delta" as const,
                  id: "reasoning-1",
                  delta: "thinking",
                },
                { type: "reasoning-end" as const, id: "reasoning-1" },
                { type: "text-start" as const, id: "text-1" },
                {
                  type: "text-delta" as const,
                  id: "text-1",
                  delta: "final",
                },
                { type: "text-end" as const, id: "text-1" },
                {
                  type: "finish" as const,
                  finishReason: {
                    unified: "stop" as const,
                    raw: "end_turn",
                  },
                  usage: {
                    inputTokens: {
                      total: 1,
                      noCache: 1,
                      cacheRead: undefined,
                      cacheWrite: undefined,
                    },
                    outputTokens: {
                      total: 2,
                      text: 1,
                      reasoning: 1,
                    },
                  },
                },
              ],
              chunkDelayInMs: null,
            }),
          }),
        }),
        prompt: "hi",
      })

    const converted = actualAi.toUIMessageStream({
      stream: makeTextResult().stream,
      messageMetadata: harness.captured.responseOpts.messageMetadata,
    })
    const amplifiedControl = actualAi.toUIMessageStream({
      stream: makeTextResult().stream,
      messageMetadata: () => ({}),
    })
    const [chunkStream, wireStream] = converted.tee()
    const [chunks, controlChunks, wireText] = await Promise.all([
      readStream(chunkStream),
      readStream(amplifiedControl),
      actualAi.createUIMessageStreamResponse({ stream: wireStream }).text(),
    ])

    expect(chunks.filter((chunk) => chunk.type === "message-metadata")).toEqual(
      []
    )
    expect(wireText).not.toContain('"type":"message-metadata"')
    expect(chunks.find((chunk) => chunk.type === "start")).toMatchObject({
      messageMetadata: {},
    })
    expect(chunks.find((chunk) => chunk.type === "finish")).toMatchObject({
      messageMetadata: {},
    })
    expect(chunks.some((chunk) => chunk.type === "reasoning-delta")).toBe(true)
    expect(chunks.some((chunk) => chunk.type === "text-delta")).toBe(true)
    expect(
      controlChunks.filter((chunk) => chunk.type === "message-metadata").length
    ).toBeGreaterThan(0)
    const decodedText = (streamChunks: typeof chunks) =>
      streamChunks
        .filter((chunk) => chunk.type === "text-delta")
        .map((chunk) => chunk.delta)
        .join("")
    expect(decodedText(chunks)).toBe("final")
    expect(decodedText(chunks)).toBe(decodedText(controlChunks))
  })
})

describe("createChatTurnRuntime — Anthropic pause_turn telemetry", () => {
  it("captures one content-free event with model and search dimensions", async () => {
    const harness = makeStreamHarness()
    const fetchMutation = makeFetchMutation()
    const wire = makeWorkerWire()
    const capture = vi.fn()
    const toolRuntime = makeToolRuntime()
    toolRuntime.policySummary.searchInjected = true
    vi.mocked(prepareToolRuntime).mockResolvedValue(
      toolRuntime as unknown as Awaited<ReturnType<typeof prepareToolRuntime>>
    )
    const runtime = createChatTurnRuntime({
      input: makeInput(),
      deps: makeDeps(harness, fetchMutation, {
        durableWorkerWire: wire,
        getPostHogClient: (() => ({
          capture,
        })) as unknown as ChatTurnDeps["getPostHogClient"],
      }),
    })

    await runtime.prepare()
    await runtime.toResponse(notAbortedSignal())
    await harness.captured.streamOpts.onEnd({
      text: "private generated content",
      usage: {},
      steps: [{ rawFinishReason: "pause_turn", toolCalls: [] }],
      finishReason: "stop",
    })
    await harness.captured.responseOpts.onEnd({
      responseMessage: {
        id: "msg1",
        role: "assistant",
        parts: [{ type: "text", text: "private generated content" }],
        metadata: {},
      },
      isAborted: false,
      finishReason: "stop",
    })

    const pauseTurnEvents = capture.mock.calls.filter(
      ([event]) => event.event === "anthropic_pause_turn"
    )
    expect(pauseTurnEvents).toEqual([
      [
        {
          distinctId: "chat-runtime",
          event: "anthropic_pause_turn",
          properties: {
            provider: "anthropic",
            model: "test-model",
            searchToolsActive: true,
          },
        },
      ],
    ])
    expect(wireCall(wire, "markGenerationRunCompleted")?.args).toMatchObject({
      runId: "run1",
      messageId: "msg1",
      finishReason: "stop",
    })
    expect(wireCall(wire, "markGenerationRunAborted")).toBeUndefined()
    expect(wireCall(wire, "markGenerationRunFailed")).toBeUndefined()
  })

  it("does not let a telemetry capture failure break stream completion", async () => {
    const harness = makeStreamHarness()
    const captureError = new Error(
      'analytics unavailable: Value: {"encryptedContent":"TELEMETRY_SENTINEL"}'
    )
    const capture = vi.fn((event: { event: string }) => {
      if (event.event === "anthropic_pause_turn") {
        throw captureError
      }
    })
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const runtime = createChatTurnRuntime({
        input: makeInput(),
        deps: makeDeps(harness, makeFetchMutation(), {
          getPostHogClient: (() => ({
            capture,
          })) as unknown as ChatTurnDeps["getPostHogClient"],
        }),
      })

      await runtime.prepare()
      await runtime.toResponse(notAbortedSignal())

      await expect(
        harness.captured.streamOpts.onEnd({
          text: "done",
          usage: {},
          steps: [{ rawFinishReason: "pause_turn", toolCalls: [] }],
          finishReason: "stop",
        })
      ).resolves.toBeUndefined()
      const logged = String(consoleError.mock.calls.at(-1)?.[0])
      expect(logged).toContain("posthog_pause_turn_capture_failed")
      expect(logged).toContain("analytics unavailable")
      expect(logged).not.toContain("TELEMETRY_SENTINEL")
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe("createChatTurnRuntime — abort telemetry", () => {
  it("excludes the request signal from a DURABLE turn's execution signal — a client disconnect leaves the worker streaming", async () => {
    const harness = makeStreamHarness()
    const runtime = createChatTurnRuntime({
      input: makeInput(),
      deps: makeDeps(harness, makeFetchMutation()),
    })

    await runtime.prepare()
    const controller = new AbortController()
    await runtime.toResponse(controller.signal)

    // Reload/disconnect durability: the request abort is telemetry only; Stop and
    // supersession reach the worker via heartbeat `lost`/grant rejection.
    const executionSignal = harness.captured.streamOpts
      .abortSignal as AbortSignal
    expect(executionSignal.aborted).toBe(false)
    controller.abort()
    expect(executionSignal.aborted).toBe(false)
  })

  it("keeps the request signal authoritative for GUEST turns", async () => {
    const harness = makeStreamHarness()
    const runtime = createChatTurnRuntime({
      input: makeInput({
        isAuthenticated: false,
        convexToken: undefined,
        credential: {
          provider: "anthropic",
          apiKey: "platform-key",
          source: "platform",
        },
      }),
      deps: makeDeps(harness, makeFetchMutation()),
    })

    await runtime.prepare()
    const controller = new AbortController()
    await runtime.toResponse(controller.signal)

    // Nobody is left to receive or settle a disconnected guest stream — the
    // request signal IS the guest lifecycle.
    const executionSignal = harness.captured.streamOpts
      .abortSignal as AbortSignal
    expect(executionSignal.aborted).toBe(false)
    controller.abort()
    expect(executionSignal.aborted).toBe(true)
  })

  it("captures chat_client_abort exactly once when the request is already aborted", async () => {
    const harness = makeStreamHarness()
    const runtime = createChatTurnRuntime({
      input: makeInput(),
      deps: makeDeps(harness, makeFetchMutation()),
    })

    await runtime.prepare()
    const abortedController = new AbortController()
    abortedController.abort()
    await runtime.toResponse(abortedController.signal)

    // Stream then completes — the streamCompleted/abortCaptured guards must
    // prevent any second chat_client_abort capture.
    await harness.captured.streamOpts.onEnd({
      text: "",
      usage: undefined,
      steps: [],
      finishReason: "stop",
    })

    const clientAborts = vi
      .mocked(Sentry.captureMessage)
      .mock.calls.filter((call) => call[0] === "chat_client_abort")
    expect(clientAborts).toHaveLength(1)
    expect(clientAborts[0]?.[1]).toMatchObject({
      extra: {
        elapsedMs: 0,
        timeSinceLastProgressMs: 0,
      },
    })
  })

  it("captures chat_stalled_continuation once when no chunk follows a tool-calls step", async () => {
    vi.useFakeTimers()
    // Pin the threshold so an environment override cannot skew the advances.
    vi.stubEnv("SENTRY_CHAT_STALLED_CONTINUATION_MS", "30000")
    try {
      // A guest turn: no durable heartbeat rides the fake clock, so the only
      // thing that can end the stream here is the callbacks below.
      const harness = makeStreamHarness()
      const runtime = createChatTurnRuntime({
        input: makeInput({
          isAuthenticated: false,
          convexToken: undefined,
          credential: {
            provider: "anthropic",
            apiKey: "platform-key",
            source: "platform",
          },
        }),
        deps: makeDeps(harness, makeFetchMutation()),
      })
      await runtime.prepare()
      await runtime.toResponse(notAbortedSignal())

      await harness.captured.streamOpts.onStepEnd({
        toolCalls: [{ toolName: "web_search" }],
        toolResults: [],
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          inputTokenDetails: {},
          outputTokenDetails: {},
        },
        finishReason: "tool-calls",
        performance: { responseTimeMs: 0, toolExecutionMs: {} },
      })
      // The provider never resumes after the tool step: the stall fires once
      // at the threshold, then completion must not fire it again.
      await vi.advanceTimersByTimeAsync(30_000)
      await harness.captured.streamOpts.onEnd({
        text: "",
        usage: undefined,
        steps: [],
        finishReason: "stop",
      })
      await vi.advanceTimersByTimeAsync(30_000)

      const stalls = vi
        .mocked(Sentry.captureMessage)
        .mock.calls.filter((call) => call[0] === "chat_stalled_continuation")
      expect(stalls).toHaveLength(1)
      expect(stalls[0]?.[1]).toMatchObject({
        tags: { chat_stream_phase: "post_tool_continue" },
        extra: {
          stepCounter: 1,
          observedToolCalls: 1,
          lastToolNames: ["web_search"],
          postToolContinuationDelayMs: 30_000,
        },
      })
    } finally {
      vi.unstubAllEnvs()
      vi.useRealTimers()
    }
  })

  it("rejects toResponse() before prepare() — phase guard", async () => {
    const runtime = createChatTurnRuntime({
      input: makeInput(),
      deps: makeDeps(makeStreamHarness(), makeFetchMutation()),
    })
    await expect(runtime.toResponse(notAbortedSignal())).rejects.toThrow(
      "requires a completed prepare()"
    )
  })
})
