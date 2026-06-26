/**
 * ============================================================================
 * temporalGrainAuthority.ts — THE single decision point for chart time-axis grain
 * ============================================================================
 *
 * WHY THIS EXISTS
 *   Temporal grain ("plot by Day vs Week vs Month vs Quarter ...") used to be
 *   decided independently in at least four places — the planner query patch,
 *   the dashboard feature sweep, periodColumnResolver, and (not at all) the
 *   visual planner's LLM loop. Each re-implemented the span→grain heuristic with
 *   different code AND keyed off the SAME fragile input (`summary.columns[].dateRange`,
 *   an optional field looked up by exact source-column name). When that input was
 *   absent (e.g. the columnar/metadata reload path strips it) every path silently
 *   degraded to the identical Month-first default — so a single month of DAILY data
 *   collapsed to one monthly point, and a fix to any one path never generalized.
 *
 *   This module is the ONE authority all chart-building paths delegate to. It is
 *   pure (no IO, no LLM) and is the SOLE home of the grain-decision primitives
 *   (`pickTrendGrainForSpan`, `distinctBucketsForGrain`, `GRAIN_RANK`,
 *   `DEFAULT_FACET_PREFERENCE`, `PERIOD_TO_FACET_GRAIN`). `queryPlanTemporalPatch.ts`
 *   re-exports the movers for back-compat; new code imports from here.
 *
 * DESIGN INVARIANTS (honoured by `resolveTrendGrain`)
 *   • Canonical keys (L-007): the authority only ever CHOOSES an existing facet
 *     COLUMN NAME (e.g. "Day · Date") — a sortable key, never a formatted label —
 *     and never down-converts a genuinely coarse grain.
 *   • Span-aware (the single-month-daily fix): a ≤90-day span recommends `date`
 *     (daily); the chosen facet is the span-appropriate one when it yields ≥2 buckets.
 *   • Metadata-free robustness: selectability counts MATERIALIZED non-null facet
 *     values in the supplied `sample` rows, so an absent/stripped `dateRange` (or an
 *     all-null coarse facet on quarterly data) can never force a collapsing axis.
 *   • No down-convert (structural): never choose a grain strictly finer than a
 *     coarser grain that yields the SAME bucket count (finer would be fake
 *     resolution) — except when the user EXPLICITLY asked for that grain.
 */

import {
  parseTemporalFacetDisplayKey,
  facetColumnKey,
  detectCoarseTimeIntentFromMessage,
  parseRowDate,
  GRAIN_TO_PERIOD,
  type TemporalFacetGrain,
  type CoarseTimeIntent,
} from "./temporalFacetColumns.js";
import {
  normalizeDateToPeriod,
  newIntradayStats,
  accumulateIntraday,
  intradayResolution,
} from "./dateUtils.js";
import type { DataSummary } from "../shared/schema.js";

// ────────────────────────────────────────────────────────────────────────────
// Span primitives (moved here so the authority is the leaf module; re-exported
// from queryPlanTemporalPatch.ts so existing importers keep working).
// ────────────────────────────────────────────────────────────────────────────

/** Per-source-date-column span metadata (subset produced by `createDataSummary`).
 *  `minIso`/`maxIso` are required to mirror the canonical `dateRange` shape in
 *  `shared/schema.ts` (DataSummary columns) — `deriveDateRangeFromRows` and
 *  `createDataSummary` always emit all four fields when they emit a range at all,
 *  so the two structures stay assignable in both directions. */
export interface DateRange {
  spanDays: number;
  distinctDayCount: number;
  minIso: string;
  maxIso: string;
  /** Wave H1 · 'sub_day' iff the source column carries ≥2 distinct non-midnight
   *  times. The gate every sub-day grain branch checks — pure-daily columns
   *  ('day' or undefined) are never promoted to an hour/minute axis. */
  temporalResolution?: "day" | "sub_day";
  /** Distinct hours (0–23) seen — bounds the `hour_of_day` bucket count. */
  distinctHourCount?: number;
}

export type DateRangeByColumn = ReadonlyMap<string, DateRange>;

