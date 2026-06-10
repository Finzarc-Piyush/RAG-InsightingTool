/**
 * applyChartInsightsBySignature — mirror the per-chart insights the chat answer
 * already produced onto another set of charts (the dashboard's), matched by
 * chart-axis signature.
 *
 * WHY: the dashboard is assembled inside `answerQuestion` BEFORE chart
 * enrichment (`enrichCharts` in chatResponse.service.ts) runs — enrichment
 * returns NEW chart objects with `keyInsight`/`businessCommentary`, so the
 * dashboard keeps the bare originals. Rather than regenerate insights (N extra
 * LLM calls), we copy the chat-enriched ones onto the dashboard charts. This is
 * the "pick the same chart from chat along with its insight" path.
 *
 * Pure: no I/O, never mutates inputs. Only fills fields that are empty on the
 * target (a curated insight already on the target is preserved). Targets that
 * change come back as new objects; unchanged targets are returned by reference.
 */
import type { ChartSpec } from "../shared/schema.js";
import { chartAxisSignature } from "./agents/runtime/chartFromTable.js";

function hasText(s: unknown): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

export function applyChartInsightsBySignature(
  targetCharts: ChartSpec[],
  enrichedCharts: ChartSpec[]
): { charts: ChartSpec[]; patchedCount: number } {
  const bySig = new Map<string, ChartSpec>();
  for (const c of enrichedCharts) {
    const sig = chartAxisSignature(c);
    // First writer wins — mergedCharts are already de-duped by this same
    // signature upstream, so collisions shouldn't occur, but be deterministic.
    if (!bySig.has(sig)) bySig.set(sig, c);
  }

  let patchedCount = 0;
  const charts = targetCharts.map((t) => {
    const src = bySig.get(chartAxisSignature(t));
    if (!src) return t;
    const patch: Partial<ChartSpec> = {};
    if (!hasText(t.keyInsight) && hasText(src.keyInsight)) {
      patch.keyInsight = src.keyInsight;
    }
    if (!hasText(t.businessCommentary) && hasText(src.businessCommentary)) {
      patch.businessCommentary = src.businessCommentary;
    }
    if (!t.insight && src.insight) {
      patch.insight = src.insight;
    }
    if (Object.keys(patch).length === 0) return t;
    patchedCount++;
    return { ...t, ...patch };
  });

  return { charts, patchedCount };
}
