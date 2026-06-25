/**
 * ============================================================================
 * weekdayPattern.ts — deterministic day-of-week grounding for date-axis charts
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Given a chart's rows + its (date) x column + numeric y column, it asks the
 *   only question a daily trend really raises: "does the rise-and-fall track the
 *   weekly calendar?" It buckets each point by weekday, and if one (or more)
 *   weekday is a consistent OFF-DAY — its average sits far below the other days —
 *   it returns a compact, factual block naming that weekday and the specific
 *   dates that fall on it. The off-day is DERIVED FROM THE DATA (no hardcoded
 *   "Sunday", no calendar config), so it generalises to any dataset / region.
 *
 * WHY IT MATTERS
 *   Without this, the chart-insight LLM only sees x/y values and speculates
 *   ("the zero days *may be* non-working") about dips that are, in fact, just
 *   Sundays. Feeding the deterministic weekday fact in BEFORE the prompt lets
 *   the "WHY" state the weekly rhythm plainly instead of treating an expected
 *   off-day as a surprise. (Ships the gate before the prompt opens the
 *   permission — see docs/lessons.md L-022.)
 *
 * HOW IT CONNECTS
 *   Pure, no I/O. Consumed by insightGenerator.ts (per-chart Key-Insight prompt)
 *   and the narrator hint block (main answer narrative). Reuses parseRowDate
 *   from temporalFacetColumns so date parsing matches the rest of the app.
 */
import {
  parseRowDate,
  parseTemporalFacetDisplayKey,
  facetColumnKey,
} from "../temporalFacetColumns.js";
import { formatCompactNumber } from "../formatCompactNumber.js";
// Single source of truth for weekday naming/order (shared with the day_of_week
// facet + chart/pivot sort authorities).
import { WEEKDAY_NAMES } from "../../shared/weekday.js";

// Calendar display order: Monday-first, Sunday last (FMCG week convention).
const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** An off-day is a weekday whose average is ≤15% of the other days' average. */
const OFF_DAY_RATIO = 0.15;
/** Need a genuine multi-week, near-daily series before weekday structure means anything. */
const MIN_POINTS = 10;
const MIN_DISTINCT_WEEKDAYS = 5;

export interface WeekdayPattern {
  /** Ready-to-inject ground-truth block for the insight / narrator prompt. */
  block: string;
  /** Off-day weekday names, e.g. ["Sunday"]. */
  offWeekdays: string[];
  /** The specific x-labels (dates) that fall on an off-day, e.g. ["2026-04-05", …]. */
  offDates: string[];
  /**
   * One-line, UI-ready comparison (no prompt scaffolding) for the off-day
   * affordance chip, e.g. "Sunday averages 0 vs 4.2K on other days".
   */
  summary: string;
}

function coerceNumber(raw: unknown): number {
  if (typeof raw === "number") return raw;
  const n = Number(String(raw).replace(/[%,]/g, ""));
  return n;
}

/**
 * Detect a recurring weekly off-day in a date-axis series. Returns null when the
 * series is too short / not date-shaped, or when no weekday is a clear off-day
 * (so charts without weekly rhythm are never polluted with a spurious note).
 */
export function deriveWeekdayPattern(
  rows: Record<string, any>[],
  xCol: string,
  yCol: string,
  format: (n: number) => string = (n) => String(Math.round(n))
): WeekdayPattern | null {
  if (!Array.isArray(rows) || rows.length < MIN_POINTS || !xCol || !yCol) {
    return null;
  }

  const byWeekday: Array<{ values: number[]; dates: Array<{ label: string; y: number }> }> =
    Array.from({ length: 7 }, () => ({ values: [], dates: [] }));

  for (const row of rows) {
    const d = parseRowDate(row[xCol]);
    if (!d) continue;
    const y = coerceNumber(row[yCol]);
    if (!Number.isFinite(y)) continue;
    const wd = d.getDay();
    byWeekday[wd]!.values.push(y);
    byWeekday[wd]!.dates.push({ label: String(row[xCol]), y });
  }

  const present = byWeekday.filter((b) => b.values.length > 0).length;
  if (present < MIN_DISTINCT_WEEKDAYS) return null;

  const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const weekdayMean = byWeekday.map((b) => mean(b.values));

  // An off-day must recur (≥2 occurrences) and average far below the rest.
  const offWeekdayIdx: number[] = [];
  for (let wd = 0; wd < 7; wd++) {
    const b = byWeekday[wd]!;
    if (b.values.length < 2) continue;
    const others = byWeekday
      .filter((_, i) => i !== wd)
      .flatMap((o) => o.values);
    const othersMean = mean(others);
    if (othersMean > 0 && weekdayMean[wd]! <= OFF_DAY_RATIO * othersMean) {
      offWeekdayIdx.push(wd);
    }
  }
  if (offWeekdayIdx.length === 0) return null;

  const offWeekdays = offWeekdayIdx.map((i) => WEEKDAY_NAMES[i]!);
  const offSet = new Set(offWeekdayIdx);

  // Off-day vs working-day averages — for the UI-ready one-liner.
  const offMean = mean(offWeekdayIdx.flatMap((wd) => byWeekday[wd]!.values));
  const otherMean = mean(
    byWeekday.filter((_, i) => !offSet.has(i)).flatMap((o) => o.values)
  );

  // The dates that fall on an off-day, chronologically, capped for prompt budget.
  const offDates = [...DISPLAY_ORDER]
    .filter((wd) => offSet.has(wd))
    .flatMap((wd) => byWeekday[wd]!.dates.map((x) => x.label))
    .sort()
    .slice(0, 6);

  // By-weekday averages line (Mon-first), only for weekdays that appear.
  const weekdayLine = DISPLAY_ORDER.filter((wd) => byWeekday[wd]!.values.length > 0)
    .map((wd) => `${WEEKDAY_NAMES[wd]!.slice(0, 3)} ${format(weekdayMean[wd]!)}`)
    .join(", ");

  const offNames =
    offWeekdays.length === 1
      ? offWeekdays[0]!
      : `${offWeekdays.slice(0, -1).join(", ")} and ${offWeekdays[offWeekdays.length - 1]}`;
  const datesStr = offDates.join(", ");

  const block = [
    `TEMPORAL CALENDAR (ground truth — derive the WHY from this; do NOT speculate or call it a surprise):`,
    `- Average ${yCol} by weekday: ${weekdayLine}.`,
    `- ${offNames} ${offWeekdays.length === 1 ? "is a" : "are"} recurring OFF-DAY${offWeekdays.length === 1 ? "" : "s"}: far below the other days. The low/zero points (${datesStr}) all fall on ${offNames}.`,
    `- So the regular rise-and-fall is the normal weekly work cycle, not a demand swing or a data gap.`,
  ].join("\n");

  const summary = `${offNames} ${
    offWeekdays.length === 1 ? "averages" : "average"
  } ${format(offMean)} vs ${format(otherMean)} on other days`;

  return { block, offWeekdays, offDates, summary };
}

