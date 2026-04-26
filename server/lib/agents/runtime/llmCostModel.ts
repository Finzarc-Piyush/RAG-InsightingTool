/**
 * Cost model for Azure OpenAI chat-completion calls.
 *
 * Tracks input / output / cached-input tokens per call and converts to USD using
 * a static rate table (override via env for future price changes).
 *
 * Consumed by the `completeJson` wrapper and direct-call sites wired through
 * `callLlm` (see roadmap Phase 1). Telemetry is the prerequisite for every
 * downstream cost-optimization wave.
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
  // Anthropic Claude (W1 · multi-provider). Prices per public Anthropic pricing
  // as of 2026-04-26; override via OPENAI_RATE_<MODEL>_<KIND> env vars.
  "claude-opus-4-7": { input: 15.0, output: 75.0, cachedInput: 1.5 },
  "claude-opus-4-6": { input: 15.0, output: 75.0, cachedInput: 1.5 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cachedInput: 0.3 },
  "claude-haiku-4-5": { input: 0.8, output: 4.0, cachedInput: 0.08 },
};

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
