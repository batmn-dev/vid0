import type { Provider } from "@/lib/provider-identity"
import type { ToolCapabilities } from "@/lib/tools/types"

/** Editorial selector visibility. Lifecycle and priority are separate facts. */
export type ModelCatalogStatus = "visible" | "hidden"

export type ModelReleaseStage = "stable" | "preview" | "experimental"

/**
 * Closed vocabulary for models that compete to be the same recommendation.
 * These lanes intentionally span product-name changes (for example, o-series
 * to GPT-series); membership remains on each model record, not in a second
 * registry of "current" heads.
 */
export const MODEL_RECOMMENDATION_LANE_IDS = [
  "anthropic:fable",
  "anthropic:haiku",
  "anthropic:opus",
  "anthropic:sonnet",
  "google:gemini-flash",
  "google:gemini-flash-lite",
  "google:gemini-pro",
  "deepseek:chat",
  "deepseek:fast",
  "deepseek:reasoning",
  "mistral:codestral",
  "mistral:large",
  "mistral:medium",
  "mistral:ministral-14b",
  "mistral:ministral-3b",
  "mistral:ministral-8b",
  "mistral:pixtral-12b",
  "mistral:pixtral-large",
  "mistral:small",
  "moonshot:kimi",
  "moonshot:kimi-code",
  "openai:balanced",
  "openai:fast",
  "openai:flagship",
  "openai:pro",
  "perplexity:sonar",
  "perplexity:sonar-deep-research",
  "perplexity:sonar-pro",
  "perplexity:sonar-reasoning",
  "qwen:open-flagship",
  "xai:grok",
] as const

export type ModelRecommendationLaneId =
  (typeof MODEL_RECOMMENDATION_LANE_IDS)[number]

/**
 * Dated editorial policy for makers whose default model portfolio is an exact
 * allowlist. Unlisted logical models stay available, but classify as Legacy.
 */
export type ModelRecommendationPolicy = {
  vendorId: string
  currentModelIds: readonly string[]
  /** UTC calendar date (`YYYY-MM-DD`). */
  verifiedAt: string
}

export type ModelLifecycleStatus =
  "active" | "legacy" | "deprecated" | "retired"

export type ModelLifecycleSource = "provider" | "openrouter" | "editorial"

/**
 * Dated lifecycle evidence for one concrete route. The canonical route's
 * evidence also describes the logical model; non-canonical route evidence
 * remains route-specific.
 */
export type ModelLifecycle = {
  status: ModelLifecycleStatus
  source: ModelLifecycleSource
  /** UTC calendar date (`YYYY-MM-DD`). */
  verifiedAt: string
  sourceUrl?: string
  /** UTC calendar date (`YYYY-MM-DD`). */
  retiresAt?: string
  replacementModelId?: string
}

export type ModelPriorityReason =
  | "lifecycle_legacy"
  | "lifecycle_deprecated"
  | "lifecycle_retired"
  | "not_recommended"
  | "retirement_scheduled"
  | "superseded"

export type ModelPriority = {
  classification: "current" | "legacy"
  classificationReason?: ModelPriorityReason
  classificationSource?: ModelLifecycleSource
  successorModelId?: string
  classificationEffectiveAt?: string
}

export type ModelIdKind = "stable" | "snapshot" | "alias" | "wrapped"

/** How a model route exposes web search to the product. */
export type SearchMode = "optional" | "always-on" | "unsupported"

/**
 * Canonical reasoning-effort scale (ADR-0026), ordered least → most effort.
 * The app-wide superset: each route declares the subset its provider accepts
 * via `effortLevels`; provider mapping never invents levels. "Default" (no
 * selection) is `undefined`, never a sentinel member.
 */
export const REASONING_EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const

export type ModelReasoningEffort = (typeof REASONING_EFFORT_LEVELS)[number]

export function isModelReasoningEffort(
  value: unknown
): value is ModelReasoningEffort {
  return (REASONING_EFFORT_LEVELS as readonly unknown[]).includes(value)
}

/**
 * Clamp a level onto an offered subset: the requested level when offered,
 * else the nearest offered level in canonical order (ties prefer the cheaper
 * side). Pure vocabulary math — shared by Request shaping's effort
 * resolution and the OpenRouter catalog generator's default derivation.
 */
export function clampToNearestEffortLevel(
  levels: readonly ModelReasoningEffort[],
  requested: ModelReasoningEffort
): ModelReasoningEffort | undefined {
  if (levels.length === 0) return undefined
  if (levels.includes(requested)) return requested

  const requestedIndex = REASONING_EFFORT_LEVELS.indexOf(requested)
  let nearest: ModelReasoningEffort | undefined
  let nearestDistance = Number.POSITIVE_INFINITY
  for (const level of levels) {
    const distance = Math.abs(
      REASONING_EFFORT_LEVELS.indexOf(level) - requestedIndex
    )
    if (
      distance < nearestDistance ||
      (distance === nearestDistance &&
        nearest !== undefined &&
        REASONING_EFFORT_LEVELS.indexOf(level) <
          REASONING_EFFORT_LEVELS.indexOf(nearest))
    ) {
      nearest = level
      nearestDistance = distance
    }
  }
  return nearest
}

