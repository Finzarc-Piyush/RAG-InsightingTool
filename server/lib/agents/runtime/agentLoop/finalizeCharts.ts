/**
 * agentLoop/finalizeCharts.ts — final dedupe + cap across all chart sources.
 *
 * WHY IT LIVES HERE (and not in agentLoop.service.ts)
 *   `finalizeMergedCharts` + the `DASHBOARD_CHART_HARD_CAP` constant are a
 *   cohesive, LOW-COUPLING cluster: the helper takes the `mergedCharts` array and
 *   the optional `IntentEnvelope` as explicit arguments, mutates the array in
 *   place, and depends only on EXTERNAL modules (`./chartFromTable.js`,
 *   `./chartIntentGuard.js`, `./agentLogger.js`) plus the shared `ChartSpec` /
 *   `IntentEnvelope` types — never on any mutable closure state inside
 *   `runAgentTurn`. Pulling it into a sibling module shrinks the god-file
 *   (ARCH-1 / CQ-1); it was previously left inline ONLY because a source-grep
 *   test (`tests/dashboardCapsDPF6.test.ts`) pinned the `24`-cap literals to the
 *   service path. That test now points here (the L-017 pattern: move +
 *   re-point + back it with a behavioural characterization test).
 *
 *   `agentLoop.service.ts` imports both back for internal use AND re-exports them
 *   so any file importing them from the agent-loop path keeps resolving unchanged.
 *
 * WHAT IT DOES
 *   `finalizeMergedCharts` runs once at end of turn after every chart source
 *   (per-step promotion, deferred build_chart materialiser, visual planner,
 *   dashboard feature sweep) has populated `mergedCharts`. It drops charts whose
 *   leader contradicts the user's exclusion intent, dedupes by axis-signature
 *   (first-seen wins), then caps at `AGENT_MAX_FINAL_CHARTS_PER_TURN` (default 24,
 *   matching `DASHBOARD_CHART_HARD_CAP` and the per-sheet schema ceiling) keeping
 *   the most informative charts (more rows wins, ties broken by emission order).
 */
import { agentLog } from "../agentLogger.js";
import { chartAxisSignature } from "../chartFromTable.js";
import {
  validateChartAgainstIntent,
  chartIntentGuardEnabled,
} from "../chartIntentGuard.js";
import type { ChartSpec } from "../../../../shared/schema.js";
import type { IntentEnvelope } from "../types.js";

/**
 * Total chart cap for a dashboard turn (planner + visualPlanner + feature sweep).
 * Kept equal to the per-sheet schema ceiling (`dashboardSheetSpecSchema.charts.max(24)`)
 * so the schema is the single source of truth — no runtime cap re-trims below it.
 */
export const DASHBOARD_CHART_HARD_CAP = 24;

/**
 * Final pass over `mergedCharts`: dedupe by axis-signature and cap at
 * `AGENT_MAX_FINAL_CHARTS_PER_TURN` (default 24, matches the schema
 * ceiling and the dashboard-turn hard cap; operators can tighten via env var).
 * Mutates the array in place; called once at end of turn after all chart
 * sources (per-step promotion, materializeDeferredBuildCharts, visualPlanner,
 * dashboard feature sweep) have populated it.
 *
 * Dedupe order: first-seen wins (preserves chart sources earlier in the turn).
 * Cap order: rows-count wins (more informative survives), ties broken by
 * earliest emission.
 */
export function finalizeMergedCharts(
  mergedCharts: ChartSpec[],
  intentEnvelope?: IntentEnvelope
): void {
  if (mergedCharts.length === 0) return;

  // RD4 · catch-all intent guard. The chart-promotion path already runs the
  // guard, but charts from the visual planner / dashboard sweep / deferred
  // build_chart materializer also reach this list. Run a pre-dedupe pass so
  // ANY chart whose leader contradicts the user's exclusion intent is
  // dropped — regardless of which builder emitted it.
  if (intentEnvelope?.exclusions.length && chartIntentGuardEnabled()) {
    const kept: ChartSpec[] = [];
    for (const c of mergedCharts) {
      const verdict = validateChartAgainstIntent(c, intentEnvelope);
      if (verdict.ok || !verdict.drop) {
        kept.push(c);
      }
    }
    if (kept.length !== mergedCharts.length) {
      agentLog("finalize_charts_intent_guard_dropped", {
        before: mergedCharts.length,
        after: kept.length,
      });
      mergedCharts.length = 0;
      for (const c of kept) mergedCharts.push(c);
    }
  }

  const seen = new Set<string>();
  const dedupedInPlace: ChartSpec[] = [];
  for (const c of mergedCharts) {
    const sig = chartAxisSignature(c);
    if (seen.has(sig)) continue;
    seen.add(sig);
    dedupedInPlace.push(c);
  }

  const capRaw = process.env.AGENT_MAX_FINAL_CHARTS_PER_TURN;
  const cap = capRaw != null && capRaw !== "" ? parseInt(capRaw, 10) : 24;
  const effectiveCap = Number.isFinite(cap) && cap > 0 ? cap : 24;

  let capped: ChartSpec[];
  if (dedupedInPlace.length <= effectiveCap) {
    capped = dedupedInPlace;
  } else {
    // Pair each chart with its original index so ties break on emission order.
    const ranked = dedupedInPlace
      .map((c, i) => ({
        c,
        i,
        rows: Array.isArray((c as { data?: unknown[] }).data)
          ? ((c as { data: unknown[] }).data.length as number)
          : 0,
      }))
      .sort((a, b) => (b.rows - a.rows) || (a.i - b.i))
      .slice(0, effectiveCap)
      // Restore original emission order for the final array.
      .sort((a, b) => a.i - b.i);
    capped = ranked.map((r) => r.c);
  }

  mergedCharts.length = 0;
  for (const c of capped) mergedCharts.push(c);
}