/** Coarse→fine ordinal so we only ever refine to / coarsen toward a known rank.
 *  Sub-day grains are FINER than `date` (negative). `hour_of_day` and `day_of_week`
 *  are cyclical — they have a rank for completeness but never participate in the
 *  absolute ladder. */
export const GRAIN_RANK: Record<TemporalFacetGrain, number> = {
  minute: -2,
  hour: -1,
  date: 0,
  week: 1,
  month: 2,
  quarter: 3,
  half_year: 4,
  year: 5,
  hour_of_day: -3,
  day_of_week: -4,
};

/** MATERIALIZED facet grains usable as a TIMELINE trend axis, fine → coarse.
 *  Sub-day grains are intentionally ABSENT (never pre-materialized). `day_of_week`
 *  is materialized but CYCLICAL (Mon…Sun is not a timeline) — also absent here, so
 *  the cardinality/refinement tiers never pick "Day of week · X" as a trend grain. */
const GRAINS_FINE_TO_COARSE: TemporalFacetGrain[] = [
  "date",
  "week",
  "month",
  "quarter",
  "half_year",
  "year",
];

/** Default grain preference when no span/intent applies. Most useful first. */
export const DEFAULT_FACET_PREFERENCE: TemporalFacetGrain[] = [
  "month",
  "quarter",
  "week",
  "year",
  "half_year",
  "date",
];

/** Map `pickTrendGrainForSpan`'s SQL periods to facet grains. */
export const PERIOD_TO_FACET_GRAIN: Record<
  "day" | "week" | "month" | "quarter",
  TemporalFacetGrain
> = { day: "date", week: "week", month: "month", quarter: "quarter" };

/** User-intent coarse grain → facet grain. */
const INTENT_TO_FACET_GRAIN: Record<CoarseTimeIntent, TemporalFacetGrain> = {
  day: "date",
  week: "week",
  month: "month",
  quarter: "quarter",
  half_year: "half_year",
  year: "year",
  hour: "hour",
  hour_of_day: "hour_of_day",
  minute: "minute",
};

/**
 * Pure span → SQL-period picker. ≤90d → day, ≤1y → week, ≤5y → month, else quarter.
 * Returns "month" for a degenerate span (single day / no span) so callers fall
 * through to the cardinality/default branches rather than fabricating a grain.
 */
export function pickTrendGrainForSpan(
  spanDays: number,
  distinctDayCount: number,
): "day" | "week" | "month" | "quarter" {
  if (!Number.isFinite(spanDays) || spanDays <= 0 || distinctDayCount <= 1) {
    return "month";
  }
  if (spanDays <= 90) return "day";
  if (spanDays <= 365) return "week";
  if (spanDays <= 365 * 5) return "month";
  return "quarter";
}

/**
 * How many distinct buckets a grain yields over [minIso, maxIso]. `date` →
 * `distinctDayCount` directly; coarser grains walk the span day-by-day and
 * bucket via `normalizeDateToPeriod` (matching the upload-time facet keys).
 * Returns 1 when the span can't be resolved (the safe "single bucket" answer),
 * bounded so a multi-year span can't dominate planning time.
 */
