/**
 * ============================================================================
 * computeGrowthTool.ts — the "compute_growth" tool (period-over-period change)
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Defines the tool that measures how a metric changed over time. It computes
 *   period-over-period growth at a chosen "grain":
 *     • YoY  = Year-over-Year (this Jan vs last Jan)
 *     • QoQ  = Quarter-over-Quarter
 *     • MoM  = Month-over-Month
 *     • WoW  = Week-over-Week
 *     • auto = pick the right one from how much history the data covers.
 *   For each period it finds the matching prior period, then reports the
 *   value, the prior value, the percentage change (growth_pct), and the
 *   absolute change (growth_abs).
 *
 *   Three output modes:
 *     • "series"       — one row per (dimension, period) with its growth.
 *     • "summary"      — one row per period, no dimension breakdown.
 *     • "rankByGrowth" — the fastest-growing (or biggest-declining) N
 *       dimension values; this is the "which market grew fastest?" path.
 *
 * WHY IT MATTERS
 *   "Is it up or down, and by how much vs last year?" is one of the most
 *   common business questions. Doing the prior-period matching correctly (and
 *   choosing the right grain) is fiddly, so the agent delegates it here rather
 *   than eyeballing a table.
 *
 * KEY PIECES
 *   - computeGrowthArgsSchema — Zod schema for the tool arguments (metric,
 *     optional dimension, date/period columns, grain, period kind, mode, topN,
 *     aggregation, filters).
 *   - registerComputeGrowthTool — registers the tool as "compute_growth".
 *   - computeGrowthInMemory — the JavaScript fallback that aggregates by
 *     (dimension, period) and pairs each period to its prior.
 *   - detectTemporalCoverage / inferGrainFromKind — helpers that look at the
 *     data to decide a sensible default grain.
 *   - summarizeRanked / summarizeSeries — write the short human-readable result.
 *
 * HOW IT CONNECTS
 *   Registered into the ToolRegistry (../toolRegistry.js).
 *   Two execution paths:
 *     • Preferred: DuckDB (a fast in-process SQL engine). When columnar
 *       storage is active, SQL from ../../../growth/buildGrowthSql.js runs
 *       against the session's data table (or the filtered view when an active
 *       filter is set) via ColumnarStorageService (../../../columnarStorage.js)
 *       and resolveSessionDataTable (../../../activeFilter/...).
 *     • Fallback: in-memory, using priorPeriodKey/chooseAutoGrain from
 *       ../../../growth/periodShift.js.
 *
 * WIDE-FORMAT AWARENESS
 *   "Wide format" = a dataset where time periods are spread across columns and
 *   a single "Metric" column names what each Value row measures. For these,
 *   periodIsoColumn defaults to the detected wide-format period column. On
 *   "compound" wide-format data, if the caller hasn't pinned a single Metric
 *   (via a filter or groupBy), the tool refuses — summing Value across mixed
 *   metrics produces nonsense. The planner normally injects that guard; this
 *   is a second line of defense.
 */
import { z } from "zod";
import type { ToolRegistry } from "../toolRegistry.js";
import type { ToolResult } from "../toolRegistry.js";
import {
  ColumnarStorageService,
  isDuckDBAvailable,
} from "../../../columnarStorage.js";
import { resolveSessionDataTable } from "../../../activeFilter/resolveSessionDataTable.js";
import {
  buildGrowthSql,
  type BuildGrowthSqlInput,
} from "../../../growth/buildGrowthSql.js";
import {
  priorPeriodKey,
  chooseAutoGrain,
  type GrowthGrain,
} from "../../../growth/periodShift.js";
import { linearTrend } from "../../../growth/linearTrend.js";
import {
  isTemporalFacetColumnKey,
  parseTemporalFacetDisplayKey,
} from "../../../temporalFacetColumns.js";
import { distinctBucketsForGrain } from "../../../queryPlanTemporalPatch.js";
import type { DimensionFilter } from "../../../../shared/queryTypes.js";
import { agentLog } from "../agentLogger.js";

const dimensionFilterSchema = z
  .object({
    column: z.string(),
    op: z.enum(["in", "not_in"]),
    values: z.array(z.string()),
    match: z.enum(["exact", "case_insensitive", "contains"]).optional(),
  })
  .strict();

