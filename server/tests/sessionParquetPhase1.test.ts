import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";
import * as fs from "fs/promises";
import { ColumnarStorageService } from "../lib/columnarStorage.js";
import {
  writeDataTableToParquet,
  openParquetAsDataView,
  parquetBlobName,
  isParquetReadPathEnabled,
} from "../lib/sessionParquet.js";

describe("Phase 1 · sessionParquet pure helpers", () => {
  it("parquetBlobName builds the versioned convention path and sanitizes the user", () => {
    assert.equal(parquetBlobName("alice", "sess-1", 3), "alice/parquet/sess-1/v3.parquet");
    assert.equal(parquetBlobName("a/b c", "s", 0), "a_b_c/parquet/s/v0.parquet");
    assert.equal(parquetBlobName("", "s", 1), "anon/parquet/s/v1.parquet");
  });

  it("isParquetReadPathEnabled reflects env and defaults OFF", () => {
    delete process.env.USE_PARQUET_READ_PATH;
    assert.equal(isParquetReadPathEnabled(), false);
    process.env.USE_PARQUET_READ_PATH = "false";
    assert.equal(isParquetReadPathEnabled(), false);
    process.env.USE_PARQUET_READ_PATH = "true";
    assert.equal(isParquetReadPathEnabled(), true);
    delete process.env.USE_PARQUET_READ_PATH;
  });
});

describe("Phase 1 · DuckDB Parquet round-trip (local, no blob)", () => {
  it("writes the data table to Parquet and reads it back via a read_parquet view", async () => {
    // Date.now() is permitted in node tests (the restriction is workflow-script only).
    const sessionId = `parquet-test-${process.pid}-${Date.now()}`;
    const storage = new ColumnarStorageService({ sessionId });
    const parquetPath = path.join(os.tmpdir(), `${sessionId}.parquet`);
    try {
      await storage.initialize();
      const csv = Buffer.from("region,sales\nNorth,10\nSouth,20\nNorth,30\n", "utf8");
      await storage.loadCsvFromBuffer(csv, "data");

      // Write `data` to Parquet, drop the table, then re-expose `data` as a
      // view over the Parquet file — the exact mechanism the read path uses.
      await writeDataTableToParquet(storage, parquetPath);
      await storage.executeStatement('DROP TABLE "data"');
      await openParquetAsDataView(storage, parquetPath);

      const rows = await storage.executeQuery<{ region: string; total: number }>(
        'SELECT region, SUM(CAST(sales AS BIGINT)) AS total FROM "data" GROUP BY region ORDER BY region',
      );
      assert.equal(rows.length, 2);
      const north = rows.find((r) => r.region === "North");
      const south = rows.find((r) => r.region === "South");
      assert.ok(north && south);
      assert.equal(Number(north!.total), 40);
      assert.equal(Number(south!.total), 20);
    } finally {
      await storage.cleanup().catch(() => {});
      await fs.unlink(parquetPath).catch(() => {});
    }
  });
});
