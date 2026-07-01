/**
 * Wave W4 (data-bound cards) · compute a KPI scorecard's SNAPSHOT (current
 * value, prior-period comparison, sparkline, direction-aware tone) from the
 * dataset behind a session. REUSES the compose spine (measure×agg×filter →
 * plan → DuckDB/in-memory) and the temporal-grain authority (period picking).
 *
 * PoP is the default: bucket the measure by the calibrated period grain, take
 * the latest bucket vs the previous. A user-set target switches to vs-target.
 * No temporal column → a single total, no delta.
 */

import type {
  DashboardScorecardSpec,
  DataSummary,
  SemanticModel,
} from "../../shared/schema.js";
import type { ChatDocument } from "../../models/chat.model.js";
import {
  compileCardSpecToPlan,
  runComposePlan,
} from "../dashboardTileCompose.js";
import {
  buildDateRangeByColumn,
  deriveDateRangeFromRows,
  pickTrendGrainForSpan,
  type DateRange,
} from "../temporalGrainAuthority.js";
import { facetColumnKey, type TemporalFacetGrain } from "../temporalFacetColumns.js";
import { MONTH_SHORT_NAMES } from "../dateUtils.js";
import { resolveMetricPolarity, type MetricPolarity } from "../financeMetricAuthority.js";
import {
  resolveTone,
  resolveToneVsTarget,
  type ScorecardTone,
} from "./tone.js";

export interface ComputeScorecardCtx {
  summary: DataSummary;
  sessionId?: string | null;
  chat?: ChatDocument | null;
  model?: SemanticModel | null;
  /** In-memory fallback data loader (DuckDB-unavailable path). */
  loadRows?: () => Promise<Record<string, any>[]>;
  signal?: AbortSignal;
  /** Stamped onto the snapshot for INCREMENTAL_REFRESH staleness. */
  dataVersion?: number;
  /** Injectable clock (defaults to Date.now) so callers/tests stay deterministic. */
  now?: number;
}

export interface ScorecardSnapshot {
  value: number | null;
  priorValue?: number | null;
  deltaAbs?: number | null;
  deltaPct?: number | null;
  targetValue?: number | null;
  tone: ScorecardTone;
  sparkline?: { label: string; value: number | null }[];
  periodLabel?: string;
  computedAt: number;
  dataVersion?: number;
}

const MAX_SPARKLINE_POINTS = 60;

/** Scorecard grains: weekly is snapped to monthly for a cleaner exec cadence. */
type ScorecardGrain = "day" | "month" | "quarter";

/** ScorecardGrain → the facet-layer grain ("date" is the day-level facet). */
function toFacetGrain(g: ScorecardGrain): TemporalFacetGrain {
  return g === "day" ? "date" : g;
}

/**
 * The executor emits a period's DISPLAY label ("Apr 2017", "Q1 2017"), not a
 * lexically-sortable key, and groups in first-seen (not chronological) order.
 * Since we CHOSE the grain, we can parse the label to a chronological ordinal
 * deterministically. Unparseable → 0 (sorts first; degrades, never throws).
 */
function labelToOrdinal(label: string, grain: ScorecardGrain): number {
  if (grain === "quarter") {
    const m = /Q(\d)\s+(\d{4})/.exec(label);
    return m ? Number(m[2]) * 10 + Number(m[1]) : 0;
  }
  if (grain === "month") {
    const m = /([A-Za-z]{3})\s+(\d{4})/.exec(label);
    if (!m) return 0;
    const mi = MONTH_SHORT_NAMES.indexOf(m[1] as (typeof MONTH_SHORT_NAMES)[number]);
    return mi < 0 ? 0 : Number(m[2]) * 100 + (mi + 1);
  }
  // day: "Jan 3, 2017" parses natively.
  const t = Date.parse(label);
  return Number.isFinite(t) ? t : 0;
}

function pickPeriodColumn(
  spec: DashboardScorecardSpec,
  summary: DataSummary
): string | undefined {
  const explicit = spec.cardDefinition.comparison?.periodColumn;
  if (explicit && summary.columns.some((c) => c.name === explicit)) return explicit;
  const dc = summary.dateColumns?.[0];
  if (dc) return dc;
  const sem = summary.columns.find((c) =>
    c.semantics?.semanticType?.startsWith("temporal_")
  );
  return sem?.name;
}

