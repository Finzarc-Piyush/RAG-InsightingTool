/**
 * ============================================================================
 * runtimeConfig.ts — env-derived config values & feature-flag readers
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Holds the small handful of VALUE exports the agent runtime reads from the
 *   environment: the persisted-size byte caps (AGENT_TRACE_MAX_BYTES etc.), the
 *   AgentConfig loader, and the feature-flag readers (isAgenticLoopEnabled etc.).
 *   These were split out of `types.ts` so that `types.ts` can stay a pure
 *   type-only leaf (zero value imports) — see audit finding ARCH-8.
 *
 * WHY IT MATTERS
 *   The size constants and AgentConfig caps bound what gets persisted to the
 *   1 MB Cosmos document limit; getting them wrong risks dropped data or
 *   oversized writes. They are env-overridable so prod can dial them down
 *   without a redeploy. The feature-flag readers gate runtime behaviour
 *   (the mandatory agentic loop, optional inter-agent trace, etc.).
 *
 * HOW IT CONNECTS
 *   Imports `envInt` (../../envFlags.js) and `isFlagOn` (../../featureFlags.js).
 *   Re-exported through the runtime barrel (index.ts) and imported directly by
 *   the act loop, formatters, tool registry, the chat services, and the
 *   replay/spawned-follow-up paths. The `AgentConfig` *type* lives in types.ts;
 *   the *loader* lives here.
 */
import type { AgentConfig } from "./types.js";
import { envInt } from "../../envFlags.js";
import { isFlagOn } from "../../featureFlags.js";

// Trace / workbench size caps are env-overridable so prod can dial them down
// without a redeploy. They bound how much step-by-step debugging detail gets
// persisted. Cosmos document soft cap is 1 MB; total here + message metadata
// stays well under that (~300 KB).
const _envInt = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const AGENT_TRACE_MAX_BYTES = _envInt("AGENT_TRACE_MAX_BYTES", 96_000);

/** Total JSON size budget for persisted message.agentWorkbench. */
export const AGENT_WORKBENCH_MAX_BYTES = _envInt(
  "AGENT_WORKBENCH_MAX_BYTES",
  80_000
);

/** Max characters per workbench block code field. */
export const AGENT_WORKBENCH_ENTRY_CODE_MAX = _envInt(
  "AGENT_WORKBENCH_ENTRY_CODE_MAX",
  40_000
);

export function isAgenticLoopEnabled(): boolean {
  return isFlagOn("AGENTIC_LOOP_ENABLED");
}

/**
 * W-LEAVE · when true, per-day AVERAGES on a dataset with a detected structural
 * leave-day (dataSummary.leaveDayPattern) are computed over WORKING days only —
 * after disclosing the finding and only once the user consents
 * (decision === "exclude"). Default OFF (dark-launch a number-moving change).
 */
export function isWorkingDayAveragesEnabled(): boolean {
  return isFlagOn("WORKING_DAY_AVERAGES_ENABLED");
}

/**
 * @deprecated When AGENTIC_LOOP_ENABLED=true, strict no-legacy behavior is always on; this only reflects env for tests/logging.
 */
export function isAgenticStrictEnabled(): boolean {
  return process.env.AGENTIC_STRICT === "true";
}

/** When true, `runAgentTurn` records structured handoffs in `AgentTrace.interAgentMessages`. */
export function isInterAgentTraceEnabled(): boolean {
  return process.env.AGENT_INTER_AGENT_MESSAGES === "true";
}

/**
 * When true (and inter-agent messages exist), a compact handoff digest is appended to planner
 * and reflector prompts so replans can use prior coordinator decisions. Increases tokens slightly.
 */
export function isInterAgentPromptFeedbackEnabled(): boolean {
  return process.env.AGENT_INTER_AGENT_PROMPT_FEEDBACK === "true";
}

export function loadAgentConfigFromEnv(): AgentConfig {
  const num = envInt;
  return {
    maxSteps: num(process.env.AGENT_MAX_STEPS, 30),
    maxWallTimeMs: num(process.env.AGENT_MAX_WALL_MS, 600_000),
    maxToolCalls: num(process.env.AGENT_MAX_TOOL_CALLS, 60),
    maxVerifierRoundsPerStep: num(process.env.AGENT_MAX_VERIFIER_ROUNDS_STEP, 2),
    maxVerifierRoundsFinal: num(process.env.AGENT_MAX_VERIFIER_ROUNDS_FINAL, 2),
    maxReplansPerStep: num(process.env.AGENT_MAX_REPLANS_PER_STEP, 2),
    maxTotalLlmCallsPerTurn: num(process.env.AGENT_MAX_LLM_CALLS, 100),
    // FMCG dimensions routinely have 100s of values, so the per-observation
    // row sample is generous to avoid over-aggressive truncation.
    sampleRowsCap: num(process.env.AGENT_SAMPLE_ROWS_CAP, 500),
    // Large so richer growth tables / RAG hits / investigation digests aren't
    // clipped — the model has plenty of context headroom.
    observationMaxChars: num(process.env.AGENT_OBSERVATION_MAX_CHARS, 40_000),
  };
}
