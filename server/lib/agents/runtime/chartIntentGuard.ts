/**
 * RD4 · Validate an auto-promoted ChartSpec against the user's exclusion
 * intent. The agent's chart-promotion path (agentLoop.service.ts) calls this
 * with the just-built chart and the turn's IntentEnvelope. If the chart's
 * leader bar is a value the user said to exclude, we drop or recover the
 * chart before it ships to the SSE payload.
 *
 * Three outcomes:
 *   - ok: chart is consistent with user intent (or no relevant exclusion)
 *   - drop + reason "single_excluded_bar": the chart has ONE bar/row and it
 *     is the excluded value (e.g. the FSG bug — the chart shows the value
 *     the user said to omit). Always drop.
 *   - drop + reason "excluded_leader": multi-row chart whose max-y row is the
 *     excluded value. Drop — the chart's headline contradicts user intent.
 *   - recover + reason "filter_pollution" + cleanedRows: multi-row chart that
 *     includes the excluded value but not as the leader. Strip those rows;
 *     caller re-processes the data via processChartData + calculateSmartDomains.
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
