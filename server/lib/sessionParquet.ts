/**
 * Phase 1 (keystone) · durable Parquet store + DuckDB-over-blob read path.
 *
 * North star: write each session's authoritative dataset ONCE as Parquet in
 * Azure Blob, then have DuckDB query it directly — eliminating the per-request
 * full rehydration (load all rows → JS array → CSV → read_csv_auto) that breaks
 * on serverless at scale. See plans/phase1-parquet-duckdb-spike.md.
 *
 * Status: the DuckDB COPY→read_parquet mechanism here is unit-verified locally.
 * The REMOTE read of a blob Parquet via a SAS URL needs DuckDB's httpfs/azure
 * extension on the host (Vercel read-only FS) — that's the one open question the
 * spike script (scripts/spikeParquetReadPath.ts) answers. `openSessionParquetAsView`
 * already tolerates both outcomes: it tries the remote read and falls back to a
 * download-to-/tmp read, which always works. The read path is gated behind the
 * default-OFF `USE_PARQUET_READ_PATH` flag, so production behaviour is unchanged
 * until it is explicitly enabled.
 */

import path from "path";
import os from "os";
import * as fs from "fs/promises";
import type { ColumnarStorageService } from "./columnarStorage.js";
import {
  uploadBufferToBlobAtExactPath,
  getFileFromBlob,
  generateSasUrl,
} from "./blobStorage.js";
import { logger } from "./logger.js";

/** Phase 1 feature flag. Default OFF — the existing read path is used unless set to "true". */
export function isParquetReadPathEnabled(): boolean {
  return process.env.USE_PARQUET_READ_PATH === "true";
}

/**
 * Canonical blob path for a session's authoritative Parquet at a given data
 * version. Mirrors the `…/v{n}.json` convention used by `updateProcessedDataBlob`.
 * Pure + unit-testable.
 */
export function parquetBlobName(
  username: string,
  sessionId: string,
  version: number,
): string {
  const safeUser = (username || "anon").replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${safeUser}/parquet/${sessionId}/v${version}.parquet`;
}

/** DuckDB single-quoted string literal: forward-slash paths + escape quotes. */
function sqlPathLiteral(p: string): string {
  return p.replace(/\\/g, "/").replace(/'/g, "''");
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Write a DuckDB relation (default the `data` table) to a Parquet file via the
 * native `COPY … TO … (FORMAT PARQUET)` — no extension required.
 */
export async function writeDataTableToParquet(
  storage: ColumnarStorageService,
  parquetPath: string,
  sourceTable = "data",
): Promise<void> {
  await storage.executeStatement(
    `COPY (SELECT * FROM ${quoteIdent(sourceTable)}) TO '${sqlPathLiteral(
      parquetPath,
    )}' (FORMAT PARQUET)`,
  );
}

/**
 * (Re)create a view (default `data`) backed by a Parquet source — a local
 * /tmp path OR a remote URL. Downstream query code (`resolveSessionDataTable`,
 * the query-plan executor, the `data_filtered` overlay) is unchanged: it still
 * targets `data`, now a view over Parquet.
 */
export async function openParquetAsDataView(
  storage: ColumnarStorageService,
  parquetSource: string,
  viewName = "data",
): Promise<void> {
  await storage.executeStatement(
    `CREATE OR REPLACE VIEW ${quoteIdent(viewName)} AS SELECT * FROM read_parquet('${sqlPathLiteral(
      parquetSource,
    )}')`,
  );
}

/**
 * Write the session's `data` table to /tmp Parquet, upload it to blob, and
 * return the blob name. Caller must have a materialized `data` table on `storage`.
 * (Integration path — exercised when the Parquet read path is enabled.)
 */
export async function writeAndUploadSessionParquet(
  storage: ColumnarStorageService,
  args: { username: string; sessionId: string; version: number },
): Promise<string> {
  const tmpPath = path.join(
    os.tmpdir(),
    `marico-parquet-${args.sessionId}-v${args.version}.parquet`,
  );
  try {
    await writeDataTableToParquet(storage, tmpPath);
    const buf = await fs.readFile(tmpPath);
    const blobName = parquetBlobName(args.username, args.sessionId, args.version);
    await uploadBufferToBlobAtExactPath(buf, blobName, "application/octet-stream");
    return blobName;
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
}

/**
 * Open a blob-stored Parquet as the session `data` view, dual-branch:
 *   A (preferred) — remote read via a short-lived SAS URL (needs httpfs/azure
 *       on the host; validated by the spike). Probed with a trivial SELECT so an
 *       unsupported/lazy extension surfaces here, not mid-query.
 *   B (fallback, always works) — download to /tmp, then read the local file.
 * Returns which branch served the open.
 */
export async function openSessionParquetAsView(
  storage: ColumnarStorageService,
  blobName: string,
  sessionId: string,
): Promise<"remote" | "download"> {
  try {
    const sasUrl = await generateSasUrl(blobName, 60);
    await openParquetAsDataView(storage, sasUrl);
    await storage.executeQuery('SELECT 1 FROM "data" LIMIT 1');
    return "remote";
  } catch (remoteErr) {
    logger.warn(
      `⚠️ Parquet remote read unavailable, falling back to download: ${
        remoteErr instanceof Error ? remoteErr.message : String(remoteErr)
      }`,
    );
  }
  const buf = await getFileFromBlob(blobName);
  const localPath = path.join(os.tmpdir(), `marico-parquet-read-${sessionId}.parquet`);
  await fs.writeFile(localPath, buf);
  try {
    // Branch B already holds the full dataset locally, so materialize it into a
    // real `data` TABLE rather than a view: a `read_parquet` view reads lazily
    // and would dangle the moment we delete the temp file. With a table the
    // relation is self-contained, so we can delete the file in `finally` — no
    // leak. Drop any partial `data` view a failed Branch A may have left first.
    await storage.executeStatement('DROP VIEW IF EXISTS "data"');
    await storage.executeStatement(
      `CREATE OR REPLACE TABLE "data" AS SELECT * FROM read_parquet('${sqlPathLiteral(localPath)}')`,
    );
  } finally {
    await fs.unlink(localPath).catch(() => {});
  }
  return "download";
}
