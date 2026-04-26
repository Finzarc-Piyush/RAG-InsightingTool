import type { AgentExecutionContext } from "./types.js";
import type { PlanStep } from "./types.js";
import { plannerOutputSchema } from "./schemas.js";
import { completeJson } from "./llmJson.js";
import { LLM_PURPOSE } from "./llmCallPurpose.js";
import { summarizeContextForPrompt } from "./context.js";
import type { ToolRegistry } from "./toolRegistry.js";
import { sortPlanStepsByDependency } from "./workingMemory.js";
import { formatForPlanner } from "./analyticalBlackboard.js";
import { agentLog } from "./agentLogger.js";
import { formatSkillsManifestForPlanner } from "./skills/index.js";
import {
  resolveMetricAliasToSchemaColumn,
  resolveToSchemaColumn,
} from "./plannerColumnResolve.js";
import {
  patchExecuteQueryPlanDateAggregation,
  patchExecuteQueryPlanTrendCoarserGrain,
  patchExecuteQueryPlanTrendMissingGroupBy,
} from "../../queryPlanTemporalPatch.js";
import {
  repairExecuteQueryPlanDimensionFilters,
  repairExecuteQueryPlanSort,
  ensureInferredFiltersOnStep,
} from "./planArgRepairs.js";

/** Args whose string values must be real column names from DataSummary. */
const COLUMN_BOUND_ARG_KEYS = new Set(["x", "y", "y2", "targetVariable"]);

function normalizeExecuteQueryPlanStepArgs(
  step: PlanStep,
  columns: readonly { name: string }[],
  preferredNumeric: readonly string[] = [],
  streamPreAnalysis?: AgentExecutionContext["streamPreAnalysis"]
): void {
  if (step.tool !== "execute_query_plan") return;
  const plan = step.args.plan as Record<string, unknown> | undefined;
  if (!plan || typeof plan !== "object") return;
  const schemaSet = new Set(columns.map((c) => c.name));
  const canonical = (streamPreAnalysis?.canonicalColumns || []).filter((c) =>
    schemaSet.has(c)
  );
  const canonicalSet = new Set(canonical);
  const canonicalCols = canonical.map((name) => ({ name }));
  const mapping = streamPreAnalysis?.columnMapping || {};
  const normKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const mappingLookup = new Map<string, string>();
  for (const [k, v] of Object.entries(mapping)) {
    if (!schemaSet.has(v)) continue;
    mappingLookup.set(normKey(k), v);
    mappingLookup.set(normKey(v), v);
  }
  const aggOutputName = (a: { column?: string; operation?: string; alias?: string }) => {
    if (a.alias && a.alias.trim()) return a.alias.trim();
    if (a.column && a.operation) return `${a.column}_${a.operation}`;
    return null;
  };
  const resolveAuthoritative = (raw: string): string => {
    if (!raw?.trim()) return raw;
    if (schemaSet.has(raw)) return raw;
    const mapped = mappingLookup.get(normKey(raw));
    if (mapped && schemaSet.has(mapped)) return mapped;
    const resolved = resolveToSchemaColumn(raw, columns);
    if (schemaSet.has(resolved)) return resolved;
    if (canonicalCols.length > 0) {
      const canonResolved = resolveToSchemaColumn(raw, canonicalCols);
      if (canonicalSet.has(canonResolved)) return canonResolved;
    }
    return resolved;
  };

  if (Array.isArray(plan.groupBy)) {
    plan.groupBy = (plan.groupBy as string[]).map((c) =>
      resolveAuthoritative(String(c))
    );
  }
  if (Array.isArray(plan.aggregations)) {
    for (const a of plan.aggregations as { column?: string }[]) {
      if (!a?.column) continue;
      const resolved = resolveAuthoritative(a.column);
      a.column = columns.some((c) => c.name === resolved)
        ? resolved
        : resolveMetricAliasToSchemaColumn(a.column, columns, preferredNumeric);
    }
  }
  if (Array.isArray(plan.dimensionFilters)) {
    for (const d of plan.dimensionFilters as { column?: string }[]) {
      if (d?.column) d.column = resolveAuthoritative(d.column);
    }
  }
  if (Array.isArray(plan.sort)) {
    const allowedSort = new Set<string>(schemaSet);
    for (const a of (plan.aggregations as
      | { column?: string; operation?: string; alias?: string }[]
      | undefined) ?? []) {
      const out = aggOutputName(a);
      if (out) allowedSort.add(out);
    }
    for (const s of plan.sort as { column?: string }[]) {
      if (!s?.column) continue;
      if (allowedSort.has(s.column)) continue;
      const resolved = resolveAuthoritative(s.column);
      if (allowedSort.has(resolved)) s.column = resolved;
    }
  }
}

