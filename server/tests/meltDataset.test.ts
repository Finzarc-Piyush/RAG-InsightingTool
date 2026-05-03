import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyDataset } from "../lib/wideFormat/classifyDataset.js";
import { meltDataset } from "../lib/wideFormat/meltDataset.js";

describe("meltDataset · pure_period (Marico-VN shape)", () => {
  const headers = [
    "Facts",
    "Markets",
    "Products",
    "Q1 23 - w/e 23/03/23",
    "Q2 23 - w/e 22/06/23",
    "Q3 23 - w/e 22/09/23",
  ];
  const rows = [
    {
      "Facts": "Value Sales",
      "Markets": "Off VN",
      "Products": "MARICO",
      "Q1 23 - w/e 23/03/23": "đ135,804,075,023",
      "Q2 23 - w/e 22/06/23": "đ140,000,000,000",
      "Q3 23 - w/e 22/09/23": "đ150,000,000,000",
    },
    {
      "Facts": "Value Sales",
      "Markets": "Off VN",
      "Products": "OLIV",
      "Q1 23 - w/e 23/03/23": "đ36,073,526,133",
      "Q2 23 - w/e 22/06/23": "đ40,000,000,000",
      "Q3 23 - w/e 22/09/23": "đ45,000,000,000",
    },
  ];
  const c = classifyDataset(headers);
  const m = meltDataset(rows, c);

  it("produces 2 × 3 = 6 long rows", () => {
    assert.equal(m.rows.length, 6);
  });
  it("each long row has id + Period + PeriodIso + PeriodKind + Value", () => {
    for (const r of m.rows) {
      assert.ok("Facts" in r);
      assert.ok("Markets" in r);
      assert.ok("Products" in r);
      assert.ok("Period" in r);
      assert.ok("PeriodIso" in r);
      assert.ok("PeriodKind" in r);
      assert.ok("Value" in r);
      assert.ok(!("Metric" in r), "pure_period must not add Metric");
    }
  });
  it("Period column carries the original raw header label", () => {
    const periods = m.rows.map((r) => r.Period);
    assert.ok(periods.includes("Q1 23 - w/e 23/03/23"));
  });
  it("PeriodIso is canonical (2023-Q1 etc.)", () => {
    const isos = new Set(m.rows.map((r) => r.PeriodIso));
    assert.ok(isos.has("2023-Q1"));
    assert.ok(isos.has("2023-Q2"));
    assert.ok(isos.has("2023-Q3"));
  });
  it("currency-stripped Value column contains numbers", () => {
    for (const r of m.rows) {
      assert.equal(typeof r.Value, "number", `expected number, got ${typeof r.Value}`);
    }
    const mar = m.rows.find((r) => r.Products === "MARICO" && r.PeriodIso === "2023-Q1");
    assert.ok(mar);
    assert.equal(mar!.Value, 135804075023);
  });
  it("summary captures the đ symbol as dominant currency", () => {
    assert.equal(m.summary.detectedCurrencySymbol, "đ");
    assert.equal(m.summary.shape, "pure_period");
    assert.equal(m.summary.periodCount, 3);
    assert.deepEqual(m.summary.idColumns, ["Facts", "Markets", "Products"]);
    assert.equal(m.summary.metricColumn, undefined);
  });
});

describe("meltDataset · compound shape", () => {
  const headers = [
    "Brand",
    "Q1 2023 Value Sales",
    "Q1 2023 Volume Sales",
    "Q2 2023 Value Sales",
    "Q2 2023 Volume Sales",
  ];
  const rows = [
    {
      Brand: "MARICO",
      "Q1 2023 Value Sales": 1000,
      "Q1 2023 Volume Sales": 50,
      "Q2 2023 Value Sales": 1100,
      "Q2 2023 Volume Sales": 55,
    },
  ];
  const c = classifyDataset(headers);
  const m = meltDataset(rows, c);

  it("produces 4 long rows (1 brand × 4 compound cols)", () => {
    assert.equal(m.rows.length, 4);
  });
  it("each row has Metric column with canonical metric name", () => {
    for (const r of m.rows) assert.ok("Metric" in r);
    const metrics = new Set(m.rows.map((r) => r.Metric));
    assert.ok(metrics.has("Value Sales"));
    assert.ok(metrics.has("Volume Sales"));
  });
  it("summary metricColumn is set", () => {
    assert.equal(m.summary.metricColumn, "Metric");
    assert.equal(m.summary.shape, "compound");
  });
});

describe("meltDataset · null + non-numeric handling", () => {
  const headers = ["Brand", "Q1 23", "Q2 23", "Q3 23"];
  const rows = [
    { Brand: "X", "Q1 23": null, "Q2 23": "not-a-number", "Q3 23": "đ500" },
  ];
  const c = classifyDataset(headers);
  const m = meltDataset(rows, c);
  it("null and non-numeric → null Value, parseable currency → number", () => {
    assert.equal(m.rows[0].Value, null);
    assert.equal(m.rows[1].Value, null);
    assert.equal(m.rows[2].Value, 500);
  });
});

describe("meltDataset · throws on non-wide classification", () => {
  const headers = ["Date", "Brand", "Sales"];
  const c = classifyDataset(headers);
  it("not-wide classification throws", () => {
    assert.throws(() => meltDataset([], c), /non-wide/);
  });
});

describe("meltDataset · round-trip preserves cell values", () => {
  const headers = ["Brand", "Region", "Q1 23", "Q2 23", "Q3 23"];
  const rows = [
    { Brand: "A", Region: "N", "Q1 23": 100, "Q2 23": 200, "Q3 23": 250 },
    { Brand: "B", Region: "S", "Q1 23": 300, "Q2 23": 400, "Q3 23": 450 },
  ];
  const c = classifyDataset(headers);
  const m = meltDataset(rows, c);
  it("6 rows after melt (2 brands × 3 quarters)", () =>
    assert.equal(m.rows.length, 6));
  it("cells round-trip", () => {
    const lookup = (b: string, p: string) =>
      m.rows.find((r) => r.Brand === b && r.Period === p)?.Value;
    assert.equal(lookup("A", "Q1 23"), 100);
    assert.equal(lookup("A", "Q2 23"), 200);
    assert.equal(lookup("B", "Q1 23"), 300);
    assert.equal(lookup("B", "Q3 23"), 450);
  });
});
