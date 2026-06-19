/**
 * Wave WR7 (incremental refresh) · APPEND policy — union the new data onto the
 * existing data and regenerate on the FULL combined dataset (e.g. Jan + Feb).
 *
 * This is the user's primary "incremental" model: the new file holds additional
 * rows that are ADDED to what's already there, and the whole analysis is then
 * recomputed on Jan+Feb together — not "the same answers on Feb-only".
 *
 * Dedup: rows are unioned by an inferred BUSINESS KEY (the non-measure
 * dimension columns — dates + categoricals). On a key collision the NEW row
 * wins (a re-stated row supersedes the old). This guards the dangerous case
 * where a user accidentally re-appends rows they already have: instead of
 * silently double-counting, identical-key rows collapse to the new value. The
 * overlap count is surfaced so the UI can warn.
 *
 * The pure cores (`inferBusinessKey`, `unionAppendRows`, `countOverlap`) are
 * exported for tests; `ingestAppendFromRows` adds the load + Cosmos write.
 */

import type { ChatDocument } from "../../models/chat.model.js";
import type { DataSummary } from "../../shared/schema.js";
import { loadLatestData } from "../../utils/dataLoader.js";
import { ingestReplaceFromRows, type IngestNewVersionResult } from "./ingestNewVersion.js";
import { logger } from "../logger.js";

/**
 * Infer the business key = the dimension columns that identify a row (dates +
 * categoricals), i.e. every column that ISN'T a numeric measure. Two rows with
 * the same key are "the same cell" and collapse on append (new wins). Falls
 * back to ALL columns (full-row identity) when every column is numeric.
 */
export function inferBusinessKey(summary: DataSummary | undefined): string[] {
  if (!summary?.columns?.length) return [];
  const numeric = new Set(summary.numericColumns ?? []);
  const key = summary.columns.map((c) => c.name).filter((n) => !numeric.has(n));
  return key.length > 0 ? key : summary.columns.map((c) => c.name);
}

/** Stable key string for a row over the given key columns. */
const rowKey = (row: Record<string, unknown>, keyCols: string[]): string =>
  keyCols.map((c) => String(row?.[c] ?? "")).join("");

/**
 * Count how many NEW rows collide (by key) with an existing row — the rows that
 * would be duplicated by a naïve concat (and are superseded by the dedup).
 */
export function countOverlap(
  oldRows: Record<string, unknown>[],
  newRows: Record<string, unknown>[],
  keyCols: string[]
): number {
  if (keyCols.length === 0) return 0;
  const oldKeys = new Set(oldRows.map((r) => rowKey(r, keyCols)));
  let overlap = 0;
  for (const r of newRows) if (oldKeys.has(rowKey(r, keyCols))) overlap += 1;
  return overlap;
}

export interface UnionAppendResult {
  rows: Record<string, unknown>[];
  /** New rows (all of them are kept). */
  added: number;
  /** Old rows superseded by a same-key new row. */
  superseded: number;
}

/**
 * Union old + new with key-based dedup, NEW wins on collision. Order: surviving
 * old rows (chronological), then the new rows.
 */
export function unionAppendRows(
  oldRows: Record<string, unknown>[],
  newRows: Record<string, unknown>[],
  keyCols: string[]
): UnionAppendResult {
  if (keyCols.length === 0) {
    // No key to dedup on — straight concat.
    return { rows: [...oldRows, ...newRows], added: newRows.length, superseded: 0 };
  }
  const newKeys = new Set(newRows.map((r) => rowKey(r, keyCols)));
  const survivingOld = oldRows.filter((r) => !newKeys.has(rowKey(r, keyCols)));
  return {
    rows: [...survivingOld, ...newRows],
    added: newRows.length,
    superseded: oldRows.length - survivingOld.length,
  };
}

export interface IngestAppendResult extends IngestNewVersionResult {
  superseded: number;
}

/**
 * APPEND-mode ingest: load the session's current rows, union the new rows onto
 * them (key dedup, new wins), and persist the COMBINED dataset as a new version
 * via the replace primitive (the combined data IS the full new dataset).
 */
export async function ingestAppendFromRows(
  chat: ChatDocument,
  newRows: Record<string, unknown>[],
  opts: { versionLabel?: string; keyColumns?: string[] } = {}
): Promise<IngestAppendResult> {
  if (!newRows || newRows.length === 0) {
    throw new Error("Refresh dataset is empty — nothing to append.");
  }
  const oldRows = (await loadLatestData(chat, undefined, undefined, {
    skipActiveFilter: true,
  }).catch((err) => {
    logger.warn(`[refresh] append: loadLatestData failed (${chat.sessionId}):`, err);
    return chat.rawData ?? [];
  })) as Record<string, unknown>[];

  const keyCols = opts.keyColumns?.length
    ? opts.keyColumns
    : inferBusinessKey(chat.dataSummary);
  const union = unionAppendRows(oldRows, newRows, keyCols);
  logger.log(
    `[refresh] append: ${oldRows.length} old + ${newRows.length} new → ${union.rows.length} combined (${union.superseded} superseded)`
  );

  const result = await ingestReplaceFromRows(chat, union.rows, {
    description: `Data refresh (append) — +${newRows.length} rows → ${union.rows.length} total`,
    versionLabel: opts.versionLabel,
  });
  return { ...result, superseded: union.superseded };
}
