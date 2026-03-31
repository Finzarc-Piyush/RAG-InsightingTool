import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveMetricAliasToSchemaColumn,
  resolveToSchemaColumn,
} from "../lib/agents/runtime/plannerColumnResolve.js";

describe("resolveToSchemaColumn", () => {
  const columns = [
    { name: "Order Date" },
    { name: "Sales" },
    { name: "Ship Mode" },
  ];

  it("returns exact match unchanged", () => {
    assert.equal(resolveToSchemaColumn("Sales", columns), "Sales");
  });

  it("fixes case when unique", () => {
    assert.equal(resolveToSchemaColumn("sales", columns), "Sales");
  });

  it("fixes spacing when unique (OrderDate vs Order Date)", () => {
    assert.equal(resolveToSchemaColumn("OrderDate", columns), "Order Date");
    assert.equal(resolveToSchemaColumn("order date", columns), "Order Date");
  });

  it("returns raw when ambiguous or unknown (generic token)", () => {
    assert.equal(resolveToSchemaColumn("Date", columns), "Date");
  });

  it("resolves partial label to unique schema column", () => {
    const wide = [
      { name: "Product Category" },
      { name: "Sales (USD)" },
    ];
    assert.equal(resolveToSchemaColumn("Category", wide), "Product Category");
    assert.equal(resolveToSchemaColumn("Sales", wide), "Sales (USD)");
  });

  it("resolves metric alias drift when preferred metric is clear", () => {
    const m = [
      { name: "Category" },
      { name: "Sales" },
      { name: "Quantity" },
    ];
    assert.equal(
      resolveMetricAliasToSchemaColumn("Total_Revenue", m, ["Sales"]),
      "Sales"
    );
  });

  it("keeps raw metric alias when ambiguous", () => {
    const m = [{ name: "Net Amount" }, { name: "Gross Value" }];
    assert.equal(resolveMetricAliasToSchemaColumn("Total_Revenue", m), "Total_Revenue");
  });
});