function preferredNumericColumns(ctx: AgentExecutionContext): string[] {
  const numeric = new Set(ctx.summary.numericColumns || []);
  if (!numeric.size) return [];
  const canonical = ctx.streamPreAnalysis?.canonicalColumns || [];
  const fromCanonical = canonical.filter((c) => numeric.has(c));
  if (fromCanonical.length > 0) return fromCanonical;
  const fromMapping = Object.values(ctx.streamPreAnalysis?.columnMapping || {}).filter(
    (c) => numeric.has(c)
  );
  if (fromMapping.length > 0) return Array.from(new Set(fromMapping));
  return Array.from(numeric);
}

function normalizeCorrelationStepArgs(
  step: PlanStep,
  columns: readonly { name: string }[]
): void {
  if (step.tool !== "run_correlation") return;
  const tv = step.args.targetVariable;
  if (typeof tv === "string" && tv.length > 0) {
    step.args.targetVariable = resolveToSchemaColumn(tv, columns);
  }
  const dfs = step.args.dimensionFilters;
  if (Array.isArray(dfs)) {
    for (const d of dfs) {
      if (d && typeof d === "object" && typeof (d as { column?: string }).column === "string") {
        (d as { column: string }).column = resolveToSchemaColumn(
          (d as { column: string }).column,
          columns
        );
      }
    }
  }
}

function normalizeRunSegmentDriverStepArgs(
  step: PlanStep,
  columns: readonly { name: string }[]
): void {
  if (step.tool !== "run_segment_driver_analysis") return;
  const out = step.args.outcomeColumn;
  if (typeof out === "string" && out.length > 0) {
    step.args.outcomeColumn = resolveToSchemaColumn(out, columns);
  }
  const dfs = step.args.dimensionFilters;
  if (Array.isArray(dfs)) {
    for (const d of dfs) {
      if (d && typeof d === "object" && typeof (d as { column?: string }).column === "string") {
        (d as { column: string }).column = resolveToSchemaColumn(
          (d as { column: string }).column,
          columns
        );
      }
    }
  }
  const bc = step.args.breakdownColumns;
  if (Array.isArray(bc)) {
    step.args.breakdownColumns = (bc as string[])
      .filter((c): c is string => typeof c === "string" && c.length > 0)
      .map((c) => resolveToSchemaColumn(c, columns));
  }
}

function validateRunSegmentDriverStep(step: PlanStep, colNames: Set<string>): string | null {
  if (step.tool !== "run_segment_driver_analysis") return null;
  const out = step.args.outcomeColumn;
  if (typeof out !== "string" || !colNames.has(out)) return "segment_outcomeColumn";
  const dfs = step.args.dimensionFilters;
  if (!Array.isArray(dfs) || dfs.length === 0) return "segment_dimensionFilters";
  for (const d of dfs) {
    if (!d || typeof d !== "object") return "segment_dimensionFilters_item";
    const col = (d as { column?: string }).column;
    if (typeof col !== "string" || !colNames.has(col)) return `segment_filter:${col}`;
  }
  const bc = step.args.breakdownColumns;
  if (Array.isArray(bc)) {
    for (const c of bc) {
      if (typeof c === "string" && c.length > 0 && !colNames.has(c)) return `segment_breakdown:${c}`;
    }
  }
  return null;
}

function normalizeDeriveDimensionBucketStepArgs(
  step: PlanStep,
  columns: readonly { name: string }[]
): void {
  if (step.tool !== "derive_dimension_bucket") return;
  const src = step.args.sourceColumn;
  if (typeof src === "string" && src.length > 0) {
    step.args.sourceColumn = resolveToSchemaColumn(src, columns);
  }
}

