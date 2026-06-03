import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";
import * as fs from "fs/promises";
import { ColumnarStorageService } from "../lib/columnarStorage.js";
import { writeDataTableToParquet, openParquetAsDataView } from "../lib/sessionParquet.js";

/** Deterministic multi-type CSV: region (string), brand (string), sales (int), units (int). */
function makeCsv(n: number): Buffer {
  const regions = ["North", "South", "East", "West"];
  const lines = ["region,brand,sales,units"];
  for (let i = 0; i < n; i++) {
    lines.push(`${regions[i % 4]},Brand${i % 10},${(i % 100) + 1},${(i % 7) + 1}`);
  }
  return Buffer.from(lines.join("\n") + "\n", "utf8");
}

type Agg = { region: string; s: number; c: number };
function normalize(rows: any[]): Agg[] {
  return rows.map((r) => ({ region: String(r.region), s: Number(r.s), c: Number(r.c) }));
}
const AGG_SQL =
  'SELECT region, SUM(CAST(sales AS BIGINT)) AS s, COUNT(*) AS c FROM "data" GROUP BY region ORDER BY region';

describe("Phase 1+2 · Parquet round-trip preserves data exactly at scale", () => {
  it("a 5k-row, multi-type table aggregates identically through write→read_parquet", async () => {
    const sessionId = `parquet-int-${process.pid}-${Date.now()}`;
    const storage = new ColumnarStorageService({ sessionId });
    const parquetPath = path.join(os.tmpdir(), `${sessionId}.parquet`);
    try {
      await storage.initialize();
      await storage.loadCsvFromBuffer(makeCsv(5000), "data");

      const before = normalize(await storage.executeQuery(AGG_SQL));
      assert.equal(before.reduce((t, r) => t + r.c, 0), 5000);

      await writeDataTableToParquet(storage, parquetPath);
      await storage.executeStatement('DROP TABLE "data"');
      await openParquetAsDataView(storage, parquetPath); // data is now a VIEW over parquet

      const after = normalize(await storage.executeQuery(AGG_SQL));
      assert.deepEqual(after, before, "aggregation must be identical after the parquet round-trip");
    } finally {
      await storage.cleanup().catch(() => {});
      await fs.unlink(parquetPath).catch(() => {});
    }
  });
});

describe("Phase 1 · active-filter overlay stacks over a Parquet-backed `data` view", () => {
  it("data_filtered = SELECT * FROM data WHERE … resolves correctly when data reads from parquet", async () => {
    const sessionId = `parquet-filter-${process.pid}-${Date.now()}`;
    const storage = new ColumnarStorageService({ sessionId });
    const parquetPath = path.join(os.tmpdir(), `${sessionId}.parquet`);
    try {
      await storage.initialize();
      await storage.loadCsvFromBuffer(makeCsv(4000), "data");
      const before = normalize(await storage.executeQuery(AGG_SQL));
      const northCount = before.find((r) => r.region === "North")!.c;

      await writeDataTableToParquet(storage, parquetPath);
      await storage.executeStatement('DROP TABLE "data"');
      await openParquetAsDataView(storage, parquetPath);

      // Mirror resolveSessionDataTable's overlay: a view stacked on the parquet-backed `data`.
      await storage.executeStatement(
        'CREATE OR REPLACE VIEW "data_filtered" AS SELECT * FROM "data" WHERE region = \'North\'',
      );
      const filtered = await storage.executeQuery('SELECT COUNT(*) AS c FROM "data_filtered"');
      assert.equal(Number(filtered[0].c), northCount, "filtered view count must match the unfiltered North count");
    } finally {
      await storage.cleanup().catch(() => {});
      await fs.unlink(parquetPath).catch(() => {});
    }
  });
});
