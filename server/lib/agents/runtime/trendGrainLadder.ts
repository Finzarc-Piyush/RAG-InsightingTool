/**
 * ============================================================================
 * trendGrainLadder.ts — render the anchor metric's trend at a LADDER of grains
 * ============================================================================
 * WHAT THIS DOES
 *   A dashboard (or an un-pinned trend ask) should not show the anchor metric's
 *   trend at a single, often-degenerate grain (a 1-bucket monthly line on a
 *   month of data). It should show a short LADDER — e.g. a month of data →
 *   weekly + daily; a year of data → quarterly + monthly. The grains come from
 *   the ONE authority (`resolveTrendGrainLadder`, temporalGrainAuthority.ts);
 *   this module turns that grain list into chart specs and swaps them in for any
 *   existing single-grain trend of the same metric.
 *
 * WHY A POST-MERGE PASS
 *   The anchor trend can be built by several engines (per-step promotion, the
 *   visual planner, the dashboard feature sweep / coverage gate). Running once
 *   over the FINAL merged chart list — just before dedupe/cap — is the only
 *   place that sees them all, so we can REPLACE whatever single grain they
 *   produced with the ladder (this is what drops a lone weekly line on a full
 *   year, or the useless 1-bucket monthly).
 *
 * ROBUSTNESS
 *   Built from the RAW frame (not by re-parsing a chart's bucket labels) so it
 *   works for both numeric measures (sum / per-period mean for rate-shaped
 *   names) and Yes/No boolean indicators (per-period rate = positives / valid,
 *   honouring the indicator's applicability scope). No dependency on whether the
 *   temporal facet columns were materialized on the rows.
 *
 * GATING (invariant #12 / L-032)
 *   Only for dashboards or an explicit trend ask, never a `minimal`-depth
 *   lookup, and never when the user PINNED a grain ("daily chart" → one daily
 *   chart). Applies to the ANCHOR metric only — a bounded 1–3 trend tiles, not a
 *   per-metric × per-grain fan-out.
 */
import type { AgentExecutionContext } from "./types.js";
import type { ChartSpec } from "../../../shared/schema.js";
import { chartSpecSchema } from "../../../shared/schema.js";
import { finishChartSpec } from "../../chartSpecFinish.js";
import {
  resolveTrendGrainLadder,
  buildDateRangeByColumn,
  deriveDateRangeFromRows,
  type DateRange,
} from "../../temporalGrainAuthority.js";
import {
  facetColumnKey,
  parseTemporalFacetDisplayKey,
  isTemporalFacetColumnKey,
  parseRowDate,
  detectCoarseTimeIntentFromMessage,
  GRAIN_TO_PERIOD,
  type TemporalFacetGrain,
} from "../../temporalFacetColumns.js";
import { normalizeDateToPeriod } from "../../dateUtils.js";
import {
  collectBooleanIndicators,
  type BooleanIndicator,
} from "./booleanIndicatorRateRepair.js";

/** Rate-shaped numeric names average per period; count-like names sum. Same
 *  vocabulary the feature sweep uses for its per-period aggregate. */
const RATE_NAME_RX =
  /\b(rate|adher|adherence|compliance|pct|percent|percentage|ratio|share|score|index)\b/i;

const norm = (s: string): string => s.replace(/[\s_-]+/g, "").toLowerCase();

/** Is `chart` a temporal trend of the anchor metric (any grain)? Lenient on the
 *  y so a computed alias ("PJP_Adherence_rate") still matches its indicator. */
function isAnchorTrendChart(
  chart: ChartSpec,
  anchor: string,
  dateColumns: readonly string[]
): boolean {
  const x = chart.x;
  const isTemporalX =
    isTemporalFacetColumnKey(x) || dateColumns.includes(x);
  if (!isTemporalX) return false;
  const y = chart.y;
  if (!y) return false;
  const a = norm(anchor);
  const ny = norm(y);
  return ny === a || ny.startsWith(a) || ny.includes(a);
}

/** The metric the ladder is about: the dashboard outcome, else the dominant y
 *  among existing temporal trend charts. */
