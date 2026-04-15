/**
 * When the LLM mistakes a data value for a column name (e.g. column: "Technology"),
 * map it to the real categorical column using DataSummary top_values / sample_values only.
 */

import type { DimensionFilter } from "../shared/queryTypes.js";
import type { DataSummary } from "../shared/schema.js";

type Nullable<T> = { [K in keyof T]?: T[K] | null };

function columnNamesAllowed(summary: DataSummary): Set<string> {
  return new Set(summary.columns.map((c) => c.name));
}

function isCategoricalColumn(summary: DataSummary, colName: string): boolean {
  const numeric = new Set(summary.numericColumns ?? []);
  const dates = new Set(summary.dateColumns ?? []);
  if (numeric.has(colName) || dates.has(colName)) return false;
  const col = summary.columns.find((c) => c.name === colName);
  if (!col) return false;
  if (col.type === "number") return false;
  return true;
}

function collectCatalogStrings(summary: DataSummary, colName: string): string[] {
  const col = summary.columns.find((c) => c.name === colName);
  if (!col) return [];
  const out: string[] = [];
  for (const t of col.topValues ?? []) {
    out.push(String(t.value));
  }
  for (const s of col.sampleValues ?? []) {
    if (s === null || s === undefined) continue;
    const str = String(s).trim();
    if (str) out.push(str);
  }
  return [...new Set(out)];
}

function dedupePairs(
  pairs: Array<{ column: string; canonical: string }>
): Array<{ column: string; canonical: string }> {
  const seen = new Set<string>();
  const out: Array<{ column: string; canonical: string }> = [];
  for (const p of pairs) {
    const k = `${p.column}\x00${p.canonical}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

/**
 * Find a unique (column, canonical value) for a user/token string using summary hints only.
 * Returns null if ambiguous or no match.
 */
export function findUniqueValueColumnMatch(
  summary: DataSummary,
  token: string
): { column: string; canonical: string } | null {
  const t = token.trim();
  if (!t) return null;

  const collectPhase = (
    mode: "exact" | "ci" | "contains"
  ): Array<{ column: string; canonical: string }> => {
    const pairs: Array<{ column: string; canonical: string }> = [];
    for (const c of summary.columns) {
      if (!isCategoricalColumn(summary, c.name)) continue;
      const vals = collectCatalogStrings(summary, c.name);
      for (const v of vals) {
        if (mode === "exact" && v === t) {
          pairs.push({ column: c.name, canonical: v });
        } else if (mode === "ci" && v.toLowerCase() === t.toLowerCase()) {
          pairs.push({ column: c.name, canonical: v });
        } else if (
          mode === "contains" &&
          t.length >= 2 &&
          v.length >= 2
        ) {
          const tl = t.toLowerCase();
          const vl = v.toLowerCase();
          if (vl.includes(tl) || tl.includes(vl)) {
            pairs.push({ column: c.name, canonical: v });
          }
        }
      }
    }
    return dedupePairs(pairs);
  };

  for (const mode of ["exact", "ci", "contains"] as const) {
    const found = collectPhase(mode);
    if (found.length === 1) {
      return found[0]!;
    }
  }
  return null;
}

function tryRepairOneFilter(
  filter: DimensionFilter,
  summary: DataSummary,
  allowed: Set<string>
): DimensionFilter {
  if (!filter?.column || allowed.has(filter.column)) {
    return filter;
  }

  const op = filter.op === "not_in" ? "not_in" : "in";
  const rawVals = (filter.values || [])
    .map((v) => (v === null || v === undefined ? "" : String(v).trim()))
    .filter(Boolean);
  const candidates = rawVals.length > 0 ? rawVals : [filter.column];

  const resolved: Array<{ column: string; canonical: string }> = [];
  for (const token of candidates) {
    const m = findUniqueValueColumnMatch(summary, token);
    if (!m) {
      return filter;
    }
    resolved.push(m);
  }

  const col0 = resolved[0]!.column;
  if (!resolved.every((r) => r.column === col0)) {
    return filter;
  }

  const values = resolved.map((r) => r.canonical);
  const uniqVals = [...new Set(values)];

  return {
    column: col0,
    op,
    values: uniqVals,
    match: "case_insensitive",
  };
}

/**
 * Rewrite dimension filters whose `column` is not a real column name but matches
 * a value in exactly one categorical column (per token), using summary hints.
 */
export function repairMisassignedDimensionFilters(
  filters: Nullable<DimensionFilter>[] | null | undefined,
  summary: DataSummary | null | undefined
): Nullable<DimensionFilter>[] | undefined {
  if (!filters?.length || !summary) return filters ?? undefined;
  const allowed = columnNamesAllowed(summary);
  return filters.map((f) => {
    if (!f || !f.column) return f;
    return tryRepairOneFilter(f as DimensionFilter, summary, allowed);
  }) as Nullable<DimensionFilter>[];
}
