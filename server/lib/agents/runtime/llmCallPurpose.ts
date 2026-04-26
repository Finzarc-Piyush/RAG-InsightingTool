/**
 * Labels every chat-completion call site so the server can route classification
 * / extraction / simple-repair calls to GPT-4o-mini while keeping planner,
 * reflector, narrator, and synthesizer on the flagship model. This is the
 * biggest lever in the cost roadmap (~60% reduction in LLM spend at current
 * usage patterns — see docs/plans/enterprise_platform_overhaul.md).
 *
 * Routing precedence (highest to lowest):
 *   1. `OPENAI_MODEL_FOR_<PURPOSE>` — per-purpose override (escape hatch)
 *   2. Category env (MINI vs PRIMARY) declared in `PURPOSE_TO_CATEGORY`
 *   3. `AZURE_OPENAI_DEPLOYMENT_NAME` (the deployment already in use)
 *   4. Hard fallback: `"gpt-4o"`
 *
 * W3.2 wires `completeJson` / `callLlm` to accept a `purpose` and call
 * `resolveModelFor(purpose)`. W3.3–3.9 migrate each call site.
 */

export const LLM_PURPOSE = {
  // ── Classification / extraction / structured repair (→ MINI-eligible) ──
  MODE_CLASSIFY: "mode_classify",
  INTENT_CLASSIFY: "intent_classify",
  COMPLEX_QUERY_SCORE: "complex_query_score",
  SCHEMA_BIND: "schema_bind",
  COLUMN_MATCH: "column_match",
  QUERY_PARSE: "query_parse",
  TOOL_ARG_REPAIR: "tool_arg_repair",
  DATE_ENRICH: "date_enrich",
  TEMPORAL_GRAIN: "temporal_grain",
  DATAOPS_INTENT: "dataops_intent",
  DATAOPS_DEFAULTS: "dataops_defaults",
  DATAOPS_ML_PARAMS: "dataops_ml_params",
  DATAOPS_COMPUTED_COL: "dataops_computed_col",
  CLARIFY_QUESTION: "clarify_question",
  SUGGEST_FOLLOW_UPS: "suggest_follow_ups",
  VERIFIER_SIMPLE: "verifier_simple",

  // ── Reasoning / synthesis (→ keep on PRIMARY / flagship) ──
  HYPOTHESIS: "hypothesis",
  PLANNER: "planner",
  REFLECTOR: "reflector",
  VERIFIER_DEEP: "verifier_deep",
  NARRATOR: "narrator",
  FINAL_ANSWER: "final_answer",
  COORDINATOR: "coordinator",
  ANALYSIS_BRIEF: "analysis_brief",
  VISUAL_PLANNER: "visual_planner",
  BUILD_DASHBOARD: "build_dashboard",
  SQL_GEN: "sql_gen",
  SESSION_CONTEXT: "session_context",
  DATASET_PROFILE: "dataset_profile",
  INSIGHT_GEN: "insight_gen",
  CORRELATION_INSIGHT: "correlation_insight",
  CHART_JSON_REPAIR: "chart_json_repair",
  CONVERSATIONAL: "conversational",
  ML_MODEL_SUMMARY: "ml_model_summary",
} as const;

export type LlmCallPurpose = (typeof LLM_PURPOSE)[keyof typeof LLM_PURPOSE];

/** Which category each purpose belongs to. Used when per-purpose override is absent. */
export type LlmCallCategory = "MINI" | "PRIMARY";

const PURPOSE_TO_CATEGORY: Record<LlmCallPurpose, LlmCallCategory> = {
  // MINI
  [LLM_PURPOSE.MODE_CLASSIFY]: "MINI",
  [LLM_PURPOSE.INTENT_CLASSIFY]: "MINI",
  [LLM_PURPOSE.COMPLEX_QUERY_SCORE]: "MINI",
  [LLM_PURPOSE.SCHEMA_BIND]: "MINI",
  [LLM_PURPOSE.COLUMN_MATCH]: "MINI",
  [LLM_PURPOSE.QUERY_PARSE]: "MINI",
  [LLM_PURPOSE.TOOL_ARG_REPAIR]: "MINI",
  [LLM_PURPOSE.DATE_ENRICH]: "MINI",
  [LLM_PURPOSE.TEMPORAL_GRAIN]: "MINI",
  [LLM_PURPOSE.DATAOPS_INTENT]: "MINI",
  [LLM_PURPOSE.DATAOPS_DEFAULTS]: "MINI",
  [LLM_PURPOSE.DATAOPS_ML_PARAMS]: "MINI",
  [LLM_PURPOSE.DATAOPS_COMPUTED_COL]: "MINI",
  [LLM_PURPOSE.CLARIFY_QUESTION]: "MINI",
  [LLM_PURPOSE.SUGGEST_FOLLOW_UPS]: "MINI",
  [LLM_PURPOSE.VERIFIER_SIMPLE]: "MINI",
  // PRIMARY
  [LLM_PURPOSE.HYPOTHESIS]: "PRIMARY",
  [LLM_PURPOSE.PLANNER]: "PRIMARY",
  [LLM_PURPOSE.REFLECTOR]: "PRIMARY",
  [LLM_PURPOSE.VERIFIER_DEEP]: "PRIMARY",
  [LLM_PURPOSE.NARRATOR]: "PRIMARY",
  [LLM_PURPOSE.FINAL_ANSWER]: "PRIMARY",
  [LLM_PURPOSE.COORDINATOR]: "PRIMARY",
  [LLM_PURPOSE.ANALYSIS_BRIEF]: "PRIMARY",
  [LLM_PURPOSE.VISUAL_PLANNER]: "PRIMARY",
  [LLM_PURPOSE.BUILD_DASHBOARD]: "PRIMARY",
  [LLM_PURPOSE.SQL_GEN]: "PRIMARY",
  [LLM_PURPOSE.SESSION_CONTEXT]: "PRIMARY",
  [LLM_PURPOSE.DATASET_PROFILE]: "PRIMARY",
  [LLM_PURPOSE.INSIGHT_GEN]: "PRIMARY",
  [LLM_PURPOSE.CORRELATION_INSIGHT]: "PRIMARY",
  [LLM_PURPOSE.CHART_JSON_REPAIR]: "PRIMARY",
  [LLM_PURPOSE.CONVERSATIONAL]: "PRIMARY",
  [LLM_PURPOSE.ML_MODEL_SUMMARY]: "PRIMARY",
};

