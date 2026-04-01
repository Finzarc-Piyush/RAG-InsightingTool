import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { coerceTemporalFacetKeysToStrings } from "../lib/temporalFacetKeyNormalization.js";

describe("coerceTemporalFacetKeysToStrings", () => {
  it("coerces __tf_* facet values to strings without touching measure columns", () => {
    const rows = [
      {
        "__tf_year__Order_Date": 2015,
        "__tf_month__Order_Date": "2015-04",
        "Sales (Sum)": 12345.67,
      },
    ];

    coerceTemporalFacetKeysToStrings(rows as Array<Record<string, unknown>>);

    assert.equal(typeof (rows[0]!["__tf_year__Order_Date"] as unknown), "string");
    assert.equal(rows[0]!["__tf_year__Order_Date"], "2015");

    assert.equal(typeof (rows[0]!["Sales (Sum)"] as unknown), "number");
    assert.equal(rows[0]!["Sales (Sum)"], 12345.67);
  });

  it("coerces UI-style facet column values to strings", () => {
    const rows = [{ "Year · Order Date": 2015, Sales: 1 }];
    coerceTemporalFacetKeysToStrings(rows as Array<Record<string, unknown>>);
    assert.equal(typeof (rows[0]!["Year · Order Date"] as unknown), "string");
    assert.equal(rows[0]!["Year · Order Date"], "2015");
  });

  it("leaves null/undefined temporal facet values as-is", () => {
    const rows: any[] = [
      { "__tf_year__Order_Date": null, "__tf_month__Order_Date": undefined },
    ];

    coerceTemporalFacetKeysToStrings(rows);

    assert.equal(rows[0]!["__tf_year__Order_Date"], null);
    assert.equal(rows[0]!["__tf_month__Order_Date"], undefined);
  });
});

