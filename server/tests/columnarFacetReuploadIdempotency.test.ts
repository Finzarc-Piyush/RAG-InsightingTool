import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { metadataService } from "../lib/metadataService.js";
import type { DatasetMetadata } from "../lib/columnarStorage.js";
import { isTemporalFacetColumnKey } from "../lib/temporalFacetColumns.js";

/**
 * Regression (columnar / large-file path): when a re-uploaded enriched CSV is
 * loaded via DuckDB `read_csv_auto`, derived facet columns get re-typed (e.g.
 * "Day · Date" → DATE, "Year · Date" → BIGINT). `convertToDataSummary` must NOT
 * treat any of these as a date source — otherwise `applyTemporalFacetColumns`
 * would nest them into "Day · Day · Date" and the column count would explode,
 * exactly as in the in-memory path.
 */
function col(name: string, type: string): DatasetMetadata["columns"][0] {
  return { name, type, nullCount: 0, nullPercentage: 0, cardinality: 1 };
}

describe("columnar convertToDataSummary · facet columns are not date sources", () => {
  it("excludes re-typed facet columns from dateColumns", () => {
    const metadata: DatasetMetadata = {
      rowCount: 1,
      columnCount: 5,
      columns: [
        col("Date", "DATE"),            // genuine date source
        col("Region", "VARCHAR"),       // genuine non-date
        col("Day · Date", "DATE"),      // facet re-typed as DATE by read_csv_auto
        col("Year · Date", "BIGINT"),   // facet re-typed as BIGINT
        col("Month · Date", "VARCHAR"), // facet kept as VARCHAR
      ],
    };
    const sampleRows = [
      {
        Date: "2024-01-15",
        Region: "North",
        "Day · Date": "2024-01-15",
        "Year · Date": 2024,
        "Month · Date": "2024-01",
      },
    ];

    const summary = metadataService.convertToDataSummary(metadata, sampleRows);

    // Only the genuine "Date" column is a date source…
    assert.deepEqual(summary.dateColumns, ["Date"]);
    // …no facet column leaked into the date set…
    assert.ok(
      !summary.dateColumns.some(isTemporalFacetColumnKey),
      `dateColumns must contain no facet columns: ${summary.dateColumns.join(", ")}`
    );
    // …and the derived facet metadata is the single clean generation for "Date".
    assert.equal(summary.temporalFacetColumns?.length, 6);
    assert.ok(
      summary.temporalFacetColumns?.every((m) => m.sourceColumn === "Date"),
      "all facet metadata must be sourced from the real Date column"
    );
  });
});
