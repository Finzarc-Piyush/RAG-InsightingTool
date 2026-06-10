/**
 * ============================================================================
 * dashboardCoverageGate.ts — make sure a "build me a dashboard" request charts
 * every dimension it promised
 * ============================================================================
 * WHAT THIS FILE DOES
 *   When the user asks for a dashboard, an earlier step (the analysis brief)
 *   lists which categorical columns ("dimensions" — e.g. Region, Category) the
 *   dashboard should break the outcome metric down by. This gate inspects the
 *   planner's proposed steps and checks that each promised dimension is actually
 *   the x-axis of at least one `build_chart` step. For any dimension that was
 *   forgotten — and is sensible to chart (between 2 and 47 distinct values) —
 *   it appends a deterministic `build_chart` step so the dashboard is complete.
 *   Very-high-cardinality dimensions are left for a later "feature sweep" that
 *   buckets them into top-N + Other.
 *
 * WHY IT MATTERS
 *   Without this gate, a planner LLM building a 12-chart dashboard might silently
 *   skip half the requested breakdowns, leaving holes. Running BEFORE tool
 *   execution (rather than patching after the narrator) means the added charts
 *   flow through the full pipeline (insight enrichment, magnitudes, arrangement)
 *   like any other planned chart, not as bare appended shells.
 *
 * KEY PIECES
 *   - assertDashboardCoverage — pure check; returns missing/high-card dimensions + the extra steps needed
 *   - applyDashboardCoverage — convenience wrapper that mutates the plan in place and returns the result
 *   - DashboardCoverageResult — { ok, missingDimensions, highCardinalityDimensions, extensions }
 *
 * HOW IT CONNECTS
 *   Reads `ctx.analysisBrief` + `ctx.summary` (DataSummary). Appends `PlanStep`s
 *   the agent loop then executes. This is NOT a replan — it only adds to the
 *   planner's own plan, so the single-flow "original plan wins" policy holds.
 */

import type { PlanStep, AgentExecutionContext } from "./types.js";
import type { AnalysisBrief, DataSummary } from "../../../shared/schema.js";
import {
  collectBooleanIndicators,
  scopePredicateCells,
  type BooleanIndicator,
} from "./booleanIndicatorRateRepair.js";

export interface DashboardCoverageResult {
  ok: boolean;
  missingDimensions: string[];
  highCardinalityDimensions: string[];
  extensions: PlanStep[];
}

const SAFE_CARDINALITY_MAX = 47; // topValues saturates at 48 → use as a "too many" hint
const SAFE_CARDINALITY_MIN = 2;
// W5 · top-N for a high-cardinality entity-dimension rate leaderboard (e.g. TSOE).
const HIGH_CARD_RANKING_TOP_N = 15;
// W6 · multi-KPI breadth bounds. Each secondary KPI is charted by the first few
// low-card dims; total secondary steps are capped so the board stays legible.
const SECONDARY_DIMS_CAP = 3;
const MAX_SECONDARY_COVERAGE_STEPS = 12;
// Distinct id namespace so secondary-metric steps never collide with the
// primary-outcome extensions' `__cov_<index>_<dim>` ids.
const SECONDARY_ID_OFFSET = 1000;

/** Pull the `x` axis column from a `build_chart` step's args (case-sensitive). */
function buildChartXColumn(step: PlanStep): string | undefined {
  if (step.tool !== "build_chart") return undefined;
  const x = (step.args as { x?: unknown }).x;
  return typeof x === "string" && x ? x : undefined;
}

/** The single-element `groupBy` of an execute_query_plan step, if any. */
function queryPlanGroupByDims(step: PlanStep): string[] {
  if (step.tool !== "execute_query_plan") return [];
  const plan = (step.args as { plan?: { groupBy?: unknown } }).plan;
  const gb = plan?.groupBy;
  if (!Array.isArray(gb)) return [];
  return gb.filter((g): g is string => typeof g === "string" && g.length > 0);
}

/**
 * Collect dimensions already covered by the plan. Always counts a `build_chart`
 * step's x-axis. When `includeQueryPlanGroupBy` is set (the boolean-indicator
 * path, where breakdowns are `execute_query_plan` rate steps rather than
 * `build_chart`), also counts each `execute_query_plan` groupBy dimension so the
 * gate doesn't duplicate a rate breakdown the planner already emitted.
 */
