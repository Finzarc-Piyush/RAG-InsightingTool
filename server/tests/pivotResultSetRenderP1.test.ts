import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executePivotQuery } from "../lib/pivotQueryService.js";
import {
  pivotDefaultsSchema,
  pivotQueryRequestSchema,
  PIVOT_AGENT_RESULT_MAX_ROWS,
} from "../shared/schema.js";

/**
 * Wave P1 · Pins the contract that when the agent's analytical step
 * produced computed-alias columns (e.g. AOV = SUM(rev)/COUNT(orders)),
 * the pivot operates on the embedded result rows instead of re-querying
 * the base `data` table.
 *
 * Pre-P1 the pivot dropped alias columns (PVT2 guard at
 * `pivotDefaultsFromExecution.ts` lines 419-427) because `executePivotQuery`
 * SELECTed value fields literally from the base table and would crash
 * with a DuckDB binder error on missing columns. QL9.A surfaced aliases
 * only for SCALAR results (1 row). P1 closes the non-scalar gap.
 */

describe("Wave P1 · pivotQueryRequestSchema accepts dataSource + sourceRows", () => {
  it("dataSource: 'agent_result' + sourceRows passes schema validation", () => {
    const req = pivotQueryRequestSchema.parse({
      rowFields: ["Region"],
      colFields: [],
      filterFields: [],
      valueSpecs: [{ id: "v1", field: "aov", agg: "mean" }],
      dataSource: "agent_result",
      sourceRows: [
        { Region: "North", total_rev: 1000, num_orders: 5, aov: 200 },
        { Region: "South", total_rev: 800, num_orders: 8, aov: 100 },
      ],
    });
    assert.equal(req.dataSource, "agent_result");
    assert.equal(req.sourceRows?.length, 2);
  });

  it("dataSource defaults to undefined (base) when omitted (backwards compat)", () => {
    const req = pivotQueryRequestSchema.parse({
      rowFields: ["Region"],
      colFields: [],
      filterFields: [],
      valueSpecs: [{ id: "v1", field: "Sales", agg: "sum" }],
    });
    assert.equal(req.dataSource, undefined);
    assert.equal(req.sourceRows, undefined);
  });
});

describe("Wave P1 · pivotDefaultsSchema accepts the agent-result fields", () => {
  it("pivotDefaults can carry dataSource: 'agent_result' + agentResultRows + agentResultColumns", () => {
    const defaults = pivotDefaultsSchema.parse({
      rows: ["Region"],
      values: ["aov"],
      dataSource: "agent_result",
      agentResultRows: [{ Region: "N", aov: 100 }],
      agentResultColumns: ["Region", "aov"],
    });
    assert.equal(defaults.dataSource, "agent_result");
    assert.equal(defaults.agentResultRows?.length, 1);
    assert.deepEqual(defaults.agentResultColumns, ["Region", "aov"]);
  });

  it("PIVOT_AGENT_RESULT_MAX_ROWS is exported and bounded (sanity cap)", () => {
    assert.ok(PIVOT_AGENT_RESULT_MAX_ROWS >= 50);
    assert.ok(PIVOT_AGENT_RESULT_MAX_ROWS <= 1000);
  });
});

describe("Wave P1 · executePivotQuery short-circuits on dataSource: 'agent_result'", () => {
  it("aggregates the embedded rows in-memory and surfaces the alias column as a value", async () => {
    const sourceRows = [
      { Region: "North", total_rev: 1000, num_orders: 5, aov: 200 },
      { Region: "South", total_rev: 800, num_orders: 8, aov: 100 },
      { Region: "East", total_rev: 1200, num_orders: 6, aov: 200 },
    ];
    const resp = await executePivotQuery("sess_p1_a", {
      rowFields: ["Region"],
      colFields: [],
      filterFields: [],
      valueSpecs: [{ id: "aov_sum", field: "aov", agg: "sum" }],
      dataSource: "agent_result",
      sourceRows,
    });
    // Source is reported as "sample" (closest existing enum; an
    // "agent_result" literal would need a schema bump that this wave
    // intentionally avoids).
    assert.equal(resp.meta?.source, "sample");
    assert.equal(resp.meta?.rowCount, 3);
    // Three regions = 3 leaf nodes; alias column `aov` was aggregated.
    assert.equal(resp.model.tree.nodes.length, 3);
  });

  it("filterSelections narrow the embedded rows before aggregation", async () => {
    const sourceRows = [
      { Region: "North", aov: 200 },
      { Region: "South", aov: 100 },
      { Region: "East", aov: 250 },
    ];
    const resp = await executePivotQuery("sess_p1_b", {
      rowFields: ["Region"],
      colFields: [],
      filterFields: ["Region"],
      filterSelections: { Region: ["North", "East"] },
      valueSpecs: [{ id: "aov_sum", field: "aov", agg: "sum" }],
      dataSource: "agent_result",
      sourceRows,
    });
    assert.equal(resp.meta?.rowCount, 2);
    assert.equal(resp.model.tree.nodes.length, 2);
  });

  it("empty sourceRows produces an empty tree without crashing", async () => {
    const resp = await executePivotQuery("sess_p1_c", {
      rowFields: ["Region"],
      colFields: [],
      filterFields: [],
      valueSpecs: [{ id: "aov_sum", field: "aov", agg: "sum" }],
      dataSource: "agent_result",
      sourceRows: [],
    });
    assert.equal(resp.meta?.rowCount, 0);
    assert.equal(resp.model.tree.nodes.length, 0);
  });

  it("non-agent_result requests still hit the DuckDB path (no regression on base-table pivots)", async () => {
    // We can't easily run a real DuckDB query in this test env (no chat
    // doc, no materialised table). The contract we can verify
    // cheaply: when dataSource is omitted, executePivotQuery does NOT
    // short-circuit on sourceRows — it would attempt the DuckDB path.
    // We assert this by passing sourceRows WITHOUT the discriminator
    // and confirming the call attempts to initialize storage (which
    // will throw in this test env because no `data` table exists).
    await assert.rejects(
      executePivotQuery("sess_p1_d", {
        rowFields: ["Region"],
        colFields: [],
        filterFields: [],
        valueSpecs: [{ id: "v", field: "Sales", agg: "sum" }],
        // dataSource OMITTED — should NOT short-circuit even though
        // sourceRows is supplied; the server prefers the explicit
        // discriminator.
        sourceRows: [{ Region: "N", Sales: 10 }],
      }),
      /table|columnar|data|storage/i // any storage-init error is fine
    );
  });
});

describe("Wave P1 · cap on agent-result rows", () => {
  it("server accepts up to PIVOT_AGENT_RESULT_MAX_ROWS embedded rows", async () => {
    const sourceRows = Array.from(
      { length: PIVOT_AGENT_RESULT_MAX_ROWS },
      (_, i) => ({ Region: `R${i}`, aov: i + 1 })
    );
    const resp = await executePivotQuery("sess_p1_e", {
      rowFields: ["Region"],
      colFields: [],
      filterFields: [],
      valueSpecs: [{ id: "v", field: "aov", agg: "sum" }],
      dataSource: "agent_result",
      sourceRows,
    });
    assert.equal(resp.meta?.rowCount, PIVOT_AGENT_RESULT_MAX_ROWS);
  });
});
