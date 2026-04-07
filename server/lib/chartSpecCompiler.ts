/**
 * Completes chart specs from tabular shape so multi-dimensional long frames
 * always bind a series (or heatmap) — no silent drop of categorical columns.
 */

import { findMatchingColumn } from "./agents/utils/columnMatcher.js";
import type { ChartSpec } from "../shared/schema.js";

export type ChartCompileSummary = {
  numericColumns: string[];
  dateColumns?: string[];
};

export type ChartCompileProposal = {
  type: ChartSpec["type"];
  x: string;
  y: string;
  z?: string;
  seriesColumn?: string;
  barLayout?: "stacked" | "grouped";
  aggregate?: ChartSpec["aggregate"];
  y2?: string;
  y2Series?: string[];
  seriesKeys?: string[];
  title?: string;
};

const HEATMAP_MAX_COL_KEYS = 24;
const HEATMAP_MAX_ROW_KEYS = 40;
/** Avoid binding spurious series when `rows` are wide raw fact tables with many string columns. */
const MAX_DIMENSIONS_FOR_AUTO_BIND = 6;
const MAX_COLUMNS_FOR_AUTO_BIND = 20;

const AGG_SUFFIX = /_(sum|avg|mean|min|max|count)$/i;

function toNumberLoose(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[%,]/g, "").trim();
    if (cleaned && Number.isFinite(Number(cleaned))) return Number(cleaned);
  }
  return null;
}

/** Sample-based: column is treated as a measure if mostly numeric. */
export function columnIsMeasureLike(
  col: string,
  rows: Record<string, unknown>[],
  numericSchema: Set<string>
): boolean {
  if (numericSchema.has(col)) return true;
  if (AGG_SUFFIX.test(col)) return true;
  const cap = Math.min(40, rows.length);
  let n = 0;
  let numeric = 0;
  for (let i = 0; i < cap; i++) {
    const v = rows[i]?.[col];
    if (v === null || v === undefined || v === "") continue;
    n++;
    if (toNumberLoose(v) !== null) numeric++;
  }
  return n >= 2 && numeric / n >= 0.55;
}

/** Ordered column list: prefer explicit order, else first row key order. */
export function orderedColumns(
  rows: Record<string, unknown>[],
  columnOrder?: string[] | null
): string[] {
  if (!rows.length) return [];
  const fromRow = Object.keys(rows[0] ?? {});
  if (!columnOrder?.length) return fromRow;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of columnOrder) {
    if (!c || seen.has(c)) continue;
    if (!fromRow.includes(c)) continue;
    seen.add(c);
    out.push(c);
  }
  for (const c of fromRow) {
    if (!seen.has(c)) out.push(c);
  }
  return out;
}

export function classifyFrame(
  rows: Record<string, unknown>[],
  summary: ChartCompileSummary,
  columnOrder?: string[] | null
): { dimensions: string[]; measures: string[]; columns: string[] } {
  const columns = orderedColumns(rows, columnOrder);
  const numericSchema = new Set(summary.numericColumns ?? []);
  const dimensions: string[] = [];
  const measures: string[] = [];
  for (const col of columns) {
    if (columnIsMeasureLike(col, rows, numericSchema)) {
      if (!measures.includes(col)) measures.push(col);
    } else {
      if (!dimensions.includes(col)) dimensions.push(col);
    }
  }
  return { dimensions, measures, columns };
}

function isCorrelationSpecial(proposal: ChartCompileProposal): boolean {
  const x = proposal.x?.trim().toLowerCase();
  const y = proposal.y?.trim().toLowerCase();
  return (
    (x === "variable" && y === "correlation") ||
    (proposal.type === "bar" && x === "variable" && y === "correlation")
  );
}

function xColumnIsDateLike(
  xCol: string,
  summary: ChartCompileSummary
): boolean {
  return (summary.dateColumns ?? []).some((d) => d === xCol);
}

function inferAggregateForLongSeries(
  rows: Record<string, unknown>[],
  xKey: string,
  seriesKey: string
): "sum" | "none" {
  const pairCounts = new Map<string, number>();
  const cap = Math.min(rows.length, 8000);
  for (let i = 0; i < cap; i++) {
    const row = rows[i];
    if (!row) continue;
    const xv = row[xKey];
    const sv = row[seriesKey];
    if (xv === null || xv === undefined || xv === "") continue;
    if (sv === null || sv === undefined || sv === "") continue;
    const k = `${String(xv)}\x1f${String(sv)}`;
    pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1);
  }
  let maxDup = 0;
  for (const c of pairCounts.values()) maxDup = Math.max(maxDup, c);
  return maxDup <= 1 ? "none" : "sum";
}

function uniqueCount(
  rows: Record<string, unknown>[],
  col: string,
  cap = 5000
): number {
  const s = new Set<string>();
  for (let i = 0; i < Math.min(rows.length, cap); i++) {
    const v = rows[i]?.[col];
    if (v === null || v === undefined || v === "") continue;
    s.add(String(v));
  }
  return s.size;
}

/**
 * Merge compiler output into a chart proposal. Call before chartSpecSchema.parse + processChartData.
 */
