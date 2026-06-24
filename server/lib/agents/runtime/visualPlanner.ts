/**
 * ============================================================================
 * visualPlanner.ts — decide which extra charts to add to an answer, and build
 *                   them so they're ready to render
 * ============================================================================
 * WHAT THIS FILE DOES
 *   After the agent has analysed the data, this file proposes a small number of
 *   supporting charts and produces fully-built chart specs for them. It works in
 *   two ways. First, a deterministic fallback: if the analysis produced a simple
 *   table (one category-ish column + one numeric measure) and no chart was made
 *   yet, it builds one sensible chart with plain code — no LLM — so the user is
 *   never left chart-less. Second, an LLM path: it shows the model the question,
 *   the available columns, a sample of the result rows, and the draft answer, and
 *   asks it to propose up to N more charts that genuinely support the answer.
 *   Either way, every proposal is validated (columns must exist, the chart type
 *   must fit the data), compiled, given smart axis scaling, and packaged with its
 *   data so the client can draw it directly. Picking the chart TYPE and AXES from
 *   the actual schema (never hardcoded column names) is the whole point — it works
 *   for any uploaded dataset.
 *
 * WHY IT MATTERS
 *   Charts and dashboards are first-class outputs of this product. This module is
 *   what turns a text answer into a visual one, and what powers "dashboard mode"
 *   (when the user asked for a dashboard, it allows more charts spanning
 *   complementary angles — trend, segmentation, drivers). Without it, the agent
 *   would return prose with at most whatever a single tool happened to chart.
 *
 * KEY PIECES
 *   - proposeAndBuildExtraCharts(...) — the only public function. Runs the
 *     deterministic fallback first, then the LLM proposal, and returns
 *     { charts, note? } ready for the UI.
 *   - chartProposalSchema / visualPlannerOutputSchema / VisualPlannerOutput —
 *     zod schemas + type for what the LLM is allowed to emit.
 *   - SYSTEM — the LLM instructions (rules: use real column names only, line/area
 *     for time axes, cap series cardinality, prefer aggregated result columns).
 *   - validateChartProposal — re-exported guard that a proposed chart is buildable.
 *
 * HOW IT CONNECTS
 *   Calls the LLM via completeJson (./llmJson.js) under the VISUAL_PLANNER
 *   purpose. Validates proposals with ./chartProposalValidation.js, compiles
 *   specs with ../../chartSpecCompiler.js, shapes row data with
 *   ../../chartGenerator.js, computes axis ranges with ../../axisScaling.js, and
 *   picks time / metric axes with ../../periodColumnResolver.js and
 *   ../../factsMetricResolver.js (mirroring the chart-promotion path so the two
 *   paths agree). Output chart specs are validated against the shared
 *   chartSpecSchema (../../../shared/schema.js).
 */
import { z } from "zod";
import type { AgentExecutionContext } from "./types.js";
import { completeJson } from "./llmJson.js";
import { LLM_PURPOSE } from "./llmCallPurpose.js";
import { chartSpecSchema } from "../../../shared/schema.js";
import { processChartData } from "../../chartGenerator.js";
import { compileChartSpec } from "../../chartSpecCompiler.js";
import { finishChartSpec } from "../../chartSpecFinish.js";
import { bucketContinuousXForSpec } from "../../continuousDimensionBucket.js";
import type { ChartSpec } from "../../../shared/schema.js";
import { validateChartProposal, chartRowsForProposal } from "./chartProposalValidation.js";
import { buildChartFromAnalyticalTable } from "./chartFromTable.js";
import {
  resolveTrendGrain,
  buildDateRangeByColumn,
} from "../../temporalGrainAuthority.js";
import {
  parseTemporalFacetDisplayKey,
  isTemporalFacetColumnKey,
  facetColumnKey,
  parseRowDate,
} from "../../temporalFacetColumns.js";
import { normalizeDateToPeriod } from "../../dateUtils.js";

export { validateChartProposal } from "./chartProposalValidation.js";

