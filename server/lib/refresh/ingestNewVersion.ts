/**
 * Wave WR2 (incremental refresh) · ingest a NEW data version into an existing
 * session, REPLACE policy.
 *
 * "Replace" = the incoming rows BECOME the dataset (the new file is the full
 * latest extract that supersedes the prior version, or a Snowflake re-query of
 * the whole table). The append/union path lands in WR7.
 *
 * The whole job here is: process the incoming rows IDENTICALLY to how the
 * original upload processed April — reusing the SESSION's saved
 * `datasetProfile` so date-column approval, dirty-date cleaning, and temporal
 * facets are applied the same way — then hand them to the existing
 * `saveModifiedData` swap primitive, which bumps `currentDataBlob.version`,
 * regenerates `dataSummary`, appends a `dataVersions[]` entry (capped), and
 * schedules a RAG re-index keyed by the bumped version. Replay (WR1) then runs
 * against the swapped data.
 *
 * This module owns ONLY the row → version transformation. Parsing a file /
 * fetching from Snowflake into rows is the controller/service concern (WR3/WR6).
 */

import type { ChatDocument } from "../../models/chat.model.js";
import type { DataSummary, DatasetProfile } from "../../shared/schema.js";
import { applyUploadPipelineWithProfile } from "../fileParser.js";
import { saveModifiedData } from "../dataOps/dataPersistence.js";
import { mutateChatDocument } from "../../models/chat.model.js";
import { logger } from "../logger.js";

/**
 * Wave WR6 · re-query a Snowflake-sourced session's table for a "Fetch latest".
 * Reads the persisted `chat.snowflakeSource` pointer and pulls the full current
 * table (a re-query = Replace semantics). The connection (account/user/pwd)
 * resolves from env in `fetchTableData`; we pass only the table locator.
 * Returns the fresh rows + an optional truncation warning.
 */
export async function fetchSnowflakeRefreshRows(
  chat: ChatDocument
): Promise<{ rows: Record<string, unknown>[]; warning?: string }> {
  const src = chat.snowflakeSource;
  if (!src) {
    throw new Error(
      "This analysis isn't connected to Snowflake — upload a file to update it instead."
    );
  }
  const { fetchTableData, snowflakeTruncationWarning } = await import(
    "../snowflakeService.js"
  );
  const imported = await fetchTableData({
    tableName: src.tableName,
    ...(src.database ? { database: src.database } : {}),
    ...(src.schema ? { schema: src.schema } : {}),
    knownTotalRows: src.knownTotalRows,
  });
  if (!imported.rows || imported.rows.length === 0) {
    throw new Error("No data found in the Snowflake table.");
  }
  const warning = snowflakeTruncationWarning(imported) ?? undefined;
  return { rows: imported.rows, warning };
}

export type RefreshPolicy = "replace" | "append";

export interface IngestNewVersionResult {
  rowCount: number;
  fromVersion: number;
  toVersion: number;
  blobName: string;
}

/**
 * Pure: run the saved upload pipeline over the incoming rows when a
 * `datasetProfile` exists (so the refresh data is canonicalized exactly like
 * the original), else pass the raw rows through. Exported for tests — it is the
 * deterministic core; `ingestReplaceFromRows` adds the Cosmos write.
 */
export function prepareRefreshRows(
  rawRows: Record<string, unknown>[],
  profile: DatasetProfile | undefined
): { data: Record<string, unknown>[]; summary?: DataSummary } {
  if (!rawRows || rawRows.length === 0) {
    throw new Error("Refresh dataset is empty — nothing to ingest.");
  }
  if (!profile) {
    // No saved profile (legacy session) — let `saveModifiedData`'s own
    // canonicalize + facet pass handle the new rows.
    return { data: rawRows };
  }
  const processed = applyUploadPipelineWithProfile(
    rawRows as Record<string, any>[],
    profile
  );
  return { data: processed.data, summary: processed.summary };
}

/**
 * REPLACE-mode ingest: swap the session's dataset to `rawRows` as a new
 * version. Returns the version transition for the refresh state + dashboard
 * provenance. Must be called while the refresh holds the session turn lease
 * (exclusivity is the controller's job).
 */
export async function ingestReplaceFromRows(
  chat: ChatDocument,
  rawRows: Record<string, unknown>[],
  opts: { description?: string; versionLabel?: string } = {}
): Promise<IngestNewVersionResult> {
  const fromVersion = chat.currentDataBlob?.version ?? 0;
  const { data } = prepareRefreshRows(rawRows, chat.datasetProfile);

  const result = await saveModifiedData(
    chat.sessionId,
    data as Record<string, any>[],
    "refresh_replace",
    opts.description ?? `Data refresh (replace) — ${data.length} rows`,
    chat
  );

  // Stamp the human-facing version label onto the just-created version entry
  // (the dashboard "Data: as of …" badge + rollback menu read it). Best-effort
  // and exclusive — the refresh holds the turn lease, so no contention.
  if (opts.versionLabel) {
    await stampVersionLabel(chat.sessionId, result.version, opts.versionLabel);
  }

  logger.log(
    `[refresh] replace ingest: session=${chat.sessionId} v${fromVersion}→v${result.version} rows=${data.length}`
  );
  return {
    rowCount: data.length,
    fromVersion,
    toVersion: result.version,
    blobName: result.blobName,
  };
}

/** Set the `label` on the `v{version}` entry of `dataVersions[]`. */
async function stampVersionLabel(
  sessionId: string,
  version: number,
  label: string
): Promise<void> {
  try {
    await mutateChatDocument(sessionId, (doc) => {
      const entry = doc.dataVersions?.find((v) => v.versionId === `v${version}`);
      if (!entry) return false; // nothing to label — skip the write
      entry.label = label;
    });
  } catch (err) {
    logger.warn(`[refresh] failed to stamp version label (${sessionId}):`, err);
  }
}
