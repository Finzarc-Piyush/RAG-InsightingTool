/**
 * Continuous dimension axis bucketing — the missing "bin a continuous time column
 * before charting it" step.
 *
 * WHY THIS EXISTS
 *   A chart of the form "<metric> (avg) by <dimension>" keys each bar by the raw
 *   dimension value (chartGenerator.aggregateData: `key = String(row[groupBy])`).
 *   For a CONTINUOUS time-like column this means one bar per distinct value:
 *     - "Compliance Visit (avg) by Clock-In Time" → a bar for 08:50:49, 09:14:19, …
 *     - "Compliance Visit (avg) by Working Hrs"   → a bar for 03:16:55, 06:13:08, …
 *   which is meaningless. Calendar-date columns are already bucketed by the temporal
 *   grain authority (normalizeDateToPeriod); TIME-OF-DAY and DURATION columns had no
 *   equivalent. This module is that equivalent.
 *
 * THE PATTERN (mirrors dashboardFeatureSweep's bucketRowsTopN / deriveDimensionBucket)
 *   A chart builder that already holds the DataSummary calls
 *   `planContinuousDimensionBucket` for its chosen x column. If a plan comes back, it
 *   rewrites the dimension cells to bucket-label keys via
 *   `applyContinuousDimensionBucket` BEFORE compile/aggregate. aggregateData then keys
 *   by those labels and naturally yields one group per BUCKET — no aggregator change.
 *
 *   Labels lead with their lower bound ("08:00–09:00", "3h–4h") so the existing sort
 *   authority (shared/chartSort detectAxisOrdered → bucketLeadingNumber) orders the
 *   axis ascending for free. No new ChartSpec fields.
 *
 * SCOPE: time-of-day + duration only. Generic high-cardinality numeric binning is
 *   intentionally out of scope so a 1–12 month or 1–5 rating axis is never re-bucketed.
 *
 * Pure functions only — no IO. Unit-tested in tests/continuousDimensionBucket.test.ts.
 */
import type { ChartSpec, DataSummary } from "../shared/schema.js";
import { classifyAsTimeOfDay } from "./dateUtils.js";
import { isTemporalFacetColumnKey } from "./temporalFacetColumns.js";
import {
  classifyAsDuration,
  parseDurationToHours,
  formatHoursAsDuration,
  timeOfDayToSeconds,
  formatSecondsAsClock,
} from "./durationColumns.js";

/** Range en-dash used in every bucket label (separates lower–upper bound). */
const RANGE_DASH = "–"; // –

/** No axis ever exceeds this many buckets (matches richColumnProfile's MAX_HISTOGRAM_BINS). */
const MAX_BUCKETS = 24;

/** A coarse hour-of-day axis that yields fewer than this many populated bands is
 *  refined to a finer grain (30-min, then 15-min) — but only when the data is that
 *  narrowly clustered. */
const MIN_TIME_BUCKETS_BEFORE_REFINE = 3;

/** Rows scanned to DECIDE the grain/width. assign() still maps any value exactly, so a
 *  cap here only bounds the planning pass, never correctness. */
const PLAN_SCAN_CAP = 50_000;

/** Up to this many cells are sampled for fallback shape-detection of a column with no
 *  stored timeOfDay/duration annotation (derived result-table columns). */
const DETECT_SAMPLE_CAP = 80;

export type BucketKind = "time_of_day" | "duration";

export interface BucketPlan {
  kind: BucketKind;
  /** Source dimension column the plan buckets. */
  column: string;
  /** Map ONE raw cell → its canonical lower-bound-leading bucket KEY, or null to drop
   *  the cell (sentinel / unparseable). Pure; closes over the grain/width only. */
  assign(value: unknown): string | null;
  /** Bucket keys in canonical axis order (ascending lower bound). Lets a builder detect
   *  single-bucket collapse (`orderedKeys.length < 2` → chart natively). */
  orderedKeys: string[];
  /** Provenance for the chart's axisReason / subtitle. */
  reason: string;
}

export interface BucketDecisionInput {
  column: string;
  /** The rows about to be charted (source of cardinality + value span). */
  rows: readonly Record<string, unknown>[];
  /** Stored annotation for `column`, when present in the DataSummary. Preferred over
   *  sample-shape detection. */
  summaryColumn?: DataSummary["columns"][number];
}