const chartProposalSchema = z.object({
  type: z.enum(["line", "bar", "scatter", "pie", "area", "heatmap"]),
  x: z.string(),
  y: z.string(),
  z: z.string().optional(),
  seriesColumn: z.string().optional(),
  title: z.string().optional(),
  rationale: z.string().optional(),
});

const visualPlannerOutputSchema = z.object({
  addCharts: z.array(chartProposalSchema).max(8),
  narrativeNote: z.string().optional(),
});

export type VisualPlannerOutput = z.infer<typeof visualPlannerOutputSchema>;

const SYSTEM = `You are a visualization advisor. Given the user question, column list, analytical snippet, and (when present) the final answer draft, propose at most \`maxCharts\` charts (see input) that support that answer. \`maxCharts\` reflects how much breadth the request and data warrant: when it is large the user wants a broad dashboard — span complementary angles (e.g. trend, segmentation, drivers/outliers) rather than repeating the same metric; when it is small, propose only the most decision-relevant view(s). Use the full budget when distinct, non-redundant angles exist.

Rules:
- Use ONLY exact column names from AVAILABLE_COLUMNS and/or ANALYTICAL_RESULT_COLUMNS when the latter is present.
- If ANALYTICAL_RESULT_COLUMNS is present, prefer charting those columns (aggregated metrics, bucket labels). Do not revert to raw grain metrics (e.g. per-order Sales) when the analytical frame already has sums or aliases unless necessary.
- **MANDATORY**: ALWAYS use type 'line' or 'area' when X is a date column, month, quarter, year, or any temporal bucket label (patterns like “Month · ...”, “Quarter · ...”, “Year · ...”). NEVER use 'bar' for time-series trends — bar charts imply category rankings, not temporal progression. This rule has no exceptions.
- If dateColumns contains the proposed X and the analytical table has **more than ~50 rows**, do **not** add a second **bar** on that date X; use **line/area** or skip the extra chart if it duplicates the primary trend.
- If no useful pair exists, return {“addCharts”:[]}.
- When ANALYTICAL_RESULT_COLUMNS list **multiple categorical dimensions** plus a measure, prefer **bar** (or line/area for time-like X) so the server can bind a breakdown; you may omit \`seriesColumn\`—the chart compiler will bind a second dimension from the result rows.
- **Series cardinality**: only propose seriesColumn when the column has ≤15 distinct values. For high-cardinality columns (states, customers, SKUs), use a single-series bar chart sorted by y (top N items) instead of multi-series.
Output JSON only matching the schema.`;

/**
 * If `x` is a temporal axis, ensure it uses the span-appropriate grain via the
 * single grain authority — derived from the RAW frame (which carries every
 * materialized facet) NOT from an already-aggregated analytical table, because
 * aggregation is destructive: a `Month · Date`-grouped table can never recover
 * daily detail, and `chartRowsForProposal` serves an LLM-proposed `Month · Date`
 * straight from the raw frame where it re-collapses to one bucket. When the
 * authority picks a different (finer, non-collapsing) facet, we return it AND the
 * raw frame so the chart is rebuilt at that grain. Non-temporal axes pass through.
 */
