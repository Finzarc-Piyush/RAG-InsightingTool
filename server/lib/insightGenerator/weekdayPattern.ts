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
import { parseRowDate } from "../temporalFacetColumns.js";

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

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

  return { block, offWeekdays, offDates };
}
