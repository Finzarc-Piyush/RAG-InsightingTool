/**
 * ============================================================================
 * inferLeaveDayPattern.ts — a dataset's structural LEAVE / NON-WORKING days
 * ============================================================================
 * WHAT THIS FILE DOES
 *   In daily FMCG data a leave day (e.g. Sunday) carries ≈0 activity — a
 *   STRUCTURAL zero, not a performance zero. Including it in a per-day AVERAGE
 *   deflates the number (you divide by calendar days, not working days). This
 *   pure function discovers, at upload, which weekday(s) are structurally
 *   non-working so the engine can — with the user's consent — average over
 *   working days only.
 *
 * HOW IT DECIDES (deterministic, no LLM — data-driven, no hardcoded "Sunday")
 *   For each date column it builds a ONE-POINT-PER-DAY series (row count, and
 *   the daily total of each numeric measure) and runs the SHARED off-day
 *   detector `deriveWeekdayPattern` (a weekday ≤15% of other days, ≥2
 *   occurrences, multi-week). The strongest signal (lowest off/working ratio)
 *   wins. No clear structural off-day → null (safe: callers fall back to
 *   all-calendar-day averages). Generalises to any weekday(s) / region.
 *
 * HOW IT CONNECTS
 *   Run in the upload pipeline after createDataSummary (rows in hand); stamps
 *   `dataSummary.leaveDayPattern`. The engine (working-day averages, flag-gated)
 *   reads it to DISCLOSE + ask the user, then excludes on consent. Sibling of
 *   inferMetricApplicability (structural zeros for boolean RATES); this one is
 *   for numeric AVERAGES.
 */
import type { DataSummary } from "../shared/schema.js";
import { parseRowDate } from "./temporalFacetColumns.js";
import { deriveWeekdayPattern } from "./insightGenerator/weekdayPattern.js";
import { WEEKDAY_NAMES } from "../shared/weekday.js";

export interface LeaveDayPattern {
  /** Detected non-working weekday name(s), e.g. ["Sunday"] — any weekday(s). */
  offWeekdays: string[];
  /** The date column the pattern was detected on (the per-day axis). */
  dateColumn: string;
  /** Off-day vs working-day daily means + their ratio (for disclosure text). */
  basis: { offMean: number; workingMean: number; ratio: number };
  /** "auto" = detected; "user" = a remembered user choice (never auto-overwritten). */
  source: "auto" | "user";
  /** User consent state — averages exclude these days only when "exclude". */
  decision: "undecided" | "exclude" | "include";
}

/** Need a genuine multi-week, near-daily series before weekday structure means anything. */
const MIN_DISTINCT_DAYS = 10;
/** Bound the per-row inner loop on pathologically wide datasets. */
const MAX_MEASURES = 40;

function coerceNumber(raw: unknown): number {
  if (typeof raw === "number") return raw;
  return Number(String(raw ?? "").replace(/[%,]/g, ""));
}

/** Local Y-M-D key — matches the weekday `Date.getDay()` the detector uses. */
function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Per-weekday mean of a daily series → off/working basis for a known off-set. */
function summarizeBasis(
  series: Array<{ day: string; val: number }>,
  offWeekdays: Set<string>
): { offMean: number; workingMean: number; ratio: number } {
  const off: number[] = [];
  const work: number[] = [];
  for (const p of series) {
    const d = parseRowDate(p.day);
    if (!d) continue;
    (offWeekdays.has(WEEKDAY_NAMES[d.getDay()]!) ? off : work).push(p.val);
  }
  const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const offMean = mean(off);
  const workingMean = mean(work);
  return { offMean, workingMean, ratio: workingMean > 0 ? offMean / workingMean : 1 };
}

/**
 * Detect the dataset's structural leave/non-working weekday(s). Pure. Returns
 * null when no date column yields a clear, recurring off-day.
 */
export function inferLeaveDayPattern(
  summary: DataSummary,
  rows: ReadonlyArray<Record<string, unknown>>
): LeaveDayPattern | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const dateCols = summary.dateColumns ?? [];
  if (dateCols.length === 0) return null;
  const measures = (summary.numericColumns ?? []).filter(Boolean).slice(0, MAX_MEASURES);

  let best: LeaveDayPattern | null = null;

  for (const dateCol of dateCols) {
    // One pass per date column: per distinct day, row count + per-measure total.
    const byDay = new Map<string, { count: number; sums: Map<string, number> }>();
    for (const row of rows) {
      const d = parseRowDate(row[dateCol]);
      if (!d) continue;
      const key = isoDay(d);
      let e = byDay.get(key);
      if (!e) {
        e = { count: 0, sums: new Map() };
        byDay.set(key, e);
      }
      e.count++;
      for (const m of measures) {
        const v = coerceNumber(row[m]);
        if (Number.isFinite(v)) e.sums.set(m, (e.sums.get(m) ?? 0) + v);
      }
    }
    if (byDay.size < MIN_DISTINCT_DAYS) continue;

    const days = [...byDay.keys()].sort();

    // Candidate daily series: row-count first (the most general "was there
    // work?" signal), then each numeric measure's daily total (catches the
    // "rows exist but the metric sums to ≈0 on the off-day" shape — e.g. the
    // compliance-visit sum that drops to 0 every Sunday).
    const candidates: Array<{ series: Array<{ day: string; val: number }> }> = [
      { series: days.map((day) => ({ day, val: byDay.get(day)!.count })) },
      ...measures.map((m) => ({
        series: days.map((day) => ({ day, val: byDay.get(day)!.sums.get(m) ?? 0 })),
      })),
    ];

    for (const cand of candidates) {
      // Feed the shared detector one point per day, keyed by the real date col.
      const detectRows = cand.series.map((p) => ({ [dateCol]: p.day, __val: p.val }));
      const pattern = deriveWeekdayPattern(detectRows, dateCol, "__val");
      if (!pattern || pattern.offWeekdays.length === 0) continue;
      const basis = summarizeBasis(cand.series, new Set(pattern.offWeekdays));
      if (!(basis.workingMean > 0) || !Number.isFinite(basis.ratio)) continue;
      // Strongest signal wins: lowest off/working ratio (closest to a true zero).
      if (!best || basis.ratio < best.basis.ratio) {
        best = {
          offWeekdays: pattern.offWeekdays,
          dateColumn: dateCol,
          basis,
          source: "auto",
          decision: "undecided",
        };
      }
    }
  }

  return best;
}

/**
 * Stamp the detected pattern onto the summary, idempotently. A user's remembered
 * choice (`source:"user"`) is NEVER overwritten by auto re-detection.
 */
export function applyLeaveDayPatternToSummary(
  summary: DataSummary,
  pattern: LeaveDayPattern | null
): void {
  if (!pattern) return;
  const holder = summary as { leaveDayPattern?: LeaveDayPattern };
  if (holder.leaveDayPattern?.source === "user") return;
  holder.leaveDayPattern = pattern;
}
