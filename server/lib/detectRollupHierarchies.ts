/**
 * AD1 · Auto-detect dimension rollup rows at upload time.
 *
 * A "rollup row" is a single value in a dimension column that aggregates
 * the other values in the same column — e.g. in Marico-VN data, the
 * `Products` column contains both `FEMALE SHOWER GEL` (the entire category
 * total, ~88% of column-wide sales) and the individual brand rows
 * (`MARICO`, `PURITE`, `OLIV`, `LASHE`) that sit inside it.
 *
 * If the agent groups by such a column without realising it, every
 * breakdown is dominated by the rollup row and the analysis is
 * mathematically meaningless ("the parent always wins because it IS
 * the sum of the others, more or less").
 *
 * False positives are dangerous (silently excluding a genuine market
 * leader from breakdowns produces worse answers without explanation),
 * so the heuristic is intentionally conservative — both thresholds
 * must pass:
 *
 *   1. The top value's measure total is ≥ `minDominance` of the
 *      column-wide total (default 70 %).
 *   2. The top value's measure total is ≥ `minTopRatio` × the
 *      second-highest value's measure total (default 4×).
 *
 * Combined with a cardinality window (default 4–30) and the requirement
 * that the column be non-numeric, non-date, this rejects: market
 * leaders with 50–60 % share, Pareto-style long-tail distributions,
 * concentrated head + small tail (where dominance is high but the
 * top-to-second ratio is small), and binary splits.
 *
 * The user can always override via chat ("X is NOT the category — it's
 * just our top brand"); the user-merge LLM controls hierarchies and
 * the H2 immutability guard then preserves the correction across
 * subsequent assistant merges.
 */

import type {
  DataSummary,
  DatasetProfile,
  DimensionHierarchy,
} from "../shared/schema.js";

export interface DetectRollupOptions {
  /** Top value's share of column total ≥ this. Default 0.7. */
  minDominance?: number;
  /** Top value's measure ≥ this × second-highest value's measure. Default 4. */
  minTopRatio?: number;
  /** Minimum distinct values in the dimension column. Default 4. */
  minCardinality?: number;
  /** Maximum distinct values in the dimension column. Default 30. */
  maxCardinality?: number;
  /** Cap how many child values to record on the hierarchy. Default 25. */
  maxItemValues?: number;
}

interface GroupTotal {
  value: string;
  total: number;
}

const DEFAULTS: Required<DetectRollupOptions> = {
  minDominance: 0.7,
  minTopRatio: 4,
  minCardinality: 4,
  maxCardinality: 30,
  maxItemValues: 25,
};

function pickMeasureColumns(params: {
  summary: DataSummary;
  datasetProfile?: DatasetProfile;
}): string[] {
  const profileMeasures = params.datasetProfile?.measureColumns ?? [];
  const numericSet = new Set(params.summary.numericColumns ?? []);
  const ordered: string[] = [];
  for (const c of profileMeasures) {
    if (numericSet.has(c) && !ordered.includes(c)) ordered.push(c);
  }
  for (const c of params.summary.numericColumns ?? []) {
    if (!ordered.includes(c)) ordered.push(c);
  }
  return ordered;
}

function pickDimensionColumns(summary: DataSummary): string[] {
  const numeric = new Set(summary.numericColumns ?? []);
  const dates = new Set(summary.dateColumns ?? []);
  return summary.columns
    .filter((c) => !numeric.has(c.name) && !dates.has(c.name))
    .filter((c) => c.type !== "number" && c.type !== "date")
    .map((c) => c.name);
}

function groupByDimensionTotals(
  data: Record<string, unknown>[],
  dimension: string,
  measure: string
): GroupTotal[] {
  const totals = new Map<string, number>();
  for (const row of data) {
    const rawDim = row[dimension];
    if (rawDim == null) continue;
    const key = String(rawDim).trim();
    if (!key) continue;
    const rawVal = row[measure];
    let n: number | null = null;
    if (typeof rawVal === "number" && Number.isFinite(rawVal)) {
      n = rawVal;
    } else if (typeof rawVal === "string" && rawVal.trim() !== "") {
      const parsed = Number(rawVal);
      if (Number.isFinite(parsed)) n = parsed;
    }
    if (n == null) continue;
    totals.set(key, (totals.get(key) ?? 0) + n);
  }
  const out: GroupTotal[] = [];
  for (const [value, total] of totals) {
    if (total > 0) out.push({ value, total });
  }
  out.sort((a, b) => b.total - a.total);
  return out;
}

interface CandidateScore {
  rollupValue: string;
  itemValues: string[];
  measureColumn: string;
  dominance: number;
  topRatio: number;
}

function scoreCandidate(
  groups: GroupTotal[],
  measureColumn: string,
  opts: Required<DetectRollupOptions>
): CandidateScore | null {
  if (groups.length < opts.minCardinality) return null;
  if (groups.length > opts.maxCardinality) return null;
  const top = groups[0];
  const second = groups[1];
  if (!top || !second) return null;
  if (top.total <= 0 || second.total <= 0) return null;
  const total = groups.reduce((acc, g) => acc + g.total, 0);
  if (total <= 0) return null;
  const dominance = top.total / total;
  if (dominance < opts.minDominance) return null;
  const topRatio = top.total / second.total;
  if (topRatio < opts.minTopRatio) return null;
  return {
    rollupValue: top.value,
    itemValues: groups.slice(1, 1 + opts.maxItemValues).map((g) => g.value),
    measureColumn,
    dominance,
    topRatio,
  };
}

/**
 * Returns at most one DimensionHierarchy per qualifying dimension
 * column. Picks the strongest signal across all available measure
 * columns (highest combined `dominance × log(topRatio)`).
 */
export function detectRollupHierarchies(params: {
  data: Record<string, unknown>[];
  summary: DataSummary;
  datasetProfile?: DatasetProfile;
  options?: DetectRollupOptions;
}): DimensionHierarchy[] {
  if (!Array.isArray(params.data) || params.data.length === 0) return [];
  const opts: Required<DetectRollupOptions> = { ...DEFAULTS, ...params.options };
  const dimensions = pickDimensionColumns(params.summary);
  const measures = pickMeasureColumns(params);
  if (dimensions.length === 0 || measures.length === 0) return [];

  const detected: DimensionHierarchy[] = [];
  for (const dim of dimensions) {
    let best: CandidateScore | null = null;
    let bestScore = -Infinity;
    for (const measure of measures) {
      const groups = groupByDimensionTotals(params.data, dim, measure);
      const cand = scoreCandidate(groups, measure, opts);
      if (!cand) continue;
      const score = cand.dominance * Math.log(1 + cand.topRatio);
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    if (!best) continue;
    detected.push({
      column: dim,
      rollupValue: best.rollupValue,
      itemValues: best.itemValues,
      source: "auto",
      description: `Auto-detected: "${best.rollupValue}" totals ${(best.dominance * 100).toFixed(0)}% of "${dim}" via ${best.measureColumn} and is ${best.topRatio.toFixed(1)}× the next-highest value.`,
    });
  }
  return detected;
}
