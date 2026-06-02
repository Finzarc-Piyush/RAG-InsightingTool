/**
 * ============================================================================
 * chartIntentGuard.ts — stops a chart from showing values the user excluded
 * ============================================================================
 * WHAT THIS FILE DOES
 *   When a user asks something like "top brands excluding our own brand", that
 *   exclusion is captured in an "IntentEnvelope" for the turn. The agent may
 *   auto-build a chart from query results, and that chart could accidentally
 *   include — or even be led by — the very value the user asked to omit. This
 *   pure helper checks a built ChartSpec against the turn's exclusions and
 *   returns one of three outcomes: it's fine, drop it entirely, or strip the
 *   offending rows so the caller can rebuild a clean chart.
 *
 * WHY IT MATTERS
 *   A chart whose biggest bar is the thing the user said to exclude directly
 *   contradicts their request and undermines trust. This guard is the last line
 *   of defence before the chart ships to the client over SSE.
 *
 * KEY PIECES
 *   - validateChartAgainstIntent — the check. Outcomes:
 *       • ok — consistent with intent (or no relevant exclusion).
 *       • drop "single_excluded_bar" — the only bar IS the excluded value.
 *       • drop "excluded_leader" — multi-row chart whose tallest bar is excluded.
 *       • recover "filter_pollution" + cleanedRows — excluded value present but
 *         not the leader; rows stripped for the caller to re-process.
 *   - chartIntentGuardEnabled — env kill switch (AGENT_CHART_INTENT_GUARD),
 *     defaults ON, so operators can disable the guard during an incident.
 *
 * HOW IT CONNECTS
 *   Reads ChartSpec (shared/schema.js) and IntentEnvelope (types.js). Called by
 *   the chart-promotion path in agentLoop.service.ts; on "filter_pollution" the
 *   caller re-runs processChartData + calculateSmartDomains on cleanedRows.
 */
import type { ChartSpec } from "../../../shared/schema.js";
import type { IntentEnvelope } from "./types.js";

export type ChartIntentGuardResult =
  | { ok: true }
  | {
      ok: false;
      drop: boolean;
      reason: "single_excluded_bar" | "excluded_leader" | "filter_pollution";
      cleanedRows?: Record<string, unknown>[];
      excludedValues?: string[];
    };

function normalize(v: unknown): string {
  if (v == null) return "";
  return String(v).trim().toLowerCase();
}

function excludedSetForColumn(
  envelope: IntentEnvelope,
  column: string
): Set<string> | null {
  const colNorm = column.toLowerCase();
  const merged = new Set<string>();
  for (const ex of envelope.exclusions) {
    if (ex.column.toLowerCase() !== colNorm) continue;
    for (const v of ex.values) merged.add(normalize(v));
  }
  return merged.size ? merged : null;
}

export function validateChartAgainstIntent(
  spec: ChartSpec,
  envelope: IntentEnvelope | undefined
): ChartIntentGuardResult {
  if (!envelope || envelope.exclusions.length === 0) return { ok: true };
  const rows = Array.isArray((spec as { data?: unknown[] }).data)
    ? ((spec as { data: unknown[] }).data as Record<string, unknown>[])
    : [];
  if (rows.length === 0) return { ok: true };
  const xCol = spec.x;
  if (!xCol) return { ok: true };

  const excludedSet = excludedSetForColumn(envelope, xCol);
  if (!excludedSet) return { ok: true };

  // Single-row contradiction — strongest signal.
  if (rows.length === 1) {
    const label = normalize(rows[0]?.[xCol]);
    if (excludedSet.has(label)) {
      return {
        ok: false,
        drop: true,
        reason: "single_excluded_bar",
        excludedValues: [label],
      };
    }
    return { ok: true };
  }

  // Multi-row: find the max-y leader.
  const yCol = spec.y;
  if (!yCol) {
    // Without a numeric measure, fall back to membership check only.
    const offending = rows.filter((r) => excludedSet.has(normalize(r?.[xCol])));
    if (offending.length === 0) return { ok: true };
    const cleanedRows = rows.filter((r) => !excludedSet.has(normalize(r?.[xCol])));
    if (cleanedRows.length === 0) {
      return { ok: false, drop: true, reason: "single_excluded_bar" };
    }
    return {
      ok: false,
      drop: false,
      reason: "filter_pollution",
      cleanedRows,
      excludedValues: offending.map((r) => normalize(r?.[xCol])),
    };
  }

  let leaderIdx = -1;
  let leaderVal = -Infinity;
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]?.[yCol];
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) continue;
    if (n > leaderVal) {
      leaderVal = n;
      leaderIdx = i;
    }
  }
  const leaderLabel = leaderIdx >= 0 ? normalize(rows[leaderIdx]?.[xCol]) : "";
  if (leaderLabel && excludedSet.has(leaderLabel)) {
    return {
      ok: false,
      drop: true,
      reason: "excluded_leader",
      excludedValues: [leaderLabel],
    };
  }

  // Leader is fine, but there may still be excluded values polluting the
  // chart (showing up as non-leader bars). Strip and let caller re-process.
  const offendingLabels: string[] = [];
  const cleanedRows: Record<string, unknown>[] = [];
  for (const r of rows) {
    const lbl = normalize(r?.[xCol]);
    if (excludedSet.has(lbl)) {
      offendingLabels.push(lbl);
    } else {
      cleanedRows.push(r);
    }
  }
  if (offendingLabels.length === 0) return { ok: true };
  if (cleanedRows.length === 0) {
    return { ok: false, drop: true, reason: "single_excluded_bar" };
  }
  return {
    ok: false,
    drop: false,
    reason: "filter_pollution",
    cleanedRows,
    excludedValues: offendingLabels,
  };
}

/** Kill switch — operators can disable the guard during incident response. */
export function chartIntentGuardEnabled(): boolean {
  return (process.env.AGENT_CHART_INTENT_GUARD ?? "true").toLowerCase() !== "false";
}
