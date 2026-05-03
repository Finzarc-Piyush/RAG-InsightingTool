/**
 * Wave-FA1 · In-memory row filter for the per-session active filter overlay.
 *
 * Pure fn: rows + spec → filtered rows. Reuses `pivotDimensionStringKeyForChartFilter`
 * for value normalization so the in-memory predicate matches the SQL predicate
 * built by `buildActiveFilterSql` (which uses `COALESCE(CAST(col AS VARCHAR), '')`).
 *
 * The canonical dataset is never mutated. RAG retrieval (`indexSession.ts`,
 * `retrieve_semantic_context`) intentionally bypasses this filter — it embeds
 * the full session context regardless of what slice the user is currently
 * inspecting. Do not "fix" that without an explicit product decision.
 */
import type { ActiveFilterSpec, ActiveFilterCondition } from "../../shared/schema.js";
import { pivotDimensionStringKeyForChartFilter } from "../pivotRowFilters.js";

export function isActiveFilterEffective(spec: ActiveFilterSpec | undefined | null): boolean {
  if (!spec) return false;
  if (!Array.isArray(spec.conditions) || spec.conditions.length === 0) return false;
  return spec.conditions.some(isConditionEffective);
}

function isConditionEffective(c: ActiveFilterCondition): boolean {
  // For `in`, an empty values array IS effective — it means "exclude all rows"
  // (the user opened the filter and unchecked every value). The condition only
  // becomes a no-op if the array is missing entirely (defensive).
  if (c.kind === "in") return Array.isArray(c.values);
  if (c.kind === "range") return c.min !== undefined || c.max !== undefined;
  if (c.kind === "dateRange") return Boolean(c.from) || Boolean(c.to);
  return false;
}

function rowMatchesCondition(
  row: Record<string, unknown>,
  c: ActiveFilterCondition
): boolean {
  const raw = row[c.column];
  if (c.kind === "in") {
    if (c.values.length === 0) return false; // empty IN ⇒ matches nothing (mirrors SQL `1=0`)
    const key = pivotDimensionStringKeyForChartFilter(raw);
    return c.values.includes(key);
  }
  if (c.kind === "range") {
    const num = coerceNumber(raw);
    if (num === null) return false;
    if (c.min !== undefined && num < c.min) return false;
    if (c.max !== undefined && num > c.max) return false;
    return true;
  }
  // dateRange — compare ISO strings lexicographically for YYYY-MM-DD; for full
  // ISO timestamps lexicographic compare is also order-preserving.
  const iso = coerceIsoDate(raw);
  if (iso === null) return false;
  if (c.from && iso < c.from) return false;
  if (c.to && iso > c.to) return false;
  return true;
}

function coerceNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function coerceIsoDate(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw.toISOString();
  if (typeof raw === "string") {
    // Already an ISO date or ISO timestamp — keep as-is for lexicographic compare.
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw;
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof raw === "number") {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

export function applyActiveFilter<T extends Record<string, unknown>>(
  rows: T[],
  spec: ActiveFilterSpec | undefined | null
): T[] {
  if (!isActiveFilterEffective(spec)) return rows;
  const conditions = spec!.conditions.filter(isConditionEffective);
  return rows.filter((row) => conditions.every((c) => rowMatchesCondition(row, c)));
}

/** Number of conditions that would actually narrow the result. */
export function effectiveConditionCount(spec: ActiveFilterSpec | undefined | null): number {
  if (!spec) return 0;
  return spec.conditions.filter(isConditionEffective).length;
}