function collectChartedDimensions(
  plan: PlanStep[],
  opts: { includeQueryPlanGroupBy?: boolean } = {}
): Set<string> {
  const out = new Set<string>();
  for (const step of plan) {
    const x = buildChartXColumn(step);
    if (x) out.add(x);
    if (opts.includeQueryPlanGroupBy) {
      for (const g of queryPlanGroupByDims(step)) out.add(g);
    }
  }
  return out;
}

/**
 * `topValues` is computed from up to 12k rows and saturates at 48 distinct
 * entries. `length === 0` means the column never collected categorical
 * frequencies (i.e. numeric, date, or post-cap). We treat saturated columns
 * as high-cardinality so the downstream feature-sweep bucketing handles them.
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
      // MW2 · rate-first / size-normalized: a raw SUM by dimension rewards big
      // units (more reps = more visits) and is not comparable across units of
      // different size. A per-record AVERAGE de-confounds size so a manager can
      // compare ASMs/clusters fairly. (Boolean-indicator outcomes already chart
      // a true % rate via makeCoverageRateStep.)
      x: dimension,
      y: outcomeMetric,
      aggregate: "mean",
      title: `${outcomeMetric} (avg) by ${dimension}`,
    },
  };
}

/**
 * When the outcome metric is a boolean indicator (e.g. `PJP Adherence` =
 * Yes/No), return its indicator metadata so we can chart a RATE rather than a
 * meaningless sum-of-strings. `build_chart`'s aggregate enum
 * (`sum|mean|count|none`) cannot compute a ratio, so a per-dimension rate must
 * be an `execute_query_plan` countIf-ratio step instead. Returns null for
 * numeric outcomes (those keep the existing build_chart sum path) or when the
 * indicator lacks positive values (no valid predicate can be built).
 */
function booleanIndicatorOutcome(
  summary: DataSummary,
  outcomeMetric: string
): BooleanIndicator | null {
  return (
    collectBooleanIndicators(summary).find((i) => i.name === outcomeMetric) ??
    null
  );
}

/**
 * Synthesize a deterministic `execute_query_plan` step that computes the
 * boolean-indicator RATE broken down by `dimension`. Mirrors the countIf-ratio
 * shape produced by `repairBooleanIndicatorRatePlan` (booleanIndicatorRateRepair
 * .ts) so the result flows through the identical, known-good aggregation +
 * chart-promotion path. `matching` = positive rows, `total` = positive ∪
 * negative rows (sentinels excluded), rate = matching / total, sorted desc.
 */
