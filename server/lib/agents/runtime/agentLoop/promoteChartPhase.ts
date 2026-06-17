/**
 * agentLoop/promoteChartPhase.ts — promote a successful analytical-table result
 * into a final-message chart, extracted VERBATIM from the per-step loop of
 * `runAgentTurn` (findings ARCH-1 / CQ-1).
 *
 * WHAT IT DOES
 *   After an `execute_query_plan` / `run_analytical_query` / `run_breakdown_
 *   ranking` step lands a clean entity×metric frame on `ctx.lastAnalyticalTable`,
 *   build a deterministic chart from it and push it onto `state.mergedCharts` so
 *   the rendered answer surfaces every breakdown the agent ran — not only the
 *   one the planner explicitly built. Dedupes by axis-signature against the
 *   existing merged charts; the final cap is applied later by
 *   `finalizeMergedCharts`. Honours the RD4 chart-intent guard (drop / re-filter
 *   a chart whose leader is an excluded value). Env gate:
 *   `AGENT_PROMOTE_INTERMEDIATE_CHARTS` (default true).
 *
 * WHY IT EXTRACTS CLEANLY
 *   This `if (gate) { try { … } }` block has ZERO control-flow entanglement with
 *   the loop (no break/continue/return the loop relies on). It reads `ctx`, the
 *   step's `tool`, the per-step `finalCallId` + `turnId`, and mutates
 *   `state.mergedCharts` (the SAME array instance the orchestrator destructured
 *   from `state`). The body below is byte-for-byte the inline version with
 *   `mergedCharts` → `state.mergedCharts`.
 */
import type { AgentExecutionContext } from "../types.js";
import { agentLog } from "../agentLogger.js";
import { errorMessage } from "../../../../utils/errorMessage.js";
import {
  type ChartSpec,
} from "../../../../shared/schema.js";
import {
  buildChartFromAnalyticalTable,
  chartAxisSignature,
} from "../chartFromTable.js";
import {
  validateChartAgainstIntent,
  chartIntentGuardEnabled,
} from "../chartIntentGuard.js";
import type { TurnState } from "./turnState.js";

/**
 * Promote the current `ctx.lastAnalyticalTable` into a deduped chart on
 * `state.mergedCharts`, when the producing tool + env gate qualify.
 *
 * @param state       the per-turn accumulator bundle (mutates: mergedCharts)
 * @param ctx         the agent execution context (reads: lastAnalyticalTable,
 *                    summary, question, intentEnvelope)
 * @param tool        the producing step's tool name
 * @param finalCallId the producing step's evidence call id (for provenance tags)
 * @param turnId      the current turn id (for provenance tags + logging)
 */
export function promoteIntermediateAnalyticalChart(
  state: TurnState,
  ctx: AgentExecutionContext,
  tool: string,
  finalCallId: string,
  turnId: string
): void {
  if (
    (tool === "execute_query_plan" ||
      tool === "run_analytical_query" ||
      // RNK-chart · promote ranking frames so "top performers" /
      // "who has the highest X" answers lead with a bar chart. The
      // tool already trims to topN, so cardinality stays within the
      // chart-promotion guards; topN=1 (single entity) is rejected by
      // the scalar guard → no awkward one-bar chart.
      tool === "run_breakdown_ranking") &&
    (process.env.AGENT_PROMOTE_INTERMEDIATE_CHARTS ?? "true")
      .toLowerCase() !== "false"
  ) {
    try {
      const promoted = buildChartFromAnalyticalTable({
        table: {
          rows: ctx.lastAnalyticalTable!.rows,
          columns: ctx.lastAnalyticalTable!.columns,
        },
        summary: ctx.summary,
        question: ctx.question,
      });
      if (promoted) {
        // RD4 · chart-intent guard: if the promoted chart's leader
        // (or only bar) is a value the user said to exclude, drop or
        // re-filter before push. The narrator already produced the
        // correct text; the chart layer must not contradict it.
        let chartToPush: ChartSpec | null = promoted;
        if (chartIntentGuardEnabled()) {
          const verdict = validateChartAgainstIntent(
            promoted,
            ctx.intentEnvelope
          );
          if (!verdict.ok) {
            if (verdict.drop) {
              agentLog("chart_promotion_dropped_by_intent_guard", {
                turnId,
                tool,
                reason: verdict.reason,
                title: promoted.title,
                x: promoted.x,
                y: promoted.y,
                excluded: verdict.excludedValues?.join(",") ?? "",
              });
              chartToPush = null;
            } else if (verdict.cleanedRows?.length) {
              // filter_pollution — strip offending rows and rebuild
              // the chart from the cleaned subset. We re-invoke
              // buildChartFromAnalyticalTable so processChartData /
              // calculateSmartDomainsForChart run against the
              // cleaned data and the title remains coherent.
              const cleanedSpec = buildChartFromAnalyticalTable({
                table: {
                  rows: verdict.cleanedRows,
                  columns: ctx.lastAnalyticalTable!.columns,
                },
                summary: ctx.summary,
                question: ctx.question,
              });
              if (cleanedSpec) {
                chartToPush = cleanedSpec;
                agentLog("chart_promotion_recovered_by_intent_guard", {
                  turnId,
                  tool,
                  reason: verdict.reason,
                  removedRows:
                    ctx.lastAnalyticalTable!.rows.length -
                    verdict.cleanedRows.length,
                  excluded:
                    verdict.excludedValues?.join(",") ?? "",
                });
              } else {
                agentLog("chart_promotion_dropped_by_intent_guard", {
                  turnId,
                  tool,
                  reason: "recovery_yielded_no_chart",
                  title: promoted.title,
                });
                chartToPush = null;
              }
            }
          }
        }
        if (chartToPush) {
          const sig = chartAxisSignature(chartToPush);
          const existingSigs = new Set(
            state.mergedCharts.map(chartAxisSignature)
          );
          if (!existingSigs.has(sig)) {
            const tagged: ChartSpec = {
              ...chartToPush,
              ...(finalCallId
                ? {
                    _agentEvidenceRef: finalCallId,
                    _agentTurnId: turnId,
                  }
                : {}),
            };
            state.mergedCharts.push(tagged);
            agentLog("chart_promoted_from_intermediate", {
              turnId,
              tool,
              title: chartToPush.title,
              x: chartToPush.x,
              y: chartToPush.y,
              type: chartToPush.type,
            });
          }
        }
      }
    } catch (promoteErr) {
      agentLog("chart_promotion_failed", {
        turnId,
        tool,
        err:
          errorMessage(promoteErr),
      });
    }
  }
}
