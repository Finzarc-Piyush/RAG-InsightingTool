import { test } from "node:test";
import assert from "node:assert/strict";
import { MetadataService } from "../lib/metadataService.js";
import {
  resolveTrendGrain,
  buildDateRangeByColumn,
} from "../lib/temporalGrainAuthority.js";

/**
 * TG9 · convertToDataSummary (the columnar / large-file / metadata-reload ingest
 * path) historically listed temporal facets ONLY in summary.temporalFacetColumns,
 * never in summary.columns. Because resolveTrendGrain enumerates candidate time
 * axes solely from summary.columns, the daily "Day · Date" facet was invisible on
 * that path and a single month of daily data collapsed to one Month dot.
 *
 * The facets must now appear in summary.columns (mirroring the in-memory
 * createDataSummary path), so the single grain authority can pick the daily axis
 * end-to-end — even when the sampled runtime rows carry the raw date but NO
 * materialized facet values (facets are virtual on the columnar table, computed
 * inline at render time via facetColumnInlineDuckDbExpr).
 */

function singleMonthDailyMetadata() {
  return {
    rowCount: 30,
    columnCount: 2,
    columns: [
      { name: "Date", type: "DATE" },
      { name: "Sales", type: "INTEGER" },
    ],
  } as unknown as Parameters<MetadataService["convertToDataSummary"]>[0];
}

// Raw runtime rows: the source date column only — NO "Day · Date" values, exactly
// like rows read straight from the columnar DuckDB table at chat time.
const rawRows = Array.from({ length: 30 }, (_, i) => ({
  Date: `2026-04-${String(i + 1).padStart(2, "0")}`,
  Sales: 100 + i,
}));

test("convertToDataSummary lists temporal facet columns in summary.columns", () => {
  const summary = new MetadataService().convertToDataSummary(
    singleMonthDailyMetadata(),
    rawRows,
  );
  const names = summary.columns.map((c) => c.name);
  for (const facet of [
    "Day · Date",
    "Week · Date",
    "Month · Date",
    "Quarter · Date",
    "Year · Date",
  ]) {
    assert.ok(names.includes(facet), `expected ${facet} in summary.columns`);
  }
  const day = summary.columns.find((c) => c.name === "Day · Date") as {
    type?: string;
    temporalFacetGrain?: string;
    temporalFacetSource?: string;
  };
  assert.equal(day.type, "string");
  assert.equal(day.temporalFacetGrain, "date");
  assert.equal(day.temporalFacetSource, "Date");
  // columnCount stays in lockstep with the (now larger) columns array.
  assert.equal(summary.columnCount, summary.columns.length);
});

test("single-month daily on the columnar path resolves to a DAILY axis end-to-end", () => {
  const summary = new MetadataService().convertToDataSummary(
    singleMonthDailyMetadata(),
    rawRows,
  );
  const decision = resolveTrendGrain({
    availableColumns: summary.columns.map((c) => c.name),
    dateColumns: summary.dateColumns,
    dateRangeByColumn: buildDateRangeByColumn(summary),
    // Raw rows WITHOUT materialized facet values — the columnar runtime frame.
    sample: rawRows,
    allowSingleBucket: true,
  });
  assert.equal(decision.facetColumn, "Day · Date");
  assert.equal(decision.grain, "date");
  assert.equal(decision.source, "span");
});

test("non-date dataset gets no temporal facet columns", () => {
  const summary = new MetadataService().convertToDataSummary(
    {
      rowCount: 2,
      columnCount: 2,
      columns: [
        { name: "Brand", type: "VARCHAR" },
        { name: "Sales", type: "INTEGER" },
      ],
    } as unknown as Parameters<MetadataService["convertToDataSummary"]>[0],
    [{ Brand: "A", Sales: 1 }],
  );
  assert.ok(!summary.columns.some((c) => c.name.includes(" · ")));
  assert.equal(summary.columnCount, summary.columns.length);
});