export function distinctBucketsForGrain(
  range: DateRange,
  grain: TemporalFacetGrain,
): number {
  if (grain === "date") return Math.max(0, range.distinctDayCount ?? 0);
  if (!range.minIso || !range.maxIso) return 1;
  const parse = (iso: string): Date | null => {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const start = parse(range.minIso);
  const end = parse(range.maxIso);
  if (!start || !end || end.getTime() < start.getTime()) return 1;
  const period = GRAIN_TO_PERIOD[grain];
  const keys = new Set<string>();
  const MAX_STEPS = 4000; // ~11 years of daily steps — beyond this any coarse grain clearly has ≥2 buckets.
  let steps = 0;
  const cur = new Date(start.getTime());
  while (cur.getTime() <= end.getTime() && steps < MAX_STEPS) {
    const norm = normalizeDateToPeriod(new Date(cur.getTime()), period);
    if (norm) keys.add(norm.normalizedKey);
    cur.setDate(cur.getDate() + 1);
    steps += 1;
  }
  if (steps >= MAX_STEPS) return Math.max(keys.size, 2);
  return Math.max(1, keys.size);
}

/** A ladder grain must yield at least this many buckets — a 1- or 2-point line
 *  isn't a meaningful trend, and this is also what drops the span-equal coarsest
 *  level (a single month of data → no monthly line; a single year → no yearly). */
export const MIN_LADDER_BUCKETS = 3;
/** …and at most this many — drops over-fine grains (weekly on a year = 52, daily
 *  on a year = 365) while keeping daily-on-a-month (~31) and monthly-on-a-year
 *  (12). The boundary that separates "quarterly + monthly only" (1yr) from the
 *  finer grains. */
export const MAX_LADDER_BUCKETS = 45;
/** Cap on how many grain levels one trend renders — keep the board legible. */
export const LADDER_MAX_LEVELS = 3;

/** The natural reading ladder, FINE→COARSE. `half_year` is deliberately omitted
 *  — year → quarter → month → week → day is how people step through a trend; a
 *  half-year tile in between reads as noise. Sub-day / cyclical grains are out
 *  of scope (the ladder is for calendar spans). */
const LADDER_GRAINS_FINE_TO_COARSE: TemporalFacetGrain[] = [
  "date",
  "week",
  "month",
  "quarter",
  "year",
];

/**
 * The ORDERED set of trend grains to render for a metric over `range`,
 * COARSE→FINE. This is the multi-grain extension of the authority: instead of
 * picking ONE grain (`resolveTrendGrain`), a dashboard / un-pinned trend shows a
 * short ladder so the user can read the same metric at complementary
 * resolutions.
 *
 * Rule (the user's "drop the coarsest 1-bucket level, go up to 3 levels"):
 *   a grain is eligible ⇔ MIN_LADDER_BUCKETS ≤ buckets ≤ MAX_LADDER_BUCKETS;
 *   return the COARSEST eligible grains, capped at LADDER_MAX_LEVELS.
 *
 * Worked examples (the acceptance cases):
 *   • ~1 month of data  → [week, date]      (month/quarter/year collapse to <3;
 *                                            hour/minute aren't materialized)
 *   • ~1 year of data   → [quarter, month]  (year <3; week=52 & day=365 > 45)
 * Returns [] for a degenerate/one-period span — the caller keeps its existing
 * single-grain behaviour (`resolveTrendGrain` with `allowSingleBucket`).
 */
export function resolveTrendGrainLadder(range: DateRange): TemporalFacetGrain[] {
  const eligible: TemporalFacetGrain[] = [];
  for (const g of LADDER_GRAINS_FINE_TO_COARSE) {
    const n = distinctBucketsForGrain(range, g);
    if (n >= MIN_LADDER_BUCKETS && n <= MAX_LADDER_BUCKETS) eligible.push(g);
  }
  // Iterated fine→coarse; reverse to coarse→fine and keep the coarsest (most
  // legible) up to the level cap.
  return eligible.reverse().slice(0, LADDER_MAX_LEVELS);
}

/**
 * Derive a DateRange from actual rows by parsing one date/source column. This is
 * the metadata-free span fallback: even when `dateRange` was stripped (columnar
 * reload) the rows being charted necessarily contain the dates, so the authority
 * never has zero span when there are dated rows. Mirrors the math in
 * `createDataSummary` (fileParser.ts). Returns undefined when no cell parses.
 */
export function deriveDateRangeFromRows(
  rows: readonly Record<string, unknown>[] | undefined,
  col: string,
): DateRange | undefined {
  if (!rows?.length || !col) return undefined;
  // Format day keys from LOCAL components (not toISOString) so they match the
  // canonical facet keys, which `normalizeDateToPeriod` also builds from local
  // Y/M/D. Using UTC here would shift dates across the date line in non-UTC
  // timezones (e.g. IST +05:30: local-midnight Apr-1 → "Mar-31" in UTC),
  // misbucketing month/quarter/year boundaries.
  const dayKey = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = Number.NEGATIVE_INFINITY;
  const distinctDays = new Set<string>();
  const intraday = newIntradayStats();
  for (const row of rows) {
    const v = row?.[col];
    if (v === null || v === undefined || v === "") continue;
    const d = parseRowDate(v);
    if (!d) continue;
    const ms = d.getTime();
    if (ms < minMs) minMs = ms;
    if (ms > maxMs) maxMs = ms;
    distinctDays.add(dayKey(d));
    accumulateIntraday(intraday, d);
  }
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) return undefined;
  const { temporalResolution, distinctHourCount } = intradayResolution(intraday);
  return {
    minIso: dayKey(new Date(minMs)),
    maxIso: dayKey(new Date(maxMs)),
    distinctDayCount: distinctDays.size,
    spanDays: Math.max(0, Math.floor((maxMs - minMs) / 86_400_000)),
    temporalResolution,
    distinctHourCount,
  };
}

