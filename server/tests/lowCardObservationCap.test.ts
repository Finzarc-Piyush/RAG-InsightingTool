/**
 * Wave W2 · execute_query_plan observation cap is cardinality-aware.
 *
 * A SMALL result (≤ 50 rows — e.g. a 24-row ASM ranking) must appear IN FULL in
 * the narrator-facing `Sample:` snippet so the writer can state the complete
 * ranking instead of hedging "only partially shown in the snippet". A LARGER
 * result keeps the 30-row cap (the full table still rides on `table.rows`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../lib/agents/runtime/toolRegistry.js";
import { registerDefaultTools } from "../lib/agents/runtime/tools/registerTools.js";
import type { DataSummary } from "../shared/schema.js";

const summary: DataSummary = {
  rowCount: 200,
  columnCount: 2,
  columns: [
    { name: "id", type: "string", sampleValues: [] },
    { name: "val", type: "number", sampleValues: [] },
  ],
  numericColumns: ["val"],
  dateColumns: [],
};

const rows = Array.from({ length: 200 }, (_, i) => ({ id: `R${i}`, val: i }));

function ctxFor() {
  return {
    exec: {
      sessionId: "w2-fixture",
      summary,
      data: rows,
      turnStartDataRef: { rows },
      columnarStoragePath: undefined,
      chatDocument: {} as unknown,
    },
    metadata: {},
  } as unknown as Parameters<ToolRegistry["execute"]>[2];
}

async function runProjection(limit: number) {
  const registry = new ToolRegistry();
  registerDefaultTools(registry);
  // Projection (no aggregations) → legitimate in-memory path, no DuckDB needed.
  return registry.execute(
    "execute_query_plan",
    { plan: { groupBy: [], limit, sort: [{ column: "val", direction: "desc" }] } } as Record<
      string,
      unknown
    >,
    ctxFor()
  );
}

describe("Wave W2 · execute_query_plan observation cap is cardinality-aware", () => {
  it("shows ALL rows in the snippet for a small (≤50-row) result — no partial-snippet note", async () => {
    const result = await runProjection(24);
    assert.equal(result.ok, true);
    assert.match(result.summary, /Rows: 24/);
    // No "showing first N of M" truncation note when the whole result fits.
    assert.ok(!/showing first/.test(result.summary), result.summary.slice(0, 200));
    // Every one of the 24 projected rows is present in the Sample JSON.
    const idCount = (result.summary.match(/"id":/g) ?? []).length;
    assert.equal(idCount, 24);
  });

  it("caps the snippet at 30 rows for a larger (>50-row) result", async () => {
    const result = await runProjection(60);
    assert.equal(result.ok, true);
    assert.match(result.summary, /showing first 30 of 60/);
    const idCount = (result.summary.match(/"id":/g) ?? []).length;
    assert.equal(idCount, 30);
  });
});
