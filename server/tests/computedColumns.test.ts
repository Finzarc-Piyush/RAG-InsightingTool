import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addComputedColumnsArgsSchema,
  applyAddComputedColumns,
  registerComputedColumnsOnSummary,
} from "../lib/computedColumns.js";
import type { DataSummary } from "../shared/schema.js";

function minimalSummary(columnNames: string[], dateCols: string[] = []): DataSummary {
  const numericCols = columnNames.filter((c) => !dateCols.includes(c));
  return {
    rowCount: 2,
    columnCount: columnNames.length,
    columns: columnNames.map((name) => ({
      name,
      type: dateCols.includes(name) ? "date" : "number",
      sampleValues: dateCols.includes(name) ? ["11/8/17"] : [1],
    })),
    numericColumns: numericCols,
    dateColumns: dateCols,
  };
}

describe("addComputedColumnsArgsSchema", () => {
  it("accepts date_diff_days", () => {
    const r = addComputedColumnsArgsSchema.safeParse({
      columns: [
        {
          name: "LagDays",
          def: {
            type: "date_diff_days",
            startColumn: "Order Date",
            endColumn: "Ship Date",
          },
        },
      ],
    });
    assert.equal(r.success, true);
  });

  it("accepts numeric_binary", () => {
    const r = addComputedColumnsArgsSchema.safeParse({
      columns: [
        {
          name: "MarginRatio",
          def: {
            type: "numeric_binary",
            op: "divide",
            leftColumn: "Profit",
            rightColumn: "Sales",
          },
        },
      ],
    });
    assert.equal(r.success, true);
  });
});

describe("applyAddComputedColumns", () => {
  it("computes whole-day difference using facet-aligned date parsing", () => {
    const summary = minimalSummary(["Order Date", "Ship Date"], ["Order Date", "Ship Date"]);
    const data = [
      { "Order Date": "11/8/17", "Ship Date": "11/11/17" },
      { "Order Date": "6/9/15", "Ship Date": "6/14/15" },
    ];
    const out = applyAddComputedColumns(data, summary, {
      columns: [
        {
          name: "ShipLagDays",
          def: {
            type: "date_diff_days",
            startColumn: "Order Date",
            endColumn: "Ship Date",
          },
        },
      ],
    });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.rows[0]!.ShipLagDays, 3);
    assert.equal(out.rows[1]!.ShipLagDays, 5);
  });

  it("returns null for clampNegative when diff negative", () => {
    const summary = minimalSummary(["A", "B"], ["A", "B"]);
    const data = [{ A: "1/10/20", B: "1/5/20" }];
    const out = applyAddComputedColumns(data, summary, {
      columns: [
        {
          name: "D",
          def: {
            type: "date_diff_days",
            startColumn: "A",
            endColumn: "B",
            clampNegative: true,
          },
        },
      ],
    });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.rows[0]!.D, null);
  });

  it("numeric_binary divide by zero yields null", () => {
    const summary = minimalSummary(["Sales", "Qty"]);
    const data = [{ Sales: 100, Qty: 0 }];
    const out = applyAddComputedColumns(data, summary, {
      columns: [
        {
          name: "PerUnit",
          def: {
            type: "numeric_binary",
            op: "divide",
            leftColumn: "Sales",
            rightColumn: "Qty",
          },
        },
      ],
    });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.rows[0]!.PerUnit, null);
  });
});

describe("registerComputedColumnsOnSummary", () => {
  it("appends numeric column metadata", () => {
    const summary = minimalSummary(["Order Date", "Ship Date"], ["Order Date", "Ship Date"]);
    const rows = [{ ShipLagDays: 3 }, { ShipLagDays: 5 }];
    registerComputedColumnsOnSummary(
      summary,
      {
        columns: [
          {
            name: "ShipLagDays",
            def: {
              type: "date_diff_days",
              startColumn: "Order Date",
              endColumn: "Ship Date",
            },
          },
        ],
      },
      rows
    );
    assert.ok(summary.numericColumns.includes("ShipLagDays"));
    assert.ok(summary.columns.some((c) => c.name === "ShipLagDays"));
  });
});
