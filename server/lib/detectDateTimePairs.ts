/**
 * SU-DT1 · Auto-detect (date column, time-of-day column) pairings at upload.
 *
 * A "pair" means: the time-of-day column carries the *time component* for
 * a row whose calendar date lives in the paired date column. E.g. on the
 * Marico attendance dataset, "Clock-In Time" (HH:MM:SS) belongs with
 * "Day · Date" or whatever date column the row's calendar date lives in.
 *
 * Without this pairing the agent literally cannot reason about combined
 * datetime — "earliest weekday clock-in by region", "% of late clock-ins
 * on Mondays", etc. all become inexpressible because the two halves of
 * the timestamp are floating in unrelated columns.
 *
 * False positives are dangerous (the agent would build a meaningless
 * datetime from a date and an unrelated time), so the heuristic is
 * intentionally conservative — only emit a pair when the strongest
 * candidate beats the runner-up by ≥ `minMargin` (default 2×). The user
 * can always declare a pairing via chat or the SU-UX1 banner override.
 *
 * Scoring components, summed:
 *   1. Shared lowercased name tokens (after stripping common time/date
 *      stopwords like "time", "date", "at", "on") — proxy for "these
 *      columns are obviously about the same thing", e.g. "Clock-In Time"
 *      ↔ "Clock-In Date".
 *   2. Column header proximity in the original ordering — adjacent or
 *      near-adjacent headers usually carry related fields.
 *   3. Co-non-null rate — a row that has the time-of-day should also
 *      have the date. Rate is computed against the sample rows we have
 *      access to, so noisy / capped samples just attenuate the signal.
 *
 * The 1:1 trivial case (one date column + one time column) auto-pairs
 * unconditionally — there is nothing to be ambiguous about.
 */

import type { DataSummary, DateTimeColumnPair } from "../shared/schema.js";

export interface DetectDateTimePairsOptions {
  /**
   * Strongest candidate must beat the runner-up by at least this multiplier
   * to emit a pair. Default 2.0 — i.e. > 2× margin required.
   */
  minMargin?: number;
  /** Soft cap on the number of pairs returned. Default 10. */
  maxPairs?: number;
}

const DEFAULTS: Required<DetectDateTimePairsOptions> = {
  minMargin: 2.0,
  maxPairs: 10,
};

/** Tokens stripped before name-similarity scoring (case-insensitive). */
const STOPWORDS = new Set([
  "time",
  "date",
  "datetime",
  "timestamp",
  "at",
  "on",
  "of",
  "the",
  "a",
  "an",
  "day",
  "dt",
  "ts",
]);

function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

function sharedTokenScore(timeName: string, dateName: string): number {
  const a = new Set(nameTokens(timeName));
  const b = new Set(nameTokens(dateName));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  // Normalize so two-token columns that share both score 1.0; a single
  // shared token among many gets a smaller boost.
  return shared / Math.max(a.size, b.size);
}

function proximityScore(
  timeIdx: number,
  dateIdx: number,
  totalCols: number
): number {
  if (timeIdx < 0 || dateIdx < 0 || totalCols <= 1) return 0;
  const dist = Math.abs(timeIdx - dateIdx);
  // Adjacent → 1, very far → ~0. Linear decay over the header width.
  return Math.max(0, 1 - dist / Math.max(1, totalCols - 1));
}

function coNonNullRate(
  rows: Record<string, unknown>[],
  timeCol: string,
  dateCol: string,
  sentinelValues: Set<string>
): number {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  let timeNonNull = 0;
  let bothNonNull = 0;
  for (const r of rows) {
    const t = r[timeCol];
    const d = r[dateCol];
    const tIsTime =
      t != null &&
      String(t).trim() !== "" &&
      !sentinelValues.has(String(t).trim());
    if (!tIsTime) continue;
    timeNonNull += 1;
    if (d != null && String(d).trim() !== "") bothNonNull += 1;
  }
  if (timeNonNull === 0) return 0;
  return bothNonNull / timeNonNull;
}

interface PairCandidate {
  timeColumn: string;
  dateColumn: string;
  score: number;
  components: { name: number; proximity: number; coNonNull: number };
}

function scorePair(params: {
  timeColumn: string;
  dateColumn: string;
  headerOrder: string[];
  rows: Record<string, unknown>[];
  sentinels: Set<string>;
}): PairCandidate {
  const name = sharedTokenScore(params.timeColumn, params.dateColumn);
  const proximity = proximityScore(
    params.headerOrder.indexOf(params.timeColumn),
    params.headerOrder.indexOf(params.dateColumn),
    params.headerOrder.length
  );
  const coNonNull = coNonNullRate(
    params.rows,
    params.timeColumn,
    params.dateColumn,
    params.sentinels
  );
  // Weighted sum — name-similarity dominates because that's the strongest
  // signal in real datasets, but proximity + co-non-null break ties.
  const score = name * 2.0 + proximity * 1.0 + coNonNull * 1.0;
  return {
    timeColumn: params.timeColumn,
    dateColumn: params.dateColumn,
    score,
    components: { name, proximity, coNonNull },
  };
}

/**
 * Pure fn. Returns at most one DateTimeColumnPair per time-of-day column.
 *
 * @param params.summary  the post-classification DataSummary
 * @param params.data     sample rows (used for co-non-null scoring; passing
 *                        50–200 rows is plenty)
 * @param params.options  thresholds (see DetectDateTimePairsOptions)
 */
export function detectDateTimePairs(params: {
  summary: DataSummary;
  data: Record<string, unknown>[];
  options?: DetectDateTimePairsOptions;
}): DateTimeColumnPair[] {
  const opts: Required<DetectDateTimePairsOptions> = {
    ...DEFAULTS,
    ...params.options,
  };
  const summary = params.summary;
  const timeColumns = summary.columns.filter(
    (c) => c.timeOfDay !== undefined
  );
  const dateColumns = summary.dateColumns ?? [];
  if (timeColumns.length === 0 || dateColumns.length === 0) return [];

  const headerOrder = summary.columns.map((c) => c.name);
  const detected: DateTimeColumnPair[] = [];

  for (const timeCol of timeColumns) {
    if (detected.length >= opts.maxPairs) break;
    const sentinels = new Set(timeCol.timeOfDay?.sentinelValues ?? []);

    // 1:1 trivial case — auto-pair unconditionally.
    if (timeColumns.length === 1 && dateColumns.length === 1) {
      detected.push({
        timeColumn: timeCol.name,
        dateColumn: dateColumns[0]!,
        source: "auto",
        description: `Auto-paired (only date column in dataset).`,
      });
      continue;
    }

    const candidates = dateColumns.map((dateCol) =>
      scorePair({
        timeColumn: timeCol.name,
        dateColumn: dateCol,
        headerOrder,
        rows: params.data,
        sentinels,
      })
    );
    candidates.sort((a, b) => b.score - a.score);
    const top = candidates[0];
    const second = candidates[1];
    if (!top || top.score <= 0) continue;
    // Margin guard — only emit when the top is decisively better than the
    // runner-up (or there's only one candidate at all).
    if (second && top.score < opts.minMargin * Math.max(0.01, second.score)) {
      continue;
    }
    detected.push({
      timeColumn: top.timeColumn,
      dateColumn: top.dateColumn,
      source: "auto",
      description: `Auto-paired (name=${top.components.name.toFixed(
        2
      )}, proximity=${top.components.proximity.toFixed(
        2
      )}, coNonNull=${top.components.coNonNull.toFixed(2)}).`,
    });
  }

  return detected;
}