/** Build the per-purpose override env-var name: `mode_classify` → `OPENAI_MODEL_FOR_MODE_CLASSIFY`. */
export function envKeyForPurpose(purpose: LlmCallPurpose): string {
  return `OPENAI_MODEL_FOR_${purpose.toUpperCase()}`;
}

/** Build the MINI-ramp env-var name: `schema_bind` → `OPENAI_MODEL_MINI_RAMP_SCHEMA_BIND`. */
export function rampEnvKeyForPurpose(purpose: LlmCallPurpose): string {
  return `OPENAI_MODEL_MINI_RAMP_${purpose.toUpperCase()}`;
}

/** Fallback chain: per-purpose env → category env → deployment env → hardcoded. */
function resolveCategoryModel(category: LlmCallCategory): string {
  if (category === "MINI") {
    return (
      process.env.OPENAI_MODEL_MINI ||
      process.env.OPENAI_MODEL_PRIMARY ||
      process.env.AZURE_OPENAI_DEPLOYMENT_NAME ||
      "gpt-4o-mini"
    );
  }
  return (
    process.env.OPENAI_MODEL_PRIMARY ||
    process.env.AZURE_OPENAI_DEPLOYMENT_NAME ||
    "gpt-4o"
  );
}

/**
 * Parse a rollout percentage (0-100) from env for a MINI purpose. Returns null
 * when the env var is absent or non-numeric — callers treat that as "full
 * rollout" (100%). Out-of-range values are clamped to [0, 100].
 */
export function rampPctForPurpose(purpose: LlmCallPurpose): number | null {
  const raw = process.env[rampEnvKeyForPurpose(purpose)];
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}

/**
 * FNV-1a 32-bit → bucket in [0, buckets). Deterministic + well-distributed for
 * short keys like `${turnId}:${purpose}`. Cheap enough to run per LLM call.
 */
function hashToBucket(seed: string, buckets = 100): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % buckets;
}

/**
 * Decide whether a MINI-eligible purpose actually gets MINI under the current
 * rollout ramp. Deterministic per `(turnId, purpose)` so every LLM call within
 * a single turn for the same purpose lands the same side of the ramp — a turn
 * shouldn't oscillate between models halfway through planning. Returns `true`
 * when no ramp is configured (= full rollout).
 *
 * Falls back to a timestamp-based seed when `turnId` is unavailable (e.g. a
 * classifier call that runs before the agent loop starts). The downside is
 * non-determinism for untagged calls, but ops should mostly only configure
 * ramps against turn-bound purposes anyway.
 */
export function shouldRouteToMini(
  purpose: LlmCallPurpose,
  turnId: string | undefined
): boolean {
  const rampPct = rampPctForPurpose(purpose);
  if (rampPct == null) return true; // default = full rollout
  if (rampPct >= 100) return true;
  if (rampPct <= 0) return false;
  const seed = `${turnId ?? String(Date.now())}:${purpose}`;
  return hashToBucket(seed, 100) < rampPct;
}

export interface ResolveModelOptions {
  /** Stable identifier used to make the ramp decision deterministic per turn. */
  turnId?: string;
}

/**
 * Pick the model deployment name for a given purpose. Reads env lazily on each
 * call so tests / ops can flip a flag at runtime without a restart.
 *
 * Precedence:
 *   1. per-purpose override `OPENAI_MODEL_FOR_<PURPOSE>` (always wins)
 *   2. for MINI purposes: `OPENAI_MODEL_MINI_RAMP_<PURPOSE>` percentage ramp
 *   3. category default (`OPENAI_MODEL_MINI` / `OPENAI_MODEL_PRIMARY`)
 *   4. `AZURE_OPENAI_DEPLOYMENT_NAME`
 *   5. hardcoded (`"gpt-4o"` or `"gpt-4o-mini"`)
 */
export function resolveModelFor(
  purpose: LlmCallPurpose,
  opts?: ResolveModelOptions
): string {
  const override = process.env[envKeyForPurpose(purpose)];
  if (override && override.trim()) return override.trim();
  const category = PURPOSE_TO_CATEGORY[purpose];
  if (category === "MINI" && !shouldRouteToMini(purpose, opts?.turnId)) {
    return resolveCategoryModel("PRIMARY");
  }
  return resolveCategoryModel(category);
}

/** Category lookup — exported for telemetry rollups and the W3.10 ramp. */
export function categoryForPurpose(purpose: LlmCallPurpose): LlmCallCategory {
  return PURPOSE_TO_CATEGORY[purpose];
}
