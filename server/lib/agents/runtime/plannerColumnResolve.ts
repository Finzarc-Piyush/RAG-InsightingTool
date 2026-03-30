/**
 * Map LLM-output column string to exact DataSummary name when unambiguous (case / spacing).
 * Used by the planner before Zod + column validation.
 */
export function resolveToSchemaColumn(
  raw: string,
  columns: readonly { name: string }[]
): string {
  const t = raw.trim();
  if (!t) return raw;
  if (columns.some((c) => c.name === t)) return t;
  const tl = t.toLowerCase();
  const caseInsensitive = columns.filter((c) => c.name.toLowerCase() === tl);
  if (caseInsensitive.length === 1) return caseInsensitive[0].name;
  const compact = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const compactHits = columns.filter((c) => compact(c.name) === compact(t));
  if (compactHits.length === 1) return compactHits[0].name;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const normHits = columns.filter((c) => norm(c.name) === norm(t));
  if (normHits.length === 1) return normHits[0].name;
  return raw;
}
