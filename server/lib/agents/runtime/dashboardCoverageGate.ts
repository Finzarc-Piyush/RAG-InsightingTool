/**
 * DB3 · Dashboard coverage gate.
 *
 * After the planner returns, when `brief.requestsDashboard === true`, verify
 * every dimension named in `brief.candidateDriverDimensions ∪
 * brief.segmentationDimensions` is the `x` of at least one `build_chart`
 * step. Any uncovered dimension within a sane cardinality envelope (2 ≤
 * topValues ≤ 47) gets a deterministic `build_chart` step appended — the
 * downstream feature sweep (DB4) handles the high-cardinality (top-N+Other)
 * case.
 *
 * Why upstream of the planner's tool execution rather than post-synthesis
 * (where `dashboardFeatureSweep` already lives): plan-time additions go
 * through the full agent processing chain (chart-insight enrichment,
 * magnitudes, dashboard arrangement) instead of being deterministic shells
 * appended after the narrator.
 *
 * This is NOT a replan — single-flow policy is preserved. We append steps to
 * the planner's emitted plan so the original-plan-wins invariant from
 * agentLoop.service.ts:1988 still holds.
 */

import type { PlanStep, AgentExecutionContext } from "./types.js";
import type { AnalysisBrief, DataSummary } from "../../../shared/schema.js";

export interface DashboardCoverageResult {
  ok: boolean;
  missingDimensions: string[];
  highCardinalityDimensions: string[];
  extensions: PlanStep[];
}

const SAFE_CARDINALITY_MAX = 47; // topValues saturates at 48 → use as a "too many" hint
const SAFE_CARDINALITY_MIN = 2;

/** Pull the `x` axis column from a `build_chart` step's args (case-sensitive). */
function buildChartXColumn(step: PlanStep): string | undefined {
  if (step.tool !== "build_chart") return undefined;
  const x = (step.args as { x?: unknown }).x;
  return typeof x === "string" && x ? x : undefined;
}

/** Collect dimensions used as the x-axis across all build_chart steps in the plan. */
function collectChartedDimensions(plan: PlanStep[]): Set<string> {
  const out = new Set<string>();
  for (const step of plan) {
    const x = buildChartXColumn(step);
    if (x) out.add(x);
  }
  return out;
}

/**
 * `topValues` is computed from up to 12k rows and saturates at 48 distinct
 * entries. `length === 0` means the column never collected categorical
 * frequencies (i.e. numeric, date, or post-cap). We treat saturated columns
 * as high-cardinality so DB4's feature-sweep bucketing handles them.
 */
function classifyCardinality(
  summary: DataSummary,
  columnName: string
): "low" | "high" | "unknown" {
  const col = summary.columns.find((c) => c.name === columnName);
  if (!col) return "unknown";
  if (
    summary.numericColumns?.includes(columnName) ||
    summary.dateColumns?.includes(columnName)
  ) {
    return "unknown";
  }
  const topValues = Array.isArray(col.topValues) ? col.topValues : [];
  if (topValues.length === 0) return "unknown";
  if (topValues.length >= 48) return "high";
  if (topValues.length < SAFE_CARDINALITY_MIN) return "unknown";
  if (topValues.length > SAFE_CARDINALITY_MAX) return "high";
  return "low";
}

/**
 * Synthesize a deterministic `build_chart` step for an uncovered dimension.
 * The id namespace `__cov_<dim>` is intentional so subsequent invocations
 * (e.g. on retry) do not duplicate the step — the planner ids are random
 * UUIDs, so collisions are vanishingly unlikely.
 */
function makeCoverageBuildChartStep(
  dimension: string,
  outcomeMetric: string,
  index: number
): PlanStep {
  return {
    id: `__cov_${index}_${dimension.replace(/[^a-zA-Z0-9_-]+/g, "_")}`,
    tool: "build_chart",
    args: {
      type: "bar",
      x: dimension,
      y: outcomeMetric,
      aggregate: "sum",
      title: `${outcomeMetric} by ${dimension}`,
    },
  };
}

/**
 * Run the coverage gate. Returns `{ ok: true }` when no extension is needed
 * (non-dashboard intent, or every required dimension is already charted).
 */
export function assertDashboardCoverage(
  plan: PlanStep[],
  brief: AnalysisBrief | undefined,
  summary: DataSummary
): DashboardCoverageResult {
  if (!brief || !brief.requestsDashboard) {
    return { ok: true, missingDimensions: [], highCardinalityDimensions: [], extensions: [] };
  }

  const outcomeMetric = brief.outcomeMetricColumn;
  if (!outcomeMetric) {
    // No outcome to chart against — gate cannot synth coverage steps.
    return { ok: true, missingDimensions: [], highCardinalityDimensions: [], extensions: [] };
  }

  const required = new Set<string>();
  for (const d of brief.segmentationDimensions ?? []) if (d) required.add(d);
  for (const d of brief.candidateDriverDimensions ?? []) if (d) required.add(d);

  const colNames = new Set(summary.columns.map((c) => c.name));
  const charted = collectChartedDimensions(plan);

  const missingDimensions: string[] = [];
  const highCardinalityDimensions: string[] = [];

  for (const dim of required) {
    if (!colNames.has(dim)) continue; // brief named a column that does not exist
    if (dim === outcomeMetric) continue; // covered as y-axis
    if (charted.has(dim)) continue;
    const card = classifyCardinality(summary, dim);
    if (card === "high") {
      highCardinalityDimensions.push(dim);
    } else if (card === "low") {
      missingDimensions.push(dim);
    }
    // 'unknown' falls through silently (e.g. numeric/date/no-topValues column)
  }

  const extensions: PlanStep[] = missingDimensions.map((dim, i) =>
    makeCoverageBuildChartStep(dim, outcomeMetric, i)
  );

  return {
    ok: extensions.length === 0,
    missingDimensions,
    highCardinalityDimensions,
    extensions,
  };
}

/**
 * Convenience caller for the agent loop. Mutates `plan` in place by
 * appending coverage steps; returns the gate result for SSE emission. No-op
 * (returns ok=true) when not a dashboard turn.
 */
export function applyDashboardCoverage(
  plan: PlanStep[],
  ctx: AgentExecutionContext
): DashboardCoverageResult {
  const result = assertDashboardCoverage(plan, ctx.analysisBrief, ctx.summary);
  if (result.extensions.length > 0) {
    plan.push(...result.extensions);
  }
  return result;
}
