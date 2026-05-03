import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFile, createDataSummary } from "../lib/fileParser.js";

function csvBuffer(rows: string[]): Buffer {
  return Buffer.from(rows.join("\n"), "utf-8");
}

describe("fileParser · currency-aware coercion", () => {
  // Mixed magnitudes + a decimal so isIdentifierLikeNumericColumn
  // doesn't flag the column as ID-like (it requires all-integer +
  // either ≥80% unique OR fixed digit width). Magnitudes are large
  // enough that csv-parse's cast_date doesn't misinterpret them as
  // year tokens.
  const repeatedSales = [
    1500, 25000, 1500, 350000, 1234.5, 4900, 1500, 25000, 7500, 350000,
  ];

  it("Vietnamese đồng strings parse to numbers and tag the column", async () => {
    const csv = csvBuffer([
      "Brand,Sales",
      ...repeatedSales.map(
        (v, i) => `Brand${i % 4},"đ${v.toLocaleString()},000"`
      ),
    ]);
    const data = await parseFile(csv, "marico.csv");
    assert.equal(data.length, repeatedSales.length);
    assert.equal(typeof data[0].Sales, "number");

    const summary = createDataSummary(data);
    const sales = summary.columns.find((c) => c.name === "Sales")!;
    assert.equal(sales.type, "number");
    assert.ok(sales.currency, "expected currency tag on Sales");
    assert.equal(sales.currency!.isoCode, "VND");
    assert.equal(sales.currency!.symbol, "đ");
    assert.equal(sales.currency!.position, "prefix");
    assert.ok(sales.currency!.confidence >= 0.8);
  });

  it("dollar sign columns get USD by default", async () => {
    const csv = csvBuffer([
      "Brand,Sales",
      ...repeatedSales.map(
        (v, i) => `Brand${i % 4},"$${v.toLocaleString()}"`
      ),
    ]);
    const data = await parseFile(csv, "usd.csv");
    const summary = createDataSummary(data);
    const sales = summary.columns.find((c) => c.name === "Sales")!;
    assert.ok(sales.currency);
    assert.equal(sales.currency!.isoCode, "USD");
    assert.equal(sales.currency!.symbol, "$");
  });

  it("plain numeric column has no currency tag", async () => {
    const csv = csvBuffer([
      "Brand,Sales",
      ...repeatedSales.map((v, i) => `Brand${i % 4},${v}`),
    ]);
    const data = await parseFile(csv, "plain.csv");
    const summary = createDataSummary(data);
    const sales = summary.columns.find((c) => c.name === "Sales")!;
    assert.equal(sales.type, "number");
    assert.equal(sales.currency, undefined);
  });

  it("string column never carries a currency tag even with one stray symbol", async () => {
    const csv = csvBuffer([
      "Brand,Note",
      "A,Marico",
      "B,Olive",
      "C,Lashe",
    ]);
    const data = await parseFile(csv, "txt.csv");
    const summary = createDataSummary(data);
    const note = summary.columns.find((c) => c.name === "Note")!;
    assert.equal(note.type, "string");
    assert.equal(note.currency, undefined);
  });
});
