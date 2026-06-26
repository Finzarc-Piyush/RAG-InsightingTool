/**
 * ============================================================================
 * metricComparisonCharts.ts — "anchor vs secondary" grouped comparison tiles
 * ============================================================================
 * WHAT THIS DOES
 *   A dashboard the user framed as "PJP vs attendance" should show the anchor
 *   metric and the named secondary metric SIDE BY SIDE per key dimension
 *   (grouped bars), not as two unrelated standalone charts. This builds those
 *   grouped comparison tiles deterministically.
 *
 * WHY IT'S SAFE (no unsolicited metrics)
 *   The comparison partners are `analysisBrief.outlineMetrics`, which the brief
 *   enrichment (`ensureDashboardOutlineMetrics`) populates with OTHER metrics
 *   ONLY when the user either named them or asked for a broad multi-KPI board. A
 *   pointed "PJP dashboard" has no outline metrics → this produces nothing, so
 *   Compliance never appears here uninvited. Every tile is anchored on the
 *   outcome metric (PJP is always one of the grouped series).
 *
 * SCALE-SAFETY
 *   Only runs when the anchor AND partners are the SAME kind of measure (all
 *   boolean-indicator rates, 0–1) so the grouped bars share one comparable axis.
 *   `ensureDashboardOutlineMetrics` already only seeds indicators for an
 *   indicator outcome, so this holds in practice.
 */
import type { AgentExecutionContext } from "./types.js";
import type { ChartSpec } from "../../../shared/schema.js";
import { chartSpecSchema } from "../../../shared/schema.js";
import { finishChartSpec } from "../../chartSpecFinish.js";
import { processChartData } from "../../chartGenerator.js";
import {
  collectBooleanIndicators,
  type BooleanIndicator,
} from "./booleanIndicatorRateRepair.js";

/** Keep the board legible: at most this many comparison tiles, each with at
 *  most this many series (anchor + N partners). */
const COMPARE_DIMS_CAP = 2;
const MAX_SERIES = 4;
const SERIES_COL = "Metric";
const VALUE_COL = "Rate";
const LOW_CARD_MAX = 12;

function passesScope(ind: BooleanIndicator, row: Record<string, unknown>): boolean {
  for (const g of ind.applicabilityScope ?? []) {
    const v = row[g.gateColumn];
    const sv = v == null ? "" : String(v).trim();
    if (!g.inScopeValues.includes(sv)) return false;
  }
  return true;
}

/** Per-group rate (positives / valid) for a boolean indicator, scoped to its
 *  valid-measurement universe. Returns null groups with no valid measurements. */
function indicatorRateByGroup(
  rows: Record<string, unknown>[],
  ind: BooleanIndicator,
  dim: string
): Map<string, number> {
  const acc = new Map<string, { num: number; den: number }>();
  for (const row of rows) {
    const gv = row[dim];
    if (gv == null || gv === "") continue;
    if (!passesScope(ind, row)) continue;
    const raw = row[ind.name];
    const v = raw == null ? "" : String(raw).trim();
    if (ind.sentinels.includes(v)) continue;
    const isPos = ind.positives.includes(v);
    const isNeg = ind.negatives.includes(v);
    if (!isPos && !isNeg) continue;
    const key = String(gv);
    let a = acc.get(key);
    if (!a) {
      a = { num: 0, den: 0 };
      acc.set(key, a);
    }
    a.den += 1;
    if (isPos) a.num += 1;
  }
  const out = new Map<string, number>();
  for (const [k, a] of acc) if (a.den > 0) out.set(k, a.num / a.den);
  return out;
}

function uniqueCountUpTo(
  rows: Record<string, unknown>[],
  col: string,
  capPlusOne: number
): number {
  const seen = new Set<string>();
  for (const r of rows) {
    const v = r[col];
    if (v == null || v === "") continue;
    seen.add(String(v));
    if (seen.size >= capPlusOne) break;
  }
  return seen.size;
}

/**
 * Build grouped "anchor vs <named secondaries> by <dim>" comparison charts.
 * Pure. Returns [] unless this is a dashboard with both an indicator anchor and
 * at least one indicator partner in `outlineMetrics`.
 */
export function buildAnchorComparisonCharts(
  ctx: AgentExecutionContext
): ChartSpec[] {
  const brief = ctx.analysisBrief;
  if (brief?.requestsDashboard !== true) return [];
  if (ctx.depthBudget === "minimal") return [];

  const anchor = brief.outcomeMetricColumn?.trim();
  if (!anchor) return [];

  const indicators = collectBooleanIndicators(ctx.summary);
  const anchorInd = indicators.find((i) => i.name === anchor);
  if (!anchorInd) return []; // only rate-vs-rate comparisons (shared 0–1 axis)

  const partners = (brief.outlineMetrics ?? [])
    .map((m) => m?.trim())
    .filter((m): m is string => Boolean(m) && m !== anchor)
    .map((m) => indicators.find((i) => i.name === m))
    .filter((i): i is BooleanIndicator => Boolean(i))
    .slice(0, MAX_SERIES - 1);
  if (partners.length === 0) return [];

  const rawRows = (ctx.turnStartDataRef ?? ctx.data) as
    | Record<string, unknown>[]
    | undefined;
  if (!rawRows?.length) return [];

  const colNames = new Set(ctx.summary.columns.map((c) => c.name));
  const dateCols = new Set(ctx.summary.dateColumns ?? []);
  const numericCols = new Set(ctx.summary.numericColumns ?? []);
  const metricNames = new Set([anchor, ...partners.map((p) => p.name)]);

  const dims = (brief.segmentationDimensions ?? [])
    .map((d) => d?.trim())
    .filter(
      (d): d is string =>
        Boolean(d) &&
        colNames.has(d) &&
        !dateCols.has(d) &&
        !numericCols.has(d) &&
        !metricNames.has(d)
    )
    .filter((d) => {
      const n = uniqueCountUpTo(rawRows, d, LOW_CARD_MAX + 1);
      return n >= 2 && n <= LOW_CARD_MAX;
    })
    .slice(0, COMPARE_DIMS_CAP);
  if (dims.length === 0) return [];

  const series = [anchorInd, ...partners];
  const out: ChartSpec[] = [];
  for (const dim of dims) {
    const rateByMetric = series.map((ind) => ({
      name: ind.name,
      rates: indicatorRateByGroup(rawRows, ind, dim),
    }));
    // Long frame: one row per (dim value × metric).
    const groupKeys = new Set<string>();
    for (const m of rateByMetric) for (const k of m.rates.keys()) groupKeys.add(k);
    if (groupKeys.size < 2) continue;
    const longRows: Record<string, unknown>[] = [];
    for (const key of groupKeys) {
      for (const m of rateByMetric) {
        const v = m.rates.get(key);
        if (v === undefined) continue;
        longRows.push({ [dim]: key, [SERIES_COL]: m.name, [VALUE_COL]: v });
      }
    }
    if (longRows.length === 0) continue;

    try {
      const spec = chartSpecSchema.parse({
        type: "bar",
        title: `${[anchor, ...partners.map((p) => p.name)].join(" vs ")} by ${dim}`,
        x: dim,
        y: VALUE_COL,
        seriesColumn: SERIES_COL,
        barLayout: "grouped",
        aggregate: "mean",
      });
      const processed = processChartData(
        longRows as Record<string, any>[],
        spec,
        ctx.summary.dateColumns,
        { chartQuestion: ctx.question }
      );
      out.push(finishChartSpec(spec, processed));
    } catch {
      /* skip invalid */
    }
  }
  return out;
}
