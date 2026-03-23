import type { AgentExecutionContext } from "./types.js";
import type { PlanStep } from "./types.js";
import { plannerOutputSchema, type PlannerOutput } from "./schemas.js";
import { completeJson } from "./llmJson.js";
import { summarizeContextForPrompt } from "./context.js";
import type { ToolRegistry } from "./toolRegistry.js";
import { sortPlanStepsByDependency } from "./workingMemory.js";

/** Args whose string values must be real column names from DataSummary. */
const COLUMN_BOUND_ARG_KEYS = new Set(["x", "y", "targetVariable"]);

function validateStepColumnArgs(
  step: PlanStep,
  colNames: Set<string>
): boolean {
  for (const key of COLUMN_BOUND_ARG_KEYS) {
    const v = step.args[key];
    if (typeof v === "string" && v.length > 0 && !colNames.has(v)) {
      return false;
    }
  }
  return true;
}

export async function runPlanner(
  ctx: AgentExecutionContext,
  registry: ToolRegistry,
  turnId: string,
  onLlmCall: () => void,
  priorObservationsText?: string,
  workingMemoryBlock?: string
): Promise<PlannerOutput | null> {
  const tools = registry.formatToolManifestForPlanner();
  const modeNote =
    ctx.mode === "dataOps"
      ? "Mode is dataOps: use run_data_ops for data transformations/mutations when appropriate; use analysis tools (run_analytical_query, etc.) for numeric analysis. Do not use run_data_ops for pure analysis questions."
      : "Mode is analysis: do not use run_data_ops (dataOps-only).";

  const system = `You are a planner for a data analysis assistant. Choose a short ordered list of tool calls.

Tools (read each tool's args carefully — strict schemas; wrong keys fail):
${tools}

${modeNote}
Rules:
- Prefer get_schema_summary first if the question is broad.
- retrieve_semantic_context: **required** args.query (string) for narrative/themes/wording — never put "query" on run_analytical_query.
- run_analytical_query: only optional question_override; **never** use a "query" key here.
- Decide tools from **what the user is trying to learn**, not from specific words they must say. Use run_analytical_query whenever computed results from the dataset (filters, summaries, comparisons, rankings) are needed; prefer its numbers over RAG text when both exist.
- Use run_correlation when the user asks what drives/affects/correlates with a numeric column.
- Use build_chart when a visualization would make comparisons or magnitudes clearer (e.g. breakdowns, trends); x and y must be exact column names from the schema. Chain build_chart after run_analytical_query when the analytical result is suitable for plotting.
- Use clarify_user if critical information is missing.
- Compose multiple tools instead of a single catch-all; there is no legacy "delegate" tool.
- Multi-step: if step B needs outputs from step A (e.g. discover columns via RAG/schema then chart), set step B's dependsOn to step A's id (same plan). Tools run in dependency order.
- If "Prior tool observations" or "Structured working memory" are present, use them for later-step args (columns, filters). Do not ignore successful tool output. If a prior step failed or returned a near–full-table result without useful summary, replan with a clearer question_override or add a follow-up tool.
- At most 6 steps. Each step: id (unique string), tool (exact name), args (object, use {} if none), optional dependsOn (id string referencing another step in this plan).

Output JSON shape: {"rationale": string, "steps": [{"id": string, "tool": string, "args": object, "dependsOn"?: string}]}`;

  const priorBlock =
    priorObservationsText?.trim().length ?
      `Prior tool observations (from this turn; use for planning next steps):\n${priorObservationsText.trim().slice(0, 12000)}\n\n`
      : "";

  const memoryBlock =
    workingMemoryBlock?.trim().length ?
      `Structured working memory (callId, suggestedColumns, slots — use for chained tool args):\n${workingMemoryBlock.trim().slice(0, 8000)}\n\n`
      : "";

  const user = `User question:\n${ctx.question}\n\n${priorBlock}${memoryBlock}${summarizeContextForPrompt(ctx)}`;

  const out = await completeJson(system, user, plannerOutputSchema, {
    turnId,
    temperature: 0.25,
    onLlmCall,
  });
  if (!out.ok) {
    return null;
  }

  const allowed = new Set(
    registry
      .listToolDescriptions()
      .split(", ")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const colNames = new Set(ctx.summary.columns.map((c) => c.name));
  const stepIds = new Set(out.data.steps.map((s) => s.id));

  const stepsWithMeta: PlanStep[] = out.data.steps.map((s) => ({
    id: s.id,
    tool: s.tool,
    args: s.args as Record<string, unknown>,
    dependsOn: s.dependsOn,
  }));

  for (const step of stepsWithMeta) {
    if (!allowed.has(step.tool)) {
      return null;
    }
    if (!registry.argsValidForTool(step.tool, step.args)) {
      return null;
    }
    if (!validateStepColumnArgs(step, colNames)) {
      return null;
    }
    if (step.dependsOn && !stepIds.has(step.dependsOn)) {
      return null;
    }
  }

  const sorted = sortPlanStepsByDependency(stepsWithMeta);
  if (!sorted) {
    return null;
  }

  return {
    rationale: out.data.rationale,
    steps: sorted,
  };
}