export function refineTemporalAxis(
  ctx: AgentExecutionContext,
  x: string,
  fallbackRows: Record<string, unknown>[],
  fallbackUseAnalyticalOnly: boolean,
): {
  x: string;
  rows: Record<string, unknown>[];
  useAnalyticalOnly: boolean;
  axisReason?: string;
} {
  const passthrough = {
    x,
    rows: fallbackRows,
    useAnalyticalOnly: fallbackUseAnalyticalOnly,
  };
  const parsed = parseTemporalFacetDisplayKey(x);
  const isRawDate = ctx.summary.dateColumns.includes(x);
  if (!parsed && !isRawDate) return passthrough;

  const rawFrame = (ctx.turnStartDataRef ?? ctx.data) as
    | Record<string, unknown>[]
    | undefined;
  if (!rawFrame?.length) return passthrough;

  // Constrain the authority to the SAME source column the proposal intended, so a
  // multi-date-column dataset doesn't silently switch axes to a different source.
  const wantSource = parsed?.sourceColumn ?? (isRawDate ? x : null);
  const available = ctx.summary.columns
    .map((c) => c.name)
    .filter((n) => {
      if (!wantSource) return true;
      const p = parseTemporalFacetDisplayKey(n);
      return p ? p.sourceColumn === wantSource : n === wantSource;
    });

  const decision = resolveTrendGrain({
    availableColumns: available,
    dateColumns: ctx.summary.dateColumns,
    dateRangeByColumn: buildDateRangeByColumn(ctx.summary),
    question: ctx.question,
    sample: rawFrame.slice(0, 200),
    isDashboard: ctx.analysisBrief?.requestsDashboard === true,
    allowSingleBucket: true,
  });

  if (!decision.facetColumn || decision.facetColumn === x) return passthrough;

  // Authority chose a finer, non-collapsing facet → rebuild from the raw frame,
  // which carries that facet with real (e.g. daily) buckets.
  return {
    x: decision.facetColumn,
    rows: rawFrame,
    useAnalyticalOnly: false,
    axisReason: decision.reason,
  };
}

/**
 * Deterministic single-chart fallback. When the turn produced an analytical
 * result table but no chart yet, build ONE sensible chart from that table with
 * plain code — no LLM — so the user is never left chart-less.
 *
 * This delegates the ENTIRE column-split → x-pick → measure-pick → type →
 * compile → finish flow to the SAME `buildChartFromAnalyticalTable` the
 * chart-promotion path (agentLoop) uses, so the two deterministic paths can
 * never produce different charts from the same `lastAnalyticalTable`. The only
 * extra step is the ctx-aware `validateChartProposal` guard the fallback has
 * always applied (the promotion path runs that guard separately in agentLoop).
 *
 * Returns `null` to mean "no deterministic chart — let the LLM proposer try"
 * (empty/too-many rows, no usable dimension, scalar frame, too many X labels,
 * compile failure, or the proposal guard rejects it). Returns `{ charts, note }`
 * when a chart was built. A `minimal` depth ask is then short-circuited to
 * `{ charts: [] }` by the caller's depth gate, so a plain lookup still gets at
 * most this one chart and never an LLM-padded plethora.
 */
export function buildDeterministicFallbackChart(
  ctx: AgentExecutionContext,
  existingCharts: ChartSpec[]
): { charts: ChartSpec[]; note: string } | null {
  if (existingCharts.length !== 0) return null;
  const table = ctx.lastAnalyticalTable;
  if (!table?.rows?.length) return null;

  const spec = buildChartFromAnalyticalTable({
    table: { rows: table.rows, columns: table.columns ?? [] },
    summary: ctx.summary,
    question: ctx.question,
  });
  if (!spec) return null;

  // Re-apply the ctx-aware proposal guard (columns exist on the analytical
  // frame / dataset summary + y is numeric). On failure, fall through to the
  // LLM proposer rather than ship a chart the validator can't confirm.
  if (
    !validateChartProposal(ctx, {
      x: spec.x,
      y: spec.y,
      type: spec.type,
      z: spec.z,
      seriesColumn: spec.seriesColumn,
    })
  ) {
    return null;
  }

  return {
    charts: [spec],
    note: `Deterministic chart fallback for breakdown: ${spec.title}`,
  };
}

/** Coarser-than-daily companion grains, in order, with a span-gate threshold. */
const TREND_COMPANION_GRAINS: ReadonlyArray<{
  grain: "week" | "month";
  /** Build only when the daily points span MORE than this many buckets. */
  minBuckets: number;
}> = [
  { grain: "week", minBuckets: 2 }, // >2 weeks of data
  { grain: "month", minBuckets: 2 }, // >2 months of data
];