/**
 * Construction-time reasoning declaration for models whose provider takes
 * reasoning as a model-construction setting rather than a per-call provider
 * option (today: OpenRouter's `.chat(id, { reasoning })`; per-call reasoning
 * lives in Request shaping — lib/openproviders/request-shaping.ts). Exactly
 * one knob: an effort level or a reasoning-token budget.
 */
export type ModelReasoningSettings =
  | { effort: ModelReasoningEffort; maxTokens?: never }
  | { maxTokens: number; effort?: never }

type ModelConfig = {
  id: string
  /** Authoritative full user-facing model name. */
  name: string
  /** Optional compact label for constrained presentation surfaces. */
  shortName?: string
  provider: string
  providerId: Provider
  modelFamily?: string
  /** Explicit recommendation lane used for successor-aware classification. */
  lineageId?: ModelRecommendationLaneId
  /** Defaults to stable; previews never supersede stable predecessors. */
  releaseStage?: ModelReleaseStage
  baseProviderId: string

  description?: string
  tags?: string[]

  catalogStatus: ModelCatalogStatus
  lifecycle?: ModelLifecycle
  idKind: Exclude<ModelIdKind, "alias">
  /**
   * Explicit logical-model mapping (ADR-0020). A route record whose model is
   * already represented by a direct catalog entry names that entry here; the
   * logical catalog compiles both records into ONE selector model with two
   * routes. Absent → this record is its own logical model (its id doubles as
   * the logical id). Never inferred from display names; a target that is
   * missing or itself mapped fails catalog compilation loudly.
   */
  logicalModelId?: string
  verifiedAgainst?: string
  lastVerifiedAt?: string

  contextWindow?: number
  maxOutput?: number
  inputCost?: number
  outputCost?: number
  priceUnit?: string

  vision?: boolean
  tools?: boolean | ToolCapabilities
  audio?: boolean
  reasoningText?: boolean
  /**
   * Explicit route-level web-search behavior. Undefined derives optional
   * search from `tools`; always-on marks inherently grounded models and
   * unsupported is a deliberate opt-out.
   */
  searchMode?: SearchMode
  /**
   * The provider returns its reasoning inline in the answer text as a
   * literal tag section (Perplexity `sonar-reasoning-pro`: `<think>…</think>`).
   * The Chat turn runtime lifts that section into ordinary reasoning parts at
   * the stream seam (ADR-0041) so persisted content, replay, and the UI never
   * see the tag text. Independent of `reasoningText`, which states whether the
   * route can actually deliver reasoning today. Declare it only for a route
   * that demonstrably streams the tags: the lift removes every literal section
   * from the answer, so on a route that never emits them (Perplexity's default
   * stream mode suppresses reasoning) it would only strip content a user asked
   * for. No shipped route declares it today.
   */
  inlineReasoningTags?: "think"
  openSource?: boolean

  /**
   * Thinking mode for this model.
   *   - "adaptive" — model dynamically allocates thinking budget (Opus 4.6+)
   *   - "enabled"  — fixed budget via budgetTokens (default for older models)
   *   - undefined  — inherit from reasoningText flag (backward compat)
   */
  thinkingMode?: "adaptive" | "enabled"

  /**
   * Fixed thinking budget in tokens, used when thinkingMode is "enabled"
   * (or unset). Models without a declared budget fall back to the
   * Request shaping default (10000).
   */
  thinkingBudget?: number

  /**
   * Anthropic-only: when server-side search tools are active, Request shaping
   * downgrades adaptive thinking to {type: "enabled", budgetTokens} (the
   * pause_turn workaround). Set ONLY on 4.6-generation models — `budget_tokens`
   * is removed upstream on Opus 4.7+/Sonnet 5/Fable 5 (HTTP 400; Fable 5
   * accepts only adaptive or omitted thinking).
   */
  searchThinkingDowngrade?: boolean

  /**
   * Construction-time reasoning settings, fed to the Provider strategy's
   * `languageModel(id, settings)` when the model is built. Only providers
   * whose reasoning knob is construction-time consume it (today: OpenRouter);
   * every other strategy ignores it. Distinct from `reasoningText`, which
   * remains the capability FLAG (the model emits reasoning text) — this field
   * is the request CONFIGURATION that turns reasoning output on.
   */
  reasoning?: ModelReasoningSettings

  /**
   * User-selectable reasoning-effort levels this route's provider accepts for
   * this model (ADR-0026), in `REASONING_EFFORT_LEVELS` order. Absent → the
   * route has no per-turn effort knob and the effort control never renders
   * for it. Vocabulary only — the effort→wire mapping stays in
   * lib/openproviders (Request shaping / Provider strategy).
   */
  effortLevels?: readonly ModelReasoningEffort[]

  /**
   * The provider's documented default effort. The menu shows it as implicitly
   * selected with no user override, and the runtime records it as the concrete
   * applied receipt. It is never treated as a per-turn wire override.
   */
  defaultEffort?: ModelReasoningEffort

  speed?: "Fast" | "Medium" | "Slow"
  intelligence?: "Low" | "Medium" | "High"

  website?: string
  apiDocs?: string
  modelPage?: string
  /** UTC calendar date (`YYYY-MM-DD`). */
  releasedAt?: string
  /** Explicit upstream snapshot date; use day 01 for month-only YYMM ids. */
  snapshotDate?: string

  icon?: string

  accessible?: boolean
}

export type { ModelConfig }
