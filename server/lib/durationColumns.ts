/**
 * DUR1 · Duration column authority.
 *
 * A "duration" column holds ELAPSED TIME — e.g. "Working Hrs" = "03:31:57"
 * (3h 31m 57s worked). This is semantically a QUANTITY, distinct from a
 * "time-of-day" column ("Clock-In Time" = "09:45:34", a clock reading).
 *
 * Before this module the type detector classified any ≥95% HH:MM:SS column
 * as time-of-day (see classifyAsTimeOfDay in dateUtils), kept it as text, and
 * never added it to numericColumns — so "average Working Hrs" aggregated to 0
 * because every cell failed numeric coercion. This module recognises durations
 * and converts them to a numeric measure (decimal hours), mirroring the way
 * currency columns store a number + a display annotation.
 *
 * Pure functions only — no IO, no schema imports. Unit-tested in
 * tests/durationColumns.test.ts.
 */

/**
 * Matches a duration string: one-or-more leading hours digits (so 24h+ like
 * "30:15:00" parses, unlike TIME_OF_DAY_REGEX which caps at 23), then minutes,
 * then optional seconds. Leading "+" / surrounding whitespace tolerated by the
 * caller (value is trimmed first).
 */
const DURATION_SEGMENT_RE = /^(\d{1,3}):([0-5]?\d)(?::([0-5]?\d))?$/;

/** Time-of-day (clock) string, 0–23 hours — shared shape with dateUtils. */
const CLOCK_SEGMENT_RE = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

/** Placeholder strings that are NOT a real measurement (→ null, excluded). */
const DURATION_SENTINELS = new Set<string>([
  "absent",
  "n/a",
  "na",
  "-",
  "--",
  "",
  "null",
  "none",
  "no pjp available",
]);

/** Column names that signal ELAPSED TIME (a quantity). */
const DURATION_NAME_HINT =
  /\b(hrs?|hours?|duration|elapsed|worked|working|tat|turn[ _-]?around|mins?|minutes?|spent|runtime|uptime|downtime|idle|break)\b/i;

/** Column names that signal a CLOCK READING (time-of-day), not a duration. */
const TIME_OF_DAY_ONLY_NAME =
  /\b(clock|punch|arrival|log[ _-]?in|login|log[ _-]?out|logout|in[ _-]?time|out[ _-]?time|start[ _-]?time|end[ _-]?time)\b/i;

export interface DurationClassification {
  isDuration: boolean;
  /** Non-time placeholder strings present in the column (e.g. "Absent"). */
  sentinelValues: string[];
  /** True when at least one value parsed to ≥ 24h (can't be a clock reading). */
  strongSignal: boolean;
}

/**
 * Parse a duration string to DECIMAL HOURS.
 *
 * "03:31:57" → 3.5325, "30:15:00" → 30.25, "01:30" → 1.5 (HH:MM).
 * A numeric input is returned as-is (already-hours columns). Returns null for
 * blanks, sentinels, and anything that isn't a duration shape — callers then
 * exclude the cell from aggregation.
 */
export function parseDurationToHours(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  if (s.length === 0) return null;
  if (DURATION_SENTINELS.has(s.toLowerCase())) return null;
  const m = DURATION_SEGMENT_RE.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] != null ? Number(m[3]) : 0;
  if (!Number.isFinite(h) || !Number.isFinite(min) || !Number.isFinite(sec)) {
    return null;
  }
  return h + min / 60 + sec / 3600;
}

/**
 * Heuristic classifier for duration columns. Distinguishes durations from
 * time-of-day columns (both look like HH:MM:SS):
 *
 *  - STRONG SIGNAL: any value ≥ 24h ⇒ duration outright (a clock can't read 30:00).
 *  - Otherwise ≥85% of non-sentinel samples parse as a duration AND the column
 *    name carries a duration hint ("hrs", "working", "duration", "TAT", …).
 *  - A time-of-day-only name ("clock", "in time", …) defers to time-of-day
 *    unless the strong signal fires.
 *  - Needs ≥ 5 non-sentinel samples (same conservative guard as time-of-day).
 */