function makeCoverageRateStep(
  dimension: string,
  indicator: BooleanIndicator,
  index: number,
  /** When set, top-N the result (used for high-cardinality entity dimensions
   *  like TSOE — a full thousands-row group-by is unusable, but a ranked
   *  leaderboard is exactly the "give me TSOE info" ask). */
  limit?: number
): PlanStep {
  const denom = Array.from(
    new Set([...indicator.positives, ...indicator.negatives])
  ).filter((v) => !indicator.sentinels.includes(v));
  const denomValues = denom.length > 0 ? denom : indicator.positives;
  const rateAlias = `${indicator.name}_rate`;
  // Scope numerator + denominator to the metric's VALID UNIVERSE (e.g. adherence
  // only on Market-Working days) so structural-zero rows don't deflate the rate.
  const scopeCells = scopePredicateCells(indicator);
  const plan: Record<string, unknown> = {
    groupBy: [dimension],
    aggregations: [
      {
        operation: "countIf",
        column: "*",
        predicate: [
          { column: indicator.name, op: "in", values: indicator.positives },
          ...scopeCells,
        ],
        alias: "matching",
      },
      {
        operation: "countIf",
        column: "*",
        predicate: [
          { column: indicator.name, op: "in", values: denomValues },
          ...scopeCells,
        ],
        alias: "total",
      },
    ],
    computedAggregations: [{ alias: rateAlias, expression: "matching / total" }],
    sort: [{ column: rateAlias, direction: "desc" }],
  };
  if (typeof limit === "number" && limit > 0) plan.limit = limit;
  return {
    id: `__cov_${index}_${dimension.replace(/[^a-zA-Z0-9_-]+/g, "_")}`,
    tool: "execute_query_plan",
    args: { plan },
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

  // Boolean-indicator outcomes (e.g. `PJP Adherence` = Yes/No) have no numeric
  // form, so per-dimension breakdowns must be countIf-RATE `execute_query_plan`
  // steps — not `build_chart` sum-of-strings (which renders empty/garbage and
  // mirrors the feature-sweep's own numeric guard). Coverage for those dims is
  // therefore also satisfied by the planner's own execute_query_plan rate
  // breakdowns, so count their groupBy dims as charted to avoid duplication.
  const indicator = booleanIndicatorOutcome(summary, outcomeMetric);

  const colNames = new Set(summary.columns.map((c) => c.name));
  const charted = collectChartedDimensions(plan, {
    includeQueryPlanGroupBy: Boolean(indicator),
  });

  const missingDimensions: string[] = [];
  const highCardinalityDimensions: string[] = [];
  // Low-cardinality required dims regardless of whether the PRIMARY outcome is
  // already charted against them — secondary KPI metrics (W6) were not charted
  // by the planner, so they need these dims even when the primary covers them.
  const allLowCardDims: string[] = [];

  // Degenerate-breakdown skip: a boolean metric is structurally constant across
  // its own gate column (e.g. "adherence by PJP Planned Type" is 0 for every
  // type except Market Working). Charting it produces the all-zero chart the
  // manager flagged, so skip the gate column(s) as breakdown dimensions.
  const gateColumns = new Set(
    (indicator?.applicabilityScope ?? []).map((g) => g.gateColumn)
  );

  for (const dim of required) {
    if (!colNames.has(dim)) continue; // brief named a column that does not exist
    if (dim === outcomeMetric) continue; // covered as y-axis
    if (gateColumns.has(dim)) continue; // degenerate breakdown by its own gate
    const card = classifyCardinality(summary, dim);
    if (card === "low") allLowCardDims.push(dim);
    if (charted.has(dim)) continue;
    if (card === "high") {
      highCardinalityDimensions.push(dim);
    } else if (card === "low") {
      missingDimensions.push(dim);
    }
    // 'unknown' falls through silently (e.g. numeric/date/no-topValues column)
  }

  const extensions: PlanStep[] = missingDimensions.map((dim, i) =>
    indicator
      ? makeCoverageRateStep(dim, indicator, i)
      : makeCoverageBuildChartStep(dim, outcomeMetric, i)
  );

  // W5 · high-cardinality entity dimensions (e.g. TSOE — thousands of distinct
  // values) are otherwise dropped here and the boolean-outcome feature sweep
  // can't chart them either, so the user's "give me TSOE info" goes unanswered.
  // For a boolean-indicator outcome, emit a TOP-N rate leaderboard per high-card
  // dim — a ranked table is exactly what a thousands-row entity dimension wants.
  // (Numeric outcomes keep riding on the feature sweep's top-N+Other bucketing.)
  if (indicator && highCardinalityDimensions.length > 0) {
    highCardinalityDimensions.forEach((dim, i) => {
      extensions.push(
        makeCoverageRateStep(dim, indicator, missingDimensions.length + i, HIGH_CARD_RANKING_TOP_N)
      );
    });
  }

  // W6 · multi-KPI dashboard: chart each secondary KPI (brief.outlineMetrics) by
  // the key low-card dimensions too, so a "PJP dashboard" surfaces adherence +
  // compliance + attendance + punctuality rather than one metric. Bounded to keep
  // the board legible. Secondary metrics aren't charted by the planner, so no
  // dedup against existing steps is needed; a distinct id namespace avoids
  // collisions with the primary-outcome extensions above.
  const secondaryMetrics = (brief.outlineMetrics ?? [])
    .map((m) => m?.trim())
    .filter((m): m is string => Boolean(m) && colNames.has(m) && m !== outcomeMetric);
  if (secondaryMetrics.length > 0 && allLowCardDims.length > 0) {
    const secondaryDims = allLowCardDims.slice(0, SECONDARY_DIMS_CAP);
    let secondaryCount = 0;
    for (const metric of secondaryMetrics) {
      if (secondaryCount >= MAX_SECONDARY_COVERAGE_STEPS) break;
      const metricIndicator = booleanIndicatorOutcome(summary, metric);
      for (const dim of secondaryDims) {
        if (secondaryCount >= MAX_SECONDARY_COVERAGE_STEPS) break;
        if (dim === metric) continue;
        const idx = SECONDARY_ID_OFFSET + secondaryCount;
        extensions.push(
          metricIndicator
            ? makeCoverageRateStep(dim, metricIndicator, idx)
            : makeCoverageBuildChartStep(dim, metric, idx)
        );
        secondaryCount += 1;
      }
    }
  }

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
