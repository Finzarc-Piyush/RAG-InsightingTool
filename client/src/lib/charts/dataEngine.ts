/**
 * In-house data engine for client-side chart re-derivation. WC2.2.
 *
 * Pure functions. No DOM, no React. Designed to be small (~200 LOC)
 * and replace the parts of `chartGenerator.ts` / `chartSpecCompiler.ts`
 * that we need running in the browser when an encoding shelf changes.
 *
 * If/when we hit pivot-style joins or rolling windows that exceed
 * what's reasonable to hand-roll, swap to Arquero behind the same
 * function signatures.
 */

import type { ChartAggOp, ChartTransform } from "@/shared/schema";
import { asNumber, asString } from "./encodingResolver";

export type Row = Record<string, unknown>;
export type Predicate = (row: Row) => boolean;

// ────────────────────────────────────────────────────────────────────────
// Group by
// ────────────────────────────────────────────────────────────────────────

/**
 * Group rows by one or more key columns. Composite keys are joined
 * with a unit-separator that won't appear in user data.
 */
const KEY_SEP = "";

export function groupBy(rows: Row[], keys: string[]): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  if (keys.length === 0) {
    out.set("", rows);
    return out;
  }
  for (const r of rows) {
    const k = keys.map((kk) => asString(r[kk])).join(KEY_SEP);
    const arr = out.get(k);
    if (arr) arr.push(r);
    else out.set(k, [r]);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Aggregation
// ────────────────────────────────────────────────────────────────────────

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

/** Reduce an array of values down to a single number per the op. */
export function aggregate(values: number[], op: ChartAggOp): number {
  const finite = values.filter((v): v is number => Number.isFinite(v));
  if (op === "count") return values.length;
  if (op === "distinct") return new Set(values).size;
  if (finite.length === 0) return Number.NaN;
  switch (op) {
    case "sum":
      return finite.reduce((a, b) => a + b, 0);
    case "mean":
      return finite.reduce((a, b) => a + b, 0) / finite.length;
    case "min":
      return Math.min(...finite);
    case "max":
      return Math.max(...finite);
    case "median":
    case "p50":
      return quantile([...finite].sort((a, b) => a - b), 0.5);
    case "p25":
      return quantile([...finite].sort((a, b) => a - b), 0.25);
    case "p75":
      return quantile([...finite].sort((a, b) => a - b), 0.75);
    case "p95":
      return quantile([...finite].sort((a, b) => a - b), 0.95);
    case "stdev": {
      const m = finite.reduce((a, b) => a + b, 0) / finite.length;
      const v =
        finite.reduce((a, b) => a + (b - m) ** 2, 0) /
        Math.max(1, finite.length - 1);
      return Math.sqrt(v);
    }
    case "variance": {
      const m = finite.reduce((a, b) => a + b, 0) / finite.length;
      return (
        finite.reduce((a, b) => a + (b - m) ** 2, 0) /
        Math.max(1, finite.length - 1)
      );
    }
    default:
      return Number.NaN;
  }
}

export interface AggregateSpec {
  groupby: string[];
  ops: Array<{ op: ChartAggOp; field: string; as: string }>;
}

/** Group + reduce → one row per distinct group. */
export function aggregateGroups(rows: Row[], spec: AggregateSpec): Row[] {
  const grouped = groupBy(rows, spec.groupby);
  const out: Row[] = [];
  for (const [, groupRows] of grouped) {
    const groupOut: Row = {};
    // Echo the group keys.
    if (groupRows[0]) {
      for (const k of spec.groupby) groupOut[k] = groupRows[0]![k];
    }
    for (const op of spec.ops) {
      const values = groupRows.map((r) => asNumber(r[op.field]));
      groupOut[op.as] = aggregate(values, op.op);
    }
    out.push(groupOut);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Filter / sort
// ────────────────────────────────────────────────────────────────────────

export function filterRows(rows: Row[], predicate: Predicate): Row[] {
  return rows.filter(predicate);
}

export function sortRows(
  rows: Row[],
  key: string,
  order: "asc" | "desc" = "asc",
): Row[] {
  const dir = order === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av === bv) return 0;
    if (av == null) return 1 * dir;
    if (bv == null) return -1 * dir;
    if (typeof av === "number" && typeof bv === "number") {
      return (av - bv) * dir;
    }
    return String(av).localeCompare(String(bv)) * dir;
  });
}