function normalizeAddComputedColumnsStepArgs(
  step: PlanStep,
  columns: readonly { name: string }[]
): void {
  if (step.tool !== "add_computed_columns") return;
  const arr = step.args.columns;
  if (!Array.isArray(arr)) return;
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const def = (item as { def?: Record<string, unknown> }).def;
    if (!def || typeof def !== "object") continue;
    const t = def.type;
    if (t === "date_diff_days") {
      const s = def.startColumn;
      const e = def.endColumn;
      if (typeof s === "string" && s.length > 0) {
        def.startColumn = resolveToSchemaColumn(s, columns);
      }
      if (typeof e === "string" && e.length > 0) {
        def.endColumn = resolveToSchemaColumn(e, columns);
      }
    } else if (t === "numeric_binary") {
      const l = def.leftColumn;
      const r = def.rightColumn;
      if (typeof l === "string" && l.length > 0) {
        def.leftColumn = resolveToSchemaColumn(l, columns);
      }
      if (typeof r === "string" && r.length > 0) {
        def.rightColumn = resolveToSchemaColumn(r, columns);
      }
    }
  }
}

export type PlannerRejectReason =
  | "llm_json_invalid"
  | "unknown_tool"
  | "invalid_tool_args"
  | "column_not_in_schema"
  | "invalid_aggregation_alias"
  | "ambiguous_column_resolution"
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
  for (const a of (plan.aggregations as { column: string; alias?: string }[] | undefined) ?? []) {
    if (!a?.column || !check(a.column)) return a.column;
    if (a.alias && a.alias === a.column) {
      return `invalid_aggregation_alias:${a.alias}`;
    }
  }
  for (const d of (plan.dimensionFilters as { column: string }[] | undefined) ?? []) {
    if (!d?.column || !check(d.column)) return d.column;
  }
  const allowedSort = new Set(colNames);
  for (const a of (plan.aggregations as
    | { column?: string; operation?: string; alias?: string }[]
    | undefined) ?? []) {
    if (a?.alias) allowedSort.add(a.alias);
    if (a?.column && a?.operation) {
      allowedSort.add(`${a.column}_${a.operation}`);
    }
  }
  for (const s of (plan.sort as { column: string }[] | undefined) ?? []) {
    if (!s?.column || !allowedSort.has(s.column)) return s.column;
  }
  return null;
}

function firstInvalidBoundColumnArg(
  step: PlanStep,
  colNames: Set<string>
): string | null {
  // build_chart x/y often name columns produced by execute_query_plan (aliases like total_sales),
  // which are not in the raw DataSummary.headers — validate at tool runtime against rows ∪ schema.
  if (step.tool !== "build_chart") {
    for (const key of COLUMN_BOUND_ARG_KEYS) {
      const v = step.args[key];
      if (typeof v === "string" && v.length > 0 && !colNames.has(v)) {
        return key;
      }
    }
  }
  const q = firstInvalidQueryPlanColumn(step, colNames);
  return q;
}

function validateDeriveDimensionStep(step: PlanStep, cumulative: Set<string>): string | null {
  if (step.tool !== "derive_dimension_bucket") return null;
  const src = step.args.sourceColumn;
  const neu = step.args.newColumnName;
  const buckets = step.args.buckets;
  if (typeof src !== "string" || !cumulative.has(src)) return "derive_sourceColumn";
  if (typeof neu !== "string" || !neu.trim()) return "derive_newColumnName";
  if (cumulative.has(neu)) return "derive_newColumnName_conflict";
  if (!Array.isArray(buckets) || buckets.length === 0) return "derive_buckets";
  return null;
}

function validateAddComputedColumnsStep(step: PlanStep, cumulative: Set<string>): string | null {
  if (step.tool !== "add_computed_columns") return null;
  const cols = step.args.columns;
  if (!Array.isArray(cols) || cols.length === 0) return "add_computed_columns_columns";
  const stepCumulative = new Set(cumulative);
  for (const entry of cols) {
    if (!entry || typeof entry !== "object") return "add_computed_columns_item";
    const name = (entry as { name?: string }).name;
    const def = (entry as { def?: { type?: string } }).def;
    if (typeof name !== "string" || !name.trim()) return "add_computed_columns_name";
    if (stepCumulative.has(name)) return "add_computed_columns_name_conflict";
    if (!def || typeof def !== "object" || typeof def.type !== "string") {
      return "add_computed_columns_def";
    }
    if (def.type === "date_diff_days") {
      const s = (def as { startColumn?: string }).startColumn;
      const e = (def as { endColumn?: string }).endColumn;
      if (typeof s !== "string" || !stepCumulative.has(s)) return "add_computed_columns_startColumn";
      if (typeof e !== "string" || !stepCumulative.has(e)) return "add_computed_columns_endColumn";
    } else if (def.type === "numeric_binary") {
      const l = (def as { leftColumn?: string }).leftColumn;
      const r = (def as { rightColumn?: string }).rightColumn;
      if (typeof l !== "string" || !stepCumulative.has(l)) return "add_computed_columns_leftColumn";
      if (typeof r !== "string" || !stepCumulative.has(r)) return "add_computed_columns_rightColumn";
    } else {
      return "add_computed_columns_def_type";
    }
    stepCumulative.add(name);
  }
  return null;
}

