import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  periodIsoFacetValue,
  applyPeriodDimensionFacets,
  applyTemporalFacetColumns,
  type TemporalFacetGrain,
} from "../lib/temporalFacetColumns.js";

// Regression guard for the wide-format melt bug: grain facet columns
// (`Quarter · Period`, …) on a melted period dimension must derive from the
// canonical `PeriodIso` value, NOT from parsing the human `Period` label
// ("Q1 23" / "YTD 2YA") as a date — which yields all-NULL columns and 0-row
// quarterly answers.

describe("periodIsoFacetValue · grain gate by PeriodIso shape", () => {
  it("returns the iso verbatim for a matching calendar grain", () => {
    assert.strictEqual(periodIsoFacetValue("2023-Q1", "quarter"), "2023-Q1");
    assert.strictEqual(periodIsoFacetValue("2023-03", "month"), "2023-03");
    assert.strictEqual(periodIsoFacetValue("2024-W12", "week"), "2024-W12");
    assert.strictEqual(periodIsoFacetValue("2023-01-15", "date"), "2023-01-15");
    assert.strictEqual(periodIsoFacetValue("2023-H1", "half_year"), "2023-H1");
  });

  it("extracts the leading year for the year grain from any calendar shape", () => {
    assert.strictEqual(periodIsoFacetValue("2023", "year"), "2023");
    assert.strictEqual(periodIsoFacetValue("2023-Q1", "year"), "2023");
    assert.strictEqual(periodIsoFacetValue("2023-03", "year"), "2023");
    assert.strictEqual(periodIsoFacetValue("2024-W12", "year"), "2024");
  });

  it("does NOT cross grains — a quarter iso is not a month/week/day", () => {
    assert.strictEqual(periodIsoFacetValue("2023-Q1", "month"), null);
    assert.strictEqual(periodIsoFacetValue("2023-Q1", "week"), null);
    assert.strictEqual(periodIsoFacetValue("2023-Q1", "date"), null);
  });

  it("treats the half-year trap correctly (matchHalfYear reuses kind:quarter)", () => {
    // PeriodKind is "quarter" for H1/H2 but the iso is YYYY-HN — must NOT
    // populate the quarter grain.
    assert.strictEqual(periodIsoFacetValue("2023-H1", "quarter"), null);
    assert.strictEqual(periodIsoFacetValue("2023-H1", "half_year"), "2023-H1");
    assert.strictEqual(periodIsoFacetValue("2023-H1", "year"), "2023");
  });

  it("returns null for relative / non-calendar isos in every grain", () => {
    const grains: TemporalFacetGrain[] = [
      "date",
      "week",
      "month",
      "quarter",
      "half_year",
      "year",
    ];
    for (const iso of ["L12M", "L12M-2YA", "YTD-TY", "YTD-2YA", "MAT-2024-12", "XXXX-Q1", "QTD-2024-Q1"]) {
      for (const g of grains) {
        assert.strictEqual(periodIsoFacetValue(iso, g), null, `${iso} / ${g}`);
      }
    }
  });

  it("returns null for non-string / empty input", () => {
    assert.strictEqual(periodIsoFacetValue(null, "quarter"), null);
    assert.strictEqual(periodIsoFacetValue(undefined, "quarter"), null);
    assert.strictEqual(periodIsoFacetValue("", "quarter"), null);
    assert.strictEqual(periodIsoFacetValue(2023, "year"), null);
  });
});

describe("applyPeriodDimensionFacets · fills grains from PeriodIso", () => {
  it("populates calendar rows and nulls relative rows", () => {
    const rows: Record<string, any>[] = [
      { Period: "Q1 23", PeriodIso: "2023-Q1", PeriodKind: "quarter", Value: 100 },
      { Period: "Q4 25", PeriodIso: "2025-Q4", PeriodKind: "quarter", Value: 200 },
      { Period: "YTD 2YA", PeriodIso: "YTD-2YA", PeriodKind: "ytd", Value: 999 },
      { Period: "Latest 12 Mths", PeriodIso: "L12M", PeriodKind: "latest_n", Value: 555 },
    ];
    const meta = applyPeriodDimensionFacets(rows, { periodCol: "Period", isoCol: "PeriodIso" });

    assert.deepEqual(
      meta.map((m) => m.name).sort(),
      [
        "Day · Period",
        "Half-year · Period",
        "Month · Period",
        "Quarter · Period",
        "Week · Period",
        "Year · Period",
      ].sort()
    );

    assert.strictEqual(rows[0]["Quarter · Period"], "2023-Q1");
    assert.strictEqual(rows[0]["Year · Period"], "2023");
    assert.strictEqual(rows[0]["Month · Period"] ?? null, null);
    assert.strictEqual(rows[1]["Quarter · Period"], "2025-Q4");
    // Relative periods carry no calendar grain → null everywhere.
    assert.strictEqual(rows[2]["Quarter · Period"] ?? null, null);
    assert.strictEqual(rows[2]["Year · Period"] ?? null, null);
    assert.strictEqual(rows[3]["Quarter · Period"] ?? null, null);
  });
});

describe("applyTemporalFacetColumns · melted period dimension", () => {
  const meltedRows = (): Record<string, any>[] => [
    { Products: "FEMALE SHOWER GEL", Period: "Q1 23", PeriodIso: "2023-Q1", PeriodKind: "quarter", Value: 100 },
    { Products: "FEMALE SHOWER GEL", Period: "Q4 25", PeriodIso: "2025-Q4", PeriodKind: "quarter", Value: 200 },
    { Products: "FEMALE SHOWER GEL", Period: "YTD 2YA", PeriodIso: "YTD-2YA", PeriodKind: "ytd", Value: 999 },
  ];

  it("derives Quarter · Period from PeriodIso via the explicit binding (label is unparseable as a date)", () => {
    const rows = meltedRows();
    applyTemporalFacetColumns(rows, ["Period"], {
      periodDimension: { periodCol: "Period", isoCol: "PeriodIso" },
    });
    assert.strictEqual(rows[0]["Quarter · Period"], "2023-Q1");
    assert.strictEqual(rows[1]["Quarter · Period"], "2025-Q4");
    assert.strictEqual(rows[2]["Quarter · Period"] ?? null, null);
  });

  it("self-detects the Period/PeriodIso triple when no binding is supplied", () => {
    const rows = meltedRows();
    applyTemporalFacetColumns(rows, ["Period"]);
    assert.strictEqual(rows[0]["Quarter · Period"], "2023-Q1");
    assert.strictEqual(rows[1]["Year · Period"], "2025");
  });

  it("still facets a real date column (Order Date) the normal way", () => {
    const rows: Record<string, any>[] = [
      { "Order Date": "2023-02-15", Sales: 10 },
      { "Order Date": "2025-11-01", Sales: 20 },
    ];
    applyTemporalFacetColumns(rows, ["Order Date"]);
    assert.strictEqual(rows[0]["Quarter · Order Date"], "2023-Q1");
    assert.strictEqual(rows[1]["Quarter · Order Date"], "2025-Q4");
  });
});
