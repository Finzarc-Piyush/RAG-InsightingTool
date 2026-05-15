/**
 * Merges deterministic analytical charts into chat responses (uses insight generator).
 *
 * Wave B3 · Forward-compat synthesis-context plumbing. The current agent
 * loop does NOT call `mergeDeterministicAnalyticalCharts` (it's imported
 * by `dataAnalyzer.ts` but no live call site references it — verified by
 * grep at audit time). Kept as a public surface in case the
 * deterministic-charts shortcut is re-enabled. The function now accepts
 * an optional `synthesisContext` and forwards it to `generateChartInsights`
 * so the future re-wiring doesn't lose the contract.
 *
 * Live chart-insight callers that already pass full context (audited as
 * part of Wave B3):
 *   - `services/chat/chatStream.service.ts:enrichCharts` callsite (line 1270)
 *   - `services/chat/chat.service.ts:enrichCharts` callsite (line 205)
 *   - `controllers/sessionController.ts:postChartKeyInsightEndpoint` (PVT1)
 *   - `lib/correlationAnalyzer.ts:350` (W12)
 *
 * Live callers that pass NO synthesis context (acceptable because no
 * user question is in scope yet — upload-time first-look chart
 * insights):
 *   - `lib/dataAnalyzer.ts:183, 324` — upload-time, no user question
 *     and no SAC yet (enrichment hasn't completed).
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
import type { ChartInsightSynthesisContext } from "./insightSynthesis/types.js";
import {
  calculateSmartDomainsForChart,
  multiSeriesYDomainKind,
  yDomainForMultiSeriesRows,
} from "./axisScaling.js";
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
  chatInsights?: Insight[],
  // Wave B3 · Forward-compat. If callers (future re-wiring) pass this,
  // the chart insights are grounded in the user's question + session
  // context + domain context exactly like the live `enrichCharts` path.
  synthesisContext?: ChartInsightSynthesisContext
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
        domains = yDomainForMultiSeriesRows(
          processed,
          sk,
          multiSeriesYDomainKind(mergedSpec.type, mergedSpec.barLayout)
        );
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
        chatInsights,
        // Wave B3 · forward `synthesisContext` so the LLM sees user
        // question + session + permanent + domain context. Undefined
        // when the caller didn't supply one (matches pre-B3 behavior).
        synthesisContext
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
