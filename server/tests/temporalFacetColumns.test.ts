import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyTemporalFacetColumns,
  facetColumnKey,
  isTemporalFacetColumnKey,
  remapGroupByToTemporalFacet,
  resolveFacetSourceBindings,
  stripTemporalFacetColumns,
  temporalFacetMetadataForDateColumns,
} from "../lib/temporalFacetColumns.js";

describe("temporalFacetColumns", () => {
  it("facetColumnKey is stable and prefixed", () => {
    const k = facetColumnKey("Order Date", "year");
    assert.ok(isTemporalFacetColumnKey(k));
    assert.match(k, /^__tf_year__/);
  });

  it("metadata lists six grains per source (incl. half_year)", () => {
    const m = temporalFacetMetadataForDateColumns(["Ship Date"]);
    assert.equal(m.length, 6);
    assert.ok(m.some((x) => x.grain === "year" && x.sourceColumn === "Ship Date"));
    assert.ok(m.some((x) => x.grain === "half_year" && x.sourceColumn === "Ship Date"));
  });

  it("resolveFacetSourceBindings maps logical Order Date to Cleaned_* when raw key missing", () => {
    const keys = new Set(["Sales", "Cleaned_Order Date"]);
    const b = resolveFacetSourceBindings(keys, ["Order Date"]);
    assert.equal(b.length, 1);
    assert.equal(b[0].logical, "Order Date");
    assert.equal(b[0].readFrom, "Cleaned_Order Date");
  });

  it("applyTemporalFacetColumns fills __tf_year__Order_Date from Cleaned_Order Date", () => {
    const data: Record<string, unknown>[] = [
      { Sales: 1, "Cleaned_Order Date": "2015-06-15" },
      { Sales: 2, "Cleaned_Order Date": "2016-01-02" },
    ];
    const y = facetColumnKey("Order Date", "year");
    applyTemporalFacetColumns(data as Record<string, any>[], ["Order Date"]);
    assert.equal(data[0][y], "2015");
    assert.equal(data[1][y], "2016");
  });

  it("applyTemporalFacetColumns writes ISO-aligned bucket strings", () => {
    const data: Record<string, unknown>[] = [
      { "Order Date": "2015-06-15", Sales: 1 },
      { "Order Date": "2016-01-02", Sales: 2 },
    ];
    applyTemporalFacetColumns(data as Record<string, any>[], ["Order Date"]);
    const y = facetColumnKey("Order Date", "year");
    const q = facetColumnKey("Order Date", "quarter");
    const mo = facetColumnKey("Order Date", "month");
    assert.equal(data[0][y], "2015");
    assert.equal(data[0][q], "2015-Q2");
    assert.equal(data[0][mo], "2015-06");
    assert.equal(data[1][y], "2016");
    const h = facetColumnKey("Order Date", "half_year");
    assert.equal(data[0][h], "2015-H1");
    assert.equal(data[1][h], "2016-H1");
  });

  it("stripTemporalFacetColumns removes __tf_ keys", () => {
    const row = { a: 1, __tf_year__X: "2020" };
    stripTemporalFacetColumns([row]);
    assert.equal(row.__tf_year__X, undefined);
    assert.equal(row.a, 1);
  });

  it("remapGroupByToTemporalFacet maps date column + year intent to year facet", () => {
    const data = [{ "Order Date": "2015-01-01", Sales: 1 }];
    applyTemporalFacetColumns(data, ["Order Date"]);
    const keys = new Set(Object.keys(data[0]));
    const r = remapGroupByToTemporalFacet({
      groupByColumn: "Order Date",
      dateColumns: ["Order Date"],
      originalMessage: "aggregate sales by year",
      availableKeys: keys,
    });
    assert.equal(r.remapped, true);
    assert.equal(r.groupBy, facetColumnKey("Order Date", "year"));
  });

  it("remapGroupByToTemporalFacet maps half-year intent to half_year facet", () => {
    const data = [{ "Order Date": "2015-07-01", Sales: 1 }];
    applyTemporalFacetColumns(data, ["Order Date"]);
    const keys = new Set(Object.keys(data[0]));
    const r = remapGroupByToTemporalFacet({
      groupByColumn: "Order Date",
      dateColumns: ["Order Date"],
      originalMessage: "sales by half year",
      availableKeys: keys,
    });
    assert.equal(r.remapped, true);
    assert.equal(r.groupBy, facetColumnKey("Order Date", "half_year"));
  });

  it("remapGroupByToTemporalFacet does not remap without time intent", () => {
    const data = [{ "Order Date": "2015-01-01", Sales: 1 }];
    applyTemporalFacetColumns(data, ["Order Date"]);
    const keys = new Set(Object.keys(data[0]));
    const r = remapGroupByToTemporalFacet({
      groupByColumn: "Order Date",
      dateColumns: ["Order Date"],
      originalMessage: "aggregate by Order Date",
      availableKeys: keys,
    });
    assert.equal(r.remapped, false);
    assert.equal(r.groupBy, "Order Date");
  });
});
