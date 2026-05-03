/**
 * Wave-FA2 · Resolve which DuckDB table analytical tools should query.
 *
 * Returns either `"data"` (canonical, unfiltered) or `"data_filtered"` (a view
 * over `data` with the active-filter `WHERE` clause applied). The canonical
 * `data` table is never destroyed or rebuilt by filter changes — only the
 * lightweight view is replaced. This is what the user asked for: "let all
 * tools that are doing the analysis hit this newly created dataset. Anytime
 * filters are changed, you change this filtered-dataset file only with an
 * overwrite."
 *
 * The view is keyed by `activeFilter.version` via an in-process cache; if the
 * version hasn't changed we skip the DDL altogether. Multiple sessions are
 * isolated because each `ColumnarStorageService` instance is per-session
 * (different `.duckdb` file).
 */
import type { ChatDocument } from "../../models/chat.model.js";
import type { ColumnarStorageService } from "../columnarStorage.js";
import type { ActiveFilterSpec } from "../../shared/schema.js";
import { buildActiveFilterWhereSql } from "./buildActiveFilterSql.js";
import { isActiveFilterEffective } from "./applyActiveFilter.js";

export const CANONICAL_DATA_TABLE = "data";
export const FILTERED_DATA_VIEW = "data_filtered";

/** sessionId → last applied filter version. */
const lastEnsuredVersionBySession = new Map<string, number | "none">();

/** Test seam — clears the per-session cache so a fresh assertion can run. */
export function __resetActiveFilterViewCacheForTests(): void {
  lastEnsuredVersionBySession.clear();
}

export interface ResolveSessionDataTableOptions {
  /** Default true. Set false to force the canonical `data` table even if a filter is active. */
  allowFiltered?: boolean;
}

/**
 * Ensures the DuckDB view `data_filtered` is up to date and returns the table
 * name analytical tools should query. Idempotent across calls within the same
 * `(sessionId, activeFilter.version)` tuple.
 */
export async function resolveSessionDataTable(
  storage: ColumnarStorageService,
  chat: Pick<ChatDocument, "sessionId" | "activeFilter">,
  options: ResolveSessionDataTableOptions = {}
): Promise<string> {
  const allowFiltered = options.allowFiltered !== false;
  const spec = chat.activeFilter;
  if (!allowFiltered || !isActiveFilterEffective(spec)) {
    // No filter active (or caller forced canonical) — drop any stale view if it
    // exists so subsequent reads can't accidentally see yesterday's predicate.
    await dropFilteredViewIfStale(storage, chat.sessionId, "none");
    return CANONICAL_DATA_TABLE;
  }
  await ensureFilteredDataView(storage, chat.sessionId, spec!);
  return FILTERED_DATA_VIEW;
}

async function ensureFilteredDataView(
  storage: ColumnarStorageService,
  sessionId: string,
  spec: ActiveFilterSpec
): Promise<void> {
  const cached = lastEnsuredVersionBySession.get(sessionId);
  if (cached === spec.version) return;
  const where = buildActiveFilterWhereSql(spec);
  if (!where) {
    // Defensive: an effective spec should produce a WHERE clause. Drop view.
    await storage.executeStatement(`DROP VIEW IF EXISTS "${FILTERED_DATA_VIEW}"`);
    lastEnsuredVersionBySession.set(sessionId, "none");
    return;
  }
  // CREATE OR REPLACE VIEW is atomic in DuckDB — concurrent readers either see
  // the old or the new view, never a partially-built state.
  const sql = `CREATE OR REPLACE VIEW "${FILTERED_DATA_VIEW}" AS SELECT * FROM "${CANONICAL_DATA_TABLE}" WHERE ${where}`;
  await storage.executeStatement(sql);
  lastEnsuredVersionBySession.set(sessionId, spec.version);
}

async function dropFilteredViewIfStale(
  storage: ColumnarStorageService,
  sessionId: string,
  marker: "none"
): Promise<void> {
  if (lastEnsuredVersionBySession.get(sessionId) === marker) return;
  await storage.executeStatement(`DROP VIEW IF EXISTS "${FILTERED_DATA_VIEW}"`);
  lastEnsuredVersionBySession.set(sessionId, marker);
}

/**
 * Bumps the cache invalidation marker for a session — call from the
 * activeFilter controller after a successful PUT/DELETE so the next analytical
 * read rebuilds the view even if an in-process cache had marked it fresh.
 */
export function invalidateFilteredDataView(sessionId: string): void {
  lastEnsuredVersionBySession.delete(sessionId);
}