// ────────────────────────────────────────────────────────────────────────
// Bin (histogram-style numeric binning)
// ────────────────────────────────────────────────────────────────────────

export interface BinResult {
  start: number;
  end: number;
  label: string;
}

/** Compute bin boundaries (Sturges' rule, capped at maxbins). */
export function computeBins(
  values: number[],
  maxbins = 20,
): { boundaries: number[]; binIndex: (v: number) => number } {
  const finite = values.filter((v): v is number => Number.isFinite(v));
  if (finite.length === 0) {
    return { boundaries: [], binIndex: () => -1 };
  }
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const sturges = Math.ceil(Math.log2(finite.length) + 1);
  const n = Math.max(1, Math.min(maxbins, sturges));
  const step = (max - min) / n || 1;
  const boundaries: number[] = [];
  for (let i = 0; i <= n; i++) boundaries.push(min + i * step);
  const binIndex = (v: number) => {
    if (!Number.isFinite(v)) return -1;
    if (v >= max) return n - 1;
    return Math.min(n - 1, Math.max(0, Math.floor((v - min) / step)));
  };
  return { boundaries, binIndex };
}

/** Produce a new column on each row with the bin start / end / label. */
export function binNumeric(
  rows: Row[],
  field: string,
  as: string,
  maxbins = 20,
): Row[] {
  const values = rows.map((r) => asNumber(r[field]));
  const { boundaries, binIndex } = computeBins(values, maxbins);
  return rows.map((r) => {
    const i = binIndex(asNumber(r[field]));
    if (i < 0) return { ...r, [as]: null };
    const start = boundaries[i]!;
    const end = boundaries[i + 1]!;
    const label = `${start.toFixed(2)}–${end.toFixed(2)}`;
    return { ...r, [as]: label, [`${as}_start`]: start, [`${as}_end`]: end };
  });
}

// ────────────────────────────────────────────────────────────────────────
// Top-N + "Others" merge (mirrors v1 server-side 15-cap behavior)
// ────────────────────────────────────────────────────────────────────────

export function topNAndOther(
  rows: Row[],
  groupKey: string,
  valueField: string,
  n = 15,
  otherLabel = "Others",
): Row[] {
  if (rows.length <= n) return rows;
  const totals = aggregateGroups(rows, {
    groupby: [groupKey],
    ops: [{ op: "sum", field: valueField, as: "_total" }],
  });
  const ranked = sortRows(totals, "_total", "desc");
  const keep = new Set(ranked.slice(0, n).map((r) => asString(r[groupKey])));
  return rows.map((r) =>
    keep.has(asString(r[groupKey]))
      ? r
      : { ...r, [groupKey]: otherLabel },
  );
}

// ────────────────────────────────────────────────────────────────────────
// Sampling (stratified, for scatter density mitigation)
// ────────────────────────────────────────────────────────────────────────

