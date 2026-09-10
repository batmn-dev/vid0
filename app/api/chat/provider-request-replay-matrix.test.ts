import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogle } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { createXai } from "@ai-sdk/xai"
import {
  convertToModelMessages,
  dynamicTool,
  generateText,
  jsonSchema,
  safeValidateUIMessages,
  tool,
  type ModelMessage,
  type ToolSet,
  type UIMessage,
} from "ai"
import { describe, expect, it } from "vitest"
import { adaptHistoryForProvider } from "./adapters"
import { splitAndValidateApprovalContinuation } from "./approval-continuation"
import { lowerForeignHostedToolParts } from "./hosted-tool-lowering"

type Provider = "openai" | "anthropic" | "google" | "xai"

const providers: Provider[] = ["openai", "anthropic", "google", "xai"]
const modelIds: Record<Provider, string> = {
  openai: "gpt-5.2",
  anthropic: "claude-sonnet-4-5",
  google: "gemini-2.5-flash",
  xai: "grok-4-1-fast",
}

const ENCRYPTED = "MATRIX_ENCRYPTED_CONTENT_SENTINEL"
const CURRENT_IMAGE_URL = "https://example.com/current-image.png"

function originHistory(origin: Provider): UIMessage[] {
  const prefix: UIMessage[] = [
    {
      id: `user-${origin}`,
      role: "user",
      parts: [{ type: "text", text: "Find one source" }],
    },
  ]
  if (origin === "google") {
    prefix.push({
      id: "assistant-google-grounding",
      role: "assistant",
      metadata: { provider: "google" },
      parts: [
        {
          type: "source-url",
          sourceId: "google-grounding-private-id",
          url: "https://example.com/google-grounding",
          title: "Google grounding source",
        },
        { type: "text", text: "Grounded answer" },
      ],
    })
  } else {
    const fixture = {
      openai: {
        id: "ws_openai_foreign_id",
        input: {},
        output: {
          action: { type: "search", queries: ["query"] },
          sources: [{ type: "url", url: "https://example.com/openai-result" }],
        },
      },
      anthropic: {
        id: "srvtoolu_anthropic_foreign_id",
        input: { query: "query" },
        output: [
          {
            type: "web_search_result",
            url: "https://example.com/anthropic-result",
            title: "Anthropic result",
            pageAge: null,
            encryptedContent: ENCRYPTED,
          },
        ],
      },
      xai: {
        id: "xai_foreign_response_id",
        input: {},
        output: {
          query: "query",
          sources: [
            {
              title: "xAI result",
              url: "https://example.com/xai-result",
              snippet: "snippet",
            },
          ],
        },
      },
    }[origin]
    prefix.push({
      id: `assistant-${origin}`,
      role: "assistant",
      metadata: { provider: origin },
      parts: [
        {
          type: "tool-web_search",
          state: "output-available",
          toolCallId: fixture.id,
          providerExecuted: true,
          input: fixture.input,
          output: fixture.output,
        } as never,
        { type: "text", text: `${origin} answer` },
      ],
    })
  }

  prefix.push({
    id: "current-user",
    role: "user",
    parts: [
      { type: "text", text: "Now inspect this image" },
      {
        type: "file",
        mediaType: "image/png",
        filename: "current-image.png",
        url: CURRENT_IMAGE_URL,
      },
    ],
  })
  return prefix
}

function hasToolCall(messages: ModelMessage[]): boolean {
  return messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "tool-call")
  )
}

function hasFile(messages: ModelMessage[]): boolean {
  return messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "file")
  )
}

function modelToolPairCounts(
  messages: ModelMessage[]
): Map<string, { calls: number; results: number }> {
  const counts = new Map<string, { calls: number; results: number }>()
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type !== "tool-call" && part.type !== "tool-result") continue
      const current = counts.get(part.toolCallId) ?? { calls: 0, results: 0 }
      if (part.type === "tool-call") current.calls += 1
      else current.results += 1
      counts.set(part.toolCallId, current)
    }
  }
  return counts
}

