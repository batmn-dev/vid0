import { ANTHROPIC_BETA_HEADERS } from "@/lib/config"
import { getAllModels } from "@/lib/models"
import type { ModelConfig } from "@/lib/models/types"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  resolveReasoningEffort,
  shapeRequest,
  type RequestShapingContext,
} from "./request-shaping"

function makeModel(overrides: Partial<ModelConfig>): ModelConfig {
  return {
    id: "test-model",
    name: "Test Model",
    provider: "Test",
    providerId: "openai",
    baseProviderId: "openai",
    catalogStatus: "visible",
    idKind: "stable",
    ...overrides,
  } as ModelConfig
}

const NO_TOOLS: RequestShapingContext = {
  searchToolsActive: false,
  hasTools: false,
}

describe("shapeRequest provider options", () => {
  const cases: Array<{
    name: string
    model: Partial<ModelConfig>
    ctx: RequestShapingContext
    expected: Record<string, unknown>
  }> = [
    {
      name: "anthropic adaptive without search uses adaptive thinking",
      model: {
        providerId: "anthropic",
        reasoningText: true,
        thinkingMode: "adaptive",
      },
      ctx: { searchToolsActive: false, hasTools: true },
      expected: {
        anthropic: { thinking: { type: "adaptive", display: "summarized" } },
      },
    },
    {
      // The pause_turn downgrade is catalog-driven: only 4.6-generation
      // models (where budget_tokens is deprecated but functional) carry
      // searchThinkingDowngrade.
      name: "flagged anthropic adaptive with search downgrades to enabled (pause_turn workaround)",
      model: {
        providerId: "anthropic",
        reasoningText: true,
        thinkingMode: "adaptive",
        searchThinkingDowngrade: true,
      },
      ctx: { searchToolsActive: true, hasTools: true },
      expected: {
        anthropic: { thinking: { type: "enabled", budgetTokens: 10000 } },
      },
    },
    {
      // Opus 4.8/Sonnet 5/Fable 5: budget_tokens is removed upstream (HTTP
      // 400), so unflagged adaptive models stay adaptive even with search
      // tools active.
      name: "unflagged anthropic adaptive keeps adaptive thinking with search active",
      model: {
        providerId: "anthropic",
        reasoningText: true,
        thinkingMode: "adaptive",
      },
      ctx: { searchToolsActive: true, hasTools: true },
      expected: {
        anthropic: { thinking: { type: "adaptive", display: "summarized" } },
      },
    },
    {
      // The flag without active search tools changes nothing.
      name: "flagged anthropic adaptive without search keeps adaptive thinking",
      model: {
        providerId: "anthropic",
        reasoningText: true,
        thinkingMode: "adaptive",
        searchThinkingDowngrade: true,
      },
      ctx: { searchToolsActive: false, hasTools: true },
      expected: {
        anthropic: { thinking: { type: "adaptive", display: "summarized" } },
      },
    },
    {
      name: "anthropic fixed-budget model uses its declared thinkingBudget",
      model: {
        providerId: "anthropic",
        reasoningText: true,
        thinkingBudget: 12000,
      },
      ctx: NO_TOOLS,
      expected: {
        anthropic: { thinking: { type: "enabled", budgetTokens: 12000 } },
      },
    },
    {
      name: "anthropic without declared budget falls back to 10000",
      model: { providerId: "anthropic", reasoningText: true },
      ctx: NO_TOOLS,
      expected: {
        anthropic: { thinking: { type: "enabled", budgetTokens: 10000 } },
      },
    },
    {
      // The pause_turn downgrade is adaptive-only: a non-adaptive (fixed-budget)
      // model keeps its declared budget even when search tools are active.
      name: "anthropic fixed-budget model ignores active search (downgrade is adaptive-only)",
      model: {
        providerId: "anthropic",
        reasoningText: true,
        thinkingBudget: 12000,
      },
      ctx: { searchToolsActive: true, hasTools: true },
      expected: {
        anthropic: { thinking: { type: "enabled", budgetTokens: 12000 } },
      },
    },
    {
      name: "google reasoning model includes thoughts",
      model: { providerId: "google", reasoningText: true },
      ctx: NO_TOOLS,
      expected: { google: { thinkingConfig: { includeThoughts: true } } },
    },
    {
      name: "openai reasoning model gets no effort override and an auto summary",
      model: { providerId: "openai", reasoningText: true },
      ctx: NO_TOOLS,
      expected: { openai: { reasoningSummary: "auto" } },
    },
    {
      // xAI accepts reasoning_effort only on grok-3-mini ("low" | "high");
      // the cataloged Grok 4-family models reject it, so xai sends none.
      name: "xai reasoning model gets no provider options",
      model: { providerId: "xai", reasoningText: true },
      ctx: NO_TOOLS,
      expected: {},
    },
    {
      name: "model without reasoningText gets no options",
      model: { providerId: "anthropic", thinkingBudget: 12000 },
      ctx: NO_TOOLS,
      expected: {},
    },
    {
      // Mistral reasoning is off unless reasoning_effort is "high" (the
      // adapter's only enabling value).
      name: "mistral reasoning model asks for high reasoning effort",
      model: { providerId: "mistral", reasoningText: true },
      ctx: NO_TOOLS,
      expected: { mistral: { reasoningEffort: "high" } },
    },
    {
      name: "reasoning model on a provider without thinking options gets none",
      model: { providerId: "perplexity", reasoningText: true },
      ctx: NO_TOOLS,
      expected: {},
    },
  ]

  it.each(cases)("$name", ({ model, ctx, expected }) => {
    const { providerOptions } = shapeRequest(makeModel(model), ctx)
    expect(providerOptions).toEqual(expected)
  })
})

