/**
 * Wave C8 · `RowSetRef` symbolic row-set references for cross-tool data
 * passing.
 *
 * When tool 2 produces a filtered row set, it stores a `RowSetRef` (filter
 * spec + count + optional small sample) on the scratchpad instead of pushing
 * 5 000 rows into the next tool's args. Tool 5 reads via `resolveRowSet`,
 * which re-runs the filter against the row-level frame.
 *
 * Benefits:
 *   - Cosmos doc bloat goes away (refs are tiny).
 *   - No drift between snapshots — filter is the single source of truth.
 *   - Observation char cap can't truncate the underlying rows.
 */

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

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const f = parseFloat(v);
    if (Number.isFinite(f)) return f;
  }
  return null;
}
