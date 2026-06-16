/**
 * agentLoopSynthesisPrep.ts — pure pre-synthesis / dashboard-prep helpers.
 *
 * WHY IT LIVES HERE (and not in agentLoop.service.ts)
 *   Both helpers are pure: they take every input as an explicit argument, return a
 *   value, and depend only on EXTERNAL modules (`./agentLoopFormatters.js`,
 *   `../../autoPivotSpec.js`) plus the shared `AgentExecutionContext` / `AgentTrace`
 *   / `DataSummary` / `DashboardPivotSpec` types — never on any mutable closure state
 *   inside `runAgentTurn`. The agent loop passes its `observations` / `mergedCharts`
 *   arrays in as arguments, so there is nothing captured. Pulling them into a sibling
 *   module shrinks the god-file (ARCH-1 / CQ-1) and lets them be unit-tested in
 *   isolation. `agentLoop.service.ts` imports them back for internal use.
 *
 * WHAT IT DOES
 *   - buildAutoPivotSpec : derive the `DashboardPivotSpec` to auto-attach to the
 *     dashboard at build time, using the same preview-rows derivation that seeds the
 *     chat-side pivot panel, so the dashboard's pivot tile mirrors the chat view.
 *   - buildPreSynthesisMidTurnSummary : assemble the compact text digest persisted
 *     via the fire-and-forget mid-turn session-context hook just before synthesis.
 */
import type { AgentExecutionContext, AgentTrace } from "./types.js";
import type { DataSummary, DashboardPivotSpec } from "../../../shared/schema.js";
import { extractTableRowsAndColumns } from "./agentLoopFormatters.js";
import { buildAutoPivotSpecFromPreview } from "../../autoPivotSpec.js";

/**
 * Build the `DashboardPivotSpec` to auto-attach to the dashboard at build
 * time. Uses the same `derivePivotDefaultsFromPreviewRows` helper that seeds
 * the chat-side pivot panel — so the dashboard's pivot tile renders the
 * SAME view the user sees if they switch the chat response to "Pivot".
 *
 * Returns `undefined` when the turn produced no analytical table or when the
 * derived defaults don't have a meaningful row × value pivot (single-cell
 * scalar answers, etc.). Caller treats undefined as "no pivot tile".
 */
export function buildAutoPivotSpec(args: {
  table: unknown;
  summary: DataSummary | undefined;
  turnId: string;
  sessionId: string | undefined;
}): DashboardPivotSpec | undefined {
  if (!args.summary) return undefined;
  const { rows, columns } = extractTableRowsAndColumns(args.table);
  // Pure spec assembly (incl. the base-table value-field guard) lives in
  // ../../autoPivotSpec.js so it can be unit-tested without the agent runtime.
  return buildAutoPivotSpecFromPreview({
    rows,
    columns,
    summary: args.summary,
    turnId: args.turnId,
    sessionId: args.sessionId,
  });
}

export function buildPreSynthesisMidTurnSummary(
  ctx: AgentExecutionContext,
  trace: AgentTrace,
  observations: string[],
  mergedCharts: Array<{ title: string; x: string; y: string }>
): string {
  const tools = trace.toolCalls.map((t) => `${t.name}:${t.ok}`).join(", ");
  const obsTail = observations.join("\n\n---\n\n").slice(-5000);
  const charts = mergedCharts.map((c) => `${c.title}(${c.x}/${c.y})`).join("; ");
  return [
    `Question: ${ctx.question.slice(0, 500)}`,
    `planRationale: ${(trace.planRationale || "").slice(0, 1200)}`,
    `tools: ${tools || "(none)"}`,
    `chartsSoFar: ${charts || "(none)"}`,
    `recentObservations:\n${obsTail}`,
  ].join("\n\n");
}
