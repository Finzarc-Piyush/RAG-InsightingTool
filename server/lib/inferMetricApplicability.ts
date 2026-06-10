/**
 * ============================================================================
 * inferMetricApplicability.ts — a metric's VALID MEASUREMENT UNIVERSE
 * ============================================================================
 * WHAT THIS FILE DOES
 *   A boolean indicator like "PJP Adherence" (Yes/No) is only *measurable* in
 *   certain rows — you can't follow a journey plan on a Weekly-Off / Leave /
 *   Holiday, or when the rep is Vacant. In the Marico data, "Yes" occurs ONLY
 *   when `PJP Planned Type = "Market Working"`. So the meaningful adherence rate
 *   is 2102/6272 = 33.5% (Market-Working days), NOT 2102/10006 = 21% (diluted by
 *   non-working days). This pure function discovers, at upload, the "gate"
 *   column + in-scope values that define each indicator's valid universe.
 *
 * HOW IT DECIDES (deterministic, no LLM)
 *   For each boolean indicator, cross-tab its POSITIVE value against every
 *   low-card categorical column. A column C is a candidate gate when the
 *   positives are CONCENTRATED in a proper subset S of C's values (≈all
 *   positives in S; the excluded values carry real rows but ≈0 positives). To
 *   pick the SEMANTICALLY-RIGHT gate (a planned/context column, NOT an outcome/
 *   failure column like "Attendance = Absent"), candidates are ranked by
 *   name-affinity to the metric ("PJP" Adherence ↔ "PJP" Planned Type) and a
 *   plan/activity/type name hint. No qualifying gate → no scope (safe: callers
 *   fall back to unscoped behaviour).
 *
 * HOW IT CONNECTS
 *   Run in the upload pipeline after applyIndicatorsToSummary (rows in hand);
 *   stamps `indicator.applicabilityScope`. Consumed by booleanIndicatorRateRepair
 *   / dashboardCoverageGate (scope rate predicates), the degenerate-breakdown
 *   skip, the scoped headline, and the narrator scope note.
 */
import type { DataSummary } from "../shared/schema.js";

export interface ApplicabilityGate {
  gateColumn: string;
  inScopeValues: string[];
  rationale?: string;
}

const MIN_POSITIVE_COVERAGE = 0.98; // ≥98% of positives must fall in the scope
const MIN_OUT_OF_SCOPE_ROW_FRAC = 0.08; // scoping must remove a meaningful slice
const MAX_IN_SCOPE_FRACTION = 0.6; // positives concentrated in ≤60% of values
const PLAN_TYPE_NAME_RE = /\b(plan|planned|type|activity|category|reason|mode|scheme)\b/i;

function tokens(name: string): Set<string> {
  return new Set(
    name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2)
  );
}
function tokenOverlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

/**
 * Returns a map of indicator-column-name → its applicability gate(s), for every
 * boolean indicator whose positives concentrate in a name-affine plan/context
 * column. Pure. Empty map when nothing qualifies.
 */
export function inferMetricApplicability(
  summary: DataSummary,
  rows: ReadonlyArray<Record<string, unknown>>
): Map<string, ApplicabilityGate[]> {
  const out = new Map<string, ApplicabilityGate[]>();
  if (!Array.isArray(rows) || rows.length === 0) return out;

  const numericSet = new Set(summary.numericColumns ?? []);
  const dateSet = new Set(summary.dateColumns ?? []);
  const total = rows.length;

  for (const col of summary.columns) {
    const ind = (col as { indicator?: { kind?: string; positiveValues?: string[] } }).indicator;
    if (!ind || ind.kind !== "boolean") continue;
    const positives = new Set((ind.positiveValues ?? []).map((v) => String(v)));
    if (positives.size === 0) continue;
    const metricName = col.name;
    const metricTokens = tokens(metricName);

    // Candidate gate columns: low-card categoricals other than the metric.
    const candidates: Array<{ gateColumn: string; inScope: string[]; score: number; rationale: string }> = [];
    for (const other of summary.columns) {
      const c = other.name;
      if (c === metricName) continue;
      if (numericSet.has(c) || dateSet.has(c)) continue;
      if ((other as { indicator?: unknown }).indicator && c !== metricName) {
        // allow other indicators as gates too, but they're rarely plan columns
      }
      // Cross-tab: positives + total rows per value of C.
      const posByVal = new Map<string, number>();
      const rowsByVal = new Map<string, number>();
      let totalPos = 0;
      for (const r of rows) {
        const cv = r[c];
        if (cv == null || cv === "") continue;
        const key = String(cv);
        rowsByVal.set(key, (rowsByVal.get(key) ?? 0) + 1);
        const mv = r[metricName];
        if (mv != null && positives.has(String(mv))) {
          posByVal.set(key, (posByVal.get(key) ?? 0) + 1);
          totalPos++;
        }
      }
      if (totalPos === 0 || rowsByVal.size < 2) continue;
      const inScope = [...posByVal.keys()].filter((k) => (posByVal.get(k) ?? 0) > 0);
      if (inScope.length === 0) continue;
      const posCovered = inScope.reduce((a, k) => a + (posByVal.get(k) ?? 0), 0) / totalPos;
      const outOfScopeRows = [...rowsByVal.keys()]
        .filter((k) => !inScope.includes(k))
        .reduce((a, k) => a + (rowsByVal.get(k) ?? 0), 0);
      const concentrated = inScope.length <= Math.max(1, Math.floor(rowsByVal.size * MAX_IN_SCOPE_FRACTION));
      const qualifies =
        posCovered >= MIN_POSITIVE_COVERAGE &&
        concentrated &&
        outOfScopeRows >= total * MIN_OUT_OF_SCOPE_ROW_FRAC;
      if (!qualifies) continue;

      // Rank: name-affinity to the metric dominates (picks the PLANNED/CONTEXT
      // column, not an outcome column like Attendance/Availability).
      const overlap = tokenOverlap(metricTokens, tokens(c));
      const planHint = PLAN_TYPE_NAME_RE.test(c) ? 1 : 0;
      const score = overlap * 100 + planHint * 10 - inScope.length; // fewer in-scope = tighter
      candidates.push({
        gateColumn: c,
        inScope: inScope.sort(),
        score,
        rationale: `${metricName} is only measurable where ${c} ∈ {${inScope.join(", ")}}; other ${c} values are structural zeros.`,
      });
    }
    if (candidates.length === 0) continue;
    // SAFE: only adopt a gate that has a real name/plan signal (score > 0 from
    // overlap or plan-hint). Otherwise we'd risk gating on an outcome column.
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const hasSignal =
      tokenOverlap(metricTokens, tokens(best.gateColumn)) > 0 ||
      PLAN_TYPE_NAME_RE.test(best.gateColumn);
    if (!hasSignal) continue;
    out.set(metricName, [
      { gateColumn: best.gateColumn, inScopeValues: best.inScope, rationale: best.rationale },
    ]);
  }
  return out;
}

/** Stamp inferred gates onto the summary's indicator metadata (idempotent;
 *  preserves user-source indicators). */
export function applyMetricApplicabilityToSummary(
  summary: DataSummary,
  gates: Map<string, ApplicabilityGate[]>
): void {
  for (const [metric, scope] of gates) {
    const col = summary.columns.find((c) => c.name === metric);
    const ind = col?.indicator as
      | { source?: string; applicabilityScope?: ApplicabilityGate[] }
      | undefined;
    if (!ind || ind.source === "user") continue;
    if (scope.length > 0) ind.applicabilityScope = scope;
  }
}
