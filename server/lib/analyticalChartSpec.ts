/**
 * Merges deterministic analytical charts into chat responses (uses insight generator).
 */
import type { ChartSpec, DataSummary, Insight } from "../shared/schema.js";
import type { ParsedQuery } from "../shared/queryTypes.js";
import type { AnalyticalQueryResult } from "./analyticalQueryExecutor.js";
import { processChartData } from "./chartGenerator.js";
import { generateChartInsights } from "./insightGenerator.js";
import { calculateSmartDomainsForChart } from "./axisScaling.js";
import {
  buildAnalyticalChartSpecs,
  shouldBuildDeterministicAnalyticalCharts,
} from "./analyticalChartBuilders.js";

export { buildAnalyticalChartSpecs, shouldBuildDeterministicAnalyticalCharts } from "./analyticalChartBuilders.js";

function chartFingerprint(c: ChartSpec): string {
  const s = (c as ChartSpec & { seriesColumn?: string }).seriesColumn ?? "";
  const z = (c as ChartSpec & { z?: string }).z ?? "";
  return `${c.type}|${c.x}|${c.y}|${s}|${z}`;
}

export async function mergeDeterministicAnalyticalCharts(
  existing: ChartSpec[] | undefined,
  workingData: Record<string, any>[],
  summary: DataSummary,
  parsedQuery: ParsedQuery | null | undefined,
  question: string,
  analyticalResult: AnalyticalQueryResult | null,
  chatInsights?: Insight[]
): Promise<ChartSpec[] | undefined> {
  if (
    !analyticalResult?.isAnalytical ||
    !analyticalResult.queryResults?.data?.length
  ) {
    return existing;
  }
  const rows = analyticalResult.queryResults.data;
  const keys = Object.keys(rows[0] ?? {});
  if (
    !shouldBuildDeterministicAnalyticalCharts(question, parsedQuery, keys)
  ) {
    return existing;
  }

  const specs = buildAnalyticalChartSpecs(
    rows as Record<string, unknown>[],
    summary,
    parsedQuery,
    question
  ).slice(0, 2);
  if (!specs.length) return existing;

  const seen = new Set((existing ?? []).map(chartFingerprint));
  const out: ChartSpec[] = [...(existing ?? [])];

  for (const spec of specs) {
    if (seen.has(chartFingerprint(spec))) continue;
    try {
      const processed = processChartData(
        workingData,
        { ...spec },
        summary.dateColumns,
        { chartQuestion: question }
      );
      if (!processed.length) continue;

      let domains: Record<string, unknown> = {};
      if (spec.type === "heatmap") {
        domains = {};
      } else if ((spec as ChartSpec & { seriesKeys?: string[] }).seriesKeys?.length) {
        const sk = (spec as ChartSpec & { seriesKeys?: string[] }).seriesKeys!;
        let maxSum = 0;
        for (const row of processed) {
          let s = 0;
          for (const k of sk) {
            const v = row[k];
            const n = typeof v === "number" ? v : Number(v);
            if (Number.isFinite(n)) s += n;
          }
          maxSum = Math.max(maxSum, s);
        }
        domains = { yDomain: [0, maxSum * 1.05] as [number, number] };
      } else {
        domains = calculateSmartDomainsForChart(
          processed,
          spec.x,
          spec.y,
          spec.y2 || undefined,
          {
            yOptions: { useIQR: true, paddingPercent: 5, includeOutliers: true },
            y2Options: spec.y2
              ? { useIQR: true, paddingPercent: 5, includeOutliers: true }
              : undefined,
          }
        );
      }

      const insights = await generateChartInsights(
        spec,
        processed,
        summary,
        chatInsights
      );
      out.push({
        ...spec,
        ...domains,
        data: processed,
        keyInsight: insights.keyInsight,
        xLabel: spec.xLabel || spec.x,
        yLabel: spec.yLabel || spec.y,
      });
      seen.add(chartFingerprint(spec));
    } catch {
      /* skip */
    }
  }

  return out.length ? out : existing;
}