function hasSearchDeclaration(body: unknown, target: Provider): boolean {
  const serialized = JSON.stringify(body)
  if (target === "anthropic") return serialized.includes("web_search_20250305")
  if (target === "google") return serialized.includes('"googleSearch"')
  return serialized.includes('"type":"web_search"')
}

function makeTarget(target: Provider): {
  model: Parameters<typeof generateText>[0]["model"]
  searchTools: ToolSet
  getBody: () => unknown
} {
  let body: unknown
  const fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({ error: { message: "offline stub" } }),
      {
        status: 400,
        headers: { "content-type": "application/json" },
      }
    )
  }

  if (target === "openai") {
    const provider = createOpenAI({ apiKey: "offline", fetch })
    return {
      model: provider(modelIds[target]),
      searchTools: { web_search: provider.tools.webSearch({}) } as ToolSet,
      getBody: () => body,
    }
  }
  if (target === "anthropic") {
    const provider = createAnthropic({ apiKey: "offline", fetch })
    return {
      model: provider(modelIds[target]),
      searchTools: {
        web_search: provider.tools.webSearch_20250305(),
      } as ToolSet,
      getBody: () => body,
    }
  }
  if (target === "google") {
    const provider = createGoogle({ apiKey: "offline", fetch })
    return {
      model: provider(modelIds[target]),
      searchTools: {
        web_search: provider.tools.googleSearch({}),
      } as ToolSet,
      getBody: () => body,
    }
  }

  const provider = createXai({ apiKey: "offline", fetch })
  return {
    model: provider.responses(modelIds[target]),
    searchTools: { web_search: provider.tools.webSearch({}) } as ToolSet,
    getBody: () => body,
  }
}

async function captureRequest(options: {
  origin: Provider
  target: Provider
  searchEnabled: boolean
  history?: UIMessage[]
}) {
  const target = makeTarget(options.target)
  const tools = options.searchEnabled ? target.searchTools : ({} as ToolSet)
  const projection = lowerForeignHostedToolParts(
    options.history ?? originHistory(options.origin),
    {
      targetProvider: options.target,
      tools,
    }
  )
  const adapted = await adaptHistoryForProvider(
    projection.messages,
    options.target,
    {
      targetModelId: modelIds[options.target],
      hasTools: options.searchEnabled,
    }
  )
  const validation = await safeValidateUIMessages({
    messages: adapted.messages,
    tools: tools as never,
  })
  expect(validation.success).toBe(true)
  const modelMessages = await convertToModelMessages(adapted.messages, {
    tools,
  })
  try {
    await generateText({ model: target.model, messages: modelMessages, tools })
  } catch {
    // The offline fetch stub intentionally returns 400 after capturing input.
  }
  return { projection, adapted, modelMessages, body: target.getBody() }
}

