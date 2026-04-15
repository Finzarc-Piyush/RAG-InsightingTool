/**
 * LLM proposes 0–2 extra charts from schema + context (no hardcoded dimensions).
 */
import { z } from "zod";
import type { AgentExecutionContext } from "./types.js";
import { completeJson } from "./llmJson.js";
import { chartSpecSchema } from "../../../shared/schema.js";
import { processChartData } from "../../chartGenerator.js";
import { compileChartSpec } from "../../chartSpecCompiler.js";
import {
  calculateSmartDomainsForChart,
  multiSeriesYDomainKind,
  yDomainForMultiSeriesRows,
} from "../../axisScaling.js";
import type { ChartSpec } from "../../../shared/schema.js";
import { validateChartProposal, chartRowsForProposal } from "./chartProposalValidation.js";

export { validateChartProposal } from "./chartProposalValidation.js";

const chartProposalSchema = z.object({
  type: z.enum(["line", "bar", "scatter", "pie", "area", "heatmap"]),
  x: z.string(),
  y: z.string(),
  z: z.string().optional(),
  seriesColumn: z.string().optional(),
  title: z.string().optional(),
  rationale: z.string().optional(),
});

const visualPlannerOutputSchema = z.object({
  addCharts: z.array(chartProposalSchema).max(2),
  narrativeNote: z.string().optional(),
});

export type VisualPlannerOutput = z.infer<typeof visualPlannerOutputSchema>;

const SYSTEM = `You are a visualization advisor. Given the user question, column list, analytical snippet, and (when present) the final answer draft, propose at most 2 charts that support that answer.

Rules:
- Use ONLY exact column names from AVAILABLE_COLUMNS and/or ANALYTICAL_RESULT_COLUMNS when the latter is present.
- If ANALYTICAL_RESULT_COLUMNS is present, prefer charting those columns (aggregated metrics, bucket labels). Do not revert to raw grain metrics (e.g. per-order Sales) when the analytical frame already has sums or aliases unless necessary.
- Prefer **bar** for categorical X vs numeric sum. Prefer **line** or **area** when X is a date column or temporal bucket labels—**never** propose **bar** for “distribution across dates” or long date sequences (many distinct dates): bar sorts by magnitude by default and misreads as a ranking, not a time trend.
- If dateColumns contains the proposed X and the analytical table has **more than ~50 rows**, do **not** add a second **bar** on that date X; use **line/area** or skip the extra chart if it duplicates the primary trend.
- If no useful pair exists, return {"addCharts":[]}.
- When ANALYTICAL_RESULT_COLUMNS list **multiple categorical dimensions** plus a measure, prefer **bar** (or line/area for time-like X) so the server can bind a breakdown; you may omit \`seriesColumn\`—the chart compiler will bind a second dimension from the result rows.
Output JSON only matching the schema.`;