type SummaryColumn = NonNullable<BucketDecisionInput["summaryColumn"]>;

/**
 * Decide whether `column` is a continuous time-of-day or duration dimension that should
 * be binned for a "by <column>" chart. Returns a BucketPlan, or null to chart natively.
 *
 * Detection precedence: stored annotation first, then sample-shape detection for derived
 * columns absent from the DataSummary. Calendar dates / temporal facets are never
 * handled here (that is the temporal grain authority's domain).
 */
export function planContinuousDimensionBucket(
  input: BucketDecisionInput
): BucketPlan | null {
  const { column, rows, summaryColumn } = input;
  if (rows.length === 0) return null;

  // Never double-handle a calendar date or a pre-materialized temporal facet — those
  // belong to temporalGrainAuthority. (time-of-day stays string, duration stays number,
  // so neither overlaps summary.dateColumns; this is a belt-and-braces guard.)
  if (summaryColumn?.type === "date") return null;
  if (isTemporalFacetColumnKey(column)) return null;

  const kind = detectKind(column, rows, summaryColumn);
  if (kind === "time_of_day") return planTimeOfDay(column, rows);
  if (kind === "duration") return planDuration(column, rows);
  return null;
}

function detectKind(
  column: string,
  rows: readonly Record<string, unknown>[],
  summaryColumn?: SummaryColumn
): BucketKind | null {
  // 1) Stored annotations are authoritative.
  if (summaryColumn?.timeOfDay) return "time_of_day";
  if (summaryColumn?.duration) return "duration";

  // 2) Fallback: shape-detect on a sample (derived result-table columns have no
  //    DataSummary annotation). Order matters — time-of-day before duration, mirroring
  //    the upload-time detector (TOD1 runs before duration's strong-signal check).
  const samples: unknown[] = [];
  for (let i = 0; i < rows.length && samples.length < DETECT_SAMPLE_CAP; i++) {
    samples.push(rows[i]![column]);
  }
  if (classifyAsTimeOfDay(column, samples).isTimeOfDay) return "time_of_day";
  if (classifyAsDuration(column, samples).isDuration) return "duration";
  return null;
}

// ── time-of-day ──────────────────────────────────────────────────────────────────

const TIME_GRAIN_STEPS = [3600, 1800, 900] as const; // hour → 30-min → 15-min

function planTimeOfDay(
  column: string,
  rows: readonly Record<string, unknown>[]
): BucketPlan | null {
  // One scan → seconds-since-midnight for parseable cells (capped for planning).
  const seconds: number[] = [];
  const scan = Math.min(rows.length, PLAN_SCAN_CAP);
  for (let i = 0; i < scan; i++) {
    const sec = timeOfDayToSeconds(rows[i]![column]);
    if (sec !== null) seconds.push(sec);
  }
  if (seconds.length === 0) return null;

  // Pick the coarsest grain (hour) that yields ≥ 3 populated bands; only refine to
  // 30-min, then 15-min, when the data is clustered too tightly for hour bands to be
  // informative. Each step is naturally bounded (hour ≤ 24; finer only fires when the
  // data spans < 3 of the coarser unit → a handful of bands).
  let step: number = TIME_GRAIN_STEPS[0];
  for (const candidate of TIME_GRAIN_STEPS) {
    step = candidate;
    if (distinctBucketStarts(seconds, candidate).size >= MIN_TIME_BUCKETS_BEFORE_REFINE) {
      break;
    }
  }

  const labelFor = (startSec: number): string =>
    `${formatSecondsAsClock(startSec)}${RANGE_DASH}${formatSecondsAsClock(startSec + step)}`;

  const orderedStarts = Array.from(distinctBucketStarts(seconds, step)).sort(
    (a, b) => a - b
  );
  // Defensive cap (should never trigger at hour grain).
  const orderedKeys = orderedStarts.slice(0, MAX_BUCKETS).map(labelFor);

  const reason =
    step === 3600
      ? `Bucketed "${column}" into hour-of-day bands`
      : `Bucketed "${column}" into ${step / 60}-minute windows`;

  return {
    kind: "time_of_day",
    column,
    assign(value) {
      const sec = timeOfDayToSeconds(value);
      if (sec === null) return null;
      return labelFor(Math.floor(sec / step) * step);
    },
    orderedKeys,
    reason,
  };
}

