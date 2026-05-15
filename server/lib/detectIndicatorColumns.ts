/**
 * SU-IC1 · Auto-detect "indicator" columns at upload time.
 *
 * An indicator column is a pre-computed answer column — low-cardinality,
 * boolean-like or short-shortlist-categorical — that directly answers a
 * common question. Examples from the Marico attendance dataset:
 *   - `Clock-In <09:30` with values {Yes, No, Absent}
 *   - `Compliance Visit` with {Yes, No}
 *   - `Attn Status` with {Present, Absent, Leave}
 *   - `PJP Adherence` / `GCPC Adher` (similar shape)
 *
 * The agent should prefer using these columns directly over deriving the
 * answer from raw values — it's faster, more accurate, and matches what
 * the analyst originally intended when they pre-computed the column.
 *
 * False positives are dangerous (the agent would prefer the wrong
 * column), so the heuristic is intentionally conservative — same
 * principle as AD1 (rollup hierarchies). Two paths to qualify, both
 * required to pass:
 *
 *   PATH A — "value-set match"
 *   - Cardinality 2 ≤ N ≤ 6.
 *   - ≥ 80% of distinct values intersect a known boolean-like dictionary
 *     (Yes/No/True/False/Present/Absent/Pass/Fail/On/Off/Compliant/etc.).
 *
 *   PATH B — "name-pattern match"
 *   - Cardinality ≤ 8.
 *   - Column name matches an indicator-name regex
 *     (adherence/compliance/status/availability/<|>/etc.).
 *
 * Either path is sufficient. Numeric and date columns are skipped
 * unconditionally — a 0/1 numeric is a future enhancement (would need
 * additional disambiguation against numeric IDs and binary flags).
 *
 * The user can always declare or remove indicators via chat or the
 * SU-UX1 banner override.
 */

import type { DataSummary } from "../shared/schema.js";

export interface DetectIndicatorColumnsOptions {
  /** Hard cap on cardinality for value-set matches. Default 6. */
  maxCardinalityValueSet?: number;
  /** Hard cap on cardinality for name-pattern matches. Default 8. */
  maxCardinalityNamePattern?: number;
  /** Minimum fraction of distinct values that must be in the dictionary. Default 0.8. */
  minDictionaryHitRate?: number;
}

const DEFAULTS: Required<DetectIndicatorColumnsOptions> = {
  maxCardinalityValueSet: 6,
  maxCardinalityNamePattern: 8,
  minDictionaryHitRate: 0.8,
};

/**
 * Boolean-like vocabulary (lower-cased). Each entry maps to "positive" /
 * "negative" / "sentinel" — the heuristic uses this to fill the indicator's
 * `positiveValues` / `negativeValues` partition deterministically when
 * possible. Anything not in this map but still in a small value-set is
 * left for SU-IC2 (LLM enrichment) to disambiguate.
 */
const POLARITY: Record<string, "positive" | "negative" | "sentinel"> = {
  yes: "positive",
  y: "positive",
  true: "positive",
  "1": "positive",
  present: "positive",
  pass: "positive",
  active: "positive",
  available: "positive",
  compliant: "positive",
  adherent: "positive",
  "on-time": "positive",
  on: "positive",

  no: "negative",
  n: "negative",
  false: "negative",
  "0": "negative",
  fail: "negative",
  inactive: "negative",
  unavailable: "negative",
  "non-compliant": "negative",
  "non-adherent": "negative",
  late: "negative",
  off: "negative",

  absent: "sentinel",
  na: "sentinel",
  "n/a": "sentinel",
  unknown: "sentinel",
  "-": "sentinel",
};

const NAME_PATTERN =
  /(adherence|adher|compliance|status|availability|presence|attendance|<|>|≤|≥|flag|indicator|bucket|y\/n|yes\/no)/i;

interface CountedValue {
  value: string;
  count: number;
}

function distinctValuesFromColumn(
  data: Record<string, unknown>[],
  column: string,
  cap = 50
): CountedValue[] {
  const counts = new Map<string, number>();
  for (const row of data) {
    const raw = row[column];
    if (raw == null) continue;
    const s = String(raw).trim();
    if (!s) continue;
    counts.set(s, (counts.get(s) ?? 0) + 1);
    if (counts.size > cap) break;
  }
  return Array.from(counts, ([value, count]) => ({ value, count })).sort(
    (a, b) => b.count - a.count
  );
}

interface ClassifyResult {
  kind: "boolean" | "categorical";
  positiveValues?: string[];
  negativeValues?: string[];
  sentinelValues?: string[];
  /** how many distinct values mapped to a polarity (used for hit-rate gate) */
  dictHits: number;
  totalDistinct: number;
}