describe("per-turn reasoning effort (ADR-0026)", () => {
  it("separates the wire override from the concrete applied receipt", () => {
    const levels = makeModel({
      effortLevels: ["low", "medium", "high", "max"],
      defaultEffort: "medium",
    })
    const platform = { platformFunded: true, searchToolsActive: false }
    const byok = { platformFunded: false, searchToolsActive: false }

    expect(resolveReasoningEffort(levels, "high", byok)).toEqual({
      wireReasoningEffort: "high",
      appliedReasoningEffort: "high",
    })
    // "xhigh" is not offered — clamps to the nearest level in canonical order.
    expect(resolveReasoningEffort(levels, "xhigh", byok)).toEqual({
      wireReasoningEffort: "high",
      appliedReasoningEffort: "high",
    })
    expect(resolveReasoningEffort(levels, "none", byok)).toEqual({
      wireReasoningEffort: "low",
      appliedReasoningEffort: "low",
    })
    // Default/platform turns omit the wire override but record the concrete
    // provider default so receipts and reopened chats agree.
    expect(resolveReasoningEffort(levels, "max", platform)).toEqual({
      appliedReasoningEffort: "medium",
    })
    expect(resolveReasoningEffort(levels, undefined, byok)).toEqual({
      appliedReasoningEffort: "medium",
    })
    expect(resolveReasoningEffort(makeModel({}), "high", byok)).toEqual({})
  })

  it("drops applied effort when Claude search uses the fixed-budget fallback", () => {
    const claude46 = makeModel({
      providerId: "anthropic",
      thinkingMode: "adaptive",
      effortLevels: ["low", "medium", "high", "max"],
      searchThinkingDowngrade: true,
    })

    expect(
      resolveReasoningEffort(claude46, "high", {
        platformFunded: false,
        searchToolsActive: true,
      })
    ).toEqual({})
    expect(
      resolveReasoningEffort(claude46, "high", {
        platformFunded: false,
        searchToolsActive: false,
      })
    ).toEqual({
      wireReasoningEffort: "high",
      appliedReasoningEffort: "high",
    })
  })

  it("maps the wire override onto each provider's request shape", () => {
    const ctx: RequestShapingContext = {
      ...NO_TOOLS,
      wireReasoningEffort: "xhigh",
    }
    expect(
      shapeRequest(
        makeModel({
          providerId: "anthropic",
          reasoningText: true,
          thinkingMode: "adaptive",
        }),
        ctx
      ).providerOptions
    ).toEqual({
      anthropic: {
        thinking: { type: "adaptive", display: "summarized" },
        effort: "xhigh",
      },
    })
    expect(
      shapeRequest(makeModel({ providerId: "openai", reasoningText: true }), {
        ...NO_TOOLS,
        wireReasoningEffort: "low",
      }).providerOptions
    ).toEqual({
      openai: { reasoningEffort: "low", reasoningSummary: "auto" },
    })
    expect(
      shapeRequest(makeModel({ providerId: "google", reasoningText: true }), {
        ...NO_TOOLS,
        wireReasoningEffort: "high",
      }).providerOptions
    ).toEqual({
      google: {
        thinkingConfig: { includeThoughts: true, thinkingLevel: "high" },
      },
    })
    expect(
      shapeRequest(makeModel({ providerId: "xai", reasoningText: true }), {
        ...NO_TOOLS,
        wireReasoningEffort: "low",
      }).providerOptions
    ).toEqual({ xai: { reasoningEffort: "low" } })
    // Without a wire override, xai sends nothing (Grok 4 rejects the param).
    expect(
      shapeRequest(
        makeModel({ providerId: "xai", reasoningText: true }),
        NO_TOOLS
      ).providerOptions
    ).toEqual({})
  })
})