/** Transient, UI-facing off-day hint surfaced on chart responses (not persisted). */
export interface OffDayHint {
  /** Detected recurring off-day weekday name(s), e.g. ["Sunday"]. */
  offWeekdays: string[];
  /** One-line comparison for the affordance chip. */
  summary: string;
  /**
   * Materialized "Day of week · <date>" column to target for a SESSION-WIDE
   * exclusion (the active-filter `notIn`). Undefined when the chart's x can't be
   * resolved to a date source (then only per-chart exclusion is offered).
   */
  weekdayColumn?: string;
}

/** Resolve the materialized weekday column to exclude on for a session-wide filter. */
function resolveWeekdayColumn(
  x: string,
  dateColumns: string[] | undefined
): string | undefined {
  const facet = parseTemporalFacetDisplayKey(x);
  if (facet?.grain === "day_of_week") return x; // x already IS the weekday column
  const src = facet?.sourceColumn ?? (dateColumns?.includes(x) ? x : undefined);
  return src ? facetColumnKey(src, "day_of_week") : undefined;
}

/**
 * Detect an off-day pattern for a chart and return a compact UI hint, or null.
 * Shared by the chart-preview and key-insight endpoints so detection is byte-
 * identical. Guards mirror the insight generator: only single-measure,
 * non-dual-axis, non-heatmap date-axis charts (the off-day detector itself
 * self-guards on series length / weekday rhythm).
 */
export function computeOffDayHint(
  rows: Record<string, any>[],
  spec: {
    x?: string | null;
    y?: string | null;
    type?: string | null;
    seriesKeys?: unknown[] | null;
    y2?: unknown;
  },
  dateColumns?: string[]
): OffDayHint | null {
  if (!spec.x || !spec.y) return null;
  if (spec.type === "heatmap") return null;
  if (Array.isArray(spec.seriesKeys) && spec.seriesKeys.length) return null;
  if (spec.y2) return null;
  const pattern = deriveWeekdayPattern(rows, spec.x, spec.y, formatCompactNumber);
  if (!pattern) return null;
  return {
    offWeekdays: pattern.offWeekdays,
    summary: pattern.summary,
    weekdayColumn: resolveWeekdayColumn(spec.x, dateColumns),
  };
}

/**
 * Drop rows that fall on an excluded weekday (per-chart off-day exclusion),
 * applied BEFORE aggregation so the average divides by working-day count only.
 * Resolves the weekday three ways from the chart's x column:
 *   1. x is the "Day of week · Y" facet → its value IS the weekday name;
 *   2. x is another facet ("Day · Date") → use its source date column;
 *   3. x is a raw date column → parse it directly.
 * Rows whose date can't be parsed are KEPT (never silently dropped). A no-op
 * when there is nothing to exclude or x is not date-shaped.
 */
export function filterRowsByExcludedWeekdays(
  rows: Record<string, any>[],
  xColumn: string | null | undefined,
  dateColumns: string[],
  excludedWeekdays: string[] | null | undefined
): Record<string, any>[] {
  if (!rows.length || !xColumn || !excludedWeekdays?.length) return rows;
  const excluded = new Set(excludedWeekdays);

  const facet = parseTemporalFacetDisplayKey(xColumn);
  if (facet?.grain === "day_of_week") {
    return rows.filter((r) => !excluded.has(String(r[xColumn])));
  }

  const dateCol = facet?.sourceColumn ?? (dateColumns.includes(xColumn) ? xColumn : null);
  if (!dateCol) return rows;
  return rows.filter((r) => {
    const d = parseRowDate(r[dateCol]);
    if (!d) return true;
    return !excluded.has(WEEKDAY_NAMES[d.getDay()]!);
  });
}
