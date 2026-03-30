import { test } from "node:test";
import assert from "node:assert/strict";
import { extractColumnsFromMessage } from "../lib/columnExtractor.js";

test("extractColumnsFromMessage: Volume and (Volume) do not match inside Sales (Volume)", () => {
  const available = [
    "Sales (Volume)",
    "Volume",
    "(Volume)",
    "Markets",
    "Products",
  ];
  const message = "Sales (Volume) trend for Products in Markets";
  const got = extractColumnsFromMessage(message, available);
  assert.deepEqual(
    got,
    ["Sales (Volume)", "Products", "Markets"],
    "shorter names must not match as embedded segments inside a longer metric phrase"
  );
});

test("extractColumnsFromMessage: specific Sales (Volume) does not pull every Sales* column", () => {
  const available = [
    "Month",
    "Markets",
    "Products",
    "Sales Value",
    "Sales (Volume)",
    "Sales Value % Chg YA",
    "Sales (Volume) % Chg YA",
    "(Volume) / Wghtd Dist Reach CATEGORY",
    "Sales (Volume) Price Index - Product",
  ];
  const message =
    "Sales (Volume) trend for Products = Marico in Markets = OFF VN in.SR";
  const got = extractColumnsFromMessage(message, available);
  assert.ok(
    got.includes("Sales (Volume)"),
    "should include the exact column mentioned"
  );
  assert.ok(
    !got.includes("Sales Value"),
    "should not include Sales Value when only Sales (Volume) was referenced"
  );
  assert.ok(
    !got.includes("Sales (Volume) % Chg YA"),
    "should not include derived % Chg column when message only names Sales (Volume)"
  );
});

test("extractColumnsFromMessage: quoted column name", () => {
  const available = ["Sales (Volume)", "Sales Value"];
  const message = 'Show `"Sales (Volume)"` by month';
  const got = extractColumnsFromMessage(message, available);
  assert.deepEqual(got, ["Sales (Volume)"]);
});

test("extractColumnsFromMessage: @ mention returns only picked columns", () => {
  const available = [
    "Markets",
    "Products",
    "Sales Value",
    "Sales (Volume)",
    "Sales (Volume) % Chg YA",
  ];
  const message =
    "@Sales (Volume) trend for Products = Marico in Markets = OFF VN — ignore extra words";
  const got = extractColumnsFromMessage(message, available);
  assert.deepEqual(
    got,
    ["Sales (Volume)"],
    "must not add Markets/Products/Sales Value from free text when @ pick is present"
  );
});

test("extractColumnsFromMessage: multiple @ mentions", () => {
  const available = ["Markets", "Products", "Sales (Volume)"];
  const message = "@Sales (Volume) by @Markets for @Products test";
  const got = extractColumnsFromMessage(message, available);
  assert.equal(got.length, 3);
  assert.ok(got.includes("Sales (Volume)"));
  assert.ok(got.includes("Markets"));
  assert.ok(got.includes("Products"));
});
