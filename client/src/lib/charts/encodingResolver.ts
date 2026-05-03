/**
 * Encoding resolver — turns a v2 ChartSpec encoding into the concrete
 * accessor functions and value summaries that renderers need.
 *
 * This is intentionally small for WC0.3 (bar mark only). It will grow
 * as new marks land. Each renderer takes resolved encodings + raw rows
 * and produces visx scales / shapes.
 */

import type { ChartEncodingChannel, ChartSpecV2 } from "@/shared/schema";

export type Row = Record<string, unknown>;

export interface ResolvedChannel<T = unknown> {
  field: string;
  type: ChartEncodingChannel["type"];
  /** Pure accessor — pulls the value for this channel from a row. */
  accessor: (row: Row) => T;
  /** Optional pre-formatted display value. */
  format?: (v: T) => string;
}

/**
 * Coerce row[field] into a number. Returns NaN if not coercible.
 * Used by quantitative encodings.
 */
export function asNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? n : Number.NaN;
  }
  if (v == null) return Number.NaN;
  return Number(v);
}

/** Coerce to display string. */
export function asString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function resolveChannel(
  channel: ChartEncodingChannel | undefined
): ResolvedChannel | null {
  if (!channel?.field) return null;
  const field = channel.field;
  const type = channel.type;
  const accessor =
    type === "q"
      ? (row: Row) => asNumber(row[field])
      : (row: Row) => row[field];
  return { field, type, accessor };
}

export interface ResolvedBarEncoding {
  x: ResolvedChannel<unknown>;
  y: ResolvedChannel<number>;
  color?: ResolvedChannel<unknown>;
}

/**
 * Resolves the encoding for a `bar` mark. Throws (caller renders an
 * error state) if required channels are missing.
 */
export function resolveBarEncoding(spec: ChartSpecV2): ResolvedBarEncoding {
  const x = resolveChannel(spec.encoding.x);
  const y = resolveChannel(spec.encoding.y);
  if (!x) throw new Error("bar mark requires an x encoding with a field");
  if (!y) throw new Error("bar mark requires a y encoding with a field");
  if (y.type !== "q") {
    throw new Error("bar mark requires y to be quantitative (type='q')");
  }
  const color = resolveChannel(spec.encoding.color) ?? undefined;
  return {
    x,
    y: y as ResolvedChannel<number>,
    color,
  };
}

/**
 * Compute [min, max] over a numeric accessor. Returns [0, 1] for empty
 * input so scales remain valid.
 */
export function numericExtent(
  rows: Row[],
  accessor: (row: Row) => number
): [number, number] {
  if (!rows.length) return [0, 1];
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows) {
    const v = accessor(r);
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) return [Math.min(0, min), Math.max(0, max + 1)];
  return [min, max];
}

/**
 * Pad a numeric domain by paddingFraction on each side. Mirrors the
 * legacy `getDynamicDomain` helper (paddingFraction default 0.1) so v2
 * charts match v1 axis padding by default.
 */
export function paddedDomain(
  extent: [number, number],
  paddingFraction = 0.1
): [number, number] {
  const [min, max] = extent;
  const span = max - min;
  if (span === 0) return [min - 1, max + 1];
  const pad = span * paddingFraction;
  return [min - pad, max + pad];
}

/**
 * Distinct categorical values from a column, preserving first-seen order.
 * Used to derive the band-scale domain for categorical x in bars.
 */
export function distinctOrdered(
  rows: Row[],
  accessor: (row: Row) => unknown
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const v = asString(accessor(r));
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}