/**
 * For a TREND question, build the SAME-MEASURE trend re-aggregated at coarser
 * grains (Day → Week → Month) — and nothing else. This is the deterministic
 * answer to "a pointed daily-trend ask should NOT fan out into cross-dimension
 * breakdowns or a different metric" (plan Wave 2). It REPLACES the LLM proposer
 * for trend turns.
 *
 * Self-contained + exact: it re-buckets the primary chart's OWN already-daily
 * data points (so it needs no raw-frame column lookup and never trips over an
 * analytical alias like `Total_Visited_OLs_sum` that isn't in the raw frame),
 * mirroring the primary's aggregate (sum/count summed; mean averaged). Restricted
 * to a daily-grain primary so the x values parse cleanly as calendar dates.
 *
 * Span gate: a coarser grain is emitted only when the data spans MORE than 2 of
 * its buckets (>2 weeks → weekly; >2 months → monthly) — exactly the user's rule.
 */
export function buildTrendTemporalCompanions(
  ctx: AgentExecutionContext,
  existingCharts: ChartSpec[]
): ChartSpec[] {
  // 1. Find the primary daily-temporal chart to coarsen.
  const primary = existingCharts.find((c) => {
    if (!Array.isArray(c.data) || c.data.length === 0) return false;
    const parsed = parseTemporalFacetDisplayKey(c.x);
    if (parsed) return parsed.grain === "date";
    return ctx.summary.dateColumns.includes(c.x); // a raw date column ⇒ daily
  });
  if (!primary?.y || !Array.isArray(primary.data)) return [];

  const parsedX = parseTemporalFacetDisplayKey(primary.x);
  const sourceColumn = parsedX?.sourceColumn ?? primary.x;
  const y = primary.y;
  const agg = primary.aggregate ?? "sum";

  const out: ChartSpec[] = [];
  for (const { grain, minBuckets } of TREND_COMPANION_GRAINS) {
    const facetX = facetColumnKey(sourceColumn, grain);
    if (existingCharts.some((c) => c.x === facetX && c.y === y)) continue;

    // Re-bucket the daily points into this grain.
    const period = grain; // "week" | "month" are valid DatePeriod values
    const sums = new Map<string, { label: string; total: number; n: number }>();
    for (const row of primary.data) {
      const d = parseRowDate((row as Record<string, unknown>)[primary.x]);
      if (!d) continue;
      const raw = (row as Record<string, unknown>)[y];
      const v = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(v)) continue;
      const norm = normalizeDateToPeriod(d, period);
      if (!norm) continue;
      const cur = sums.get(norm.normalizedKey);
      if (cur) {
        cur.total += v;
        cur.n += 1;
      } else {
        sums.set(norm.normalizedKey, { label: norm.displayLabel, total: v, n: 1 });
      }
    }
    if (sums.size <= minBuckets) continue; // span gate

    const rows = [...sums.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, b]) => ({
        [facetX]: b.label,
        [y]: agg === "mean" ? b.total / b.n : b.total,
      }));

    try {
      const spec = chartSpecSchema.parse({
        type: "line",
        title: `${y} by ${facetX}`,
        x: facetX,
        y,
        aggregate: agg,
        _useAnalyticalDataOnly: true as const,
      });
      out.push(finishChartSpec(spec, rows));
    } catch {
      /* skip invalid */
    }
  }
  return out;
}