export function sample(rows: Row[], maxN: number): Row[] {
  if (rows.length <= maxN || maxN <= 0) return rows;
  const step = Math.ceil(rows.length / maxN);
  const out: Row[] = [];
  for (let i = 0; i < rows.length && out.length < maxN; i += step) {
    out.push(rows[i]!);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Window operations
// ────────────────────────────────────────────────────────────────────────

export type WindowOp =
  | "row_number"
  | "rank"
  | "cumsum"
  | "cummean"
  | "cummax"
  | "cummin"
  | "moving_avg"
  | "moving_sum"
  | "lag"
  | "lead";

export interface WindowSpec {
  op: WindowOp;
  field?: string;
  as: string;
  window?: number;
}

export function applyWindow(
  rows: Row[],
  spec: WindowSpec,
  groupBy?: string[],
): Row[] {
  // Partition first so window ops respect group boundaries.
  if (groupBy?.length) {
    const grouped = Array.from(
      groupBy.reduce<Map<string, Row[]>>((m, k) => {
        for (const r of rows) {
          const key = asString(r[k]);
          const arr = m.get(key) ?? [];
          arr.push(r);
          m.set(key, arr);
        }
        return m;
      }, new Map()).values(),
    );
    return grouped.flatMap((g) => applyWindow(g, spec));
  }

  const out: Row[] = [];
  let acc = 0;
  let cnt = 0;
  let runMax = -Infinity;
  let runMin = Infinity;
  const buf: number[] = [];
  const w = spec.window ?? 7;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const v = spec.field ? asNumber(r[spec.field]) : Number.NaN;
    let value: number | null = null;
    switch (spec.op) {
      case "row_number":
        value = i + 1;
        break;
      case "rank": {
        // Simple rank by value within partition.
        const allValues = rows.map((rr) =>
          spec.field ? asNumber(rr[spec.field]) : 0,
        );
        const sorted = [...allValues].sort((a, b) => b - a);
        value = sorted.indexOf(v) + 1;
        break;
      }
      case "cumsum":
        if (Number.isFinite(v)) acc += v;
        value = acc;
        break;
      case "cummean":
        if (Number.isFinite(v)) {
          acc += v;
          cnt++;
        }
        value = cnt > 0 ? acc / cnt : Number.NaN;
        break;
      case "cummax":
        if (Number.isFinite(v) && v > runMax) runMax = v;
        value = runMax === -Infinity ? Number.NaN : runMax;
        break;
      case "cummin":
        if (Number.isFinite(v) && v < runMin) runMin = v;
        value = runMin === Infinity ? Number.NaN : runMin;
        break;
      case "moving_sum":
      case "moving_avg":
        if (Number.isFinite(v)) buf.push(v);
        if (buf.length > w) buf.shift();
        if (spec.op === "moving_sum")
          value = buf.reduce((a, b) => a + b, 0);
        else
          value =
            buf.length > 0
              ? buf.reduce((a, b) => a + b, 0) / buf.length
              : Number.NaN;
        break;
      case "lag":
        value = i - (w || 1) >= 0 ? asNumber(rows[i - (w || 1)]![spec.field!]) : null;
        break;
      case "lead":
        value =
          i + (w || 1) < rows.length
            ? asNumber(rows[i + (w || 1)]![spec.field!])
            : null;
        break;
      default:
        value = null;
    }
    out.push({ ...r, [spec.as]: value });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Apply transform pipeline (subset of ChartTransform that doesn't require
// a server-side expression evaluator). filter / calculate are skipped
// here pending an expression-eval wave.
// ────────────────────────────────────────────────────────────────────────

export function applyTransform(rows: Row[], t: ChartTransform): Row[] {
  switch (t.type) {
    case "aggregate":
      return aggregateGroups(rows, t);
    case "bin":
      return binNumeric(rows, t.field, t.as, t.maxbins);
    case "window":
      return t.ops.reduce<Row[]>(
        (acc, op) =>
          applyWindow(
            acc,
            { op: op.op as WindowOp, field: op.field, as: op.as, window: op.window },
            t.groupby,
          ),
        rows,
      );
    case "fold": {
      const [keyAs, valueAs] = t.as;
      const out: Row[] = [];
      for (const r of rows) {
        for (const f of t.fields) {
          out.push({ ...r, [keyAs]: f, [valueAs]: r[f] });
        }
      }
      return out;
    }
    // filter, calculate, regression require expression eval — skipped.
    default:
      return rows;
  }
}

export function applyTransforms(
  rows: Row[],
  transforms: ChartTransform[] | undefined,
): Row[] {
  if (!transforms || transforms.length === 0) return rows;
  return transforms.reduce(applyTransform, rows);
}
