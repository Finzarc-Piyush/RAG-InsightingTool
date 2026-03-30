import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const FORBIDDEN = /\b(insert|update|delete|attach|pragma|copy|export|import|drop|alter|create|replace|call|detach)\b/i;

export const READONLY_SQL_MAX_IN_ROWS = 12_000;
export const READONLY_SQL_MAX_OUT_ROWS = 5_000;
export const READONLY_SQL_MAX_LENGTH = 1_200;

export function sanitizeReadonlyDatasetSql(sql: string): { ok: true; sql: string } | { ok: false; error: string } {
  const trimmed = sql.trim();
  if (!trimmed.length) return { ok: false, error: "Empty SQL" };
  if (trimmed.length > READONLY_SQL_MAX_LENGTH) {
    return { ok: false, error: `SQL exceeds ${READONLY_SQL_MAX_LENGTH} characters` };
  }
  if (!/^\s*select\b/is.test(trimmed)) {
    return { ok: false, error: "Only a single SELECT statement is allowed" };
  }
  const semi = trimmed.match(/;/g);
  if (semi && semi.length > 1) {
    return { ok: false, error: "Multiple statements are not allowed" };
  }
  if (FORBIDDEN.test(trimmed)) {
    return { ok: false, error: "Forbidden keyword in SQL (read-only SELECT only)" };
  }
  if (!/\bdataset\b/i.test(trimmed)) {
    return { ok: false, error: 'SQL must query the table "dataset" (e.g. SELECT ... FROM dataset ...)' };
  }
  return { ok: true, sql: trimmed.replace(/;+\s*$/g, "") };
}

/**
 * Runs a single SELECT against an ephemeral in-memory DuckDB table `dataset`.
 * Best-effort: returns ok:false if DuckDB is unavailable or load fails.
 */
export async function executeReadonlySqlOnFrame(
  data: Record<string, any>[],
  sql: string
): Promise<
  | { ok: true; rows: Record<string, any>[]; columns: string[] }
  | { ok: false; error: string }
> {
  const parsed = sanitizeReadonlyDatasetSql(sql);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  if (!data.length) {
    return { ok: false, error: "No rows to query" };
  }

  const slice = data.slice(0, READONLY_SQL_MAX_IN_ROWS);
  let duckdb: { default?: { Database?: new (p: string) => unknown }; Database?: new (p: string) => unknown };
  try {
    duckdb = await import("duckdb");
  } catch {
    return { ok: false, error: "DuckDB is not available in this environment" };
  }
  const DatabaseCtor =
    duckdb.default?.Database || duckdb.Database || (duckdb as { Database: new (p: string) => unknown }).Database;
  if (!DatabaseCtor) {
    return { ok: false, error: "DuckDB Database constructor not found" };
  }

  type DuckConn = {
    all: (q: string, cb: (err: Error | null, rows: Record<string, any>[]) => void) => void;
    close: (cb: (err: Error | null) => void) => void;
  };

  const tmp = path.join(os.tmpdir(), `agent-ro-sql-${Date.now()}-${Math.random().toString(36).slice(2, 9)}.json`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(slice), "utf8");
    const db = new DatabaseCtor(":memory:") as { connect: () => DuckConn };
    const conn = db.connect();

    const escapedPath = tmp.replace(/\\/g, "/").replace(/'/g, "''");
    await new Promise<void>((resolve, reject) => {
      conn.all(
        `CREATE TABLE dataset AS SELECT * FROM read_json_auto('${escapedPath}');`,
        (err) => (err ? reject(err) : resolve())
      );
    });

    const rows = await new Promise<Record<string, any>[]>((resolve, reject) => {
      conn.all(parsed.sql, (err, r) => (err ? reject(err) : resolve(r ?? [])));
    });

    await new Promise<void>((resolve) => conn.close(() => resolve()));

    const capped = rows.slice(0, READONLY_SQL_MAX_OUT_ROWS);
    const columns = capped.length > 0 ? Object.keys(capped[0]!) : [];
    return { ok: true, rows: capped, columns };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `DuckDB: ${msg.slice(0, 500)}` };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}