export const computeGrowthArgsSchema = z
  .object({
    metricColumn: z.string(),
    dimensionColumn: z.string().optional(),
    /** Raw timestamp / date column (used when periodIsoColumn is absent). */
    dateColumn: z.string().optional(),
    /** Pre-bucketed canonical period column (e.g. PeriodIso, temporal facet). */
    periodIsoColumn: z.string().optional(),
    grain: z.enum(["yoy", "qoq", "mom", "wow", "auto"]).default("auto"),
    /** Underlying period kind — drives YoY LAG offset (12 / 4 / 52 / 1). */
    periodKind: z.enum(["month", "quarter", "week", "year"]).optional(),
    mode: z.enum(["series", "summary", "rankByGrowth", "trend"]).default("series"),
    topN: z.number().int().min(2).max(50).optional(),
    aggregation: z.enum(["sum", "avg", "min", "max"]).optional(),
    dimensionFilters: z.array(dimensionFilterSchema).max(12).optional(),
  })
  .strict();

type ComputeGrowthArgs = z.infer<typeof computeGrowthArgsSchema>;

interface GrowthRow {
  dimension?: string;
  period: string;
  value: number | null;
  prior_value: number | null;
  growth_pct: number | null;
  growth_abs: number | null;
}

function detectTemporalCoverage(
  rows: Array<Record<string, unknown>>,
  periodCol: string
): {
  distinctYears: number;
  distinctQuartersInOneYear: number;
  distinctMonthsInOneYear: number;
  weekly: boolean;
} {
  const periods = new Set<string>();
  for (const r of rows) {
    const v = r[periodCol];
    if (v !== null && v !== undefined && v !== "") periods.add(String(v));
  }
  const arr = [...periods];
  const years = new Set<string>();
  const quartersByYear: Record<string, Set<string>> = {};
  const monthsByYear: Record<string, Set<string>> = {};
  let weekly = false;
  for (const p of arr) {
    const year = p.match(/^(\d{4})/)?.[1];
    if (year) years.add(year);
    if (/^\d{4}-Q[1-4]$/.test(p)) {
      const y = p.slice(0, 4);
      quartersByYear[y] ??= new Set();
      quartersByYear[y].add(p);
    } else if (/^\d{4}-\d{2}$/.test(p)) {
      const y = p.slice(0, 4);
      monthsByYear[y] ??= new Set();
      monthsByYear[y].add(p);
    } else if (/^\d{4}-W\d{2}$/.test(p)) {
      weekly = true;
    }
  }
  const maxQ = Math.max(0, ...Object.values(quartersByYear).map((s) => s.size));
  const maxM = Math.max(0, ...Object.values(monthsByYear).map((s) => s.size));
  return {
    distinctYears: years.size,
    distinctQuartersInOneYear: maxQ,
    distinctMonthsInOneYear: maxM,
    weekly,
  };
}

function inferGrainFromKind(kind: string | undefined): GrowthGrain {
  if (kind === "quarter") return "yoy";
  if (kind === "month") return "yoy";
  if (kind === "week") return "yoy";
  if (kind === "year") return "yoy";
  return "yoy";
}

function summarizeRanked(rows: GrowthRow[], grain: GrowthGrain): string {
  if (rows.length === 0) return "compute_growth (rankByGrowth): no rows had a prior-period pair.";
  const top = rows[0]!;
  const bottom = rows[rows.length - 1]!;
  const fmtPct = (v: number | null) =>
    v === null ? "n/a" : `${(v * 100).toFixed(1)}%`;
  const lines = [
    `compute_growth (rankByGrowth, ${grain.toUpperCase()}): ${rows.length} segment(s) ranked by growth.`,
    `Top: ${top.dimension} @ ${top.period} → ${fmtPct(top.growth_pct)} (vs ${fmtPct(0)} baseline)`,
    `Bottom: ${bottom.dimension} @ ${bottom.period} → ${fmtPct(bottom.growth_pct)}`,
  ];
  return lines.join("\n");
}

