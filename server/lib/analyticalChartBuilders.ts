/**
 * Pure builders for analytical chart specs (no LLM / insight side effects).
 */
import type { ChartSpec, DataSummary } from "../shared/schema.js";
import type { ParsedQuery } from "../shared/queryTypes.js";
import { findMatchingColumn } from "./agents/utils/columnMatcher.js";

export function shouldBuildDeterministicAnalyticalCharts(
  question: string,
  parsedQuery: ParsedQuery | null | undefined,
  rowKeys: string[]
): boolean {
  if (rowKeys.length < 2) return false;
  const g = parsedQuery?.groupBy?.length ?? 0;
  if (g >= 2) return true;
  const q = question.toLowerCase();
  if (
    /\b(chart|graph|plot|visualize|visualisation|visualization|breakdown)\b/i.test(q)
  ) {
    return true;
  }
  const byMatches = q.match(/\bby\b/g);
  if (byMatches && byMatches.length >= 2) return true;
  if (/\bby\b.+\b(and|per)\b.+/i.test(q)) return true;
  if (/\bgive me\b.+\bby\b.+\bby\b/i.test(q)) return true;
  return false;
}

function resolveMeasureColumn(
  keys: string[],
  rows: Record<string, unknown>[],
  summary: DataSummary,
  parsedQuery: ParsedQuery | null | undefined
): string | null {
  if (parsedQuery?.aggregations?.length) {
    const agg = parsedQuery.aggregations[0];
    const alias = agg.alias || `${agg.column}_${agg.operation}`;
    const m = findMatchingColumn(alias, keys) || keys.find((k) => k === alias);
    if (m) return m;
  }
  for (const name of summary.numericColumns) {
    const m = findMatchingColumn(name, keys);
    if (m) return m;
  }
  for (const k of keys) {
    let ok = 0;
    let n = 0;
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const v = rows[i][k];
      n++;
      if (typeof v === "number" && Number.isFinite(v)) ok++;
      else if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)))
        ok++;
    }
    if (n > 0 && ok / n > 0.55) return k;
  }
  return null;
}

function matchKey(keys: string[], name: string): string | null {
  return findMatchingColumn(name, keys) || (keys.includes(name) ? name : null);
}

export function buildAnalyticalChartSpecs(
  rows: Record<string, unknown>[],
  summary: DataSummary,
  parsedQuery: ParsedQuery | null | undefined,
  _question: string
): ChartSpec[] {
  if (!rows.length) return [];
  const keys = Object.keys(rows[0]);
  const measure = resolveMeasureColumn(keys, rows, summary, parsedQuery);
  if (!measure) return [];

  const groupByRaw = parsedQuery?.groupBy ?? [];
  const resolvedGroup = groupByRaw
    .map((g) => matchKey(keys, g))
    .filter((x): x is string => Boolean(x));

  const useAnalytical = true;

  if (resolvedGroup.length >= 2) {
    const xDim = resolvedGroup[0];
    const seriesDim = resolvedGroup[1];
    if (xDim === measure || seriesDim === measure) return [];

    const nSeries = new Set(rows.map((r) => String(r[seriesDim] ?? ""))).size;
    const nX = new Set(rows.map((r) => String(r[xDim] ?? ""))).size;
    const preferHeatmap = nSeries > 14 || nX > 22;

    if (preferHeatmap) {
      return [
        {
          type: "heatmap",
          title: `${measure} (${xDim} × ${seriesDim})`,
          x: xDim,
          y: seriesDim,
          z: measure,
          xLabel: xDim,
          yLabel: seriesDim,
          zLabel: measure,
          aggregate: "sum",
          _useAnalyticalDataOnly: useAnalytical,
        } as ChartSpec,
      ];
    }
    return [
      {
        type: "bar",
        title: `${measure} by ${xDim} and ${seriesDim}`,
        x: xDim,
        y: measure,
        seriesColumn: seriesDim,
        barLayout: "stacked",
        aggregate: "sum",
        xLabel: xDim,
        yLabel: measure,
        _useAnalyticalDataOnly: useAnalytical,
      } as ChartSpec,
    ];
  }

  if (resolvedGroup.length === 1 && measure) {
    const xDim = resolvedGroup[0];
    if (xDim === measure) return [];
    return [
      {
        type: "bar",
        title: `${measure} by ${xDim}`,
        x: xDim,
        y: measure,
        aggregate: "sum",
        xLabel: xDim,
        yLabel: measure,
        _useAnalyticalDataOnly: useAnalytical,
      } as ChartSpec,
    ];
  }

  const catCandidates = keys.filter((k) => {
    if (k === measure) return false;
    if (summary.dateColumns.includes(k)) return true;
    if (summary.numericColumns.includes(k)) return false;
    return true;
  });

  if (catCandidates.length >= 2) {
    const xDim = catCandidates[0];
    const seriesDim = catCandidates[1];
    const nSeries = new Set(rows.map((r) => String(r[seriesDim] ?? ""))).size;
    const nX = new Set(rows.map((r) => String(r[xDim] ?? ""))).size;
    if (nSeries <= 1 || nX <= 1) return [];

    const preferHeatmap = nSeries > 14 || nX > 22;
    if (preferHeatmap) {
      return [
        {
          type: "heatmap",
          title: `${measure} (${xDim} × ${seriesDim})`,
          x: xDim,
          y: seriesDim,
          z: measure,
          xLabel: xDim,
          yLabel: seriesDim,
          zLabel: measure,
          aggregate: "sum",
          _useAnalyticalDataOnly: useAnalytical,
        } as ChartSpec,
      ];
    }
    return [
      {
        type: "bar",
        title: `${measure} by ${xDim} and ${seriesDim}`,
        x: xDim,
        y: measure,
        seriesColumn: seriesDim,
        barLayout: "stacked",
        aggregate: "sum",
        xLabel: xDim,
        yLabel: measure,
        _useAnalyticalDataOnly: useAnalytical,
      } as ChartSpec,
    ];
  }

  return [];
}