/**
 * Build the per-source span map from a DataSummary's column `dateRange` fields.
 * The SINGLE place this map is constructed, so the planner and every chart
 * builder feed `resolveTrendGrain` an identical span input. Columns without a
 * `dateRange` (e.g. the columnar/metadata reload path) are simply absent — the
 * authority's row-derived fallback covers them.
 */
export function buildDateRangeByColumn(summary: DataSummary): Map<string, DateRange> {
  const map = new Map<string, DateRange>();
  for (const col of summary.columns) {
    const r = (col as { dateRange?: DateRange }).dateRange;
    if (r) {
      map.set(col.name, {
        spanDays: r.spanDays,
        distinctDayCount: r.distinctDayCount,
        minIso: r.minIso,
        maxIso: r.maxIso,
        temporalResolution: r.temporalResolution,
        distinctHourCount: r.distinctHourCount,
      });
    }
  }
  return map;
}

// ────────────────────────────────────────────────────────────────────────────
// The authority
// ────────────────────────────────────────────────────────────────────────────

export interface TrendGrainInput {
  /** Column names PRESENT on the table/frame to be charted (display facet keys
   *  like "Month · Date", raw date cols). The authority only ever returns one of these. */
  availableColumns: string[];
  /** Raw date/source columns the dataset declares (summary.dateColumns) — used to
   *  rank candidate source columns and gate the no-temporal-axis case. */
  dateColumns: readonly string[];
  /** Per-source span map (built once per turn). Optional — the authority derives
   *  span from `sample` when a source isn't present here. */
  dateRangeByColumn?: DateRangeByColumn;
  /** The user message — drives explicit-grain intent detection. */
  question?: string;
  /** Sample rows of the frame to be charted. Lets selectability count ACTUAL
   *  materialized buckets and lets span be derived when metadata is absent.
   *  For trend tiles this MUST be the RAW (un-aggregated) frame. */
  sample?: Record<string, unknown>[];
  /** Reserved: dashboards relax some trend-wording gates upstream. */
  isDashboard?: boolean;
  /** When every grain collapses to a single bucket (genuinely one-period data):
   *  true → return the coarsest existing facet so the caller plots one honest
   *  point (+ caveat); false (default) → return no temporal axis so the caller
   *  falls back to a non-temporal dimension. */
  allowSingleBucket?: boolean;
}

export type TrendGrainSource =
  | "intent"
  | "span"
  | "cardinality"
  | "default"
  | "none";

export interface TrendGrainDecision {
  /** The facet/date column to put on the time axis, or null when no temporal axis
   *  is appropriate. Never a collapsing facet when a finer one yields ≥2 buckets. */
  facetColumn: string | null;
  /** The chosen grain, or null when facetColumn is null. */
  grain: TemporalFacetGrain | null;
  /** The source date column the facet derives from (for callers that re-aggregate). */
  sourceColumn: string | null;
  /** Decision provenance for chart subtitle / telemetry. */
  reason: string;
  /** Which branch decided. */
  source: TrendGrainSource;
}

const UNKNOWN = -1;

/** Distinct non-null materialized values of a column in the sample, or UNKNOWN
 *  when no sample is supplied. Bounded so wide frames stay cheap. */
function materializedDistinct(
  col: string,
  sample: readonly Record<string, unknown>[] | undefined,
  cap = 64,
): number {
  if (!sample?.length) return UNKNOWN;
  const seen = new Set<string>();
  for (const row of sample) {
    const v = row?.[col];
    if (v === null || v === undefined || v === "") continue;
    seen.add(String(v));
    if (seen.size >= cap) break;
  }
  return seen.size;
}

