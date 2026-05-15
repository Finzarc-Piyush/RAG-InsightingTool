/**
 * Wave T3 · `checkTemporalTrendBuckets`
 *
 * Deterministic post-narrator gate that fires when the user asked for a
 * temporal trend ("over time", "trend", "evolution", ...) but the executed
 * query produced ≤ 1 distinct value on the grouped temporal facet axis.
 * Without this check, the agent silently delivers a cross-sectional answer
 * to a temporal question with no caveat — the failure mode that motivated
 * the trend-grain-aware planner change in T2.
 *
 * Pure logic — no I/O, no LLM. Mirrors the W17 / W22 / W35 check shape so
 * the agent-loop's existing batched repair pipeline can fold it in without
 * structural changes.
 *
 * Bounded by `config.maxVerifierRoundsFinal` at the call site (one repair
 * round in practice) — the gate fires once per turn at most, and the
 * narrator either honours the course-correction (adds a caveat) or
 * is forced into a no-op pass.
 */
import { isTemporalFacetColumnKey } from "../../temporalFacetColumns.js";
import { TREND_OVER_TIME_RE } from "../../queryPlanTemporalPatch.js";
import type { StructuredObservation } from "./investigationState.js";

export type TemporalTrendBucketsResult =
  | { ok: true }
  | {
      ok: false;
      code: "TEMPORAL_TREND_SINGLE_BUCKET";
      description: string;
      courseCorrection: string;
    };

/** Same explicit-grain phrases the planner patch honours — user intent
 * wins, and a "daily" question that yields a single day's data should not
 * fire this check (e.g. dataset truly is one day). */
const EXPLICIT_DAILY_RE = /\b(daily|per\s+day|each\s+day|day\s+by\s+day)\b/i;

function extractRowsFromToolTable(table: unknown): Record<string, unknown>[] {
  if (!table) return [];
  if (Array.isArray(table)) return table as Record<string, unknown>[];
  if (typeof table === "object" && table !== null) {
    const r = (table as { rows?: unknown }).rows;
    if (Array.isArray(r)) return r as Record<string, unknown>[];
  }
  return [];
}

/** Find the most recent `execute_query_plan` observation that grouped by
 * at least one temporal facet column, and return both the facet column
 * name and the row-level result. Returns null when no such observation
 * exists. */
function findLatestTemporalGroupByObservation(
  observations: readonly StructuredObservation[],
): { facetColumn: string; rows: Record<string, unknown>[] } | null {
  for (let i = observations.length - 1; i >= 0; i--) {
    const obs = observations[i];
    if (obs.tool !== "execute_query_plan") continue;
    const plan = (obs.args as { plan?: unknown } | undefined)?.plan as
      | { groupBy?: unknown }
      | undefined;
    const groupBy = plan?.groupBy;
    if (!Array.isArray(groupBy) || groupBy.length === 0) continue;
    const facetColumn = (groupBy as unknown[]).find(
      (g): g is string => typeof g === "string" && isTemporalFacetColumnKey(g),
    );
    if (!facetColumn) continue;
    const rows = extractRowsFromToolTable(
      (obs.result as { table?: unknown } | undefined)?.table,
    );
    return { facetColumn, rows };
  }
  return null;
}

export function checkTemporalTrendBuckets(
  question: string,
  observations: readonly StructuredObservation[],
): TemporalTrendBucketsResult {
  const q = question?.trim();
  if (!q) return { ok: true };
  if (!TREND_OVER_TIME_RE.test(q)) return { ok: true };
  if (EXPLICIT_DAILY_RE.test(q)) return { ok: true };

  const found = findLatestTemporalGroupByObservation(observations);
  if (!found) return { ok: true };

  const distinct = new Set<string>();
  for (const row of found.rows) {
    const v = row[found.facetColumn];
    if (v === null || v === undefined || v === "") continue;
    distinct.add(String(v));
  }
  if (distinct.size > 1) return { ok: true };

  const onlyBucket = distinct.size === 1 ? Array.from(distinct)[0] : "(none)";
  return {
    ok: false,
    code: "TEMPORAL_TREND_SINGLE_BUCKET",
    description:
      `The user asked for a temporal trend ("${q.replace(/\s+/g, " ").slice(0, 120)}"), ` +
      `but the executed query grouped by \`${found.facetColumn}\` and returned only ${distinct.size} distinct time bucket` +
      (distinct.size === 1 ? ` (\`${onlyBucket}\`)` : "") +
      `. A multi-period trend cannot be plotted from this slice.`,
    courseCorrection:
      "Add a caveat to `caveats[]` that names the dataset's actual temporal scope " +
      "(e.g. \"Dataset spans only one period; a multi-period trend cannot be plotted\") " +
      "and reframes the takeaway as variation across the non-temporal dimension within " +
      "that scope. Do NOT invent additional time periods. If `caveats[]` already says this, leave it.",
  };
}
