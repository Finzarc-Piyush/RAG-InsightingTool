// Layer A · relative-period phrase → period filter on a melted pure_period
// dataset. Regression guard for the "latest 12 months summed across all
// periods" bug: "latest 12 months" must resolve to PeriodIso=L12M (the
// pre-computed rollup), never the YA/2YA comparative variants.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferPeriodFilterFromQuestion } from "../lib/agents/utils/inferPeriodFilterFromQuestion.js";
import type { DataSummary, WideFormatTransform } from "../shared/schema.js";

const purePeriodTransform: WideFormatTransform = {
  detected: true,
  shape: "pure_period",
  idColumns: ["Markets", "Products"],
  meltedColumns: ["Latest 12 Mths", "YTD TY", "Q1 23"],
  periodCount: 18,
  periodColumn: "Period",
  periodIsoColumn: "PeriodIso",
  periodKindColumn: "PeriodKind",
  valueColumn: "Value",
  detectedCurrencySymbol: "đ",
};

const top = (...vals: string[]) =>
  vals.map((v, i) => ({ value: v, count: vals.length - i }));

function summaryWith(opts: {
  isos?: string[];
  kinds?: string[];
  transform?: WideFormatTransform | undefined;
}): DataSummary {
  const isos = opts.isos ?? [
    "L12M",
    "L12M-YA",
    "L12M-2YA",
    "YTD-TY",
    "YTD-YA",
    "YTD-2YA",
    "2023-Q1",
    "2025-Q4",
  ];
  const kinds = opts.kinds ?? ["quarter", "latest_n", "ytd"];
  return {
    rowCount: 13500,
    columnCount: 7,
    columns: [
      { name: "Products", type: "string", sampleValues: ["FEMALE SHOWER GEL"] },
      { name: "Period", type: "string", sampleValues: ["Latest 12 Mths"] },
      { name: "PeriodIso", type: "string", sampleValues: isos, topValues: top(...isos) },
      { name: "PeriodKind", type: "string", sampleValues: kinds, topValues: top(...kinds) },
      { name: "Value", type: "number", sampleValues: [123] },
    ],
    numericColumns: ["Value"],
    dateColumns: [],
    wideFormatTransform: "transform" in opts ? opts.transform : purePeriodTransform,
  };
}

describe("inferPeriodFilterFromQuestion · latest-12-months", () => {
  const cases = [
    "Which product had the highest Sales Value in the latest 12 months?",
    "sales in the last 12 months by product",
    "trailing twelve months value",
    "what is the TTM sales value",
    "show me L12M sales",
    "MAT sales by product",
  ];
  for (const q of cases) {
    it(`maps "${q}" → PeriodIso=L12M`, () => {
      const out = inferPeriodFilterFromQuestion(q, summaryWith({}));
      assert.equal(out.length, 1);
      assert.equal(out[0]!.column, "PeriodIso");
      assert.deepEqual(out[0]!.values, ["L12M"]);
      assert.equal(out[0]!.op, "in");
    });
  }

  it("never picks the comparative L12M-YA / L12M-2YA variant", () => {
    const out = inferPeriodFilterFromQuestion("highest sales latest 12 months", summaryWith({}));
    assert.deepEqual(out[0]!.values, ["L12M"]);
  });

  it("falls back to PeriodKind=latest_n when no L12M iso exists", () => {
    const out = inferPeriodFilterFromQuestion(
      "latest 12 months sales",
      summaryWith({ isos: ["YTD-TY", "2023-Q1"], kinds: ["quarter", "latest_n", "ytd"] })
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.column, "PeriodKind");
    assert.deepEqual(out[0]!.values, ["latest_n"]);
  });

  it("abstains ([]) when neither the iso nor the kind exists in the catalog", () => {
    const out = inferPeriodFilterFromQuestion(
      "latest 12 months sales",
      summaryWith({ isos: ["2023-Q1", "2025-Q4"], kinds: ["quarter"] })
    );
    assert.deepEqual(out, []);
  });
});

describe("inferPeriodFilterFromQuestion · year-to-date", () => {
  it("maps 'year to date' → PeriodIso=YTD-TY", () => {
    const out = inferPeriodFilterFromQuestion("YTD sales value by product", summaryWith({}));
    assert.equal(out[0]!.column, "PeriodIso");
    assert.deepEqual(out[0]!.values, ["YTD-TY"]);
  });

  it("maps 'ytd year ago' → PeriodIso=YTD-YA", () => {
    const out = inferPeriodFilterFromQuestion("ytd year ago sales", summaryWith({}));
    assert.deepEqual(out[0]!.values, ["YTD-YA"]);
  });

  it("falls back to PeriodKind=ytd when no YTD iso exists", () => {
    const out = inferPeriodFilterFromQuestion(
      "year to date sales",
      summaryWith({ isos: ["2023-Q1", "L12M"], kinds: ["quarter", "ytd", "latest_n"] })
    );
    assert.equal(out[0]!.column, "PeriodKind");
    assert.deepEqual(out[0]!.values, ["ytd"]);
  });
});

describe("inferPeriodFilterFromQuestion · generic latest N", () => {
  it("derives PeriodIso=L6M for 'latest 6 months' when present", () => {
    const out = inferPeriodFilterFromQuestion(
      "latest 6 months sales",
      summaryWith({ isos: ["L6M", "L12M", "2023-Q1"], kinds: ["latest_n", "quarter"] })
    );
    assert.deepEqual(out[0]!.values, ["L6M"]);
  });
});

describe("inferPeriodFilterFromQuestion · negative / gating", () => {
  it("returns [] for a tidy dataset (no wideFormatTransform)", () => {
    assert.deepEqual(
      inferPeriodFilterFromQuestion("latest 12 months sales", summaryWith({ transform: undefined })),
      []
    );
  });

  it("returns [] for a compound-shape dataset", () => {
    const compound = { ...purePeriodTransform, shape: "compound" as const, metricColumn: "Metric" };
    assert.deepEqual(
      inferPeriodFilterFromQuestion("latest 12 months sales", summaryWith({ transform: compound })),
      []
    );
  });

  it("returns [] when the question names an explicit quarter (no relative phrase)", () => {
    assert.deepEqual(
      inferPeriodFilterFromQuestion("Q1 2024 sales by product", summaryWith({})),
      []
    );
  });

  it("returns [] when there is no period phrase at all", () => {
    assert.deepEqual(
      inferPeriodFilterFromQuestion("which product had the highest sales value", summaryWith({})),
      []
    );
  });

  it("returns [] when null/empty summary or question", () => {
    assert.deepEqual(inferPeriodFilterFromQuestion("latest 12 months", null), []);
    assert.deepEqual(inferPeriodFilterFromQuestion("", summaryWith({})), []);
  });
});