function distinctBucketStarts(seconds: number[], step: number): Set<number> {
  const out = new Set<number>();
  for (const s of seconds) out.add(Math.floor(s / step) * step);
  return out;
}

// ── duration ─────────────────────────────────────────────────────────────────────

/** "Nice" bucket widths in hours — the smallest that keeps the bucket count ≤ MAX is
 *  chosen, so labels stay round ("3h–4h", "0h–2h") and the axis never explodes. */
const NICE_DURATION_WIDTHS_HOURS = [1, 2, 3, 4, 6, 8, 12, 24, 48, 168] as const;

function planDuration(
  column: string,
  rows: readonly Record<string, unknown>[]
): BucketPlan | null {
  const hours: number[] = [];
  const scan = Math.min(rows.length, PLAN_SCAN_CAP);
  for (let i = 0; i < scan; i++) {
    const h = parseDurationToHours(rows[i]![column]);
    if (h !== null && Number.isFinite(h)) hours.push(h);
  }
  if (hours.length === 0) return null;

  let min = hours[0]!;
  let max = hours[0]!;
  for (const h of hours) {
    if (h < min) min = h;
    if (h > max) max = h;
  }

  // Pick the finest round width whose whole-hour-aligned bins stay within MAX_BUCKETS.
  let width: number = NICE_DURATION_WIDTHS_HOURS[NICE_DURATION_WIDTHS_HOURS.length - 1]!;
  for (const w of NICE_DURATION_WIDTHS_HOURS) {
    const lo = Math.floor(min / w) * w;
    if (Math.ceil((max - lo) / w || 1) <= MAX_BUCKETS) {
      width = w;
      break;
    }
  }
  const alignedFloor = Math.floor(min / width) * width;

  const fmtEdge = (h: number): string =>
    Number.isInteger(h) ? `${h}h` : formatHoursAsDuration(h, "hm");
  const labelForLo = (lo: number): string =>
    `${fmtEdge(lo)}${RANGE_DASH}${fmtEdge(lo + width)}`;
  const bucketLo = (h: number): number => alignedFloor + Math.floor((h - alignedFloor) / width) * width;

  const present = new Set<number>();
  for (const h of hours) present.add(bucketLo(h));
  const orderedKeys = Array.from(present)
    .sort((a, b) => a - b)
    .map(labelForLo);

  return {
    kind: "duration",
    column,
    assign(value) {
      const h = parseDurationToHours(value);
      if (h === null || !Number.isFinite(h)) return null;
      return labelForLo(bucketLo(h));
    },
    orderedKeys,
    reason: `Bucketed "${column}" into duration ranges`,
  };
}

// ── appliers ─────────────────────────────────────────────────────────────────────

/**
 * Shallow-copy `rows`, rewriting `rows[*][plan.column]` to its bucket KEY. Rows whose
 * cell maps to null (sentinel / unparseable) are DROPPED (no "—"/null bucket), matching
 * the breakdown tool's exclude-sentinel behavior. Never mutates the input.
 */
export function applyContinuousDimensionBucket(
  rows: readonly Record<string, unknown>[],
  plan: BucketPlan
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    const key = plan.assign(row[plan.column]);
    if (key === null) continue;
    out.push({ ...row, [plan.column]: key });
  }
  return out;
}

/**
 * Convenience for builders that already hold a ChartSpec: looks up the x column's
 * DataSummary annotation, plans, and — if a ≥2-bucket plan exists — returns the rewritten
 * rows plus an axisReason. Otherwise returns the rows untouched. Keeps every wiring site a
 * one-liner so the bucket decision can't drift across paths.
 */
export function bucketContinuousXForSpec(
  rows: readonly Record<string, unknown>[],
  spec: Pick<ChartSpec, "x">,
  summary: DataSummary
): { rows: Record<string, unknown>[]; axisReason?: string } {
  const passthrough = { rows: rows as Record<string, unknown>[] };
  const x = spec.x;
  if (!x) return passthrough;
  const summaryColumn = summary.columns.find((c) => c.name === x);
  const plan = planContinuousDimensionBucket({ column: x, rows, summaryColumn });
  if (!plan || plan.orderedKeys.length < 2) return passthrough;
  return { rows: applyContinuousDimensionBucket(rows, plan), axisReason: plan.reason };
}
