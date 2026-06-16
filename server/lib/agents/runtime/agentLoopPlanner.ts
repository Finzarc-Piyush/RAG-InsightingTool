/**
 * agentLoopPlanner.ts — planner-retry wiring for the agent loop.
 *
 * WHY IT LIVES HERE (and not in agentLoop.service.ts)
 *   `PLANNER_RETRY_HINTS` + `runPlannerWithOneRetry` are a cohesive, LOW-COUPLING
 *   cluster: the helper takes every input as an explicit argument (ctx, registry,
 *   turnId, onLlmCall, and the optional prompt blocks), returns the planner result,
 *   and depends only on EXTERNAL modules (`./planner.js`, `./agentLogger.js`) plus
 *   the shared `AgentExecutionContext` / `ToolRegistry` types — never on any mutable
 *   closure state inside `runAgentTurn`. Pulling it into a sibling module shrinks the
 *   god-file (ARCH-1 / CQ-1). `agentLoop.service.ts` imports it back for internal use
 *   AND re-exports it so any file importing it from the agent-loop path keeps
 *   resolving unchanged.
 *
 * WHAT IT DOES
 *   `runPlannerWithOneRetry` makes ONE corrective re-attempt at planning when the
 *   first plan fails validation. The retry appends a reason-specific hint
 *   (`PLANNER_RETRY_HINTS`) to the question and, for invalid-tool-args failures, the
 *   exact tool + Zod error so the LLM fixes precisely the field that failed. This
 *   reduces empty-plan user-facing failures without re-running the whole loop.
 */
import type { AgentExecutionContext } from "./types.js";
import { ToolRegistry } from "./toolRegistry.js";
import { runPlanner, type PlannerRejectReason } from "./planner.js";
import { agentLog } from "./agentLogger.js";

const PLANNER_RETRY_HINTS: Partial<Record<PlannerRejectReason, string>> = {
  llm_json_invalid:
    "IMPORTANT: Fix the previous attempt. Output ONLY valid JSON: an object with \"rationale\" (string) and \"steps\" (non-empty array of objects with id, tool, args, optional dependsOn). Use exact tool names from the Tools list.",
  empty_steps:
    "IMPORTANT: The steps array must not be empty. Include at least one step with a valid tool and args.",
  invalid_tool_args:
    "IMPORTANT: Tool arguments failed schema validation. For `execute_query_plan`, ensure `plan.dimensionFilters` items include required keys `column`, `op` ('in'|'not_in'), and `values` (string[]). If `plan.sort` is present, every item must include `column` and `direction` ('asc'|'desc') — otherwise omit invalid sort entries. For other tools, use only allowed keys and exact column names from the Dataset columns line.",
  unknown_tool:
    "IMPORTANT: Use only tool names exactly as listed in the Tools section (no invented names).",
  column_not_in_schema:
    "IMPORTANT: Every column in the plan must match a name from the Dataset columns line exactly (including parentheses and spacing).",
  invalid_aggregation_alias:
    "IMPORTANT: For execute_query_plan aggregations, alias must differ from source column. Keep schema column in aggregations[].column and use a distinct human-readable aggregations[].alias if needed.",
  ambiguous_column_resolution:
    "IMPORTANT: Use the AUTHORITATIVE columns for this question exactly. Do not invent near-miss names; use only exact schema/canonical names in groupBy/aggregations/filters/sort.",
  bad_depends_on:
    "IMPORTANT: Each dependsOn must reference another step id from the same plan.",
  dependency_cycle:
    "IMPORTANT: Remove circular dependsOn links; order steps as a DAG.",
};

/** One follow-up planner attempt with a corrective hint (reduces empty-plan user-facing failures). */
export async function runPlannerWithOneRetry(
  ctx: AgentExecutionContext,
  registry: ToolRegistry,
  turnId: string,
  onLlmCall: () => void,
  priorObservationsText?: string,
  workingMemoryBlock?: string,
  handoffDigest?: string,
  ragHitsBlock?: string,
  memoryRecallBlock?: string,
  /** Wave B5 · structured per-step insights for re-planning. */
  stepInsightsBlock?: string
) {
  const first = await runPlanner(
    ctx,
    registry,
    turnId,
    onLlmCall,
    priorObservationsText,
    workingMemoryBlock,
    handoffDigest,
    ragHitsBlock,
    memoryRecallBlock,
    stepInsightsBlock
  );
  if (first.ok) return first;
  let hint = first.reason ? PLANNER_RETRY_HINTS[first.reason] : undefined;
  if (!hint) return first;
  // Make the retry self-correcting: append the SPECIFIC tool + Zod error so the
  // LLM fixes exactly the field that failed, not just the generic category.
  if (first.reason === "invalid_tool_args" && first.zod_error) {
    hint += `\n\nThe tool "${first.tool}" rejected its args with this exact error: ${first.zod_error}\nFix precisely that — use only the allowed keys and exact enum values for that tool.`;
  }
  agentLog("planner.retry", { turnId, reason: first.reason });
  const ctxRetry: AgentExecutionContext = {
    ...ctx,
    question: `${ctx.question}\n\n${hint}`,
  };
  return runPlanner(
    ctxRetry,
    registry,
    turnId,
    onLlmCall,
    priorObservationsText,
    workingMemoryBlock,
    handoffDigest,
    ragHitsBlock,
    memoryRecallBlock,
    stepInsightsBlock
  );
}
