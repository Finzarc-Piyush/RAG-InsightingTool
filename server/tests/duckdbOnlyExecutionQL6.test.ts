/**
 * Wave QL6 · DuckDB-first execution for analytical aggregations.
 *
 * Pins the contract: when a plan has aggregations, the `execute_query_plan`
 * tool MUST hit DuckDB. If DuckDB execution fails (or isn't materialized)
 * for any reason OTHER than a per-turn computed-column binding error, the
 * tool hard-fails with a clear retry message — NO silent fallback to
 * in-memory aggregation against Cosmos-loaded rows.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../lib/agents/runtime/toolRegistry.js";
import { registerDefaultTools } from "../lib/agents/runtime/tools/registerTools.js";
import type { DataSummary } from "../shared/schema.js";

const summary: DataSummary = {
  rowCount: 4,
  columnCount: 2,
  columns: [
    { name: "Cluster Name", type: "string", sampleValues: [] },
    { name: "Compliance Visit", type: "number", sampleValues: [] },
  ],
  numericColumns: ["Compliance Visit"],
  dateColumns: [],
};

const rows = [
  { "Cluster Name": "A", "Compliance Visit": 10 },
  { "Cluster Name": "A", "Compliance Visit": 20 },
  { "Cluster Name": "B", "Compliance Visit": 30 },
  { "Cluster Name": "B", "Compliance Visit": 40 },
];

function ctxFor(overrides: { columnarStoragePath?: string }) {
  return {
    exec: {
      sessionId: "ql6-fixture",
      summary,
      data: rows,
      turnStartDataRef: { rows },
      columnarStoragePath: overrides.columnarStoragePath,
      chatDocument: {} as any,
    },
    metadata: {},
  } as any;
}

describe("Wave QL6 · execute_query_plan hard-fails when DuckDB unavailable + plan has aggregations", () => {
  it("rejects aggregation plans when columnarStoragePath is missing (no in-memory fallback)", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const result = await registry.execute(
      "execute_query_plan",
      {
        plan: {
          groupBy: ["Cluster Name"],
          aggregations: [
            { column: "Compliance Visit", operation: "sum", alias: "total" },
          ],
        },
      } as Record<string, unknown>,
      ctxFor({ columnarStoragePath: undefined })
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(
        result.summary,
        /DuckDB execution surface is not available|materialization/i
      );
    }
  });

  it("ALLOWS projection plans (no aggregations) via in-memory path even without DuckDB", async () => {
    const registry = new ToolRegistry();
    registerDefaultTools(registry);
    const result = await registry.execute(
      "execute_query_plan",
      {
        plan: {
          groupBy: [],
          // No aggregations — this is a row-list/projection plan, legitimate
          // for the in-memory path (sample / preview / row-level chart).
          limit: 2,
          sort: [{ column: "Compliance Visit", direction: "desc" }],
        },
      } as Record<string, unknown>,
      ctxFor({ columnarStoragePath: undefined })
    );
    assert.equal(result.ok, true);
  });
});
