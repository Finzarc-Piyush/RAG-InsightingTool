/**
 * Wave W-GMK5 · tests for `detectPeriodColumns` — the public detector that
 * returns the period-column grouping without picking a specific axis.
 * Lets prompt builders (datasetProfile, planner system prompt, narrator
 * hints) share one source of truth with the chart-build path.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectPeriodColumns } from "../lib/periodColumnResolver.js";
import type { DataSummary } from "../shared/schema.js";

function summary(overrides: Partial<DataSummary> = {}): DataSummary {
  return {
    rowCount: 100,
    columnCount: 0,
    columns: [],
    numericColumns: [],
    dateColumns: [],
    sampleRows: [],
    ...overrides,
  } as DataSummary;
}

describe("detectPeriodColumns", () => {
  it("returns empty when no period-like columns present", () => {
    const sample = [
      { Product: "A", Sales: 100 },
      { Product: "B", Sales: 200 },
    ];
    const out = detectPeriodColumns(["Product", "Sales"], sample, summary());
    assert.deepEqual(out, []);
  });

  it("classifies temporal facets and exposes their grain", () => {
    const sample = [
      { "Month · Order Date": "2024-01", "Quarter · Order Date": "2024-Q1" },
      { "Month · Order Date": "2024-02", "Quarter · Order Date": "2024-Q1" },
    ];
    const out = detectPeriodColumns(
      ["Month · Order Date", "Quarter · Order Date"],
      sample,
      summary()
    );
    assert.equal(out.length, 2);
    const month = out.find((c) => c.column === "Month · Order Date");
    const quarter = out.find((c) => c.column === "Quarter · Order Date");
    assert.equal(month!.role, "temporal-facet");
    assert.equal(month!.facetGrain, "month");
    assert.equal(quarter!.role, "temporal-facet");
    assert.equal(quarter!.facetGrain, "quarter");
  });

  it("Marico nine-column scenario surfaces all period roles", () => {
    const sample = [
      {
        "Month · Period": "2025-03",
        "Quarter · Period": "2025-Q1",
        Period: "Q1 25",
        PeriodIso: "2025-Q1",
        PeriodKind: "Quarter",
      },
      {
        "Month · Period": "2024-06",
        "Quarter · Period": "2024-Q2",
        Period: "Latest 12 Mths",
        PeriodIso: "L12M",
        PeriodKind: "Latest12Mths",
      },
    ];
    const out = detectPeriodColumns(
      [
        "Month · Period",
        "Quarter · Period",
        "Period",
        "PeriodIso",
        "PeriodKind",
      ],
      sample,
      summary()
    );
    const byCol = new Map(out.map((c) => [c.column, c]));
    assert.equal(byCol.get("Month · Period")?.role, "temporal-facet");
    assert.equal(byCol.get("Quarter · Period")?.role, "temporal-facet");
    assert.equal(byCol.get("Period")?.role, "raw-period");
    assert.equal(byCol.get("PeriodIso")?.role, "raw-period");
    assert.equal(byCol.get("PeriodKind")?.role, "period-kind-discriminator");
  });

  it("raw-period multi-kind exposes detectedKinds for downstream prompt guidance", () => {
    const sample = [
      { Period: "Q1 25" },
      { Period: "Q2 25" },
      { Period: "Latest 12 Mths" },
      { Period: "YTD" },
    ];
    const out = detectPeriodColumns(["Period"], sample, summary());
    assert.equal(out.length, 1);
    const period = out[0]!;
    assert.equal(period.role, "raw-period");
    assert.ok((period.detectedKinds ?? []).includes("quarter"));
    assert.ok((period.detectedKinds ?? []).includes("latest_n"));
    assert.ok((period.detectedKinds ?? []).includes("ytd"));
  });
});
