/**
 * Phase 1 spike harness — answers the ONE open question gating the keystone:
 * can DuckDB read a blob-stored Parquet REMOTELY via a SAS URL on the target
 * host (Vercel read-only FS), or must we download-to-/tmp first?
 *
 * Run on a real deploy / preview where Azure Blob creds are set:
 *   node --import tsx scripts/spikeParquetReadPath.ts
 *
 * It is self-contained, writes a throwaway Parquet, and prints a DECISION line.
 * Nothing else imports this; it never runs in the request path.
 */
import "../loadEnv.js";
import os from "os";
import path from "path";
import * as fs from "fs/promises";
import { ColumnarStorageService } from "../lib/columnarStorage.js";
import { writeDataTableToParquet, parquetBlobName } from "../lib/sessionParquet.js";
import {
  uploadBufferToBlobAtExactPath,
  generateSasUrl,
  getFileFromBlob,
  initializeBlobStorage,
} from "../lib/blobStorage.js";

function lit(p: string): string {
  return p.replace(/\\/g, "/").replace(/'/g, "''");
}

async function main(): Promise<void> {
  const sessionId = `spike-parquet-${Date.now()}`;
  const storage = new ColumnarStorageService({ sessionId });
  const tmp = path.join(os.tmpdir(), `${sessionId}.parquet`);
  console.log("== Phase 1 spike: DuckDB <-> Parquet <-> Azure Blob ==");
  try {
    await storage.initialize();
    const csv = Buffer.from("region,sales\nNorth,10\nSouth,20\nNorth,30\n", "utf8");
    await storage.loadCsvFromBuffer(csv, "data");

    // S1.2 — write perf
    const t0 = Date.now();
    await writeDataTableToParquet(storage, tmp);
    const size = (await fs.stat(tmp)).size;
    console.log(`S1.2 COPY->Parquet write: ${Date.now() - t0}ms; file ${size} bytes`);

    // upload to blob
    await initializeBlobStorage().catch((e: unknown) =>
      console.warn("blob init warn:", e instanceof Error ? e.message : e),
    );
    const blobName = parquetBlobName("spike", sessionId, 0);
    await uploadBufferToBlobAtExactPath(await fs.readFile(tmp), blobName, "application/octet-stream");
    console.log(`uploaded to blob: ${blobName}`);
    const sasUrl = await generateSasUrl(blobName, 30);

    // S1.1 — remote read attempts (raw, then with httpfs, then azure extension)
    async function tryRemote(label: string, prep?: () => Promise<void>): Promise<boolean> {
      try {
        if (prep) await prep();
        const t = Date.now();
        await storage.executeStatement(
          `CREATE OR REPLACE VIEW data_remote AS SELECT * FROM read_parquet('${lit(sasUrl)}')`,
        );
        const rows = await storage.executeQuery<{ n: number }>("SELECT COUNT(*) AS n FROM data_remote");
        console.log(`S1.1 [${label}] REMOTE read OK in ${Date.now() - t}ms; count=${JSON.stringify(rows[0])}`);
        return true;
      } catch (e) {
        console.log(`S1.1 [${label}] REMOTE read FAILED: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    }
    let remoteOk = await tryRemote("raw (no extension)");
    if (!remoteOk) {
      remoteOk = await tryRemote("httpfs", async () => {
        await storage.executeStatement("INSTALL httpfs; LOAD httpfs;");
      });
    }
    if (!remoteOk) {
      remoteOk = await tryRemote("azure", async () => {
        await storage.executeStatement("INSTALL azure; LOAD azure;");
      });
    }

    // S1.3 (and Branch B proof) — download to /tmp then read locally; always works.
    const tDl = Date.now();
    const localPath = path.join(os.tmpdir(), `${sessionId}-dl.parquet`);
    await fs.writeFile(localPath, await getFileFromBlob(blobName));
    await storage.executeStatement(
      `CREATE OR REPLACE VIEW data_local AS SELECT * FROM read_parquet('${lit(localPath)}')`,
    );
    const localRows = await storage.executeQuery<{ n: number }>("SELECT COUNT(*) AS n FROM data_local");
    console.log(`Branch B download+read OK in ${Date.now() - tDl}ms; count=${JSON.stringify(localRows[0])}`);
    await fs.unlink(localPath).catch(() => {});

    console.log(
      `\nDECISION: branch A (remote SAS read) ${
        remoteOk ? "WORKS -> use it in production" : "UNAVAILABLE -> use download-to-/tmp fallback"
      }`,
    );
  } finally {
    await storage.cleanup().catch(() => {});
    await fs.unlink(tmp).catch(() => {});
  }
}

main().catch((e) => {
  console.error("spike failed:", e);
  process.exit(1);
});