describe("shapeRequest headers", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("sets the token-efficient beta header for anthropic with tools", () => {
    const { headers } = shapeRequest(
      makeModel({ providerId: "anthropic", reasoningText: true }),
      { searchToolsActive: false, hasTools: true }
    )
    expect(headers).toEqual({
      "anthropic-beta": ANTHROPIC_BETA_HEADERS.tokenEfficient,
    })
  })

  it("sends no header for anthropic without tools", () => {
    const { headers } = shapeRequest(
      makeModel({ providerId: "anthropic", reasoningText: true }),
      NO_TOOLS
    )
    expect(headers).toEqual({})
  })

  it("sets the header for anthropic with tools regardless of reasoningText", () => {
    // The token-efficient beta gates on provider + tools + env only — never on
    // reasoningText. A non-reasoning anthropic model with tools still gets it.
    const { headers } = shapeRequest(
      makeModel({ providerId: "anthropic", reasoningText: false }),
      { searchToolsActive: false, hasTools: true }
    )
    expect(headers).toEqual({
      "anthropic-beta": ANTHROPIC_BETA_HEADERS.tokenEfficient,
    })
  })

  it("sends no header for non-anthropic providers with tools", () => {
    const { headers } = shapeRequest(
      makeModel({ providerId: "openai", reasoningText: true }),
      { searchToolsActive: false, hasTools: true }
    )
    expect(headers).toEqual({})
  })

  it("respects the ANTHROPIC_TOKEN_EFFICIENT_TOOLS=false kill switch", () => {
    vi.stubEnv("ANTHROPIC_TOKEN_EFFICIENT_TOOLS", "false")
    const { headers } = shapeRequest(
      makeModel({ providerId: "anthropic", reasoningText: true }),
      { searchToolsActive: false, hasTools: true }
    )
    expect(headers).toEqual({})
  })
})

describe("catalog contract for Request shaping", () => {
  // Opus 4.8/Sonnet 5/Fable 5 default `display` to "omitted" (thinking blocks
  // stream empty). Request shaping asks for "summarized" explicitly; the
  // search-downgrade fixed-budget path must not carry `display` at all.
  it.each(["claude-opus-4-8", "claude-sonnet-5", "claude-fable-5"])(
    "%s sends adaptive thinking with display: summarized",
    async (id) => {
      const model = (await getAllModels()).find((m) => m.id === id)
      expect(model).toBeDefined()
      expect(
        shapeRequest(model!, { searchToolsActive: true, hasTools: true })
          .providerOptions
      ).toEqual({
        anthropic: { thinking: { type: "adaptive", display: "summarized" } },
      })
    }
  )

  it("the 4.6 search downgrade sends a fixed budget without display", async () => {
    const model = (await getAllModels()).find((m) => m.id === "claude-opus-4-6")
    expect(model?.searchThinkingDowngrade).toBe(true)
    const { providerOptions } = shapeRequest(model!, {
      searchToolsActive: true,
      hasTools: true,
    })
    expect(providerOptions.anthropic?.thinking).toMatchObject({ type: "enabled" })
    expect(providerOptions.anthropic?.thinking).not.toHaveProperty("display")
  })

  // Request shaping resolves the fixed thinking budget from the model's
  // `thinkingBudget` field, replacing the old model-id string matching
  // (`includes("opus"/"sonnet"/"haiku")`). That string match was an implicit
  // safety net: a non-adaptive anthropic reasoning model with no declared
  // budget now silently falls back to DEFAULT_THINKING_BUDGET_TOKENS (10000).
  // Pin the invariant so a future model can't lose its budget by omission.
  it("every non-adaptive anthropic reasoning model declares thinkingBudget", async () => {
    const offenders = (await getAllModels()).filter(
      (m) =>
        m.providerId === "anthropic" &&
        m.reasoningText === true &&
        m.thinkingMode !== "adaptive" &&
        m.thinkingBudget === undefined
    )

    expect(
      offenders.map((m) => m.id),
      "non-adaptive anthropic reasoning models must set an explicit thinkingBudget"
    ).toEqual([])
  })
})