function resolveAnchorMetric(
  ctx: AgentExecutionContext,
  charts: ChartSpec[]
): string | null {
  const outcome = ctx.analysisBrief?.outcomeMetricColumn?.trim();
  if (outcome) return outcome;
  const dateCols = ctx.summary.dateColumns ?? [];
  const tally = new Map<string, number>();
  for (const c of charts) {
    const x = c.x;
    const temporal = isTemporalFacetColumnKey(x) || dateCols.includes(x);
    if (!temporal || !c.y) continue;
    tally.set(c.y, (tally.get(c.y) ?? 0) + 1);
  }
  if (tally.size === 0) return null;
  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

/** The raw source date column to bucket on: the source of an existing anchor
 *  trend chart, else the first declared date column. */
function resolveSourceDateColumn(
  ctx: AgentExecutionContext,
  charts: ChartSpec[],
  anchor: string
): string | null {
  for (const c of charts) {
    if (!isAnchorTrendChart(c, anchor, ctx.summary.dateColumns)) continue;
    const parsed = parseTemporalFacetDisplayKey(c.x);
    return parsed?.sourceColumn ?? c.x;
  }
  return ctx.summary.dateColumns?.[0] ?? null;
}

function rangeForColumn(
  ctx: AgentExecutionContext,
  rawRows: Record<string, unknown>[],
  dateCol: string
): DateRange | null {
  const fromSummary = buildDateRangeByColumn(ctx.summary).get(dateCol);
  if (fromSummary) return fromSummary;
  return deriveDateRangeFromRows(rawRows, dateCol) ?? null;
}

/** Row passes the indicator's valid-measurement universe (applicability gates). */
function passesScope(
  ind: BooleanIndicator,
  row: Record<string, unknown>
): boolean {
  for (const g of ind.applicabilityScope ?? []) {
    const v = row[g.gateColumn];
    const sv = v == null ? "" : String(v).trim();
    if (!g.inScopeValues.includes(sv)) return false;
  }
  return true;
}

/** Build ONE line chart for the anchor at `grain`, bucketing the raw frame. */
function buildAnchorTrendForGrain(
  ctx: AgentExecutionContext,
  rawRows: Record<string, unknown>[],
  dateCol: string,
  anchor: string,
  indicator: BooleanIndicator | undefined,
  isRateNumeric: boolean,
  grain: TemporalFacetGrain
): ChartSpec | null {
  const facetX = facetColumnKey(dateCol, grain);
  const period = GRAIN_TO_PERIOD[grain];
  if (!period) return null;

  type Bucket = { label: string; sortKey: string; num: number; den: number; sum: number; n: number };
  const buckets = new Map<string, Bucket>();
  for (const row of rawRows) {
    const d = parseRowDate(row[dateCol]);
    if (!d) continue;
    const np = normalizeDateToPeriod(d, period);
    if (!np) continue;
    let b = buckets.get(np.normalizedKey);
    if (!b) {
      b = { label: np.displayLabel, sortKey: np.normalizedKey, num: 0, den: 0, sum: 0, n: 0 };
      buckets.set(np.normalizedKey, b);
    }
    if (indicator) {
      if (!passesScope(indicator, row)) continue;
      const raw = row[anchor];
      const v = raw == null ? "" : String(raw).trim();
      if (indicator.sentinels.includes(v)) continue;
      const isPos = indicator.positives.includes(v);
      const isNeg = indicator.negatives.includes(v);
      if (isPos || isNeg) {
        b.den += 1;
        if (isPos) b.num += 1;
      }
    } else {
      const raw = row[anchor];
      const v = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(v)) continue;
      b.sum += v;
      b.n += 1;
    }
  }
  if (buckets.size < 2) return null;

  const rows = [...buckets.values()]
    .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0))
    .map((b) => ({
      [facetX]: b.label,
      [anchor]: indicator
        ? b.den > 0
          ? b.num / b.den
          : 0
        : isRateNumeric
          ? b.n > 0
            ? b.sum / b.n
            : 0
          : b.sum,
    }));

  try {
    const spec = chartSpecSchema.parse({
      type: "line",
      title: `${anchor} by ${facetX}`,
      x: facetX,
      y: anchor,
      aggregate: indicator || isRateNumeric ? "mean" : "sum",
      _useAnalyticalDataOnly: true as const,
    });
    return finishChartSpec(spec, rows);
  } catch {
    return null;
  }
}

/**
 * Replace the anchor metric's single-grain trend with the span-appropriate
 * ladder of trend tiles. Pure: returns a new chart array; does not mutate input.
 * Returns the input unchanged when the gate doesn't apply or no ladder grain is
 * meaningful (the caller keeps whatever single-grain trend already exists).
 */
export function applyTrendGrainLadder(
  ctx: AgentExecutionContext,
  charts: ChartSpec[]
): ChartSpec[] {
  const dashboardMode = ctx.analysisBrief?.requestsDashboard === true;
  const trendSignal = ctx.queryIntent?.signals?.trend === true;
  if (ctx.depthBudget === "minimal") return charts;
  if (!dashboardMode && !trendSignal) return charts;
  // The user PINNED a grain ("daily chart") → respect it, no ladder.
  if (detectCoarseTimeIntentFromMessage(ctx.question)) return charts;

  const anchor = resolveAnchorMetric(ctx, charts);
  if (!anchor) return charts;

  const rawRows = (ctx.turnStartDataRef ?? ctx.data) as
    | Record<string, unknown>[]
    | undefined;
  if (!rawRows?.length) return charts;

  const dateCol = resolveSourceDateColumn(ctx, charts, anchor);
  if (!dateCol) return charts;
  const range = rangeForColumn(ctx, rawRows, dateCol);
  if (!range) return charts;

  const ladder = resolveTrendGrainLadder(range);
  if (ladder.length === 0) return charts;

  const indicator = collectBooleanIndicators(ctx.summary).find(
    (i) => i.name === anchor
  );
  const isNumeric = ctx.summary.numericColumns?.includes(anchor) === true;
  if (!indicator && !isNumeric) return charts; // not chartable as a trend
  const isRateNumeric =
    isNumeric && RATE_NAME_RX.test(anchor.replace(/[_-]+/g, " "));

  const ladderCharts: ChartSpec[] = [];
  for (const grain of ladder) {
    const spec = buildAnchorTrendForGrain(
      ctx,
      rawRows,
      dateCol,
      anchor,
      indicator,
      isRateNumeric,
      grain
    );
    if (spec) ladderCharts.push(spec);
  }
  if (ladderCharts.length === 0) return charts;

  // Drop any existing single-grain trend of the anchor; keep everything else;
  // append the ladder. Downstream finalizeMergedCharts dedupes + caps.
  const kept = charts.filter(
    (c) => !isAnchorTrendChart(c, anchor, ctx.summary.dateColumns)
  );
  return [...kept, ...ladderCharts];
}