export async function proposeAndBuildExtraCharts(
  ctx: AgentExecutionContext,
  observationsText: string,
  turnId: string,
  onLlmCall: () => void,
  existingCharts: ChartSpec[],
  synthesizedAnswerPreview?: string
): Promise<{ charts: ChartSpec[]; note?: string }> {
  // When the user explicitly asked for a dashboard, allow up to 8 extra
  // complementary charts (the output schema's hard max) so the dashboard can
  // span the brief's segmentationDimensions ∪ candidateDriverDimensions. This
  // is a SUPPLEMENT to the deterministic feature sweep (the per-dimension
  // breadth engine) and to the data-driven featured-chart count on the
  // Executive Summary sheet — not the cap the user ultimately sees. For plain
  // analytical answers keep the original 2-chart cap to control latency.
  const dashboardMode = ctx.analysisBrief?.requestsDashboard === true;
  const ceiling = dashboardMode ? 8 : 2;
  const envCap = parseInt(
    process.env.AGENT_MAX_EXTRA_CHARTS_PER_TURN || String(ceiling),
    10
  ) || ceiling;
  const maxExtra = Math.max(0, Math.min(ceiling, envCap));
  if (maxExtra === 0 || ctx.mode !== "analysis") {
    return { charts: [] };
  }

  // Deterministic fallback: for simple breakdown frames (one categorical-ish
  // dimension + one numeric measure), build ONE chart when no chart was produced
  // yet — delegating to the SAME `buildChartFromAnalyticalTable` the
  // chart-promotion path uses (so the two paths can't drift) plus the ctx-aware
  // proposal guard. This prevents the UX failure mode where the LLM returns
  // {"addCharts": []}. Returns null → fall through to the LLM proposer.
  const deterministic = buildDeterministicFallbackChart(ctx, existingCharts);

  // Trend questions get a DETERMINISTIC, span-gated set of same-measure coarser-
  // grain companions (Day → Week → Month) — and nothing else — instead of the
  // LLM proposer, which drifts into cross-dimension breakdowns or a different
  // metric. This is the positive half of the "pointed trend ask → pointed
  // answer" fix (the feature-sweep gate in agentLoop is the negative half).
  // Minimal depth still gets at most the single fallback chart below.
  if (ctx.depthBudget !== "minimal" && ctx.queryIntent?.signals?.trend === true) {
    const seed = deterministic
      ? [...existingCharts, ...deterministic.charts]
      : existingCharts;
    const companions = buildTrendTemporalCompanions(ctx, seed);
    const charts = deterministic
      ? [...deterministic.charts, ...companions]
      : companions;
    return { charts, ...(deterministic ? { note: deterministic.note } : {}) };
  }

  if (deterministic) return deterministic;

  // Depth-budget gate (query-intent authority). A plain lookup / direct-factual
  // ask warrants NO speculative EXTRA charts. The deterministic single-chart
  // fallback above already visualised the answer frame when there was no chart
  // yet; asking the LLM for 1–2 more is exactly the "plethora" a simple question
  // should not get. Diagnostic/strategic/descriptive turns are unaffected.
  if (ctx.depthBudget === "minimal") {
    return { charts: [] };
  }

  const cols = ctx.summary.columns.map((c) => `${c.name} (${c.type})`).join(", ");
  const existing = existingCharts.map((c) => `${c.type}:${c.x}/${c.y}`).join("; ") || "(none)";
  const analyticalCols = ctx.lastAnalyticalTable?.columns?.length
    ? ctx.lastAnalyticalTable.columns.join(", ")
    : undefined;
  const analyticalSample =
    ctx.lastAnalyticalTable?.rows?.length ?
      JSON.stringify(ctx.lastAnalyticalTable.rows.slice(0, 5)).slice(0, 4000)
    : undefined;

  const user = JSON.stringify({
    question: ctx.question,
    AVAILABLE_COLUMNS: cols,
    ANALYTICAL_RESULT_COLUMNS: analyticalCols,
    ANALYTICAL_RESULT_ROW_SAMPLE: analyticalSample,
    numericColumns: ctx.summary.numericColumns,
    dateColumns: ctx.summary.dateColumns,
    analyticalSnippet: observationsText.slice(0, 6000),
    finalAnswerPreview: (synthesizedAnswerPreview || "").slice(0, 4000),
    alreadyHaveCharts: existing,
    maxCharts: maxExtra,
  });

  const out = await completeJson(SYSTEM, user, visualPlannerOutputSchema, {
    turnId: `${turnId}_visual`,
    maxTokens: 600,
    temperature: 0.25,
    onLlmCall,
    purpose: LLM_PURPOSE.VISUAL_PLANNER,
  });

  if (!out.ok) {
    return { charts: [] };
  }

  const built: ChartSpec[] = [];
  for (const p of out.data.addCharts.slice(0, maxExtra)) {
    if (!validateChartProposal(ctx, p)) continue;
    if (existingCharts.some((c) => c.x === p.x && c.y === p.y && c.type === p.type)) continue;
    const base = chartRowsForProposal(ctx, p);
    // Span-aware grain: if the LLM proposed a temporal axis (e.g. "Month · Date"),
    // refine it to the span-appropriate, non-collapsing facet via the central
    // authority and build from the RAW frame — otherwise a single month of daily
    // data re-collapses to one Month point (the reported bug).
    const refined = refineTemporalAxis(ctx, p.x, base.rows, base.useAnalyticalOnly);
    const rowSource = refined.rows;
    const useAnalyticalOnly = refined.useAnalyticalOnly;
    const { merged: mp } = compileChartSpec(
      rowSource as Record<string, unknown>[],
      {
        numericColumns: ctx.summary.numericColumns,
        dateColumns: ctx.summary.dateColumns,
      },
      {
        type: p.type,
        x: refined.x,
        y: p.y,
        z: p.z,
        seriesColumn: p.seriesColumn,
      },
      {
        columnOrder:
          refined.x === p.x ? (ctx.lastAnalyticalTable?.columns ?? null) : null,
      }
    );

    if (
      !validateChartProposal(ctx, {
        x: mp.x,
        y: mp.y,
        type: mp.type,
        z: mp.z,
        seriesColumn: mp.seriesColumn,
      })
    ) {
      continue;
    }

    const xIsDate =
      ctx.summary.dateColumns.some((d) => d === mp.x) ||
      isTemporalFacetColumnKey(mp.x);
    if (mp.type === "bar" && xIsDate && rowSource.length > 50) {
      continue;
    }
    try {
      const manyRows = rowSource.length > 50;
      const aggregateTimeSeries =
        (mp.type === "line" || mp.type === "area") && xIsDate && manyRows ?
          ("sum" as const)
        : undefined;
      const baseAgg =
        mp.seriesColumn && (mp.type === "bar" || mp.type === "line" || mp.type === "area")
          ? (mp.aggregate ?? "sum")
          : mp.type === "heatmap"
            ? (mp.aggregate ?? "sum")
            : (mp.aggregate ?? "none");
      const spec = chartSpecSchema.parse({
        type: mp.type,
        // When the grain was refined the LLM's title (which names the old grain)
        // would be misleading, so regenerate it to name the actual axis.
        title:
          (refined.x === p.x ? p.title : undefined) ||
          (mp.type === "heatmap" && mp.z
            ? `${mp.z} (${mp.x} × ${mp.y})`
            : `${mp.y} by ${mp.x}`),
        x: mp.x,
        y: mp.y,
        ...(mp.z ? { z: mp.z } : {}),
        ...(mp.seriesColumn
          ? { seriesColumn: mp.seriesColumn, barLayout: mp.barLayout ?? ("stacked" as const) }
          : {}),
        aggregate: aggregateTimeSeries ?? baseAgg,
        ...(refined.axisReason ? { axisReason: refined.axisReason } : {}),
        ...(useAnalyticalOnly ? { _useAnalyticalDataOnly: true as const } : {}),
      });
      // Bin continuous time dimensions (Clock-In Time, Working Hrs) so a bar keyed on a
      // per-second column shows hour-of-day / duration ranges, not one bar per value.
      // No-op for any non-continuous x. See docs/conventions/continuous-dimension-bucketing.md.
      let chartRows = rowSource as Record<string, any>[];
      if (spec.type === "bar") {
        const b = bucketContinuousXForSpec(chartRows, spec, ctx.summary);
        chartRows = b.rows as Record<string, any>[];
        if (b.axisReason && !spec.axisReason) spec.axisReason = b.axisReason;
      }
      const processed = processChartData(chartRows, spec, ctx.summary.dateColumns, {
        chartQuestion: ctx.question,
      });
      built.push(finishChartSpec(spec, processed));
    } catch {
      /* skip invalid */
    }
  }

  return {
    charts: built,
    note: out.data.narrativeNote,
  };
}