/** Alias-tolerant span lookup: exact → case-insensitive → row-derived (source,
 *  then `Cleaned_<source>`). Fixes the exact-name "silent killer" AND the
 *  stripped-metadata reload path in one helper. */
function lookupSpan(
  source: string,
  dateRangeByColumn: DateRangeByColumn | undefined,
  sample: readonly Record<string, unknown>[] | undefined,
): DateRange | undefined {
  if (dateRangeByColumn) {
    const exact = dateRangeByColumn.get(source);
    if (exact) return exact;
    const lower = source.toLowerCase();
    for (const [k, v] of dateRangeByColumn) {
      if (k.toLowerCase() === lower) return v;
    }
  }
  const fromRows = deriveDateRangeFromRows(sample, source);
  if (fromRows && fromRows.distinctDayCount > 0) return fromRows;
  const cleaned = deriveDateRangeFromRows(sample, `Cleaned_${source}`);
  if (cleaned && cleaned.distinctDayCount > 0) return cleaned;
  return undefined;
}

interface SourceContext {
  source: string;
  /** grain → facet column name present on the frame. */
  byGrain: Map<TemporalFacetGrain, string>;
  range: DateRange | undefined;
}

/** Bucket count for a grain: truthful materialized count when sample present,
 *  else span-derived, else UNKNOWN. */
function bucketCount(
  sc: SourceContext,
  grain: TemporalFacetGrain,
  sample: readonly Record<string, unknown>[] | undefined,
): number {
  const col = sc.byGrain.get(grain);
  if (!col) return 0; // facet not present on this frame at all
  const mat = materializedDistinct(col, sample);
  if (mat > 0) return mat; // truthful materialized count
  // mat is 0 (facet NAME present but all-null on the sample) or UNKNOWN (no sample).
  // A 0 must NOT be treated as authoritative when a real date span exists: on the
  // columnar path the facet column is virtual (computed inline at render), so the
  // sampled runtime rows carry the raw date but no materialized "Day · Date" value
  // — counting that as a single bucket is exactly what collapsed single-month daily
  // data to one Month dot. Fall through to the span-derived count, which reads the
  // backfilled/row-derived span off the SOURCE date column. When there is no span
  // (e.g. a quarterly Period label that doesn't parse as a date — L-007), this still
  // returns 0/UNKNOWN, so the materialized-null guard for genuinely fake-finer
  // grains is preserved.
  if (sc.range) return distinctBucketsForGrain(sc.range, grain);
  return mat; // 0 (present, all-null, no span) or UNKNOWN (no sample, no span)
}

const usableCount = (n: number) => n >= 2;

/** Distinct sub-day buckets for a source date column, counted by parsing the
 *  sample (sub-day grains are NEVER materialized, so there's no facet column to
 *  read). Returns UNKNOWN when no sample. hour/minute/hour_of_day map 1:1 onto the
 *  identically-named DatePeriod tokens. */
function countSubDayBucketsInSample(
  source: string,
  grain: "hour" | "minute" | "hour_of_day",
  sample: readonly Record<string, unknown>[] | undefined,
  cap = 256,
): number {
  if (!sample?.length) return UNKNOWN;
  const seen = new Set<string>();
  for (const row of sample) {
    const v = row?.[source];
    if (v === null || v === undefined || v === "") continue;
    const d = parseRowDate(v);
    if (!d) continue;
    const norm = normalizeDateToPeriod(d, grain);
    if (norm) seen.add(norm.normalizedKey);
    if (seen.size >= cap) break;
  }
  return seen.size;
}

/**
 * Resolve the single coherent time-axis facet column for a trend chart.
 *
 * Decision order (first hit wins):
 *   1. INTENT     — explicit user grain ("monthly"/"by week"…) honoured ONLY when
 *                   its facet yields ≥2 buckets (else fall through; preserves the
 *                   prior resolvePeriodAxis behaviour — "monthly" on single-month
 *                   data refines to a finer real trend).
 *   2. SPAN       — pickTrendGrainForSpan(span) facet when it yields ≥2 buckets;
 *                   refine finer if it collapses. This is the single-month-daily → Day rule.
 *   3. CARDINALITY— finest grain with ≥2 buckets that has strictly MORE buckets than
 *                   the next coarser usable grain (real resolution, not fake-finer).
 *   4. DEFAULT    — coarsest existing facet (single honest point) or no temporal axis.
 *
 * The no-down-convert guard (never finer than a coarser grain with the same bucket
 * count) is applied to the SPAN and CARDINALITY branches, never to INTENT.
 */
