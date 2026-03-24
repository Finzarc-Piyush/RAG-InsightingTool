import type { AgentExecutionContext } from "./types.js";
import type { PlanStep } from "./types.js";
import { plannerOutputSchema } from "./schemas.js";
import { completeJson } from "./llmJson.js";
import { summarizeContextForPrompt } from "./context.js";
import type { ToolRegistry } from "./toolRegistry.js";
import { sortPlanStepsByDependency } from "./workingMemory.js";
import { agentLog } from "./agentLogger.js";

/** Args whose string values must be real column names from DataSummary. */
const COLUMN_BOUND_ARG_KEYS = new Set(["x", "y", "y2", "targetVariable"]);

export type PlannerRejectReason =
  | "llm_json_invalid"
  | "unknown_tool"
  | "invalid_tool_args"
  | "column_not_in_schema"
  | "bad_depends_on"
  | "dependency_cycle"
  | "empty_steps";

export type PlannerRunResult =
  | { ok: true; rationale: string; steps: PlanStep[] }
  | {
      ok: false;
      reason: PlannerRejectReason;
      tool?: string;
      stepId?: string;
      argKeys?: string;
      zod_error?: string;
    };

function firstInvalidQueryPlanColumn(
  step: PlanStep,
  colNames: Set<string>
): string | null {
  if (step.tool !== "execute_query_plan") return null;
  const plan = step.args.plan as Record<string, unknown> | undefined;
  if (!plan || typeof plan !== "object") return "plan";
  const check = (c: string) => colNames.has(c);
  for (const c of (plan.groupBy as string[] | undefined) ?? []) {
    if (!check(c)) return c;
  }
  for (const a of (plan.aggregations as { column: string }[] | undefined) ?? []) {
    if (!a?.column || !check(a.column)) return a.column;
  }
  for (const d of (plan.dimensionFilters as { column: string }[] | undefined) ?? []) {
    if (!d?.column || !check(d.column)) return d.column;
  }
  for (const s of (plan.sort as { column: string }[] | undefined) ?? []) {
    if (!s?.column || !check(s.column)) return s.column;
  }
  return null;
}

function firstInvalidBoundColumnArg(
  step: PlanStep,
  colNames: Set<string>
): string | null {
  for (const key of COLUMN_BOUND_ARG_KEYS) {
    const v = step.args[key];
    if (typeof v === "string" && v.length > 0 && !colNames.has(v)) {
      return key;
    }
  }
  const q = firstInvalidQueryPlanColumn(step, colNames);
  return q;
}

function validateStepColumnArgs(step: PlanStep, colNames: Set<string>): boolean {
  return firstInvalidBoundColumnArg(step, colNames) === null;
}

function logReject(
  fields: Record<string, string | number | boolean | undefined>,
  turnId: string
) {
  agentLog("plan.reject", { turnId, ...fields });
}

export async function runPlanner(
  ctx: AgentExecutionContext,
  registry: ToolRegistry,
  turnId: string,
  onLlmCall: () => void,
  priorObservationsText?: string,
  workingMemoryBlock?: string
): Promise<PlannerRunResult> {
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
- execute_query_plan: use when you need exact groupBy + aggregations (e.g. SUM revenue by year) with args.plan JSON; column names must match schema exactly. Prefer over NL when totals/sums must be correct.
- Decide tools from **what the user is trying to learn**, not from specific words they must say. Use run_analytical_query or execute_query_plan whenever computed results from the dataset (filters, summaries, comparisons, rankings) are needed; prefer its numbers over RAG text when both exist.
- Use run_correlation when the user asks what drives/affects/correlates with a numeric column.
- Use build_chart when a visualization would make comparisons or magnitudes clearer (e.g. breakdowns, trends); x and y must be exact column names from the schema. Set aggregate to sum|mean|count when plotting pre-aggregated metrics. Chain build_chart after run_analytical_query or execute_query_plan when the result rows are suitable for plotting (same column names as the aggregated output).
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
    logReject({ reason: "llm_json_invalid" }, turnId);
    return { ok: false, reason: "llm_json_invalid" };
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

  if (stepsWithMeta.length === 0) {
    logReject({ reason: "empty_steps" }, turnId);
    return { ok: false, reason: "empty_steps" };
  }

  for (const step of stepsWithMeta) {
    const argKeys = Object.keys(step.args).join(",");
    if (!allowed.has(step.tool)) {
      logReject(
        {
          reason: "unknown_tool",
          tool: step.tool,
          stepId: step.id,
          argKeys: argKeys.slice(0, 200),
        },
        turnId
      );
      return {
        ok: false,
        reason: "unknown_tool",
        tool: step.tool,
        stepId: step.id,
        argKeys: argKeys.slice(0, 200),
      };
    }
    const zodErr = registry.getArgsParseError(step.tool, step.args);
    if (zodErr) {
      logReject(
        {
          reason: "invalid_tool_args",
          tool: step.tool,
          stepId: step.id,
          argKeys: argKeys.slice(0, 200),
          zod_error: zodErr,
        },
        turnId
      );
      return {
        ok: false,
        reason: "invalid_tool_args",
        tool: step.tool,
        stepId: step.id,
        argKeys: argKeys.slice(0, 200),
        zod_error: zodErr,
      };
    }
    if (!validateStepColumnArgs(step, colNames)) {
      const bad = firstInvalidBoundColumnArg(step, colNames);
      logReject(
        {
          reason: "column_not_in_schema",
          tool: step.tool,
          stepId: step.id,
          argKeys: argKeys.slice(0, 200),
          zod_error: bad ? `invalid_column_ref:${bad}` : undefined,
        },
        turnId
      );
      return {
        ok: false,
        reason: "column_not_in_schema",
        tool: step.tool,
        stepId: step.id,
        argKeys: argKeys.slice(0, 200),
        zod_error: bad ? `invalid_column_ref:${bad}` : undefined,
      };
    }
    if (step.dependsOn && !stepIds.has(step.dependsOn)) {
      logReject(
        {
          reason: "bad_depends_on",
          tool: step.tool,
          stepId: step.id,
          argKeys: argKeys.slice(0, 200),
          zod_error: `dependsOn:${step.dependsOn}`,
        },
        turnId
      );
      return {
        ok: false,
        reason: "bad_depends_on",
        tool: step.tool,
        stepId: step.id,
        argKeys: argKeys.slice(0, 200),
        zod_error: `dependsOn:${step.dependsOn}`,
      };
    }
  }

  const sorted = sortPlanStepsByDependency(stepsWithMeta);
  if (!sorted) {
    logReject({ reason: "dependency_cycle" }, turnId);
    return { ok: false, reason: "dependency_cycle" };
  }

  return {
    ok: true,
    rationale: out.data.rationale,
    steps: sorted,
  };
}