describe("hosted replay final provider-request matrix", () => {
  it("keeps every origin safe for every target and search policy", async () => {
    for (const origin of providers) {
      for (const target of providers) {
        for (const searchEnabled of [false, true]) {
          const label = `${origin}->${target} search=${searchEnabled}`
          const result = await captureRequest({
            origin,
            target,
            searchEnabled,
          })
          const modelJson = JSON.stringify(result.modelMessages)
          const bodyJson = JSON.stringify(result.body)

          expect(result.body, label).toBeDefined()
          expect(hasToolCall(result.modelMessages), label).toBe(false)
          expect(hasFile(result.modelMessages), label).toBe(true)
          expect(modelJson, label).not.toContain(ENCRYPTED)
          expect(bodyJson, label).not.toContain(ENCRYPTED)
          expect(bodyJson, label).not.toMatch(
            /ws_openai_foreign_id|srvtoolu_anthropic_foreign_id|xai_foreign_response_id|google-grounding-private-id/
          )
          expect(bodyJson, label).toContain("Find one source")
          expect(bodyJson, label).toContain(
            origin === "google" ? "Grounded answer" : `${origin} answer`
          )
          expect(bodyJson, label).toContain("Now inspect this image")
          expect(bodyJson, label).toContain(CURRENT_IMAGE_URL)
          expect(bodyJson, label).toContain("example.com/")
          expect(hasSearchDeclaration(result.body, target), label).toBe(
            searchEnabled
          )

          if (origin === "google") {
            expect(result.projection.sourceProjectionCount, label).toBe(1)
          } else {
            expect(result.projection.loweredCount, label).toBe(1)
          }
        }
      }
    }
  })

  it("keeps every hosted state and provenance class out of every final target request", async () => {
    const states = [
      "input-streaming",
      "input-available",
      "output-available",
      "output-error",
      "output-denied",
      "approval-requested",
      "approval-responded",
    ] as const
    const provenance = ["present", "missing", "malformed"] as const

    for (const state of states) {
      for (const metadataCase of provenance) {
        const part: Record<string, unknown> = {
          type: "tool-web_search",
          state,
          toolCallId: "state-matrix-foreign-id",
          providerExecuted: true,
          input:
            state === "input-streaming"
              ? '{"query":"partial'
              : { query: "query" },
        }
        if (state === "output-available") {
          part.output = [
            {
              type: "web_search_result",
              url: "https://example.com/state-result",
              title: "State result",
              pageAge: null,
              encryptedContent: ENCRYPTED,
            },
          ]
        } else if (state === "output-error") {
          part.errorText = "provider failed"
        } else if (state === "output-denied") {
          part.approval = { id: "state-matrix-approval-id", approved: false }
        } else if (state === "approval-requested") {
          part.approval = { id: "state-matrix-approval-id" }
        } else if (state === "approval-responded") {
          part.approval = { id: "state-matrix-approval-id", approved: true }
        }

        const assistant: UIMessage = {
          id: `state-${state}-${metadataCase}`,
          role: "assistant",
          parts: [part as never, { type: "text", text: "Visible answer" }],
          ...(metadataCase === "present"
            ? { metadata: { provider: "anthropic" } }
            : metadataCase === "malformed"
              ? { metadata: { provider: { invalid: true } } }
              : {}),
        }
        const history: UIMessage[] = [
          {
            id: "state-user",
            role: "user",
            parts: [{ type: "text", text: "search" }],
          },
          assistant,
          {
            id: "state-follow-up",
            role: "user",
            parts: [{ type: "text", text: "continue" }],
          },
        ]

        for (const target of providers) {
          const label = `${state} provenance=${metadataCase} target=${target}`
          const result = await captureRequest({
            origin: "anthropic",
            target,
            searchEnabled: true,
            history,
          })
          const serialized = JSON.stringify({
            messages: result.modelMessages,
            body: result.body,
          })
          expect(result.body, label).toBeDefined()
          expect(result.projection.loweredCount, label).toBe(1)
          expect(hasToolCall(result.modelMessages), label).toBe(false)
          expect(serialized, label).not.toContain("state-matrix-foreign-id")
          expect(serialized, label).not.toContain("state-matrix-approval-id")
          expect(serialized, label).not.toContain(ENCRYPTED)
        }
      }
    }
  })

  it("projects installed Google dynamic server-tool events before all target conversions", async () => {
    const dynamicServerEvent = {
      id: "google-server-tool",
      role: "assistant",
      metadata: { provider: "google" },
      parts: [
        {
          type: "dynamic-tool",
          toolName: "server:google_search",
          state: "output-available",
          toolCallId: "google-private-server-tool-id",
          providerExecuted: true,
          input: {},
          output: {},
          callProviderMetadata: {
            google: {
              serverToolCallId: "google-private-server-tool-id",
              serverToolType: "google_search",
            },
          },
        },
        { type: "text", text: "Server tool answer" },
      ],
    } as unknown as UIMessage

    for (const target of providers) {
      const targetRuntime = makeTarget(target)
      const projected = lowerForeignHostedToolParts([dynamicServerEvent], {
        targetProvider: target,
        tools: targetRuntime.searchTools,
      })
      const adapted = await adaptHistoryForProvider(
        projected.messages,
        target,
        { targetModelId: modelIds[target], hasTools: true }
      )
      const modelMessages = await convertToModelMessages(adapted.messages, {
        tools: targetRuntime.searchTools,
      })
      const serialized = JSON.stringify(modelMessages)
      expect(projected.details[0]?.reason, target).toBe("dynamic_provider_tool")
      expect(serialized, target).not.toContain("google-private-server-tool-id")
      expect(hasToolCall(modelMessages), target).toBe(false)
      try {
        await generateText({
          model: targetRuntime.model,
          messages: modelMessages,
          tools: targetRuntime.searchTools,
        })
      } catch {}
      expect(targetRuntime.getBody(), target).toBeDefined()
      expect(JSON.stringify(targetRuntime.getBody()), target).not.toContain(
        "google-private-server-tool-id"
      )
    }
  })

  it("keeps every retained client-executed static/dynamic exchange paired through target requests", async () => {
    const clientTools = {
      static_client_tool: tool({
        inputSchema: jsonSchema({ type: "object" }),
        execute: async () => ({ ok: true }),
      }),
      dynamic_client_tool: dynamicTool({
        inputSchema: jsonSchema({ type: "object" }),
        execute: async () => ({ ok: true }),
      }),
    } as ToolSet
    const clientHistory = [
      {
        id: "client-exchanges",
        role: "assistant",
        metadata: { provider: "openai" },
        parts: [
          { type: "step-start" },
          { type: "reasoning", text: "", state: "done" },
          {
            type: "tool-static_client_tool",
            state: "output-available",
            toolCallId: "static-client-call",
            input: {},
            output: { ok: true },
          },
          {
            type: "dynamic-tool",
            toolName: "dynamic_client_tool",
            state: "output-available",
            toolCallId: "dynamic-client-call",
            input: {},
            output: { ok: true },
          },
          { type: "text", text: "Client tool answer" },
        ],
      } as unknown as UIMessage,
      {
        id: "client-follow-up",
        role: "user",
        parts: [{ type: "text", text: "continue" }],
      } as UIMessage,
    ]

    for (const targetProvider of providers) {
      const target = makeTarget(targetProvider)
      const projected = lowerForeignHostedToolParts(clientHistory, {
        targetProvider,
        tools: clientTools,
      })
      expect(projected.loweredCount).toBe(0)
      const adapted = await adaptHistoryForProvider(
        projected.messages,
        targetProvider,
        { targetModelId: modelIds[targetProvider], hasTools: true }
      )
      const validation = await safeValidateUIMessages({
        messages: adapted.messages,
        tools: clientTools as never,
      })
      expect(validation.success).toBe(true)
      const modelMessages = await convertToModelMessages(adapted.messages, {
        tools: clientTools,
        ignoreIncompleteToolCalls: true,
      })
      const pairCounts = modelToolPairCounts(modelMessages)
      for (const [toolCallId, counts] of pairCounts) {
        expect(counts.calls, `${targetProvider} ${toolCallId}`).toBe(
          counts.results
        )
      }

      try {
        await generateText({
          model: target.model,
          messages: modelMessages,
          tools: clientTools,
        })
      } catch {}
      const body = JSON.stringify(target.getBody())
      expect(target.getBody()).toBeDefined()
      for (const toolCallId of ["static-client-call", "dynamic-client-call"]) {
        const occurrences = body.split(toolCallId).length - 1
        expect(
          occurrences === 0 || occurrences >= 2,
          `${targetProvider} ${toolCallId}`
        ).toBe(true)
      }
    }
  })

  it("replays same-provider OpenAI text/reasoning history as content, never item_reference lookups", async () => {
    // Durable replay persists providerMetadata.openai.itemId on text and
    // reasoning parts. With the
    // Responses default `store: true`, the serializer turns those into
    // server-side item_reference lookups (msg_/rs_) and the API 400s with
    // `invalid_value` on `input` — killing every follow-up OpenAI turn.
    const history = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "What is 17+25?" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        metadata: { provider: "openai" },
        parts: [
          { type: "step-start" },
          {
            type: "reasoning",
            text: "",
            state: "done",
            providerMetadata: {
              openai: { itemId: "rs_stored_reasoning_id" },
            },
          },
          {
            type: "text",
            text: "The prior visible answer is 42.",
            providerMetadata: { openai: { itemId: "msg_stored_text_id" } },
          },
        ],
      },
      {
        id: "current-user",
        role: "user",
        parts: [
          { type: "text", text: "Now inspect this image" },
          {
            type: "file",
            mediaType: "image/png",
            filename: "current-image.png",
            url: CURRENT_IMAGE_URL,
          },
        ],
      },
    ] as unknown as UIMessage[]

    const result = await captureRequest({
      origin: "openai",
      target: "openai",
      searchEnabled: false,
      history,
    })
    const bodyJson = JSON.stringify(result.body)
    expect(bodyJson).not.toContain("item_reference")
    expect(bodyJson).not.toContain("rs_stored_reasoning_id")
    expect(bodyJson).not.toContain("msg_stored_text_id")
    expect(bodyJson).toContain("The prior visible answer is 42.")
    expect(bodyJson).toContain(CURRENT_IMAGE_URL)
  })

  it("replays OpenAI text phase on assistant message items without item ids (ADR-0041)", async () => {
    const history = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Find the answer" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        metadata: { provider: "openai" },
        parts: [
          { type: "step-start" },
          {
            type: "text",
            text: "Let me look that up.",
            state: "done",
            providerMetadata: {
              openai: { itemId: "msg_commentary_id", phase: "commentary" },
            },
          },
          {
            type: "text",
            text: "The answer is 42.",
            state: "done",
            providerMetadata: {
              openai: { itemId: "msg_final_id", phase: "final_answer" },
            },
          },
        ],
      },
      {
        id: "current-user",
        role: "user",
        parts: [{ type: "text", text: "Thanks, and why?" }],
      },
    ] as unknown as UIMessage[]

    const result = await captureRequest({
      origin: "openai",
      target: "openai",
      searchEnabled: false,
      history,
    })
    const body = result.body as {
      input: Array<{ role?: string; phase?: string; id?: string; type?: string }>
    }
    const assistantItems = body.input.filter((item) => item.role === "assistant")
    expect(assistantItems.map((item) => item.phase)).toEqual([
      "commentary",
      "final_answer",
    ])
    expect(assistantItems.every((item) => item.id === undefined)).toBe(true)
    const bodyJson = JSON.stringify(result.body)
    expect(bodyJson).not.toContain("item_reference")
    expect(bodyJson).not.toContain("msg_commentary_id")
    expect(bodyJson).not.toContain("msg_final_id")
  })
})