export function compileChartSpec(
  rows: Record<string, unknown>[],
  summary: ChartCompileSummary,
  proposal: ChartCompileProposal,
  options?: {
    columnOrder?: string[] | null;
    preserveAggregate?: boolean;
    /** Pivot-flattened rows are shaped for bar/line series; do not switch to heatmap here. */
    disallowHeatmapUpgrade?: boolean;
  }
): { merged: ChartCompileProposal; warnings: string[] } {
  const warnings: string[] = [];
  if (!rows.length || !proposal.x?.trim() || !proposal.y?.trim()) {
    return { merged: { ...proposal }, warnings };
  }

  const merged: ChartCompileProposal = { ...proposal };
  const { dimensions, measures, columns } = classifyFrame(
    rows,
    summary,
    options?.columnOrder ?? null
  );

  if (measures.length === 0 || dimensions.length === 0) {
    return { merged, warnings };
  }

  const available = columns;
  const matchedX = findMatchingColumn(proposal.x, available) || proposal.x;
  const matchedY = findMatchingColumn(proposal.y, available) || proposal.y;

  if (isCorrelationSpecial({ ...merged, x: matchedX, y: matchedY })) {
    return { merged: { ...merged, x: matchedX, y: matchedY }, warnings };
  }

  if (
    merged.type === "scatter" ||
    merged.type === "pie" ||
    merged.type === "heatmap"
  ) {
    return { merged: { ...merged, x: matchedX, y: matchedY }, warnings };
  }

  if (merged.y2 || (merged.y2Series && merged.y2Series.length > 0)) {
    return { merged: { ...merged, x: matchedX, y: matchedY }, warnings };
  }

  if (merged.seriesKeys && merged.seriesKeys.length > 0) {
    return { merged: { ...merged, x: matchedX, y: matchedY }, warnings };
  }

  if (merged.type !== "bar" && merged.type !== "line" && merged.type !== "area") {
    return { merged: { ...merged, x: matchedX, y: matchedY }, warnings };
  }

  // Long frame: ≥2 dimensions + at least one measure column in data
  if (dimensions.length < 2) {
    return { merged: { ...merged, x: matchedX, y: matchedY }, warnings };
  }

  if (
    dimensions.length > MAX_DIMENSIONS_FOR_AUTO_BIND ||
    columns.length > MAX_COLUMNS_FOR_AUTO_BIND
  ) {
    return { merged: { ...merged, x: matchedX, y: matchedY }, warnings };
  }

  const measureSet = new Set(measures);
  if (!measureSet.has(matchedY) && !columnIsMeasureLike(matchedY, rows, new Set(summary.numericColumns ?? []))) {
    return { merged: { ...merged, x: matchedX, y: matchedY }, warnings };
  }

  // 3+ dimensions on bar: prefer heatmap when cardinality allows (skip for temporal line/area)
  if (
    !options?.disallowHeatmapUpgrade &&
    merged.type === "bar" &&
    dimensions.length >= 3 &&
    !xColumnIsDateLike(matchedX, summary)
  ) {
    if (!dimensions.includes(matchedX)) {
      return { merged: { ...merged, x: matchedX, y: matchedY }, warnings };
    }
    const yDim = dimensions.find((d) => d !== matchedX);
    if (!yDim) {
      return { merged: { ...merged, x: matchedX, y: matchedY }, warnings };
    }
    const nx = uniqueCount(rows, matchedX);
    const ny = uniqueCount(rows, yDim);
    if (
      nx > 0 &&
      ny > 0 &&
      nx <= HEATMAP_MAX_ROW_KEYS &&
      ny <= HEATMAP_MAX_COL_KEYS
    ) {
      merged.type = "heatmap";
      merged.x = matchedX;
      merged.y = yDim;
      merged.z = matchedY;
      delete merged.seriesColumn;
      delete merged.barLayout;
      if (!options?.preserveAggregate) {
        merged.aggregate = "sum";
      }
      warnings.push(
        `compile: upgraded bar→heatmap for ${dimensions.length} dimensions (${matchedX}×${yDim}, z=${matchedY}).`
      );
      return { merged, warnings };
    }
  }

  if (merged.seriesColumn?.trim()) {
    const ms =
      findMatchingColumn(merged.seriesColumn, available) || merged.seriesColumn;
    merged.seriesColumn = ms;
    if (!options?.preserveAggregate) {
      const inferred = inferAggregateForLongSeries(rows, matchedX, ms);
      merged.aggregate = inferred;
    }
    merged.x = matchedX;
    merged.y = matchedY;
    if (!merged.barLayout) merged.barLayout = "stacked";
    return { merged, warnings };
  }

  const secondDim = dimensions.find((d) => d !== matchedX);
  if (!secondDim) {
    return { merged: { ...merged, x: matchedX, y: matchedY }, warnings };
  }

  const seriesMatched =
    findMatchingColumn(secondDim, available) || secondDim;
  merged.seriesColumn = seriesMatched;
  if (!merged.barLayout) merged.barLayout = "stacked";

  if (!options?.preserveAggregate) {
    merged.aggregate = inferAggregateForLongSeries(rows, matchedX, seriesMatched);
  }

  merged.x = matchedX;
  merged.y = matchedY;

  warnings.push(
    `compile: set seriesColumn=${seriesMatched} for long multi-dimension frame.`
  );
  return { merged, warnings };
}