export function resolveTrendGrain(input: TrendGrainInput): TrendGrainDecision {
  const { availableColumns, dateColumns, dateRangeByColumn, question, sample } =
    input;
  const allowSingleBucket = input.allowSingleBucket ?? false;

  const none = (reason: string): TrendGrainDecision => ({
    facetColumn: null,
    grain: null,
    sourceColumn: null,
    reason,
    source: "none",
  });

  // 1. Enumerate facet candidates present on the frame, grouped by source column.
  const bySourceGrain = new Map<string, Map<TemporalFacetGrain, string>>();
  for (const col of availableColumns) {
    const parsed = parseTemporalFacetDisplayKey(col);
    if (!parsed) continue;
    let m = bySourceGrain.get(parsed.sourceColumn);
    if (!m) {
      m = new Map();
      bySourceGrain.set(parsed.sourceColumn, m);
    }
    if (!m.has(parsed.grain)) m.set(parsed.grain, col);
  }
  if (bySourceGrain.size === 0) {
    return none(
      dateColumns.length
        ? "No materialized temporal facet column present on this frame"
        : "No temporal column",
    );
  }

  // 2. Pick the primary source = the one with the most usable (≥2-bucket) facets;
  //    tie-break by dateColumns order, then declaration order.
  const orderOf = (s: string) => {
    const i = dateColumns.indexOf(s);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  let primary: SourceContext | null = null;
  let primaryScore = -1;
  for (const [source, byGrain] of bySourceGrain) {
    const range = lookupSpan(source, dateRangeByColumn, sample);
    const sc: SourceContext = { source, byGrain, range };
    let score = 0;
    for (const g of byGrain.keys()) {
      if (usableCount(bucketCount(sc, g, sample))) score++;
    }
    const better =
      score > primaryScore ||
      (score === primaryScore &&
        primary !== null &&
        orderOf(source) < orderOf(primary.source));
    if (primary === null || better) {
      primary = sc;
      primaryScore = score;
    }
  }
  const sc = primary!;
  const facetFor = (g: TemporalFacetGrain) => sc.byGrain.get(g);
  const usable = (g: TemporalFacetGrain) =>
    Boolean(facetFor(g)) && usableCount(bucketCount(sc, g, sample));

  const decide = (
    grain: TemporalFacetGrain,
    source: TrendGrainSource,
    reason: string,
  ): TrendGrainDecision => ({
    facetColumn: facetFor(grain)!,
    grain,
    sourceColumn: sc.source,
    reason,
    source,
  });

  // Sub-day machinery (Wave H4). Sub-day grains are never materialized, so the
  // facet column is the INLINE display key ("Hour · <src>") that the chart/executor
  // computes from the source via facetColumnInlineDuckDbExpr / normalizeDateToPeriod.
  // EVERY sub-day branch is gated on `intraday` — a pure-daily column can never get
  // an hour axis (the regression the user flagged).
  const intraday = sc.range?.temporalResolution === "sub_day";
  const multiDay = (sc.range?.distinctDayCount ?? 0) > 1;
  const decideInline = (
    grain: "hour" | "minute" | "hour_of_day",
    source: TrendGrainSource,
    reason: string,
  ): TrendGrainDecision => ({
    facetColumn: facetColumnKey(sc.source, grain),
    grain,
    sourceColumn: sc.source,
    reason,
    source,
  });
  const subDayUsable = (grain: "hour" | "minute" | "hour_of_day") =>
    usableCount(countSubDayBucketsInSample(sc.source, grain, sample));

  // 1. INTENT
  const intent = question ? detectCoarseTimeIntentFromMessage(question) : null;
  if (intent) {
    let ig = INTENT_TO_FACET_GRAIN[intent];
    if (ig === "hour" || ig === "minute" || ig === "hour_of_day") {
      // Sub-day intent honored ONLY when the source carries intraday detail.
      if (intraday) {
        // Confirmed default: bare/absolute "hourly" over MULTI-day data → cyclical
        // hour-of-day ("typical/peak hour"); single-day scope keeps the absolute timeline.
        if (ig === "hour" && multiDay) ig = "hour_of_day";
        if (subDayUsable(ig)) {
          return decideInline(
            ig,
            "intent",
            ig === "hour_of_day"
              ? "Hour-of-day pattern requested (aggregated across days)"
              : `Explicit ${ig} grain requested`,
          );
        }
      }
      // not intraday or grain collapses → fall through to calendar logic.
    } else if (usable(ig)) {
      return decide(ig, "intent", `Explicit ${intent} grain requested`);
    }
    // intent grain collapses → fall through (e.g. "monthly" on single-month data → finer trend).
  }

  // 2. SPAN — sub-day first: a single intraday day collapses every calendar facet
  //    to one bucket (the old single-day→Month degeneracy), so show the absolute
  //    hourly (or finer minute) timeline. Multi-day intraday data with no explicit
  //    hour ask is intentionally left to the calendar span logic below (a week of
  //    hourly points is rarely what was asked).
  if (intraday && !multiDay) {
    if (subDayUsable("hour")) {
      return decideInline("hour", "span", "Single intraday day → hourly timeline");
    }
    if (subDayUsable("minute")) {
      return decideInline("minute", "span", "Single intraday day → minute timeline");
    }
  }

  // 2b. SPAN (calendar)
  if (sc.range) {
    let g =
      PERIOD_TO_FACET_GRAIN[
        pickTrendGrainForSpan(sc.range.spanDays, sc.range.distinctDayCount)
      ];
    if (!usable(g)) {
      // recommended grain collapses or isn't materialized → refine FINER.
      for (const finer of GRAINS_FINE_TO_COARSE) {
        if (GRAIN_RANK[finer] >= GRAIN_RANK[g]) break;
        if (usable(finer)) {
          g = finer;
          break;
        }
      }
    }
    if (usable(g)) {
      return decide(
        g,
        "span",
        `Span-appropriate ${g} grain (${sc.range.spanDays}d span, ${sc.range.distinctDayCount} distinct day(s))`,
      );
    }
  }

  // 3. CARDINALITY — used when span is unavailable but the sample reveals real
  //    bucket counts. Pick the FINEST real resolution = the max bucket count
  //    (so single-month daily → Day: 30 > 5 weeks > 1 month). When several grains
  //    TIE at that max (e.g. Day=Week=Month=6 → fake resolution / coarse data),
  //    prefer the most natural grain via DEFAULT_FACET_PREFERENCE (Month-first) —
  //    which is the structural no-down-convert guard for the no-span case.
  const usableGrains = GRAINS_FINE_TO_COARSE.filter(usable);
  if (usableGrains.length > 0) {
    let maxBuckets = -1;
    for (const g of usableGrains) {
      const n = bucketCount(sc, g, sample);
      if (n > maxBuckets) maxBuckets = n;
    }
    const tied = usableGrains.filter((g) => bucketCount(sc, g, sample) === maxBuckets);
    let chosen = tied[0]!;
    for (const g of DEFAULT_FACET_PREFERENCE) {
      if (tied.includes(g)) {
        chosen = g;
        break;
      }
    }
    return decide(
      chosen,
      "cardinality",
      `Finest grain with distinct buckets (${chosen}, ${maxBuckets} buckets)`,
    );
  }

  // 4. DEFAULT — every grain collapses to a single bucket (genuinely one-period
  //    dataset). Only return a facet when the caller accepts a one-point chart;
  //    otherwise report no usable temporal axis so it can fall back to a dimension.
  if (allowSingleBucket) {
    for (const g of DEFAULT_FACET_PREFERENCE) {
      if (facetFor(g)) {
        return decide(
          g,
          "default",
          `Single temporal bucket; coarsest available grain (${g})`,
        );
      }
    }
  }
  return none(
    "Temporal facets present but none yield ≥2 buckets (single-period data)",
  );
}