function resolvePeriodRange(
  periodCol: string,
  summary: DataSummary,
  rows?: Record<string, any>[]
): DateRange | undefined {
  const fromSummary = buildDateRangeByColumn(summary).get(periodCol);
  if (fromSummary) return fromSummary;
  if (rows) return deriveDateRangeFromRows(rows, periodCol);
  return undefined;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Compute a scorecard snapshot. Never throws for a data-shape reason — on any
 * degenerate input it returns a neutral, value-null snapshot so the band still
 * renders an honest "—".
 */
export async function computeScorecard(
  spec: DashboardScorecardSpec,
  ctx: ComputeScorecardCtx
): Promise<ScorecardSnapshot> {
  const now = ctx.now ?? Date.now();
  const base = { computedAt: now, dataVersion: ctx.dataVersion } as const;
  const polarity: MetricPolarity =
    spec.metricPolarity ?? resolveMetricPolarity(spec.cardDefinition.measure.ref);

  const compiled = compileCardSpecToPlan(spec.cardDefinition, ctx.summary, ctx.model);
  if (!compiled.ok) {
    return { value: null, tone: "neutral", ...base };
  }
  const { alias, plan } = compiled;

  const mode = spec.cardDefinition.comparison?.mode ?? "period_over_period";
  const target = spec.cardDefinition.comparison?.target;
  const periodCol = mode === "none" ? undefined : pickPeriodColumn(spec, ctx.summary);

  // ── No period axis (or comparison disabled) → single total ────────────────
  if (!periodCol) {
    const res = await runComposePlan({
      sessionId: ctx.sessionId,
      chat: ctx.chat,
      summary: ctx.summary,
      plan,
      loadRows: ctx.loadRows,
      signal: ctx.signal,
    });
    const value = res.ok ? toNum(res.rows[0]?.[alias]) : null;
    if (mode === "vs_target" && typeof target === "number") {
      return {
        value,
        targetValue: target,
        deltaAbs: value == null ? null : value - target,
        deltaPct: value == null || target === 0 ? null : (value - target) / Math.abs(target),
        tone: resolveToneVsTarget(value, target, polarity),
        ...base,
      };
    }
    return { value, tone: "neutral", ...base };
  }

  // ── Period-bucketed series ────────────────────────────────────────────────
  // Derive the calibrated grain, then group the measure by the display facet
  // key (e.g. "Month · Order Date") whose row value is a chronologically
  // sortable normalized key.
  const rangeRows =
    !buildDateRangeByColumn(ctx.summary).has(periodCol) && ctx.loadRows
      ? await ctx.loadRows()
      : undefined;
  const range = resolvePeriodRange(periodCol, ctx.summary, rangeRows);
  const rawGrain = range
    ? pickTrendGrainForSpan(range.spanDays, range.distinctDayCount)
    : "month";
  // Snap weekly → monthly: a monthly sparkline is the natural exec cadence and
  // keeps the point count legible (12 vs 52 over a year).
  const grain: ScorecardGrain = rawGrain === "week" ? "month" : rawGrain;
  const facetKey = facetColumnKey(periodCol, toFacetGrain(grain));

  const periodPlan = { ...plan, groupBy: [facetKey] };
  const res = await runComposePlan({
    sessionId: ctx.sessionId,
    chat: ctx.chat,
    summary: ctx.summary,
    plan: periodPlan,
    loadRows: ctx.loadRows,
    signal: ctx.signal,
  });
  if (!res.ok) {
    return { value: null, tone: "neutral", ...base };
  }

  const series = res.rows
    .map((r) => ({ key: String(r[facetKey] ?? ""), value: toNum(r[alias]) }))
    .filter((s) => s.key !== "")
    .sort((a, b) => labelToOrdinal(a.key, grain) - labelToOrdinal(b.key, grain));

  if (series.length === 0) {
    return { value: null, tone: "neutral", ...base };
  }

  const sparkline = series
    .slice(-MAX_SPARKLINE_POINTS)
    .map((s) => ({ label: s.key, value: s.value }));
  const last = series[series.length - 1]!;
  const value = last.value;

  if (mode === "vs_target" && typeof target === "number") {
    return {
      value,
      targetValue: target,
      deltaAbs: value == null ? null : value - target,
      deltaPct: value == null || target === 0 ? null : (value - target) / Math.abs(target),
      tone: resolveToneVsTarget(value, target, polarity),
      sparkline,
      periodLabel: `${last.key} vs target`,
      ...base,
    };
  }

  // Period-over-period.
  const prev = series.length >= 2 ? series[series.length - 2]! : undefined;
  const priorValue = prev?.value ?? null;
  const deltaAbs =
    value == null || priorValue == null ? null : value - priorValue;
  const deltaPct =
    value == null || priorValue == null || priorValue === 0
      ? null
      : (value - priorValue) / Math.abs(priorValue);
  return {
    value,
    priorValue,
    deltaAbs,
    deltaPct,
    tone: resolveTone(deltaPct, polarity),
    sparkline,
    periodLabel: prev ? `${last.key} vs ${prev.key}` : last.key,
    ...base,
  };
}
