import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveToSchemaColumn } from "../lib/agents/runtime/plannerColumnResolve.js";

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

  it("returns raw when ambiguous or unknown", () => {
    assert.equal(resolveToSchemaColumn("Date", columns), "Date");
  });
});