export function classifyAsDuration(
  columnName: string,
  samples: ReadonlyArray<unknown>,
  extraSentinels: ReadonlyArray<string> = []
): DurationClassification {
  const sentinelSet = new Set([
    ...DURATION_SENTINELS,
    ...extraSentinels.map((s) => s.trim().toLowerCase()),
  ]);
  const sentinelHits = new Set<string>();
  let parseMatches = 0;
  let nonSentinel = 0;
  let strongSignal = false;

  for (const raw of samples) {
    if (raw == null) continue;
    const s = String(raw).trim();
    if (s.length === 0) continue;
    if (sentinelSet.has(s.toLowerCase())) {
      sentinelHits.add(s);
      continue;
    }
    nonSentinel++;
    // Duration EVIDENCE requires a colon-formatted clock-like string. A bare
    // number ("30", "8") is NOT duration evidence — that would mis-flag a
    // count column (e.g. "Total PC" = 30) as a 30-hour duration. parse passes
    // numbers through for the conversion pass, so we gate on ':' here.
    if (!s.includes(":")) continue;
    const hours = parseDurationToHours(s);
    if (hours !== null) {
      parseMatches++;
      if (hours >= 24) strongSignal = true;
    }
  }

  const reject: DurationClassification = {
    isDuration: false,
    sentinelValues: [],
    strongSignal,
  };
  if (nonSentinel < 5) return reject;

  const share = parseMatches / nonSentinel;
  if (share < 0.85) return reject;

  const nameHinted = DURATION_NAME_HINT.test(columnName);
  const timeOfDayOnly = TIME_OF_DAY_ONLY_NAME.test(columnName);

  // Strong value signal wins regardless of name.
  if (strongSignal) {
    return {
      isDuration: true,
      sentinelValues: Array.from(sentinelHits).sort(),
      strongSignal,
    };
  }
  // A clock-only name with no strong signal is a time-of-day column.
  if (timeOfDayOnly) return reject;
  if (!nameHinted) return reject;

  return {
    isDuration: true,
    sentinelValues: Array.from(sentinelHits).sort(),
    strongSignal,
  };
}

export type DurationFormat = "hm" | "hms" | "decimal";

/**
 * Format decimal hours for display.
 *  - "hm" (default): "3h 32m"  (rounds to the minute — ideal for averages)
 *  - "hms":          "03:31:57"
 *  - "decimal":      "3.53h"
 */
export function formatHoursAsDuration(
  hours: number | null | undefined,
  fmt: DurationFormat = "hm"
): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) {
    return "—";
  }
  const neg = hours < 0;
  const abs = Math.abs(hours);
  if (fmt === "decimal") {
    return `${neg ? "-" : ""}${abs.toFixed(2)}h`;
  }
  let out: string;
  if (fmt === "hms") {
    // Exact: truncate to the second (round-trips with HH:MM:SS source).
    const totalSec = Math.round(abs * 3600);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    out = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(
      s
    ).padStart(2, "0")}`;
  } else {
    // "hm": round to the nearest minute — friendliest for averages.
    const totalMin = Math.round(abs * 60);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    out = `${h}h ${String(m).padStart(2, "0")}m`;
  }
  return neg ? `-${out}` : out;
}

/**
 * Parse a TIME-OF-DAY string to SECONDS SINCE MIDNIGHT (0–86399).
 * "09:45:34" → 35134. Returns null for blanks / sentinels / non-clock shapes
 * and for hours ≥ 24 (those are durations, not clock readings).
 */
export function timeOfDayToSeconds(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  const s = String(value).trim();
  if (s.length === 0) return null;
  if (DURATION_SENTINELS.has(s.toLowerCase())) return null;
  const m = CLOCK_SEGMENT_RE.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] != null ? Number(m[3]) : 0;
  return h * 3600 + min * 60 + sec;
}

/** Format seconds-since-midnight back to a clock "HH:MM" (drops seconds). */
export function formatSecondsAsClock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return "—";
  }
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600) % 24;
  const m = Math.floor((total % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
