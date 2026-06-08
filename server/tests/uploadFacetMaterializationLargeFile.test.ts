import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ColumnarStorageService } from "../lib/columnarStorage.js";
import { applyTemporalFacetColumns } from "../lib/temporalFacetColumns.js";

/**
 * Regression guard for the "empty charts/pivots on fresh large-file upload" bug.
 *
 * Root cause (uploadQueue.ts:1089): the temporal-facet application on the FULL
 * `data` array was gated behind `&& !useLargeFileProcessing`, so large-file
 * uploads materialized a DuckDB `data` table WITHOUT the `Month · X` / `Year · X`
 * facet columns that `dataSummary` (and the UI column panel) advertise. Any pivot
 * or chart GROUP BY on a facet column then aggregated over a non-existent column
 * and collapsed to 0 across all measures, while dimension labels still rendered.
 *
 * Fix: apply facets to the full `data` for ALL upload paths before materialize.
 * These tests pin the post-fix contract directly against a real DuckDB round-trip:
 * the materialized `data` table must carry the facet columns AND a faceted
 * aggregation must return the correct non-zero sums.
 */

/** Deterministic dated dataset: Date (ISO), Region (dim), Sales (measure). */
function makeRows(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  // 3 months × 2 regions, 10 rows each → known per-month sums.
  const months = ["2025-01", "2025-02", "2025-03"];
  const regions = ["North", "South"];
  for (const m of months) {
    for (const r of regions) {
      for (let d = 1; d <= 10; d++) {
        rows.push({
          Date: `${m}-${String(d).padStart(2, "0")}`,
          Region: r,
          Sales: 100, // every row contributes 100 → per-month sum = 2000 (2 regions × 10 rows)
        });
      }
    }
  }
  return rows;
}

const MONTH_FACET = "Month · Date";

async function dataColumns(storage: ColumnarStorageService): Promise<string[]> {
  const rows = await storage.executeQuery<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'data' ORDER BY column_name",
  );
  return rows.map((r) => String(r.column_name));
}

describe("upload · temporal facets materialized for all file sizes (large-file fix)", () => {
  it("WITHOUT facet application the materialized `data` table lacks the facet column (documents the bug)", async () => {
    const sessionId = `facet-bug-${process.pid}-${Date.now()}`;
    const storage = new ColumnarStorageService({ sessionId });
    try {
      await storage.initialize();
      // Mirror the large-file path BEFORE the fix: materialize raw `data` with no
      // facet columns applied to the full array.
      await storage.materializeAuthoritativeDataTable(makeRows(), { tableName: "data" });

      const cols = await dataColumns(storage);
      assert.ok(!cols.includes(MONTH_FACET), `bug repro: '${MONTH_FACET}' must be absent without facet application`);
    } finally {
      await storage.cleanup().catch(() => {});
    }
  });

  it("WITH facet application the `data` table carries the facet column and faceted SUM is correct (the fix)", async () => {
    const sessionId = `facet-fix-${process.pid}-${Date.now()}`;
    const storage = new ColumnarStorageService({ sessionId });
    try {
      await storage.initialize();

      // Fix A: apply temporal facets to the FULL data (what uploadQueue now does
      // for every path, large files included) before materialize.
      const rows = makeRows();
      applyTemporalFacetColumns(rows, ["Date"]);
      await storage.materializeAuthoritativeDataTable(rows, { tableName: "data" });

      const cols = await dataColumns(storage);
      assert.ok(cols.includes(MONTH_FACET), `'${MONTH_FACET}' must exist in the materialized table after the fix`);

      // A pivot/chart-style faceted aggregation must now return non-zero, correct sums.
      const agg = await storage.executeQuery<{ m: string; s: number; c: number }>(
        'SELECT "Month · Date" AS m, SUM(CAST(Sales AS BIGINT)) AS s, COUNT(*) AS c FROM "data" GROUP BY 1 ORDER BY 1',
      );
      assert.equal(agg.length, 3, "three month buckets expected");
      assert.equal(agg.reduce((t, r) => t + Number(r.c), 0), 60, "all 60 rows accounted for");
      for (const r of agg) {
        assert.equal(Number(r.s), 2000, `each month sum must be the real 2000, not 0 (got ${r.s} for ${r.m})`);
      }
    } finally {
      await storage.cleanup().catch(() => {});
    }
  });
});
