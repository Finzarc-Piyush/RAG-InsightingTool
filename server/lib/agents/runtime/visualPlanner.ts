/**
 * LLM proposes 0–2 extra charts from schema + context (no hardcoded dimensions).
 */
import { z } from "zod";
import type { AgentExecutionContext } from "./types.js";
import { completeJson } from "./llmJson.js";
import { chartSpecSchema } from "../../../shared/schema.js";
import { processChartData } from "../../chartGenerator.js";
import { optimizeChartData } from "../../chartDownsampling.js";
import { calculateSmartDomainsForChart } from "../../axisScaling.js";
import type { ChartSpec } from "../../../shared/schema.js";

const chartProposalSchema = z.object({
  type: z.enum(["line", "bar", "scatter", "pie", "area"]),
  x: z.string(),
  y: z.string(),
  title: z.string().optional(),
  rationale: z.string().optional(),
});

const visualPlannerOutputSchema = z.object({
  addCharts: z.array(chartProposalSchema).max(2),
  narrativeNote: z.string().optional(),
});

export type VisualPlannerOutput = z.infer<typeof visualPlannerOutputSchema>;

function validateProposal(ctx: AgentExecutionContext, p: z.infer<typeof chartProposalSchema>): boolean {
  const names = new Set(ctx.summary.columns.map((c) => c.name));
  if (!names.has(p.x) || !names.has(p.y)) return false;
  if (!ctx.summary.numericColumns.includes(p.y)) return false;
  return true;
}

const SYSTEM = `You are a visualization advisor. Given the user question, column list, and a short analytical snippet, propose at most 2 charts that would most help understanding (comparison, magnitude, trend, or share). Use ONLY exact column names from AVAILABLE_COLUMNS. Prefer bar for category vs numeric sum, line for time on x if a date column exists. If no useful pair exists, return {"addCharts":[]}. Output JSON only matching the schema.`;

export async function proposeAndBuildExtraCharts(
  ctx: AgentExecutionContext,
  observationsText: string,
  turnId: string,
  onLlmCall: () => void,
  existingCharts: ChartSpec[]
): Promise<{ charts: ChartSpec[]; note?: string }> {
  const maxExtra = Math.max(
    0,
    Math.min(2, parseInt(process.env.AGENT_MAX_EXTRA_CHARTS_PER_TURN || "2", 10) || 2)
  );
  if (maxExtra === 0 || ctx.mode !== "analysis") {
    return { charts: [] };
  }

  const cols = ctx.summary.columns.map((c) => `${c.name} (${c.type})`).join(", ");
  const existing = existingCharts.map((c) => `${c.type}:${c.x}/${c.y}`).join("; ") || "(none)";

  const user = JSON.stringify({
    question: ctx.question,
    AVAILABLE_COLUMNS: cols,
    numericColumns: ctx.summary.numericColumns,
    dateColumns: ctx.summary.dateColumns,
    analyticalSnippet: observationsText.slice(0, 6000),
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
    if (!validateProposal(ctx, p)) continue;
    if (existingCharts.some((c) => c.x === p.x && c.y === p.y && c.type === p.type)) continue;
    try {
      const spec = chartSpecSchema.parse({
        type: p.type,
        title: p.title || `${p.y} by ${p.x}`,
        x: p.x,
        y: p.y,
      });
      let processed = processChartData(ctx.data, spec);
      processed = optimizeChartData(processed, spec);
      const smartDomains = calculateSmartDomainsForChart(
        processed,
        spec.x,
        spec.y,
        spec.y2 || undefined,
        {
          yOptions: { useIQR: true, paddingPercent: 5, includeOutliers: true },
          y2Options: spec.y2 ? { useIQR: true, paddingPercent: 5, includeOutliers: true } : undefined,
        }
      );
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