function firstInvalidColumnReference(step: PlanStep, cumulative: Set<string>): string | null {
  const seg = validateRunSegmentDriverStep(step, cumulative);
  if (seg) return seg;
  if (step.tool === "run_segment_driver_analysis") return null;
  const der = validateDeriveDimensionStep(step, cumulative);
  if (der) return der;
  if (step.tool === "derive_dimension_bucket") return null;
  const ac = validateAddComputedColumnsStep(step, cumulative);
  if (ac) return ac;
  if (step.tool === "add_computed_columns") return null;
  return firstInvalidBoundColumnArg(step, cumulative);
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
  workingMemoryBlock?: string,
  handoffDigest?: string,
  /** P-A1: upfront RAG retrieval digest for the initial planner call. */
  ragHitsBlock?: string
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
- Decide tools by what the user is trying to learn, not by exact wording. Compose multiple tools instead of a single catch-all (no "delegate" tool).
- Tool query keys: retrieve_semantic_context.args.query (required, string) is the ONLY tool that takes "query"; never put "query" on run_analytical_query (only optional question_override).
- get_schema_summary first when the question is broad. clarify_user only when critical info is genuinely missing.
- execute_query_plan: use for exact groupBy + aggregations with args.plan JSON; column names must match the schema exactly. Prefer over NL whenever totals/sums must be correct. aggregations[].column MUST be an existing numeric column on the current frame OR a column added earlier in this plan by add_computed_columns (e.g. date_diff_days → numeric). Custom labels like Total_Revenue belong in aggregations[].alias only.
- Trends / time series: the dataset exposes derived time-bucket columns (Day · Order Date, Month · Order Date, Year · Order Date, etc.). Prefer coarse grain (month or year). Two valid patterns: (a) groupBy the derived column and omit dateAggregationPeriod (already bucketed); (b) groupBy the raw date column WITH dateAggregationPeriod. Never raw-daily groupBy on a date column when it would yield many points. Match the question's grain when explicit (daily/weekly/monthly/yearly).
- derive_dimension_bucket: run before execute_query_plan (with dependsOn) to map categories into custom buckets, then groupBy the new column name. Args: sourceColumn, newColumnName, buckets: [{ "label", "values": [...] }], optional matchMode (exact|case_insensitive), optional defaultLabel.
- add_computed_columns: row-wise derived numeric columns (safe defs only). Use before execute_query_plan when a needed metric doesn't exist (e.g. date_diff_days with startColumn/endColumn/clampNegative; or numeric_binary with op add|subtract|multiply|divide and leftColumn/rightColumn). Args: columns: [{ "name", "def" }] (max 12). Optional persistToSession (default false; true only if the user asked to save permanently) + persistDescription.
- run_readonly_sql (analysis only): last-resort SELECT-only single statement over table \`dataset\`; no DDL/DML.
- run_correlation: when the user asks what drives / affects / correlates with a numeric column. Pass dimensionFilters when scoping to a segment so the tool sees row-level data, not aggregates left in ctx.data.
- run_segment_driver_analysis (when listed): one-shot driver path for a filtered segment + outcome column. Use for "what's driving the difference between A and B".
- A vs B cohort comparisons (region slice vs the rest, etc.): run_analytical_query or execute_query_plan twice with different dimensionFilters in the same parallelGroup, then build_chart on both result sets.
- Authoritative columns: when the dataset block lists "Preferred columns", "AUTHORITATIVE columns for this question", or "DIAGNOSTIC_ANALYSIS_HINT", use those exact strings unless a get_schema_summary step in the same plan proves the headers differ. Diagnostic hint = row-level slice → breakdowns → correlation; never correlate on aggregate-only tables.
- ANALYSIS_BRIEF_JSON: when present, treat outcomeMetricColumn / filters / segmentationDimensions / timeWindow as authoritative intent. Plan tools to validate or falsify the brief (execute_query_plan with dimensionFilters, run_segment_driver_analysis, run_correlation). Do not contradict the brief without tool evidence; do not invent tool names.
- patch_dashboard: ONLY when the user refers to a dashboard that already exists ("add a margin chart to the dashboard we just built", "rename the Evidence sheet"). Args: addCharts / removeCharts / renameSheet + optional dashboardId. When the user says "the dashboard we just built" without naming it, leave dashboardId empty — the server resolves it from the session's last-created dashboard. Never use this tool to create a new dashboard.
- build_chart: use when a visualization clarifies comparisons or magnitudes. For raw schema columns, x and y must match the schema. After execute_query_plan with sum(Sales), y must be the aggregated column name on the result rows (Sales_sum), not Sales; x is the same groupBy column. Set aggregate "none" when there's exactly one row per x; use sum|mean only when charting raw rows.
- Layered / multi-series charts: when execute_query_plan returns long rows (one row per x × second dimension), use build_chart type "bar" (stacked default) or "line"/"area" for trends; set seriesColumn to the second dimension (the chart compiler can bind it automatically if omitted, as long as the column is in the result). Optional barLayout: stacked|grouped. For two numeric metrics over the same x, use y2 instead of seriesColumn. Heatmaps: type "heatmap", x/y as the two dimensions, z the numeric cell value.
- CRITICAL — Temporal x → never type "bar"; always "line" or "area" for trends.
- CRITICAL — seriesColumn cardinality ≤ 15 distinct values. Higher cardinality → either set max_series: 10 (auto-caps + "Others"), use a single-series bar sorted by y showing top N, or use a heatmap. Never produce dozens of overlapping series.
- Multi-step: when step B needs outputs from step A, set B's dependsOn to A's id; tools run in dependency order. Use Prior tool observations / Structured working memory blocks (when present) to fill later-step args. Don't ignore successful tool output; if a step failed or returned an unhelpful near-full-table result, replan with a clearer question_override or add a follow-up tool.
- At most 6 steps. Each step: id (unique string), tool (exact name), args (object, {} if none), optional dependsOn (id string), optional parallelGroup (string), optional hypothesisId (string).
- parallelGroup EFFICIENCY: when the plan has 3+ independent breakdowns (Region, Category, Salesman, etc.), assign them the same parallelGroup string — they run concurrently and count as ONE step against the 6-step budget. Steps in the same parallelGroup must not have dependsOn pointing to each other. Cap at 3 steps per group.
- hypothesisId: when INVESTIGATION_HYPOTHESES is present, set this to the id of the hypothesis the step primarily tests; the server marks that hypothesis resolved when the step produces evidence.
${formatSkillsManifestForPlanner()}
Output JSON shape: {"rationale": string, "steps": [{"id": string, "tool": string, "args": object, "dependsOn"?: string, "parallelGroup"?: string, "hypothesisId"?: string}]}`;

  const priorBlock =
    priorObservationsText?.trim().length ?
      `Prior tool observations (from this turn; use for planning next steps):\n${priorObservationsText.trim().slice(0, 12000)}\n\n`
      : "";

  const memoryBlock =
    workingMemoryBlock?.trim().length ?
      `Structured working memory (callId, suggestedColumns, slots — use for chained tool args):\n${workingMemoryBlock.trim().slice(0, 8000)}\n\n`
      : "";

  const handoffBlock =
    handoffDigest?.trim().length ?
      `Coordinator handoff log (this turn — use to align the new plan with prior decisions):\n${handoffDigest.trim().slice(0, 12000)}\n\n`
      : "";

  // P-A1: Inject a compact digest of upfront RAG hits so the planner has
  // semantic grounding on the first call, rather than having to discover it
  // via retrieve_semantic_context. Cap at 1500 chars so this stays cheap.
  const ragBlock =
    ragHitsBlock?.trim().length ?
      `### RAG HITS (upfront semantic retrieval — use for wording, themes, and column hints):\n${ragHitsBlock.trim().slice(0, 1500)}\n\n`
      : "";

  const hypothesisBlock = ctx.blackboard
    ? formatForPlanner(ctx.blackboard).trim()
    : "";
  const hypoSection = hypothesisBlock
    ? `### INVESTIGATION_HYPOTHESES (test these; mark evidence in tool args):\n${hypothesisBlock}\n\n`
    : "";

  const user = `User question:\n${ctx.question}\n\n${ragBlock}${hypoSection}${priorBlock}${memoryBlock}${handoffBlock}${summarizeContextForPrompt(ctx)}`;

  const out = await completeJson(system, user, plannerOutputSchema, {
    turnId,
    temperature: 0.25,
    onLlmCall,
    purpose: LLM_PURPOSE.PLANNER,
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
  const stepIds = new Set(out.data.steps.map((s) => s.id));

  const stepsWithMeta: PlanStep[] = out.data.steps.map((s) => ({
    id: s.id,
    tool: s.tool,
    args: s.args as Record<string, unknown>,
    hypothesisId: s.hypothesisId,
    dependsOn: s.dependsOn,
    parallelGroup: s.parallelGroup,
  }));

  if (stepsWithMeta.length === 0) {
    logReject({ reason: "empty_steps" }, turnId);
    return { ok: false, reason: "empty_steps" };
  }

  const preferredNumeric = preferredNumericColumns(ctx);
  for (const step of stepsWithMeta) {
    normalizeExecuteQueryPlanStepArgs(
      step,
      ctx.summary.columns,
      preferredNumeric,
      ctx.streamPreAnalysis
    );
    normalizeCorrelationStepArgs(step, ctx.summary.columns);
    normalizeRunSegmentDriverStepArgs(step, ctx.summary.columns);
    normalizeDeriveDimensionBucketStepArgs(step, ctx.summary.columns);
    normalizeAddComputedColumnsStepArgs(step, ctx.summary.columns);
    patchExecuteQueryPlanDateAggregation(
      step,
      ctx.question,
      ctx.summary.dateColumns
    );
    patchExecuteQueryPlanTrendCoarserGrain(
      step,
      ctx.question,
      ctx.summary.dateColumns
    );
    patchExecuteQueryPlanTrendMissingGroupBy(
      step,
      ctx.question,
      ctx.summary.dateColumns ?? []
    );
    // Belt-and-suspenders: repair common planner schema drift (e.g. missing
    // execute_query_plan.dimensionFilters[].op) before Zod validation.
    repairExecuteQueryPlanDimensionFilters(step);
    repairExecuteQueryPlanSort(step);
    const injected = ensureInferredFiltersOnStep(step, ctx.inferredFilters);
    if (injected.length) {
      console.warn(
        `[planner] injected inferred filters into ${step.tool} step ${step.id}: ${injected.join(", ")}`
      );
    }
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

  const baseColNames = new Set(ctx.summary.columns.map((c) => c.name));
  const cumulative = new Set(baseColNames);
  for (const step of sorted) {
    const argKeys = Object.keys(step.args).join(",");
    const bad = firstInvalidColumnReference(step, cumulative);
    if (bad) {
      const hasCanonical = (ctx.streamPreAnalysis?.canonicalColumns?.length ?? 0) > 0;
      const reason: PlannerRejectReason =
        bad.startsWith("invalid_aggregation_alias:")
          ? "invalid_aggregation_alias"
          : bad.startsWith("ambiguous_column_resolution:") || hasCanonical
            ? "ambiguous_column_resolution"
            : "column_not_in_schema";
      logReject(
        {
          reason,
          tool: step.tool,
          stepId: step.id,
          argKeys: argKeys.slice(0, 200),
          zod_error: `invalid_column_ref:${bad}`,
        },
        turnId
      );
      return {
        ok: false,
        reason,
        tool: step.tool,
        stepId: step.id,
        argKeys: argKeys.slice(0, 200),
        zod_error: `invalid_column_ref:${bad}`,
      };
    }
    if (step.tool === "derive_dimension_bucket") {
      const neu = step.args.newColumnName;
      if (typeof neu === "string" && neu.trim()) cumulative.add(neu);
    }
    if (step.tool === "add_computed_columns") {
      const arr = step.args.columns as { name?: string }[] | undefined;
      if (Array.isArray(arr)) {
        for (const c of arr) {
          if (typeof c?.name === "string" && c.name.trim()) cumulative.add(c.name);
        }
      }
    }
  }

  return {
    ok: true,
    rationale: out.data.rationale,
    steps: sorted,
  };
}