export async function proposeAndBuildExtraCharts(
  ctx: AgentExecutionContext,
  observationsText: string,
  turnId: string,
  onLlmCall: () => void,
  existingCharts: ChartSpec[],
  synthesizedAnswerPreview?: string
): Promise<{ charts: ChartSpec[]; note?: string }> {
  const maxExtra = Math.max(
    0,
    Math.min(2, parseInt(process.env.AGENT_MAX_EXTRA_CHARTS_PER_TURN || "2", 10) || 2)
  );
  if (maxExtra === 0 || ctx.mode !== "analysis") {
    return { charts: [] };
  }

  // Deterministic fallback: for simple breakdown frames (one categorical-ish dimension + one numeric measure),
  // always build a chart when no charts were already produced.
  // This prevents a UX failure mode where the LLM returns {"addCharts": []}.
  if (existingCharts.length === 0 && ctx.lastAnalyticalTable?.rows?.length) {
    const rows = ctx.lastAnalyticalTable.rows as Record<string, any>[];
    const columns = ctx.lastAnalyticalTable.columns ?? [];

    // Only run on small enough frames so the chart remains readable.
    if (rows.length > 0 && rows.length <= 200 && columns.length >= 2) {
      const sample = rows.slice(0, 80);

      const isNumericishOnSample = (col: string): boolean => {
        const cap = Math.min(20, sample.length);
        for (let i = 0; i < cap; i++) {
          const v = sample[i]?.[col];
          if (v == null || v === "") continue;
          if (typeof v === "number" && Number.isFinite(v)) return true;
          if (typeof v === "string") {
            const cleaned = v.replace(/[%,]/g, "").trim();
            if (cleaned && Number.isFinite(Number(cleaned))) return true;
          }
        }
        return false;
      };

      const numericCols = columns.filter((c) => isNumericishOnSample(c));
      const dimCols = columns.filter((c) => !isNumericishOnSample(c));

      if (numericCols.length >= 1 && dimCols.length >= 1) {
        const x = dimCols[0]!;
        const scoreMeasure = (col: string): number => {
          const n = col.toLowerCase();
          return (
            (/_sum\b/.test(n) ? 5 : 0) +
            (/_avg\b/.test(n) || /_mean\b/.test(n) ? 4 : 0) +
            (/_count\b/.test(n) ? 3 : 0) +
            (/_min\b/.test(n) || /_max\b/.test(n) ? 2 : 0) +
            (/_total\b/.test(n) ? 1 : 0)
          );
        };
        const y = numericCols.slice().sort((a, b) => scoreMeasure(b) - scoreMeasure(a))[0]!;

        const xTemporal =
          ctx.summary.dateColumns.includes(x) ||
          /^(Day|Week|Month|Quarter|Half-year|Year) · /.test(x) ||
          x.startsWith("__tf_");

        // Avoid building a bar chart with too many distinct X labels.
        const xUnique = new Set(sample.map((r) => String(r?.[x] ?? ""))).size;
        if (xUnique <= 60) {
          const chartType = xTemporal ? "line" : "bar";

          const { merged: mp } = compileChartSpec(
            rows as Record<string, unknown>[],
            {
              numericColumns: ctx.summary.numericColumns,
              dateColumns: ctx.summary.dateColumns,
            },
            { type: chartType, x, y },
            { columnOrder: columns }
          );

          const spec = chartSpecSchema.parse({
            type: mp.type,
            title:
              mp.type === "heatmap"
                ? `${mp.z} (${mp.x} × ${mp.y})`
                : `${mp.y} by ${mp.x}`,
            x: mp.x,
            y: mp.y,
            ...(mp.z ? { z: mp.z } : {}),
            ...(mp.seriesColumn ? { seriesColumn: mp.seriesColumn } : {}),
            ...(mp.barLayout ? { barLayout: mp.barLayout } : {}),
            aggregate:
              mp.aggregate ??
              (mp.seriesColumn &&
              (mp.type === "bar" || mp.type === "line" || mp.type === "area")
                ? ("sum" as const)
                : ("none" as const)),
          });

          if (
            validateChartProposal(ctx, {
              x: mp.x,
              y: mp.y,
              type: mp.type,
              z: mp.z,
              seriesColumn: mp.seriesColumn,
            }) &&
            !existingCharts.length
          ) {
            const processed = processChartData(
              rows,
              spec,
              ctx.summary.dateColumns,
              { chartQuestion: ctx.question }
            );

            const smartDomains =
              spec.type === "heatmap"
                ? {}
                : calculateSmartDomainsForChart(
                    processed,
                    spec.x,
                    spec.y,
                    spec.y2 || undefined,
                    {
                      yOptions: {
                        useIQR: true,
                        paddingPercent: 5,
                        includeOutliers: true,
                      },
                      y2Options: spec.y2
                        ? {
                            useIQR: true,
                            paddingPercent: 5,
                            includeOutliers: true,
                          }
                        : undefined,
                    }
                  );

            return {
              charts: [
                {
                  ...spec,
                  xLabel: spec.x,
                  yLabel: spec.y,
                  data: processed,
                  ...smartDomains,
                },
              ],
              note: `Deterministic chart fallback for breakdown: ${spec.title}`,
            };
          }
        }
      }
    }
  }

  const cols = ctx.summary.columns.map((c) => `${c.name} (${c.type})`).join(", ");
  const existing = existingCharts.map((c) => `${c.type}:${c.x}/${c.y}`).join("; ") || "(none)";
  const analyticalCols = ctx.lastAnalyticalTable?.columns?.length
    ? ctx.lastAnalyticalTable.columns.join(", ")
    : undefined;
  const analyticalSample =
    ctx.lastAnalyticalTable?.rows?.length ?
      JSON.stringify(ctx.lastAnalyticalTable.rows.slice(0, 5)).slice(0, 4000)
    : undefined;

  const user = JSON.stringify({
    question: ctx.question,
    AVAILABLE_COLUMNS: cols,
    ANALYTICAL_RESULT_COLUMNS: analyticalCols,
    ANALYTICAL_RESULT_ROW_SAMPLE: analyticalSample,
    numericColumns: ctx.summary.numericColumns,
    dateColumns: ctx.summary.dateColumns,
    analyticalSnippet: observationsText.slice(0, 6000),
    finalAnswerPreview: (synthesizedAnswerPreview || "").slice(0, 4000),
    alreadyHaveCharts: existing,
    maxCharts: maxExtra,
  });

  const out = await completeJson(SYSTEM, user, visualPlannerOutputSchema, {
    turnId: `${turnId}_visual`,
    maxTokens: 600,
    temperature: 0.25,
    onLlmCall,
  });

  if (!out.ok) {
    return { charts: [] };
  }

  const built: ChartSpec[] = [];
  for (const p of out.data.addCharts.slice(0, maxExtra)) {
    if (!validateChartProposal(ctx, p)) continue;
    if (existingCharts.some((c) => c.x === p.x && c.y === p.y && c.type === p.type)) continue;
    const { rows: rowSource, useAnalyticalOnly } = chartRowsForProposal(ctx, p);
    const { merged: mp } = compileChartSpec(
      rowSource as Record<string, unknown>[],
      {
        numericColumns: ctx.summary.numericColumns,
        dateColumns: ctx.summary.dateColumns,
      },
      {
        type: p.type,
        x: p.x,
        y: p.y,
        z: p.z,
        seriesColumn: p.seriesColumn,
      },
      {
        columnOrder: ctx.lastAnalyticalTable?.columns ?? null,
      }
    );

    if (
      !validateChartProposal(ctx, {
        x: mp.x,
        y: mp.y,
        type: mp.type,
        z: mp.z,
        seriesColumn: mp.seriesColumn,
      })
    ) {
      continue;
    }

    const xIsDate = ctx.summary.dateColumns.some((d) => d === mp.x);
    if (mp.type === "bar" && xIsDate && rowSource.length > 50) {
      continue;
    }
    try {
      const manyRows = rowSource.length > 50;
      const aggregateTimeSeries =
        (mp.type === "line" || mp.type === "area") && xIsDate && manyRows ?
          ("sum" as const)
        : undefined;
      const baseAgg =
        mp.seriesColumn && (mp.type === "bar" || mp.type === "line" || mp.type === "area")
          ? (mp.aggregate ?? "sum")
          : mp.type === "heatmap"
            ? (mp.aggregate ?? "sum")
            : (mp.aggregate ?? "none");
      const spec = chartSpecSchema.parse({
        type: mp.type,
        title:
          p.title ||
          (mp.type === "heatmap" && mp.z
            ? `${mp.z} (${mp.x} × ${mp.y})`
            : `${mp.y} by ${mp.x}`),
        x: mp.x,
        y: mp.y,
        ...(mp.z ? { z: mp.z } : {}),
        ...(mp.seriesColumn
          ? { seriesColumn: mp.seriesColumn, barLayout: mp.barLayout ?? ("stacked" as const) }
          : {}),
        aggregate: aggregateTimeSeries ?? baseAgg,
        ...(useAnalyticalOnly ? { _useAnalyticalDataOnly: true as const } : {}),
      });
      let processed = processChartData(rowSource as Record<string, any>[], spec, ctx.summary.dateColumns, {
        chartQuestion: ctx.question,
      });
      let smartDomains: Record<string, unknown> = {};
      if (spec.type === "heatmap") {
        smartDomains = {};
      } else if (spec.seriesKeys?.length) {
        const sk = spec.seriesKeys;
        smartDomains = yDomainForMultiSeriesRows(
          processed,
          sk,
          multiSeriesYDomainKind(spec.type, spec.barLayout)
        );
      } else {
        smartDomains = calculateSmartDomainsForChart(
          processed,
          spec.x,
          spec.y,
          spec.y2 || undefined,
          {
            yOptions: { useIQR: true, paddingPercent: 5, includeOutliers: true },
            y2Options: spec.y2 ? { useIQR: true, paddingPercent: 5, includeOutliers: true } : undefined,
          }
        );
      }
      built.push({
        ...spec,
        xLabel: spec.x,
        yLabel: spec.y,
        data: processed,
        ...smartDomains,
      });
    } catch {
      /* skip invalid */
    }
  }

  return {
    charts: built,
    note: out.data.narrativeNote,
  };
}