function approvalTail(options: {
  kind: "hosted" | "static" | "dynamic"
  approved: boolean
  provider?: Provider
}): UIMessage {
  const isHosted = options.kind === "hosted"
  const isDynamic = options.kind === "dynamic"
  const toolName = isHosted ? "web_search" : `${options.kind}_client_tool`
  return {
    id: `approval-${options.kind}-${options.approved}`,
    role: "assistant",
    metadata: { provider: options.provider ?? "openai" },
    parts: [
      {
        type: isDynamic ? "dynamic-tool" : `tool-${toolName}`,
        ...(isDynamic ? { toolName } : {}),
        state: "approval-responded",
        toolCallId: `${options.kind}-genuine-call-id`,
        providerExecuted: isHosted,
        input: {},
        approval: {
          id: `${options.kind}-genuine-approval-id`,
          approved: options.approved,
        },
      } as never,
    ],
  }
}

function clientApprovalTools(kind: "static" | "dynamic"): ToolSet {
  const definition = {
    inputSchema: jsonSchema({ type: "object", additionalProperties: false }),
    execute: async () => ({ ok: true }),
  }
  return {
    [`${kind}_client_tool`]:
      kind === "dynamic" ? dynamicTool(definition) : tool(definition),
  } as ToolSet
}

describe("approval continuation final provider requests", () => {
  it.each([true, false])(
    "keeps same-provider hosted approval protocol intact when approved=%s",
    async (approved) => {
      const target = makeTarget("openai")
      const tail = approvalTail({ kind: "hosted", approved })
      const split = splitAndValidateApprovalContinuation({
        messages: [tail],
        targetProvider: "openai",
        tools: target.searchTools,
      })
      const validation = await safeValidateUIMessages({
        messages: split.tail,
        tools: target.searchTools as never,
      })
      expect(validation.success).toBe(true)
      const modelMessages = await convertToModelMessages(split.tail, {
        tools: target.searchTools,
      })
      try {
        await generateText({
          model: target.model,
          messages: modelMessages,
          tools: target.searchTools,
        })
      } catch {}

      const body = target.getBody() as {
        input?: Array<Record<string, unknown>>
      }
      const reference = body.input?.find(
        (item) => item.type === "item_reference"
      )
      const response = body.input?.find(
        (item) => item.type === "mcp_approval_response"
      )
      expect(reference).toMatchObject({ id: "hosted-genuine-approval-id" })
      expect(response).toMatchObject({
        approval_request_id: "hosted-genuine-approval-id",
        approve: approved,
      })
      const serialized = JSON.stringify(body)
      expect(serialized).toContain('"type":"web_search"')
      expect(serialized).not.toContain(ENCRYPTED)
    }
  )

  it.each([
    ["static", true],
    ["static", false],
    ["dynamic", true],
    ["dynamic", false],
  ] as const)(
    "keeps same-provider %s client-tool approval paired for every target when approved=%s",
    async (kind, approved) => {
      for (const targetProvider of providers) {
        const target = makeTarget(targetProvider)
        const tools = clientApprovalTools(kind)
        const tail = approvalTail({
          kind,
          approved,
          provider: targetProvider,
        })
        const split = splitAndValidateApprovalContinuation({
          messages: [tail],
          targetProvider,
          tools,
        })
        const validation = await safeValidateUIMessages({
          messages: split.tail,
          tools: tools as never,
        })
        expect(validation.success, targetProvider).toBe(true)
        const modelMessages = await convertToModelMessages(split.tail, {
          tools,
        })
        expect(
          modelToolPairCounts(modelMessages).get(`${kind}-genuine-call-id`),
          targetProvider
        ).toEqual({ calls: 1, results: approved ? 0 : 1 })
        expect(JSON.stringify(modelMessages), targetProvider).toContain(
          `${kind}-genuine-approval-id`
        )
        try {
          await generateText({
            model: target.model,
            messages: modelMessages,
            tools,
          })
        } catch {}
        const bodyJson = JSON.stringify(target.getBody())
        const toolName = `${kind}_client_tool`
        expect(target.getBody(), targetProvider).toBeDefined()
        expect(
          bodyJson.split(toolName).length - 1,
          `${targetProvider} ${toolName}`
        ).toBeGreaterThanOrEqual(2)
        expect(bodyJson, targetProvider).not.toContain(
          `${kind}-genuine-approval-id`
        )
      }
    }
  )

  it("rejects provider switch and absent-tool tails before target conversion", () => {
    const googleTarget = makeTarget("google")
    const tail = approvalTail({ kind: "hosted", approved: true })
    expect(() =>
      splitAndValidateApprovalContinuation({
        messages: [tail],
        targetProvider: "google",
        tools: googleTarget.searchTools,
      })
    ).toThrowError(
      expect.objectContaining({ code: "APPROVAL_PROVIDER_MISMATCH" })
    )
    expect(googleTarget.getBody()).toBeUndefined()

    expect(() =>
      splitAndValidateApprovalContinuation({
        messages: [tail],
        targetProvider: "openai",
        tools: {},
      })
    ).toThrowError(
      expect.objectContaining({ code: "APPROVAL_TOOL_UNAVAILABLE" })
    )
  })
})