function summarizeSeries(rows: GrowthRow[], grain: GrowthGrain, mode: string): string {
  const nonNull = rows.filter((r) => r.growth_pct !== null);
  if (nonNull.length === 0) {
    // No CALENDAR prior period exists (e.g. a single contiguous span). This is
    // NOT a missing time series — the ordered periods are still a describable
    // trajectory. Scope the limitation narrowly to the calendar comparison so
    // the narrator describes the within-window trend instead of refusing.
    const priorLabel = grain === "yoy" ? "year" : "period";
    const cmpLabel = grain === "yoy" ? "year-over-year" : "period-over-period";
    return `compute_growth (${mode}, ${grain.toUpperCase()}): ${rows.length} ordered period(s) present, but no prior-${priorLabel} calendar pair to compare against — a ${grain.toUpperCase()} change cannot be computed. This is NOT a lack of a time series: the ${rows.length} periods form an ordered within-window trajectory that can be described (direction, start-to-end change, peak/trough). Describe that within-window trend; only the ${cmpLabel} comparison is unavailable.`;
  }
  const sample = nonNull.slice(0, 4).map((r) => {
    const dim = r.dimension ? `${r.dimension} ` : "";
    const pct = r.growth_pct === null ? "n/a" : `${(r.growth_pct * 100).toFixed(1)}%`;
    return `${dim}${r.period}: ${pct}`;
  });
  return `compute_growth (${mode}, ${grain.toUpperCase()}): ${rows.length} period(s), ${nonNull.length} with growth pairs. Sample: ${sample.join(" · ")}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Intra-span TREND (sequential) path. Instead of pairing each period to a
// calendar prior, it sorts the distinct periods and compares each to its
// immediate predecessor, then describes the overall trajectory (direction,
// start→end change, peak/trough, slope/R²). Answers "how has X trended over
// time" for a single contiguous span (daily / weekly / irregular) where
// calendar period-over-period growth is undefined.
// ─────────────────────────────────────────────────────────────────────────

interface TrajectorySummary {
  nPeriods: number;
  startPeriod: string;
  startValue: number;
  endPeriod: string;
  endValue: number;
  pctChangeStartToEnd: number | null;
  absChangeStartToEnd: number;
  peakPeriod: string;
  peakValue: number;
  troughPeriod: string;
  troughValue: number;
  slope: number;
  r2: number;
  direction: "rising" | "falling" | "flat";
}

function distinctPeriodCount(rows: GrowthRow[]): number {
  const s = new Set<string>();
  for (const r of rows) {
    if (r.period !== null && r.period !== undefined && String(r.period) !== "")
      s.add(String(r.period));
  }
  return s.size;
}

function fmtNum(v: number): string {
  const rounded = Math.round(v * 100) / 100;
  return rounded.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * Re-aggregate row-level data to one total per period, sort chronologically
 * (ISO labels sort lexicographically == chronologically, matching DuckDB's
 * VARCHAR ORDER BY), and emit consecutive (lag-1) deltas. Returns the same
 * GrowthRow shape as summary mode so charts/tables keep working.
 */
function computeTrendRowsInMemory(
  rows: Array<Record<string, unknown>>,
  args: ComputeGrowthArgs,
  periodCol: string
): GrowthRow[] {
  const filtered = applyDimensionFiltersInMemory(rows, args.dimensionFilters);
  const periodTotals = new Map<string, number>();
  for (const r of filtered) {
    const period = r[periodCol];
    if (period === null || period === undefined || period === "") continue;
    const v = Number(r[args.metricColumn]);
    if (!Number.isFinite(v)) continue;
    const key = String(period);
    periodTotals.set(key, (periodTotals.get(key) ?? 0) + v);
  }
  const periods = [...periodTotals.keys()].sort();
  const out: GrowthRow[] = [];
  for (let i = 0; i < periods.length; i++) {
    const p = periods[i]!;
    const value = periodTotals.get(p)!;
    const prior = i > 0 ? periodTotals.get(periods[i - 1]!)! : null;
    out.push({
      period: p,
      value,
      prior_value: prior,
      growth_pct: prior === null || prior === 0 ? null : (value - prior) / prior,
      growth_abs: prior === null ? null : value - prior,
    });
  }
  return out;
}

/** Build a trajectory descriptor from summary-shaped rows sorted ascending by period. */
function computeTrajectory(rows: GrowthRow[]): TrajectorySummary | null {
  if (rows.length < 2) return null;
  const values = rows.map((r) => Number(r.value ?? 0));
  const start = rows[0]!;
  const end = rows[rows.length - 1]!;
  const startValue = Number(start.value ?? 0);
  const endValue = Number(end.value ?? 0);
  let peakIdx = 0;
  let troughIdx = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i]! > values[peakIdx]!) peakIdx = i;
    if (values[i]! < values[troughIdx]!) troughIdx = i;
  }
  const { slope, r2 } = linearTrend(values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const totalDrift = Math.abs(slope) * (values.length - 1);
  const direction: "rising" | "falling" | "flat" =
    totalDrift / (Math.abs(mean) || 1) < 0.01
      ? "flat"
      : slope > 0
        ? "rising"
        : "falling";
  return {
    nPeriods: rows.length,
    startPeriod: start.period,
    startValue,
    endPeriod: end.period,
    endValue,
    pctChangeStartToEnd: startValue === 0 ? null : (endValue - startValue) / startValue,
    absChangeStartToEnd: endValue - startValue,
    peakPeriod: rows[peakIdx]!.period,
    peakValue: values[peakIdx]!,
    troughPeriod: rows[troughIdx]!.period,
    troughValue: values[troughIdx]!,
    slope,
    r2,
    direction,
  };
}

/** Human-readable trajectory summary — the string the narrator reads. Never refuses. */
function summarizeTrend(t: TrajectorySummary, metric: string, auto: boolean): string {
  const verb =
    t.direction === "rising" ? "rose" : t.direction === "falling" ? "fell" : "held roughly flat";
  const pct = t.pctChangeStartToEnd === null ? "n/a" : `${(t.pctChangeStartToEnd * 100).toFixed(1)}%`;
  const tag = auto ? "trend, auto" : "trend";
  const change =
    t.direction === "flat"
      ? `${verb} across ${t.nPeriods} periods (start ${fmtNum(t.startValue)}, end ${fmtNum(
          t.endValue
        )}; ${pct})`
      : `${verb} ~${pct} across ${t.nPeriods} periods, from ${t.startPeriod} (${fmtNum(
          t.startValue
        )}) to ${t.endPeriod} (${fmtNum(t.endValue)})`;
  // Note: the "R²=" and "n=" tokens below are intentionally in the grader's
  // parseable form (narratorHintsBlock.extractFindingEvidence) so the trend
  // finding is tiered on its actual fit/sample rather than defaulting to the
  // "no evidence → medium" hedge.
  return `compute_growth (${tag}): ${metric} ${change}. Peak ${t.peakPeriod} (${fmtNum(
    t.peakValue
  )}), trough ${t.troughPeriod} (${fmtNum(t.troughValue)}). Linear fit slope ${
    t.slope >= 0 ? "+" : ""
  }${fmtNum(t.slope)}/period, R²=${t.r2.toFixed(2)} over n=${t.nPeriods} points (${t.direction}).`;
}

/** Assemble the ToolResult for a trend computation (explicit mode OR auto-fallback). */
function buildTrendResult(
  rows: GrowthRow[],
  opts: { metric: string; grain: GrowthGrain; periodKind: string; explicit: boolean }
): ToolResult {
  const columns = ["period", "value", "prior_value", "growth_pct", "growth_abs"];
  const traj = computeTrajectory(rows);
  if (!traj) {
    const only = rows[0];
    return {
      ok: true,
      summary: `compute_growth (trend): ${opts.metric} — single period${
        only ? ` ${only.period}` : ""
      } present; need ≥2 periods to describe a trajectory.`,
      table: { rows, columns, rowCount: rows.length },
      memorySlots: {
        growth_mode: "trend",
        growth_grain: opts.grain,
        growth_period_kind: opts.periodKind,
        growth_n_periods: String(rows.length),
      },
    };
  }
  return {
    ok: true,
    summary: summarizeTrend(traj, opts.metric, !opts.explicit),
    numericPayload: JSON.stringify(rows.slice(0, 200), null, 2).slice(0, 8000),
    table: { rows, columns, rowCount: rows.length },
    memorySlots: {
      growth_grain: opts.grain,
      growth_mode: "trend",
      growth_period_kind: opts.periodKind,
      growth_direction: traj.direction,
      growth_start_to_end_pct:
        traj.pctChangeStartToEnd === null
          ? "n/a"
          : `${(traj.pctChangeStartToEnd * 100).toFixed(1)}%`,
      growth_slope: traj.slope.toFixed(4),
      growth_trend_r2: traj.r2.toFixed(3),
      growth_n_periods: String(traj.nPeriods),
      growth_peak_period: traj.peakPeriod,
      growth_trough_period: traj.troughPeriod,
    },
  };
}

// In-memory fallback: aggregates rows by (dimension, period), then pairs
// each period to its prior via `priorPeriodKey`. Supports all three modes.
function computeGrowthInMemory(
  rows: Array<Record<string, unknown>>,
  args: ComputeGrowthArgs,
  effectiveGrain: GrowthGrain,
  periodCol: string
): GrowthRow[] {
  const filtered = applyDimensionFiltersInMemory(rows, args.dimensionFilters);
  // Aggregate by (dimension?, period).
  const buckets = new Map<string, { dimension?: string; period: string; sum: number }>();
  for (const r of filtered) {
    const period = r[periodCol];
    if (period === null || period === undefined || period === "") continue;
    const periodStr = String(period);
    const dim = args.dimensionColumn
      ? r[args.dimensionColumn] === null || r[args.dimensionColumn] === undefined
        ? "(null)"
        : String(r[args.dimensionColumn])
      : undefined;
    const v = Number(r[args.metricColumn]);
    if (!Number.isFinite(v)) continue;
    const key = `${dim ?? "_"}__${periodStr}`;
    const cur = buckets.get(key);
    if (cur) cur.sum += v;
    else buckets.set(key, { dimension: dim, period: periodStr, sum: v });
  }

  // Build a (dimension, period) → value lookup so prior_value pairs work.
  const valueByKey = new Map<string, number>();
  for (const b of buckets.values()) {
    valueByKey.set(`${b.dimension ?? "_"}__${b.period}`, b.sum);
  }

  const out: GrowthRow[] = [];
  for (const b of buckets.values()) {
    const priorPeriod = priorPeriodKey(b.period, effectiveGrain);
    const priorVal = priorPeriod
      ? valueByKey.get(`${b.dimension ?? "_"}__${priorPeriod}`) ?? null
      : null;
    const growthPct =
      priorVal === null || priorVal === undefined || priorVal === 0
        ? null
        : (b.sum - priorVal) / priorVal;
    const growthAbs = priorVal === null || priorVal === undefined ? null : b.sum - priorVal;
    out.push({
      dimension: b.dimension,
      period: b.period,
      value: b.sum,
      prior_value: priorVal,
      growth_pct: growthPct,
      growth_abs: growthAbs,
    });
  }

  if (args.mode === "rankByGrowth") {
    // Latest period per dimension — pick the maximum period string per dim.
    const latestByDim = new Map<string, GrowthRow>();
    for (const r of out) {
      if (r.prior_value === null || r.prior_value === 0) continue;
      const dim = r.dimension ?? "_";
      const cur = latestByDim.get(dim);
      if (!cur || r.period > cur.period) latestByDim.set(dim, r);
    }
    const ranked = [...latestByDim.values()].sort(
      (a, b) => (b.growth_pct ?? -Infinity) - (a.growth_pct ?? -Infinity)
    );
    return ranked.slice(0, Math.max(2, Math.min(50, args.topN ?? 10)));
  }

  if (args.mode === "summary") {
    // Re-aggregate without dimension.
    const periodTotals = new Map<string, number>();
    for (const r of filtered) {
      const period = r[periodCol];
      if (period === null || period === undefined || period === "") continue;
      const v = Number(r[args.metricColumn]);
      if (!Number.isFinite(v)) continue;
      periodTotals.set(String(period), (periodTotals.get(String(period)) ?? 0) + v);
    }
    const periods = [...periodTotals.keys()].sort();
    return periods.map((p) => {
      const value = periodTotals.get(p)!;
      const prior = priorPeriodKey(p, effectiveGrain);
      const priorVal = prior ? periodTotals.get(prior) ?? null : null;
      return {
        period: p,
        value,
        prior_value: priorVal,
        growth_pct:
          priorVal === null || priorVal === 0 ? null : (value - priorVal) / priorVal,
        growth_abs: priorVal === null ? null : value - priorVal,
      };
    });
  }

  // series — sort by (dimension, period)
  out.sort((a, b) => {
    const da = a.dimension ?? "";
    const db = b.dimension ?? "";
    if (da !== db) return da < db ? -1 : 1;
    return a.period < b.period ? -1 : 1;
  });
  return out;
}

function applyDimensionFiltersInMemory(
  rows: Array<Record<string, unknown>>,
  filters: DimensionFilter[] | undefined
): Array<Record<string, unknown>> {
  if (!filters || filters.length === 0) return rows;
  return rows.filter((r) => {
    for (const f of filters) {
      const raw = r[f.column];
      const cell = raw === null || raw === undefined ? "" : String(raw);
      const cmp =
        f.match === "case_insensitive"
          ? cell.toLowerCase()
          : cell;
      const set = new Set(
        f.values.map((v) =>
          f.match === "case_insensitive" ? String(v).toLowerCase() : String(v)
        )
      );
      const inList = set.has(cmp);
      if (f.op === "in" && !inList) return false;
      if (f.op === "not_in" && inList) return false;
    }
    return true;
  });
}

export function registerComputeGrowthTool(registry: ToolRegistry) {
  registry.register(
    "compute_growth",
    computeGrowthArgsSchema as unknown as z.ZodType<Record<string, unknown>>,
    async (ctx, raw): Promise<ToolResult> => {
      const args = computeGrowthArgsSchema.parse(raw) as ComputeGrowthArgs;
      const summary = ctx.exec.summary;

      // Resolve the period column. Wide-format → PeriodIso. Otherwise the
      // caller's explicit periodIsoColumn or dateColumn.
      const wft = summary.wideFormatTransform;
      let periodIsoColumn =
        args.periodIsoColumn ??
        (wft?.detected ? wft.periodIsoColumn : undefined);
      let dateColumn =
        args.dateColumn ??
        (summary.dateColumns && summary.dateColumns[0]) ??
        undefined;

      // T4 guard (defense-in-depth): if a hand-crafted step passed a temporal
      // FACET (e.g. "Month · Date") as the period axis and that grain collapses
      // to a single bucket over the data's span, prefer the raw daily source
      // axis so the trend has ≥2 points. Wide-format PeriodIso is NOT a facet
      // (isTemporalFacetColumnKey → false) and is never touched here.
      if (periodIsoColumn && isTemporalFacetColumnKey(periodIsoColumn)) {
        const parsed = parseTemporalFacetDisplayKey(periodIsoColumn);
        const srcRange = parsed
          ? summary.columns.find((c) => c.name === parsed.sourceColumn)?.dateRange
          : undefined;
        if (parsed && srcRange && distinctBucketsForGrain(srcRange, parsed.grain) < 2) {
          periodIsoColumn = undefined;
          dateColumn = parsed.sourceColumn;
        }
      }

      if (!periodIsoColumn && !dateColumn) {
        return {
          ok: false,
          summary:
            "compute_growth: no period column found. Pass periodIsoColumn (preferred) or dateColumn, or upload a dataset with a recognised date axis.",
        };
      }

      // Validate column membership against schema (defensive — planner repair
      // already runs, but tools should never trust args blindly).
      const allow = new Set(summary.columns.map((c) => c.name));
      for (const col of [
        args.metricColumn,
        args.dimensionColumn,
        periodIsoColumn,
        dateColumn,
      ]) {
        if (col && !allow.has(col)) {
          return {
            ok: false,
            summary: `compute_growth: column not in schema: ${col}`,
          };
        }
      }

      // Compound-shape Metric guard (defense-in-depth — planner should have
      // already injected this).
      if (
        wft?.detected &&
        wft.shape === "compound" &&
        wft.metricColumn &&
        args.metricColumn === wft.valueColumn
      ) {
        const filters = args.dimensionFilters ?? [];
        const hasMetricFilter = filters.some((f) => f.column === wft.metricColumn);
        const inGroupBy = args.dimensionColumn === wft.metricColumn;
        if (!hasMetricFilter && !inGroupBy) {
          return {
            ok: false,
            summary: `compute_growth: compound-shape dataset — supply a Metric filter (e.g. dimensionFilters: [{column: "${wft.metricColumn}", op: "in", values: ["Value Sales"]}]) or set dimensionColumn to "${wft.metricColumn}" to break out by metric. Without one, summing Value across mixed metrics produces nonsense.`,
          };
        }
      }

      // Resolve grain.
      const dataRef = ctx.exec.data;
      const periodColForCoverage = periodIsoColumn ?? dateColumn!;
      const coverage = detectTemporalCoverage(dataRef, periodColForCoverage);
      const effectiveGrain: GrowthGrain =
        args.grain === "auto" ? chooseAutoGrain(coverage) : args.grain;

      // Infer periodKind when the caller didn't supply it. The wide-format
      // ISO labels carry the kind unambiguously in their prefix.
      let periodKind = args.periodKind;
      if (!periodKind) {
        if (coverage.weekly) periodKind = "week";
        else if (coverage.distinctMonthsInOneYear >= 3 && coverage.distinctQuartersInOneYear < 4)
          periodKind = "month";
        else if (coverage.distinctQuartersInOneYear >= 1) periodKind = "quarter";
        else periodKind = "year";
      }

      // ────────────────────────────────────────────────────────────
      // Try DuckDB path (preferred — full-dataset, fast LAG, honors
      // active filter via the data_filtered view).
      // ────────────────────────────────────────────────────────────
      if (
        ctx.exec.columnarStoragePath &&
        ctx.exec.sessionId &&
        isDuckDBAvailable()
      ) {
        const storage = new ColumnarStorageService({ sessionId: ctx.exec.sessionId });
        try {
          await storage.initialize();
          await storage.assertTableExists("data");
          const tableName = ctx.exec.chatDocument
            ? await resolveSessionDataTable(storage, {
                sessionId: ctx.exec.sessionId,
                activeFilter: ctx.exec.chatDocument.activeFilter,
              })
            : "data";

          const isTrend = args.mode === "trend";
          // Trend maps to the summary-shaped SQL with a forced consecutive lag;
          // the narrowing here also satisfies BuildGrowthSqlInput["mode"].
          const sqlMode: BuildGrowthSqlInput["mode"] =
            args.mode === "trend" ? "summary" : args.mode;
          const buildInput: BuildGrowthSqlInput = {
            tableName,
            metricColumn: args.metricColumn,
            // Trend is a total trajectory — drop the dimension breakdown.
            dimensionColumn: isTrend ? undefined : args.dimensionColumn,
            periodIsoColumn,
            dateColumn,
            grain: effectiveGrain,
            periodKind,
            mode: sqlMode,
            forceConsecutiveLag: isTrend,
            topN: args.topN,
            aggregation: args.aggregation,
            dimensionFilters: args.dimensionFilters,
          };
          const built = buildGrowthSql(buildInput);
          const rows = (await storage.executeQuery<GrowthRow>(built.sql)) ?? [];

          // Explicit trend mode → describe the trajectory.
          if (isTrend) {
            agentLog("compute_growth_duckdb_trend", {
              sessionId: ctx.exec.sessionId,
              grain: effectiveGrain,
              kind: periodKind,
              rowCount: rows.length,
            });
            return buildTrendResult(rows, {
              metric: args.metricColumn,
              grain: effectiveGrain,
              periodKind,
              explicit: true,
            });
          }

          // Auto-fallback: calendar pairing found zero pairs but ≥2 ordered
          // periods exist → describe the within-window trajectory instead of
          // returning the defeatist "no prior-period pairs" string.
          if (
            (args.mode === "summary" || args.mode === "series") &&
            rows.filter((r) => r.growth_pct !== null).length === 0 &&
            distinctPeriodCount(rows) >= 2
          ) {
            const trendBuilt = buildGrowthSql({
              ...buildInput,
              dimensionColumn: undefined,
              mode: "summary",
              forceConsecutiveLag: true,
            });
            const trendRows = (await storage.executeQuery<GrowthRow>(trendBuilt.sql)) ?? [];
            if (distinctPeriodCount(trendRows) >= 2) {
              agentLog("compute_growth_duckdb_trend_fallback", {
                sessionId: ctx.exec.sessionId,
                grain: effectiveGrain,
                kind: periodKind,
                rowCount: trendRows.length,
              });
              return buildTrendResult(trendRows, {
                metric: args.metricColumn,
                grain: effectiveGrain,
                periodKind,
                explicit: false,
              });
            }
          }

          const summaryStr =
            args.mode === "rankByGrowth"
              ? summarizeRanked(rows, effectiveGrain)
              : summarizeSeries(rows, effectiveGrain, args.mode);

          // Top finder for memorySlots (helps planner / narrator chain).
          const ranked = rows.filter((r) => r.growth_pct !== null);
          const topGrower = ranked[0];

          agentLog("compute_growth_duckdb", {
            sessionId: ctx.exec.sessionId,
            mode: args.mode,
            grain: effectiveGrain,
            kind: periodKind,
            rowCount: rows.length,
            lag: built.lagOffset,
          });

          return {
            ok: true,
            summary: summaryStr,
            numericPayload: JSON.stringify(rows.slice(0, 200), null, 2).slice(0, 8000),
            table: { rows, columns: built.columns, rowCount: rows.length },
            memorySlots: {
              growth_grain: effectiveGrain,
              growth_mode: args.mode,
              growth_period_kind: periodKind,
              growth_row_count: String(rows.length),
              ...(topGrower
                ? {
                    growth_top_dimension: String(topGrower.dimension ?? ""),
                    growth_top_pct:
                      topGrower.growth_pct === null
                        ? "n/a"
                        : `${(topGrower.growth_pct * 100).toFixed(1)}%`,
                  }
                : {}),
            },
          };
        } catch (e) {
          agentLog("compute_growth_duckdb_fallback", {
            sessionId: ctx.exec.sessionId,
            error: e instanceof Error ? e.message.slice(0, 400) : String(e),
          });
          // Fall through to in-memory path.
        } finally {
          await storage.close().catch(() => {
            /* ignore */
          });
        }
      }

      // ────────────────────────────────────────────────────────────
      // In-memory fallback. Honors dimensionFilters and computes
      // prior-period pairs via priorPeriodKey.
      // ────────────────────────────────────────────────────────────
      if (!dataRef || dataRef.length === 0) {
        return {
          ok: false,
          summary:
            "compute_growth: no row-level data is available and DuckDB session table is unreachable.",
        };
      }
      const periodCol = periodIsoColumn ?? dateColumn!;
      if (!periodCol) {
        return {
          ok: false,
          summary: "compute_growth: no period column resolved.",
        };
      }
      // Explicit trend mode → sequential trajectory over the available span.
      if (args.mode === "trend") {
        const trendRows = computeTrendRowsInMemory(dataRef, args, periodCol);
        agentLog("compute_growth_in_memory_trend", {
          sessionId: ctx.exec.sessionId,
          grain: effectiveGrain,
          kind: periodKind,
          rowCount: trendRows.length,
        });
        return buildTrendResult(trendRows, {
          metric: args.metricColumn,
          grain: effectiveGrain,
          periodKind,
          explicit: true,
        });
      }

      const rows = computeGrowthInMemory(dataRef, args, effectiveGrain, periodCol);

      // Auto-fallback: zero calendar pairs but ≥2 ordered periods → trajectory.
      if (
        (args.mode === "summary" || args.mode === "series") &&
        rows.filter((r) => r.growth_pct !== null).length === 0 &&
        distinctPeriodCount(rows) >= 2
      ) {
        const trendRows = computeTrendRowsInMemory(dataRef, args, periodCol);
        if (distinctPeriodCount(trendRows) >= 2) {
          agentLog("compute_growth_in_memory_trend_fallback", {
            sessionId: ctx.exec.sessionId,
            grain: effectiveGrain,
            kind: periodKind,
            rowCount: trendRows.length,
          });
          return buildTrendResult(trendRows, {
            metric: args.metricColumn,
            grain: effectiveGrain,
            periodKind,
            explicit: false,
          });
        }
      }

      const summaryStr =
        args.mode === "rankByGrowth"
          ? summarizeRanked(rows, effectiveGrain)
          : summarizeSeries(rows, effectiveGrain, args.mode);
      const topGrower = rows.filter((r) => r.growth_pct !== null)[0];

      agentLog("compute_growth_in_memory", {
        sessionId: ctx.exec.sessionId,
        mode: args.mode,
        grain: effectiveGrain,
        kind: periodKind,
        rowCount: rows.length,
      });

      return {
        ok: true,
        summary: summaryStr,
        numericPayload: JSON.stringify(rows.slice(0, 200), null, 2).slice(0, 8000),
        table: {
          rows,
          columns: ["dimension", "period", "value", "prior_value", "growth_pct", "growth_abs"],
          rowCount: rows.length,
        },
        memorySlots: {
          growth_grain: effectiveGrain,
          growth_mode: args.mode,
          growth_period_kind: periodKind,
          growth_row_count: String(rows.length),
          ...(topGrower
            ? {
                growth_top_dimension: String(topGrower.dimension ?? ""),
                growth_top_pct:
                  topGrower.growth_pct === null
                    ? "n/a"
                    : `${(topGrower.growth_pct * 100).toFixed(1)}%`,
              }
            : {}),
        },
      };
    },
    {
      description:
        "Period-over-period growth analysis (YoY/QoQ/MoM/WoW). Four modes: 'series' (one row per dim×period with growth_pct + prior_value), 'summary' (one row per period, no dimension), 'rankByGrowth' (fastest-growing N dimension values — use this for 'fastest growing market' / 'biggest decliner' questions), 'trend' (intra-span trajectory: sorts the periods, compares each to its immediate predecessor, and reports direction/start-to-end change/peak/trough/slope+R² — use this for 'how has X trended over time' on a SINGLE contiguous span such as daily rows within one month, where there is no prior-year period to compare against). Pick grain by temporal coverage: multi-year → yoy; single year multi-quarter → qoq; single year multi-month → mom; weekly → wow; single contiguous span → trend; uncertain → 'auto'. When a 'series'/'summary' call finds no calendar prior-period pairs but ≥2 ordered periods exist, the tool auto-falls-back to the trajectory so it never refuses a within-window trend. Wide-format datasets get PeriodIso for the period axis automatically. PREFER this over breakdown_ranking for any question about growth, change-over-time, or trend deltas.",
      argsHelp:
        '{"metricColumn": string (required), "dimensionColumn"?: string (required for rankByGrowth), "dateColumn"?: string, "periodIsoColumn"?: string (preferred — wide-format PeriodIso or temporal facet), "grain": "yoy"|"qoq"|"mom"|"wow"|"auto" (default "auto"), "periodKind"?: "month"|"quarter"|"week"|"year" (drives YoY LAG offset), "mode": "series"|"summary"|"rankByGrowth"|"trend" (default "series"; "trend" = intra-span trajectory for a single contiguous span), "topN"?: number (rankByGrowth only, 2–50, default 10), "aggregation"?: "sum"|"avg"|"min"|"max" (default sum), "dimensionFilters"?: [{column, op:"in"|"not_in", values:[...], match?:"case_insensitive"}]}',
    }
  );
}
