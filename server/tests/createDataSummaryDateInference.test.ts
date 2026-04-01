import { test } from "node:test";
import assert from "node:assert/strict";
import { createDataSummary } from "../lib/fileParser.js";

test("createDataSummary promotes value-parseable columns with non-temporal names at high threshold", () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({
    WeakCol: `2024-01-${String((i % 28) + 1).padStart(2, "0")}T12:00:00.000Z`,
    Sales: i + 1,
  }));
  const summary = createDataSummary(rows);
  assert.ok(
    summary.dateColumns.includes("WeakCol"),
    "expected ISO-heavy column to be promoted to dateColumns"
  );
  const col = summary.columns.find((c) => c.name === "WeakCol");
  assert.equal(col?.type, "date");
});

test("createDataSummary still classifies whitelist date columns without requiring parse threshold", () => {
  const rows = [{ "Order Date": "not-a-date", Sales: 1 }];
  const summary = createDataSummary(rows);
  assert.ok(summary.dateColumns.includes("Order Date"));
});
