/**
 * ============================================================================
 * rowSetRef.ts — pass a filtered row set between tools by reference, not copy
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Defines a "RowSetRef": a tiny pointer to a subset of rows, described by the
 *   FILTER that selects them (plus a row count and an optional small sample)
 *   rather than the rows themselves. A later tool resolves the ref by re-running
 *   that filter against the full in-memory data frame.
 *
 * WHY IT MATTERS
 *   When one tool narrows the data to, say, 5,000 rows, copying those rows into
 *   the next tool's arguments bloats the stored chat document and can get
 *   truncated by the observation size cap. A ref is small, and because the
 *   filter is the single source of truth, there's no drift between snapshots.
 *
 * KEY PIECES
 *   - RowSetRef — the reference shape (filter, count, sample, provenance).
 *   - makeRowSetRef(args) — create a ref (samples clipped to 5 rows).
 *   - resolveRowSet(rows, ref) / applyFilterSpec(rows, filter) — re-apply the
 *     filter to recover the actual rows. Supports equality, `in`, and
 *     gt/gte/lt/lte operators, with loose (case-insensitive) value matching.
 *
 * HOW IT CONNECTS
 *   A producing tool stores a RowSetRef on the agent scratchpad; a downstream
 *   tool calls resolveRowSet against the row-level frame. Pure functions, no I/O.
 */

import { toNumberOrNull as toNumber } from "../../numberCoercion.js";

export interface RowSetRef {
  kind: "rowSetRef";
  /** Filter spec describing the cohort. */
  filter: Record<string, unknown>;
  /** Row count this ref stands for at the time it was created. */
  count: number;
  /** Optional small sample for prompt rendering / verification. */
  sample?: Record<string, unknown>[];
  /** Step that produced this ref (for provenance). */
  producedByStepId?: string;
  /** ISO timestamp the ref was created. */
  createdAt: number;
}

export function makeRowSetRef(args: {
  filter: Record<string, unknown>;
  count: number;
  sample?: Record<string, unknown>[];
  producedByStepId?: string;
}): RowSetRef {
  return {
    kind: "rowSetRef",
    filter: args.filter,
    count: args.count,
    sample: args.sample?.slice(0, 5),
    producedByStepId: args.producedByStepId,
    createdAt: Date.now(),
  };
}

/**
 * Resolve a RowSetRef against an in-memory frame. Used by downstream tools
 * that want to operate on the same cohort without re-shipping rows.
 */
export function resolveRowSet(
  rows: ReadonlyArray<Record<string, unknown>>,
  ref: RowSetRef
): Record<string, unknown>[] {
  return applyFilterSpec(rows, ref.filter);
}

export function applyFilterSpec(
  rows: ReadonlyArray<Record<string, unknown>>,
  filter: Record<string, unknown>
): Record<string, unknown>[] {
  if (!filter || Object.keys(filter).length === 0) return rows.slice();
  return rows.filter((row) => matchesFilter(row, filter));
}

function matchesFilter(row: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(filter)) {
    const cell = row[k];
    if (Array.isArray(v)) {
      if (!v.some((x) => looseEqual(cell, x))) return false;
    } else if (typeof v === "object" && v !== null) {
      // Nested operator object: { op: "in" | "gt" | "lt" | "gte" | "lte", values?: any[], value?: any }
      const op = (v as { op?: string }).op;
      if (op === "in" && Array.isArray((v as { values?: unknown[] }).values)) {
        if (!(v as { values: unknown[] }).values.some((x) => looseEqual(cell, x))) return false;
      } else if (op === "gt" || op === "gte" || op === "lt" || op === "lte") {
        const target = (v as { value?: unknown }).value;
        const a = toNumber(cell);
        const b = toNumber(target);
        if (a === null || b === null) return false;
        if (op === "gt" && !(a > b)) return false;
        if (op === "gte" && !(a >= b)) return false;
        if (op === "lt" && !(a < b)) return false;
        if (op === "lte" && !(a <= b)) return false;
      }
    } else {
      if (!looseEqual(cell, v)) return false;
    }
  }
  return true;
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

