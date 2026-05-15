/**
 * Wave PAG1 · Pin the agent's per-column aggregation function (`avg`, `mean`,
 * `sum`, `count`, `min`, `max`) propagates from `tracePlan.aggregations[]`
 * into `pivotDefaults.valueAggregators` so the client value chip is pre-set
 * to the right aggregator instead of defaulting to Sum.
 *
 * Closes the bug: user asks "average compliance visits per day across
 * clusters" → agent runs `AVG()` correctly → Key Insight reads
 * "mean(Compliance Visit)" → BUT the pivot's value chip showed Sum and the
 * pivot SQL re-summed raw daily rows on the canonical `data` table,
 * producing the wrong 21K/15K bars.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  derivePivotDefaultsFromExecutionMerged,
  mapOperationToPivotAgg,
  mergePivotDefaultRowsAndValues,
} from "../lib/pivotDefaultsFromExecution.js";
import type { DataSummary } from "../shared/schema.js";
import type { QueryPlanBody } from "../lib/queryPlanExecutor.js";

function summary(): DataSummary {
  return {
    rowCount: 1000,
    columnCount: 4,
    columns: [
      { name: "Compliance Visit", type: "number", sampleValues: [] },
      { name: "Cluster Name", type: "string", sampleValues: [] },
      { name: "Region", type: "string", sampleValues: [] },
      { name: "PJP Adherence", type: "string", sampleValues: [] },
    ],
    numericColumns: ["Compliance Visit"],
    dateColumns: [],
  } as DataSummary;
}

describe("Wave PAG1 · mapOperationToPivotAgg", () => {
  it("maps mean and avg to mean", () => {
    assert.equal(mapOperationToPivotAgg("mean"), "mean");
    assert.equal(mapOperationToPivotAgg("avg"), "mean");
    assert.equal(mapOperationToPivotAgg("AVG"), "mean");
  });

  it("maps sum and sumIf to sum", () => {
    assert.equal(mapOperationToPivotAgg("sum"), "sum");
    assert.equal(mapOperationToPivotAgg("sumIf"), "sum");
    assert.equal(mapOperationToPivotAgg("SumIf"), "sum");
  });

  it("maps count and countIf to count", () => {
    assert.equal(mapOperationToPivotAgg("count"), "count");
    assert.equal(mapOperationToPivotAgg("countIf"), "count");
  });

  it("maps min and max identically", () => {
    assert.equal(mapOperationToPivotAgg("min"), "min");
    assert.equal(mapOperationToPivotAgg("max"), "max");
  });

  it("returns undefined for unmapped operations", () => {
    assert.equal(mapOperationToPivotAgg("median"), undefined);
    assert.equal(mapOperationToPivotAgg("percent_change"), undefined);
    assert.equal(mapOperationToPivotAgg(""), undefined);
    assert.equal(mapOperationToPivotAgg(undefined), undefined);
  });
});

describe("Wave PAG1 · mergePivotDefaultRowsAndValues — valueAggregators", () => {
  it("propagates mean → mean for the Marico screenshot scenario", () => {
    // The reported bug. Question: "What is the average number of compliance
    // visits per day across clusters?" — agent emits avg(Compliance Visit).
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name"],
      aggregations: [{ column: "Compliance Visit", operation: "mean" }],
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summary(),
      tracePlan: plan,
      tableRows: [
        { "Cluster Name": "Cluster 2 WEST", "Compliance Visit_mean": 21000 },
      ],
      tableColumns: ["Cluster Name", "Compliance Visit_mean"],
    });
    assert.deepEqual(out?.rows, ["Cluster Name"]);
    assert.deepEqual(out?.values, ["Compliance Visit"]);
    assert.deepEqual(out?.valueAggregators, {
      "Compliance Visit": "mean",
    });
  });

  it("propagates avg → mean (parity with the mean spelling)", () => {
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name"],
      aggregations: [{ column: "Compliance Visit", operation: "avg" }],
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summary(),
      tracePlan: plan,
      tableRows: [
        { "Cluster Name": "Cluster 1 NORTH", "Compliance Visit_avg": 8000 },
      ],
      tableColumns: ["Cluster Name", "Compliance Visit_avg"],
    });
    assert.deepEqual(out?.valueAggregators, {
      "Compliance Visit": "mean",
    });
  });

  it("round-trips sum, count, min, max identically", () => {
    const cases: Array<{ op: string; expected: string }> = [
      { op: "sum", expected: "sum" },
      { op: "count", expected: "count" },
      { op: "min", expected: "min" },
      { op: "max", expected: "max" },
    ];
    for (const { op, expected } of cases) {
      const plan: QueryPlanBody = {
        groupBy: ["Cluster Name"],
        aggregations: [{ column: "Compliance Visit", operation: op as "sum" }],
      };
      const out = mergePivotDefaultRowsAndValues({
        dataSummary: summary(),
        tracePlan: plan,
        tableRows: [
          {
            "Cluster Name": "Cluster 2 WEST",
            [`Compliance Visit_${op}`]: 1000,
          },
        ],
        tableColumns: ["Cluster Name", `Compliance Visit_${op}`],
      });
      assert.equal(
        out?.valueAggregators?.["Compliance Visit"],
        expected,
        `operation=${op} should map to ${expected}`
      );
    }
  });

  it("drops the field entirely for median and percent_change (client default fires)", () => {
    for (const op of ["median", "percent_change"]) {
      const plan: QueryPlanBody = {
        groupBy: ["Cluster Name"],
        aggregations: [
          { column: "Compliance Visit", operation: op as "sum" },
        ],
      };
      const out = mergePivotDefaultRowsAndValues({
        dataSummary: summary(),
        tracePlan: plan,
        tableRows: [
          {
            "Cluster Name": "Cluster 2 WEST",
            [`Compliance Visit_${op}`]: 1000,
          },
        ],
        tableColumns: ["Cluster Name", `Compliance Visit_${op}`],
      });
      assert.equal(
        out?.valueAggregators,
        undefined,
        `operation=${op} should omit valueAggregators entirely`
      );
    }
  });

  it("emits one entry per source column for multi-aggregation plans (last write wins on duplicates)", () => {
    // Two different value columns get independent entries.
    const summaryTwoNumeric: DataSummary = {
      ...summary(),
      columns: [
        ...summary().columns,
        { name: "Distance Travelled", type: "number", sampleValues: [] },
      ],
      numericColumns: ["Compliance Visit", "Distance Travelled"],
      columnCount: 5,
    } as DataSummary;
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name"],
      aggregations: [
        { column: "Compliance Visit", operation: "mean" },
        { column: "Distance Travelled", operation: "sum" },
      ],
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summaryTwoNumeric,
      tracePlan: plan,
      tableRows: [
        {
          "Cluster Name": "Cluster 1 WEST",
          "Compliance Visit_mean": 15000,
          "Distance Travelled_sum": 42000,
        },
      ],
      tableColumns: [
        "Cluster Name",
        "Compliance Visit_mean",
        "Distance Travelled_sum",
      ],
    });
    assert.deepEqual(out?.valueAggregators, {
      "Compliance Visit": "mean",
      "Distance Travelled": "sum",
    });
  });

  it("omits valueAggregators on filter-projection plans (PVT1 invariant)", () => {
    // "Which TSOE has not uploaded the PJP yet?" — groupBy + dimensionFilters,
    // no aggregations. Pre-PVT1 this dumped every numeric into VALUES; today
    // values is []. valueAggregators must not appear either.
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name"],
      dimensionFilters: [
        {
          column: "PJP Adherence",
          op: "in",
          values: ["No PJP Available"],
        },
      ],
    } as QueryPlanBody;
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summary(),
      tracePlan: plan,
      tableRows: [{ "Cluster Name": "Cluster 1 EAST" }],
      tableColumns: ["Cluster Name"],
    });
    assert.deepEqual(out?.rows, ["Cluster Name"]);
    assert.deepEqual(out?.values, []);
    assert.equal(
      out?.valueAggregators,
      undefined,
      "filter-projection must not carry aggregator hints"
    );
  });

  it("survives the executor's auto-alias shape (Compliance Visit_avg) via aliasToSource", () => {
    // The executor emits `${column}_${operation}` as the result column. The
    // pivotDefaults pipeline normalizes back to the source column. The
    // aggregator entry must follow that normalization — keyed by the
    // SOURCE column, not the alias.
    const plan: QueryPlanBody = {
      groupBy: ["Cluster Name"],
      aggregations: [{ column: "Compliance Visit", operation: "avg" }],
    };
    const out = mergePivotDefaultRowsAndValues({
      dataSummary: summary(),
      tracePlan: plan,
      tableRows: [
        { "Cluster Name": "Cluster 2 SOUTH", "Compliance Visit_avg": 14500 },
      ],
      tableColumns: ["Cluster Name", "Compliance Visit_avg"],
    });
    assert.ok(
      out?.valueAggregators &&
        "Compliance Visit" in out.valueAggregators,
      "valueAggregators key must be the source column, not the alias"
    );
    assert.equal(out?.valueAggregators?.["Compliance Visit"], "mean");
    // Defensive: alias key MUST NOT appear.
    assert.equal(
      (out?.valueAggregators as Record<string, string>)[
        "Compliance Visit_avg"
      ],
      undefined
    );
  });
});

describe("Wave PAG1 · derivePivotDefaultsFromExecutionMerged — end-to-end through agentTrace", () => {
  it("threads valueAggregators through the merged-path entry point", () => {
    const trace = {
      steps: [
        {
          tool: "execute_query_plan",
          args: {
            plan: {
              groupBy: ["Cluster Name"],
              aggregations: [
                { column: "Compliance Visit", operation: "mean" },
              ],
            },
          },
        },
      ],
    };
    const out = derivePivotDefaultsFromExecutionMerged(summary(), trace, {
      columns: ["Cluster Name", "Compliance Visit_mean"],
      rows: [
        { "Cluster Name": "Cluster 2 WEST", "Compliance Visit_mean": 21000 },
        { "Cluster Name": "Cluster 1 EAST", "Compliance Visit_mean": 7000 },
      ],
    });
    assert.deepEqual(out?.valueAggregators, {
      "Compliance Visit": "mean",
    });
  });
});
