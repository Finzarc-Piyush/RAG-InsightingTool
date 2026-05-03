/**
 * Wave-FA1 · DuckDB WHERE-clause builder for the per-session active filter
 * overlay. Composes existing safe helpers from `pivotFilterSql.ts` —
 * `quoteIdent` and `escapeSqlStringLiteral` — to avoid hand-rolled escapes.
 *
 * Result is a single boolean SQL expression suitable for embedding in a
 * `CREATE OR REPLACE VIEW data_filtered AS SELECT * FROM data WHERE <expr>`
 * statement. When the filter is empty/ineffective the helper returns `null`
 * and callers should fall back to the canonical `data` table directly.
 */
import type { ActiveFilterSpec, ActiveFilterCondition } from "../../shared/schema.js";
import { quoteIdent, escapeSqlStringLiteral } from "../pivotFilterSql.js";
import { isActiveFilterEffective } from "./applyActiveFilter.js";

function isoLiteral(s: string): string {
  return escapeSqlStringLiteral(s);
}

function buildConditionSql(c: ActiveFilterCondition): string | null {
  if (c.kind === "in") {
    if (!c.values || c.values.length === 0) return "1=0";
    const colExpr = `COALESCE(CAST(${quoteIdent(c.column)} AS VARCHAR), '')`;
    const inList = c.values.map((v) => escapeSqlStringLiteral(String(v))).join(", ");
    return `${colExpr} IN (${inList})`;
  }
  if (c.kind === "range") {
    if (c.min === undefined && c.max === undefined) return null;
    const ident = quoteIdent(c.column);
    // TRY_CAST returns NULL on bad rows; comparison vs NULL is NULL ⇒ row excluded.
    const expr = `TRY_CAST(${ident} AS DOUBLE)`;
    const parts: string[] = [];
    if (c.min !== undefined) parts.push(`${expr} >= ${Number(c.min)}`);
    if (c.max !== undefined) parts.push(`${expr} <= ${Number(c.max)}`);
    return parts.join(" AND ");
  }
  if (c.kind === "dateRange") {
    if (!c.from && !c.to) return null;
    const ident = quoteIdent(c.column);
    // Compare as VARCHAR; ISO 8601 prefix-match is order-preserving for both
    // YYYY-MM-DD and full timestamps. Keeps parity with `applyActiveFilter`'s
    // lexicographic compare and avoids per-dialect TIMESTAMP cast failures.
    const expr = `CAST(${ident} AS VARCHAR)`;
    const parts: string[] = [];
    if (c.from) parts.push(`${expr} >= ${isoLiteral(c.from)}`);
    if (c.to) parts.push(`${expr} <= ${isoLiteral(c.to)}`);
    return parts.join(" AND ");
  }
  return null;
}

/**
 * @returns SQL expression like `("Region" IN ('North','South')) AND (TRY_CAST("Sales" AS DOUBLE) >= 1000)`,
 *          or `null` if the spec is absent / has no effective conditions.
 */
export function buildActiveFilterWhereSql(
  spec: ActiveFilterSpec | undefined | null
): string | null {
  if (!isActiveFilterEffective(spec)) return null;
  const parts: string[] = [];
  for (const c of spec!.conditions) {
    const sql = buildConditionSql(c);
    if (sql) parts.push(`(${sql})`);
  }
  if (parts.length === 0) return null;
  return parts.join(" AND ");
}
