import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ColumnarStorageService } from "../lib/columnarStorage.js";
import { applyTemporalFacetColumns } from "../lib/temporalFacetColumns.js";

/**
 * Durability contract for Fix B (persist enriched `currentDataBlob` at upload).
 *
 * On a cold /tmp (session revisit / restart / serverless cold start), the
 * per-session DuckDB is gone, so `ensureAuthoritativeDataTable` rematerializes
 * via `loadLatestData`. With Fix B the upload writes the enriched `data` to a
 * durable blob and records `currentDataBlob`, so loadLatestData's Priority 1
 * (currentDataBlob, JSON branch) returns those rows VERBATIM — JSON.parse of the
 * uploaded buffer — and re-materializes them into the `data` table.
 *
 * This test mirrors that full path WITHOUT Azure (the blob fetch is just a JSON
 * round-trip): enriched rows → JSON.stringify/parse (the durable copy) →
 * materializeAuthoritativeDataTable (the rematerialize) → faceted aggregation.
 * It pins the load-bearing guarantee: the durable enriched copy reproduces the
 * upload-time table EXACTLY (non-zero measures), and the enrichment survives JSON
 * serialization byte-for-byte (no Date/undefined/NaN corruption that would make
 * the reloaded table diverge from what was materialized at upload).
 */

function makeRows(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const months = ["2025-01", "2025-02", "2025-03"];
  const regions = ["North", "South"];
  for (const m of months) {
    for (const r of regions) {
      for (let d = 1; d <= 10; d++) {
        rows.push({ Date: `${m}-${String(d).padStart(2, "0")}`, Region: r, Sales: 100 });
      }
    }
  }
  return rows;
}

describe("upload · durable enriched currentDataBlob reloads the table exactly (cold-/tmp heal)", () => {
  it("enriched rows survive the JSON durable copy and rematerialize to correct, non-zero aggregates", async () => {
    // 1) Upload-time: enrich the full data (Fix A) — this is what is materialized
    //    AND what Fix B persists to currentDataBlob.
    const enriched = makeRows();
    applyTemporalFacetColumns(enriched, ["Date"]);
    assert.ok(Object.keys(enriched[0]).includes("Month · Date"), "precondition: facets applied");

    // 2) Durable copy: updateProcessedDataBlob serializes to JSON; loadLatestData's
    //    currentDataBlob branch reads it back via JSON.parse. Mirror that exactly.
    const persisted = JSON.parse(JSON.stringify(enriched)) as Record<string, unknown>[];
    assert.deepEqual(persisted, enriched, "enriched rows must round-trip through JSON byte-for-byte");

    // 3) Cold reload: rematerialize the persisted rows into a fresh DuckDB (what
    //    ensureAuthoritativeDataTable does from the currentDataBlob rows).
    const sessionId = `enriched-durability-${process.pid}-${Date.now()}`;
    const storage = new ColumnarStorageService({ sessionId });
    try {
      await storage.initialize();
      await storage.materializeAuthoritativeDataTable(persisted, { tableName: "data" });

      // 4) Faceted aggregation must be correct + non-zero — i.e. the cold-reloaded
      //    table is identical to the upload-time one, not the fragile re-parse.
      const agg = await storage.executeQuery<{ m: string; s: number; c: number }>(
        'SELECT "Month · Date" AS m, SUM(CAST(Sales AS BIGINT)) AS s, COUNT(*) AS c FROM "data" GROUP BY 1 ORDER BY 1',
      );
      assert.equal(agg.length, 3, "three month buckets after cold reload");
      assert.equal(agg.reduce((t, r) => t + Number(r.c), 0), 60, "all 60 rows reloaded");
      for (const r of agg) {
        assert.equal(Number(r.s), 2000, `cold-reloaded month sum must be the real 2000, not 0 (got ${r.s} for ${r.m})`);
      }

      // 5) A non-temporal pivot (Region) must also be correct after reload.
      const byRegion = await storage.executeQuery<{ Region: string; s: number; c: number }>(
        'SELECT Region, SUM(CAST(Sales AS BIGINT)) AS s, COUNT(*) AS c FROM "data" GROUP BY Region ORDER BY Region',
      );
      assert.equal(byRegion.length, 2);
      for (const r of byRegion) {
        assert.equal(Number(r.c), 30, "30 rows per region");
        assert.equal(Number(r.s), 3000, "per-region sum must be the real 3000, not 0");
      }
    } finally {
      await storage.cleanup().catch(() => {});
    }
  });
});