function classifyValueSet(distinct: CountedValue[]): ClassifyResult {
  const pos: string[] = [];
  const neg: string[] = [];
  const sen: string[] = [];
  let dictHits = 0;
  for (const { value } of distinct) {
    const pol = POLARITY[value.toLowerCase()];
    if (pol === "positive") {
      pos.push(value);
      dictHits += 1;
    } else if (pol === "negative") {
      neg.push(value);
      dictHits += 1;
    } else if (pol === "sentinel") {
      sen.push(value);
      dictHits += 1;
    }
  }
  // "boolean" iff exactly one positive + one negative (sentinels allowed
  // alongside, e.g. Yes/No/Absent). Anything else is categorical.
  const isBoolean = pos.length === 1 && neg.length === 1;
  const result: ClassifyResult = {
    kind: isBoolean ? "boolean" : "categorical",
    dictHits,
    totalDistinct: distinct.length,
  };
  if (pos.length > 0) result.positiveValues = pos;
  if (neg.length > 0) result.negativeValues = neg;
  if (sen.length > 0) result.sentinelValues = sen;
  return result;
}

export interface IndicatorColumn {
  column: string;
  kind: "boolean" | "categorical";
  positiveValues?: string[];
  negativeValues?: string[];
  sentinelValues?: string[];
  source: "auto";
  description?: string;
}

/**
 * Pure fn. Returns one IndicatorColumn entry per qualifying column.
 *
 * @param params.summary  the post-classification DataSummary
 * @param params.data     sample rows (50–200 is plenty; we cap distinct-value
 *                        counting at the first 50 unique values per column to
 *                        bound CPU on huge datasets)
 */
export function detectIndicatorColumns(params: {
  summary: DataSummary;
  data: Record<string, unknown>[];
  options?: DetectIndicatorColumnsOptions;
}): IndicatorColumn[] {
  if (!Array.isArray(params.data) || params.data.length === 0) return [];
  const opts: Required<DetectIndicatorColumnsOptions> = {
    ...DEFAULTS,
    ...params.options,
  };
  const summary = params.summary;
  const numericSet = new Set(summary.numericColumns ?? []);
  const dateSet = new Set(summary.dateColumns ?? []);
  const detected: IndicatorColumn[] = [];

  for (const colMeta of summary.columns) {
    if (numericSet.has(colMeta.name)) continue;
    if (dateSet.has(colMeta.name)) continue;
    if (colMeta.type === "number" || colMeta.type === "date") continue;
    // Time-of-day columns are not indicators (they're TOD1 columns); skip
    // so the SU-DT pipeline keeps full ownership.
    if (colMeta.timeOfDay !== undefined) continue;

    const distinct = distinctValuesFromColumn(params.data, colMeta.name);
    if (distinct.length < 2) continue;

    const classified = classifyValueSet(distinct);

    const valueSetQualifies =
      distinct.length <= opts.maxCardinalityValueSet &&
      classified.totalDistinct > 0 &&
      classified.dictHits / classified.totalDistinct >=
        opts.minDictionaryHitRate;
    const namePatternQualifies =
      distinct.length <= opts.maxCardinalityNamePattern &&
      NAME_PATTERN.test(colMeta.name);

    if (!valueSetQualifies && !namePatternQualifies) continue;

    const hitRatePct = (
      (classified.dictHits / Math.max(1, classified.totalDistinct)) *
      100
    ).toFixed(0);
    const description = valueSetQualifies
      ? `Auto-detected: value set matches boolean-like dictionary (${hitRatePct}% hit rate, ${distinct.length} distinct values).`
      : `Auto-detected: column name matches indicator pattern (${distinct.length} distinct values).`;

    const entry: IndicatorColumn = {
      column: colMeta.name,
      kind: classified.kind,
      source: "auto",
      description,
    };
    if (classified.positiveValues) entry.positiveValues = classified.positiveValues;
    if (classified.negativeValues) entry.negativeValues = classified.negativeValues;
    if (classified.sentinelValues) entry.sentinelValues = classified.sentinelValues;
    detected.push(entry);
  }

  return detected;
}

/**
 * Stamp detected indicators back onto the DataSummary's per-column shape
 * in place. Idempotent — won't overwrite a `source: "user"` indicator.
 */
export function applyIndicatorsToSummary(
  summary: DataSummary,
  indicators: IndicatorColumn[]
): void {
  for (const ind of indicators) {
    const col = summary.columns.find((c) => c.name === ind.column);
    if (!col) continue;
    // Preserve user overrides — the H2-style immutability guard for
    // schema annotations.
    if (col.indicator?.source === "user") continue;
    col.indicator = {
      kind: ind.kind,
      ...(ind.positiveValues ? { positiveValues: ind.positiveValues } : {}),
      ...(ind.negativeValues ? { negativeValues: ind.negativeValues } : {}),
      ...(ind.sentinelValues ? { sentinelValues: ind.sentinelValues } : {}),
      source: "auto",
    };
  }
}
