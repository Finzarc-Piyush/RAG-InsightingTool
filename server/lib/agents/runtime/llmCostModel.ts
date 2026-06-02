/**
 * ============================================================================
 * llmCostModel.ts — turns token counts into dollars, and caps output length
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Every LLM call reports how many tokens it used (input, output, and a
 *   "cached-input" portion that providers bill at a discount). This file holds
 *   the price table (USD per million tokens, per model) and the math to convert a
 *   call's token usage into a dollar cost. It also knows each model's maximum
 *   allowed output length and clamps requests to it. A "token" is the chunk of
 *   text models are billed by — roughly a word-piece.
 *
 * WHY IT MATTERS
 *   This is the foundation of cost tracking: callLlm.ts uses it after every call
 *   to attach a USD figure to the usage telemetry, which is what makes spend
 *   visible and optimisable. The output-token clamp prevents a request from
 *   asking for more than a model can return (which would error or truncate).
 *
 * KEY PIECES
 *   - RATE_USD_PER_MTOK / MAX_OUTPUT_TOKENS — the static per-model price and
 *     output-cap tables (keyed by lowercase deployment/model name).
 *   - calculateCostUsd — computes a call's cost; cached prompt tokens billed at
 *     the cheaper cached rate, the rest at the full input rate. Unknown models
 *     bill at $0 so they show up as costUsd=0 in telemetry and get noticed.
 *   - clampMaxTokens — limits a requested output size to the model's cap.
 *   - normalizeUsage — turns a raw provider `usage` object into our tidy
 *     CallTokenUsage shape, tolerating missing fields (returns null if unusable).
 *   - Per-model env overrides (OPENAI_RATE_<MODEL>_<KIND>) let ops change prices
 *     without a code change or redeploy.
 *
 * HOW IT CONNECTS
 *   Consumed by callLlm.ts (and the completeJson wrapper) on every chat call.
 *   No external imports — pure data + arithmetic.
 *
 * NOTE: the rate numbers are a point-in-time snapshot of public pricing. Prefer
 * env overrides over editing the table so the captured-date stays honest.
 */

/** Per-million-token rates in USD. */
export interface ModelRate {
  input: number;
  output: number;
  /** Azure OpenAI cached-input discount tier. Absent → same as `input`. */
  cachedInput?: number;
}

/**
 * Static rate table. Keyed by the Azure OpenAI deployment name (what
 * `openai.chat.completions.create({ model })` receives). Keep lowercase.
 *
 * Sources: Azure OpenAI pricing page snapshot — 2026-04-23. Update via env
 * overrides rather than editing here so the repo stays honest about the
 * date these numbers were captured.
 */
export const RATE_USD_PER_MTOK: Record<string, ModelRate> = {
  "gpt-4o": { input: 2.5, output: 10.0, cachedInput: 1.25 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cachedInput: 0.075 },
  // GPT-5 family · Azure deployment names like "gpt-5.4-mini" pass through
  // as the model param. Placeholder rates mirror gpt-4o-mini until Azure
  // publishes per-tenant pricing; override via OPENAI_RATE_GPT_5_4_MINI_*.
  "gpt-5.4-mini": { input: 0.15, output: 0.6, cachedInput: 0.075 },
  // Anthropic Claude (multi-provider). Prices per public Anthropic pricing
  // as of 2026-04-26; override via OPENAI_RATE_<MODEL>_<KIND> env vars.
  "claude-opus-4-7": { input: 15.0, output: 75.0, cachedInput: 1.5 },
  "claude-opus-4-6": { input: 15.0, output: 75.0, cachedInput: 1.5 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cachedInput: 0.3 },
  "claude-haiku-4-5": { input: 0.8, output: 4.0, cachedInput: 0.08 },
};

export const MAX_OUTPUT_TOKENS: Record<string, number> = {
  "gpt-4o":            16_384,
  "gpt-4o-mini":       16_384,
  "gpt-5.4-mini":      16_384,
  "claude-opus-4-7":   32_768,
  "claude-opus-4-6":   32_768,
  "claude-sonnet-4-6": 16_384,
  "claude-haiku-4-5":   8_192,
};

const DEFAULT_MAX_OUTPUT = 16_384;

export function clampMaxTokens(model: string, requested: number): number;
export function clampMaxTokens(model: string, requested: undefined): undefined;
export function clampMaxTokens(model: string, requested: number | undefined): number | undefined;
export function clampMaxTokens(model: string, requested: number | undefined): number | undefined {
  if (requested == null) return undefined;
  const cap = MAX_OUTPUT_TOKENS[model.toLowerCase()] ?? DEFAULT_MAX_OUTPUT;
  return Math.min(requested, cap);
}

/** Normalized token counts extracted from an OpenAI `response.usage` object. */
export interface CallTokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** Portion of prompt_tokens that hit Azure OpenAI's automatic prompt cache. */
  cachedPromptTokens?: number;
}

/**
 * Read an optional `OPENAI_RATE_<model>_<input|output|cached>` env override
 * so ops can adjust pricing without a redeploy. Env key is upper-snake.
 */
function envRateOverride(model: string, kind: "input" | "output" | "cached"): number | null {
  const key = `OPENAI_RATE_${model.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_${kind.toUpperCase()}`;
  const raw = process.env[key];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function resolveRate(model: string): ModelRate {
  const key = model.toLowerCase();
  const base: ModelRate = RATE_USD_PER_MTOK[key] ?? { input: 0, output: 0 };
  const input = envRateOverride(key, "input") ?? base.input;
  const output = envRateOverride(key, "output") ?? base.output;
  const cachedInput = envRateOverride(key, "cached") ?? base.cachedInput;
  return { input, output, cachedInput };
}

/**
 * Compute USD cost for a single chat-completion call.
 *
 * Cached prompt tokens (when present) are billed at the cached-input rate; the
 * non-cached remainder is billed at the full input rate. Unknown models bill at
 * zero (surface in telemetry as `costUsd=0` so ops notice and add the row).
 */
export function calculateCostUsd(model: string, usage: CallTokenUsage): number {
  const rate = resolveRate(model);
  const cached = Math.max(0, usage.cachedPromptTokens ?? 0);
  const uncachedPrompt = Math.max(0, usage.promptTokens - cached);
  const cachedRate = rate.cachedInput ?? rate.input;
  const promptCost = (uncachedPrompt * rate.input + cached * cachedRate) / 1_000_000;
  const completionCost = (usage.completionTokens * rate.output) / 1_000_000;
  return promptCost + completionCost;
}

/**
 * Normalize the OpenAI SDK `response.usage` object into our `CallTokenUsage`
 * shape. Tolerates missing fields (older API versions, audio/reasoning variants
 * that we don't use yet). Returns `null` if the input is unusable.
 */
export function normalizeUsage(usage: unknown): CallTokenUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown } | null;
  };
  const promptTokens = typeof u.prompt_tokens === "number" ? u.prompt_tokens : null;
  const completionTokens = typeof u.completion_tokens === "number" ? u.completion_tokens : null;
  if (promptTokens == null || completionTokens == null) return null;
  const result: CallTokenUsage = { promptTokens, completionTokens };
  const cached = u.prompt_tokens_details?.cached_tokens;
  if (typeof cached === "number" && cached >= 0) {
    result.cachedPromptTokens = cached;
  }
  return result;
}
