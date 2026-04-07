/**
 * Merges deterministic analytical charts into chat responses (uses insight generator).
 */
import {
  chartSpecSchema,
  type ChartSpec,
  type DataSummary,
  type Insight,
} from "../shared/schema.js";
import type { ParsedQuery } from "../shared/queryTypes.js";
import type { AnalyticalQueryResult } from "./analyticalQueryExecutor.js";
import { processChartData } from "./chartGenerator.js";
import { compileChartSpec } from "./chartSpecCompiler.js";
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
      const { merged: rowCompiled } = compileChartSpec(
        rows as Record<string, unknown>[],
        {
          numericColumns: summary.numericColumns ?? [],
          dateColumns: summary.dateColumns,
        },
        {
          type: spec.type,
          x: spec.x,
          y: spec.y,
          z: spec.z,
          seriesColumn: spec.seriesColumn,
          barLayout: spec.barLayout,
          aggregate: spec.aggregate,
          y2: spec.y2,
          y2Series: spec.y2Series,
          seriesKeys: spec.seriesKeys,
        },
        {
          preserveAggregate: spec.seriesColumn != null && spec.seriesColumn !== "",
          columnOrder: keys,
        }
      );
      const mergedSpec = chartSpecSchema.parse({
        ...spec,
        type: rowCompiled.type,
        x: rowCompiled.x,
        y: rowCompiled.y,
        z: rowCompiled.z,
        seriesColumn: rowCompiled.seriesColumn,
        barLayout: rowCompiled.barLayout,
        aggregate: rowCompiled.aggregate ?? spec.aggregate,
      });
      const processed = processChartData(
        workingData,
        { ...mergedSpec },
        summary.dateColumns,
        { chartQuestion: question }
      );
      if (!processed.length) continue;

      let domains: Record<string, unknown> = {};
      if (mergedSpec.type === "heatmap") {
        domains = {};
      } else if ((mergedSpec as ChartSpec & { seriesKeys?: string[] }).seriesKeys?.length) {
        const sk = (mergedSpec as ChartSpec & { seriesKeys?: string[] }).seriesKeys!;
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
          mergedSpec.x,
          mergedSpec.y,
          mergedSpec.y2 || undefined,
          {
            yOptions: { useIQR: true, paddingPercent: 5, includeOutliers: true },
            y2Options: mergedSpec.y2
              ? { useIQR: true, paddingPercent: 5, includeOutliers: true }
              : undefined,
          }
        );
      }

      const insights = await generateChartInsights(
        mergedSpec,
        processed,
        summary,
        chatInsights
      );
      out.push({
        ...mergedSpec,
        ...domains,
        data: processed,
        keyInsight: insights.keyInsight,
        xLabel: mergedSpec.xLabel || mergedSpec.x,
        yLabel: mergedSpec.yLabel || mergedSpec.y,
      });
      seen.add(chartFingerprint(mergedSpec));
    } catch {
      /* skip */
    }
  }

  return out.length ? out : existing;
}
