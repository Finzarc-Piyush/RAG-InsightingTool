/**
 * numberFormatExport.ts — shared number/label formatting for the export renderers.
 *
 * Both the chart engine (chartSsr.ts: axis ticks + data labels) and the slide
 * layouts (table cells, KPI deltas) need consistent, human-readable number
 * formatting — compact magnitudes (1.2K / 3.4M / 1.1B), percent/currency
 * inference from a column name, and thousands separators. Owning it once keeps
 * a chart's axis labels and the table's cells speaking the same language.
 *
 * Pure leaf module: no imports.
 */

export type ColumnFormatKind = "percent" | "currency" | "number";

const PERCENT_RE = /(%|share|\brate\b|\bpct\b|percent|margin|growth|cagr|penetration)/i;
const CURRENCY_RE = /(₫|\$|€|£|¥|₹|revenue|sales|\bvalue\b|price|spend|\bcost\b|gmv|turnover|\bamount\b|\bnsv\b|\bgsv\b)/i;

/** Infer how a column's numeric values should be formatted, from its name. */
export function inferColumnFormat(columnName: string | undefined): ColumnFormatKind {
  const n = columnName ?? "";
  if (PERCENT_RE.test(n)) return "percent";
  if (CURRENCY_RE.test(n)) return "currency";
  return "number";
}

const trimZeros = (s: string): string => s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");

/**
 * Compact magnitude formatting for axis ticks and data labels.
 * 1234 → "1.2K", 3_400_000 → "3.4M", 1_100_000_000 → "1.1B".
 * Sub-unit values keep up to `decimals` places; integers stay bare.
 */
export function formatCompact(
  n: number,
  opts: { decimals?: number; percent?: boolean } = {}
): string {
  if (!Number.isFinite(n)) return "";
  const decimals = opts.decimals ?? 1;
  if (opts.percent) {
    const v = Math.abs(n) <= 1 ? n * 100 : n;
    return `${trimZeros(v.toFixed(1))}%`;
  }
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const fmt = (v: number): string => trimZeros(v.toFixed(decimals));
  if (abs >= 1e12) return `${sign}${fmt(abs / 1e12)}T`;
  if (abs >= 1e9) return `${sign}${fmt(abs / 1e9)}B`;
  if (abs >= 1e6) return `${sign}${fmt(abs / 1e6)}M`;
  if (abs >= 1e3) return `${sign}${fmt(abs / 1e3)}K`;
  if (abs === 0) return "0";
  if (abs < 1) return `${sign}${trimZeros(abs.toFixed(Math.max(decimals, 2)))}`;
  return `${sign}${Number.isInteger(abs) ? String(abs) : fmt(abs)}`;
}

/** Axis-tick formatter — compact, with percent awareness inferred from a label. */
export function formatAxisValue(n: number, axisLabel?: string): string {
  if (!Number.isFinite(n)) return "";
  if (inferColumnFormat(axisLabel) === "percent") {
    return formatCompact(n, { percent: true });
  }
  return formatCompact(n);
}

const groupedInt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const groupedDec = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/**
 * Format a single table cell. Numbers get thousands separators / percent
 * suffix / sensible decimals inferred from the column name; non-numbers pass
 * through as their string form (null/undefined → "").
 */
export function formatCell(value: unknown, columnName?: string): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return String(value);
  }
  const kind = inferColumnFormat(columnName);
  if (kind === "percent") {
    const v = Math.abs(value) <= 1 ? value * 100 : value;
    return `${trimZeros(v.toFixed(1))}%`;
  }
  return Number.isInteger(value) ? groupedInt.format(value) : groupedDec.format(value);
}

/** True when a column's non-null cells are predominantly numeric (for alignment). */
export function columnIsNumeric(rows: ReadonlyArray<ReadonlyArray<unknown>>, colIdx: number): boolean {
  let numeric = 0;
  let total = 0;
  for (const row of rows) {
    const v = row[colIdx];
    if (v === null || v === undefined || v === "") continue;
    total++;
    if (typeof v === "number" && Number.isFinite(v)) numeric++;
    else if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.replace(/[,%₫$€£\s]/g, "")))) numeric++;
  }
  return total > 0 && numeric / total >= 0.6;
}
