/**
 * `translateLegacyFilterToActiveFilter` intent helper — extracted verbatim from
 * `dataOpsOrchestrator.ts` (ARCH-2 / CQ-2 god-file decomposition).
 *
 * Pure translator (no I/O, no session state) from the legacy LLM-parsed
 * `intent.filterConditions` shape to the `ActiveFilterCondition[]` overlay shape.
 * Returns ok:false with a reason when at least one condition uses an operator the
 * overlay can't model — caller falls back to the legacy destructive
 * `saveModifiedData` path so behaviour stays exactly as before for `!=`,
 * `contains`, etc. Behaviour-preserving move.
 *
 * Operator mappings (loose; preserves user intent for the natural-language
 * path which was never operator-precise to begin with):
 *   `=`, `in`           → `kind: "in"`
 *   `>`, `>=`, `<`, `<=`, `between` (numeric) → `kind: "range"`
 *   `between` on a date column                → `kind: "dateRange"`
 *   `!=`, `contains`, `startsWith`, `endsWith` → not modelable → fall back
 */
import type { DataOpsIntent } from "../dataOpsOrchestrator.js";
import type { ActiveFilterCondition } from "../../../shared/schema.js";

export function translateLegacyFilterToActiveFilter(
  rawConditions: NonNullable<DataOpsIntent["filterConditions"]>
): { ok: true; conditions: ActiveFilterCondition[] } | { ok: false; reason: string } {
  const out: ActiveFilterCondition[] = [];
  for (const c of rawConditions) {
    if (!c.column) return { ok: false, reason: "missing column" };
    const column = c.column;
    const op = c.operator;
    if (op === "=") {
      out.push({ kind: "in", column, values: [String(c.value)] });
      continue;
    }
    if (op === "in") {
      const vals = Array.isArray(c.values) ? c.values.map(String) : [];
      out.push({ kind: "in", column, values: vals });
      continue;
    }
    if (op === ">=" || op === ">") {
      const n = Number(c.value);
      if (!Number.isFinite(n)) return { ok: false, reason: `non-numeric ${op} bound` };
      out.push({ kind: "range", column, min: n });
      continue;
    }
    if (op === "<=" || op === "<") {
      const n = Number(c.value);
      if (!Number.isFinite(n)) return { ok: false, reason: `non-numeric ${op} bound` };
      out.push({ kind: "range", column, max: n });
      continue;
    }
    if (op === "between") {
      // Treat YYYY-MM-DD-looking strings as date range; otherwise numeric range.
      const isIsoDate =
        typeof c.value === "string" && /^\d{4}-\d{2}-\d{2}/.test(c.value);
      if (isIsoDate) {
        out.push({
          kind: "dateRange",
          column,
          from: String(c.value),
          to: typeof c.value2 === "string" ? c.value2 : undefined,
        });
      } else {
        const lo = Number(c.value);
        const hi = Number(c.value2);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
          return { ok: false, reason: "between requires two numeric bounds" };
        }
        out.push({ kind: "range", column, min: lo, max: hi });
      }
      continue;
    }
    return { ok: false, reason: `operator '${op}' not representable as active filter` };
  }
  return { ok: true, conditions: out };
}
