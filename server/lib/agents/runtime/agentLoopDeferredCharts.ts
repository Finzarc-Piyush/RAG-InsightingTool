/**
 * agentLoopDeferredCharts.ts — plan-time `build_chart` deferral + materialisation.
 *
 * WHY IT LIVES HERE (and not in agentLoop.service.ts)
 *   These three helpers form a cohesive, LOW-COUPLING cluster: they depend only
 *   on EXTERNAL modules (chartProposalValidation, chartGenerator, chartSpecFinish,
 *   the chart schema) plus the shared `ChartSpec` / `AgentExecutionContext` types —
 *   never on any mutable closure state inside `runAgentTurn`. Pulling them into a
 *   sibling module shrinks the god-file (ARCH-1 / CQ-1) and lets the deferred-chart
 *   logic be unit-tested in isolation. `agentLoop.service.ts` imports them back for
 *   internal use AND re-exports them so any file importing them from the agent-loop
 *   path keeps resolving unchanged.
 *
 * WHAT IT DOES
 *   Plan-time `build_chart` steps are NOT materialised when the planner emits them.
 *   Instead the agent loop records a `DeferredBuildChartTemplate` and builds the
 *   chart AFTER synthesis, from the SAME analytical frame the answer used (the last
 *   execute_query_plan result / ctx.data) rather than a mid-plan snapshot. This keeps
 *   chart series aligned with the narrative.
 *
 *     - deferredTemplateFromBuiltChart : ChartSpec → DeferredBuildChartTemplate
 *       (captures only the fields needed to rebuild the chart later).
 *     - rowFrameSupportsDeferredTemplate : does the first row of the final frame
 *       carry every column the template references? (drop otherwise.)
 *     - materializeDeferredBuildCharts : build each deferred template against the
 *       final frame, validate + dedupe-safe, push onto mergedCharts, clear the list.
 */
import type { AgentExecutionContext } from "./types.js";
import type { ChartSpec } from "../../../shared/schema.js";
import { chartSpecSchema } from "../../../shared/schema.js";
import { agentLog } from "./agentLogger.js";
import {
  validateChartProposal,
  chartRowsForProposal,
} from "./chartProposalValidation.js";
import { processChartData } from "../../chartGenerator.js";
import { finishChartSpec } from "../../chartSpecFinish.js";

/** Shape needed to rebuild a plan-time build_chart after synthesis (same frame as narrative). */
export type DeferredBuildChartTemplate = Pick<
  ChartSpec,
  "type" | "title" | "x" | "y" | "aggregate"
> & {
  y2?: string;
  y2Series?: string[];
  z?: string;
  seriesColumn?: string;
  barLayout?: "stacked" | "grouped";
  _agentEvidenceRef?: string;
  _agentTurnId?: string;
};

export function deferredTemplateFromBuiltChart(c: ChartSpec): DeferredBuildChartTemplate {
  return {
    type: c.type,
    title: c.title,
    x: c.x,
    y: c.y,
    ...(c.y2 ? { y2: c.y2 } : {}),
    ...(c.y2Series?.length ? { y2Series: [...c.y2Series] } : {}),
    ...(c.z ? { z: c.z } : {}),
    ...(c.seriesColumn ? { seriesColumn: c.seriesColumn } : {}),
    ...(c.barLayout ? { barLayout: c.barLayout } : {}),
    ...(c.aggregate != null ? { aggregate: c.aggregate } : {}),
    ...(c._agentEvidenceRef ? { _agentEvidenceRef: c._agentEvidenceRef } : {}),
    ...(c._agentTurnId ? { _agentTurnId: c._agentTurnId } : {}),
  };
}

export function rowFrameSupportsDeferredTemplate(
  first: Record<string, unknown> | undefined,
  t: DeferredBuildChartTemplate
): boolean {
  if (!first) return false;
  const keys = [
    t.x,
    t.y,
    ...(t.y2 ? [t.y2] : []),
    ...(t.y2Series ?? []),
    ...(t.z ? [t.z] : []),
    ...(t.seriesColumn ? [t.seriesColumn] : []),
  ];
  return keys.every((k) => Object.prototype.hasOwnProperty.call(first, k));
}

/**
 * Plan-time build_chart specs are deferred until after synthesis so series are built from the
 * same analytical frame the answer used (last execute_query_plan / ctx.data), not mid-plan snapshots.
 */
export function materializeDeferredBuildCharts(
  ctx: AgentExecutionContext,
  deferred: DeferredBuildChartTemplate[],
  mergedCharts: ChartSpec[]
): void {
  if (!deferred.length) return;
  for (const tmpl of deferred) {
    try {
      const p = {
        type: tmpl.type,
        x: tmpl.x,
        y: tmpl.y,
        ...(tmpl.z ? { z: tmpl.z } : {}),
        ...(tmpl.seriesColumn ? { seriesColumn: tmpl.seriesColumn } : {}),
        ...(tmpl.barLayout ? { barLayout: tmpl.barLayout } : {}),
      };
      if (!validateChartProposal(ctx, p)) {
        // P-A5: don't silently drop; leave a breadcrumb so operators can trace
        // charts that never rendered.
        agentLog("deferredChart.dropped", {
          reason: "validateChartProposal",
          title: tmpl.title,
          x: tmpl.x,
          y: tmpl.y,
        });
        continue;
      }
      const { rows, useAnalyticalOnly } = chartRowsForProposal(ctx, p);
      const first = rows[0] as Record<string, unknown> | undefined;
      if (!rowFrameSupportsDeferredTemplate(first, tmpl)) {
        agentLog("deferredChart.dropped", {
          reason: "frameMissingColumns",
          title: tmpl.title,
          x: tmpl.x,
          y: tmpl.y,
          ...(tmpl.seriesColumn ? { seriesColumn: tmpl.seriesColumn } : {}),
          availableKeys: Object.keys(first ?? {}).slice(0, 12).join(", "),
        });
        continue;
      }
      const spec = chartSpecSchema.parse({
        type: tmpl.type,
        title: tmpl.title,
        x: tmpl.x,
        y: tmpl.y,
        ...(tmpl.z ? { z: tmpl.z } : {}),
        ...(tmpl.seriesColumn ? { seriesColumn: tmpl.seriesColumn } : {}),
        ...(tmpl.barLayout ? { barLayout: tmpl.barLayout } : {}),
        ...(tmpl.y2 ? { y2: tmpl.y2 } : {}),
        ...(tmpl.y2Series?.length ? { y2Series: tmpl.y2Series } : {}),
        aggregate: tmpl.aggregate ?? "none",
        ...(useAnalyticalOnly ? { _useAnalyticalDataOnly: true as const } : {}),
      });
      const processed = processChartData(
        rows as Record<string, any>[],
        spec,
        ctx.summary.dateColumns,
        { chartQuestion: ctx.question }
      );
      mergedCharts.push({
        ...finishChartSpec(spec, processed),
        ...(tmpl._agentEvidenceRef ?
          { _agentEvidenceRef: tmpl._agentEvidenceRef }
        : {}),
        ...(tmpl._agentTurnId ? { _agentTurnId: tmpl._agentTurnId } : {}),
      });
    } catch {
      /* skip invalid */
    }
  }
  deferred.length = 0;
}
