import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyUploadPipelineWithProfile } from "../lib/fileParser.js";
import type { DatasetProfile } from "../lib/datasetProfile.js";
import {
  facetColumnKey,
  isTemporalFacetColumnKey,
} from "../lib/temporalFacetColumns.js";

/**
 * Regression: a downloaded enriched dataset re-uploaded into the pipeline used
 * to re-detect its OWN derived facet columns ("Month · Date") as new date
 * sources and derive a nested generation ("Day · Month · Date"), multiplying
 * the column count ~6× per download→re-upload cycle (real files observed at
 * 44 → 146 → 758 columns). applyUploadPipelineWithProfile must now be a
 * fixpoint: it strips incoming facet columns up-front and re-derives exactly
 * one clean generation from the genuine date columns.
 */
const GRAINS = ["date", "week", "month", "quarter", "half_year", "year"] as const;

describe("temporal facet re-upload idempotency", () => {
  it("collapses an already-enriched (exploded) dataset to one clean facet generation", () => {
    const profile: DatasetProfile = {
      shortDescription: "",
      dateColumns: ["Date"],
    } as DatasetProfile;

    // A real source column "Date" + a non-facet business field "Region",
    // plus pre-existing gen-1 facets of "Date" AND gen-2 nested facets that a
    // prior buggy pass would have produced.
    const baseRow = (date: string, region: string): Record<string, any> => {
      const row: Record<string, any> = { Date: date, Region: region };
      for (const g of GRAINS) row[facetColumnKey("Date", g)] = date; // values irrelevant — re-derived
      // gen-2 nesting: facets-of-facets ("Day · Date" was re-detected as a source)
      row["Day · Day · Date"] = date;
      row["Year · Month · Date"] = "2024";
      return row;
    };
    const data = [baseRow("2024-01-15", "North"), baseRow("2024-06-20", "South")];

    const { data: out, summary } = applyUploadPipelineWithProfile(data, profile);
    const keys = Object.keys(out[0]!);
    const facetKeys = keys.filter(isTemporalFacetColumnKey);

    // (a) exactly 7 facet columns (incl. day_of_week), all sourced from "Date"
    assert.equal(
      facetKeys.length,
      7,
      `expected 7 facet columns, got ${facetKeys.length}: ${facetKeys.join(", ")}`
    );
    for (const g of GRAINS) {
      assert.ok(keys.includes(facetColumnKey("Date", g)), `missing ${g} facet for Date`);
    }

    // (b) no nested facet-of-facet survives
    assert.ok(!keys.includes("Day · Day · Date"), "nested Day · Day · Date must be gone");
    assert.ok(!keys.includes("Year · Month · Date"), "nested Year · Month · Date must be gone");
    assert.ok(
      !facetKeys.some((k) => /· (Day|Week|Month|Quarter|Half-year|Year) · /.test(k)),
      `no nested facet should remain: ${facetKeys.join(", ")}`
    );

    // (c) original non-facet columns preserved (with values)
    assert.ok(keys.includes("Date"));
    assert.ok(keys.includes("Region"));
    assert.equal(out[0]!.Region, "North");
    assert.equal(out[0]!.Date, "2024-01-15");

    // summary agrees: facet metadata also collapses to 7 (incl. day_of_week)
    const summaryFacets = summary.columns.filter((c) => isTemporalFacetColumnKey(c.name));
    assert.equal(summaryFacets.length, 7, "summary should expose exactly 7 facet columns");
  });

  it("does not facet a composite 'Combo' key (e.g. TSOE-Date Combo) while still faceting a real date", () => {
    // "TSOE-Date Combo" holds composite values like "20176-01-01" (a TSOE code
    // joined to a date) — the name contains "date" but it is NOT a calendar
    // date, and its grain facets ("Day · TSOE-Date Combo" → "20176-01-01") are
    // unreadable. It must never be approved as a date source.
    const profile: DatasetProfile = {
      shortDescription: "",
      // even if the LLM profile mistakenly lists it, it must be rejected:
      dateColumns: ["Date", "TSOE-Date Combo"],
    } as DatasetProfile;
    const data = [
      { Date: "2024-01-15", "TSOE-Date Combo": "20176-01-01", Region: "North" },
      { Date: "2024-06-20", "TSOE-Date Combo": "20925-01-01", Region: "South" },
    ];

    const { data: out, summary } = applyUploadPipelineWithProfile(data, profile);
    const facetKeys = Object.keys(out[0]!).filter(isTemporalFacetColumnKey);

    // Real date "Date" is faceted (7, incl. day_of_week); the composite combo column is not.
    assert.equal(facetKeys.length, 7, `only Date should be faceted: ${facetKeys.join(", ")}`);
    assert.ok(
      facetKeys.every((k) => k.endsWith("· Date")),
      `no "· TSOE-Date Combo" facet should exist: ${facetKeys.join(", ")}`
    );
    // The combo column survives as a plain column (not dropped), just not a date.
    assert.ok(Object.keys(out[0]!).includes("TSOE-Date Combo"));
    assert.ok(!summary.dateColumns.includes("TSOE-Date Combo"));
    assert.deepEqual(summary.dateColumns, ["Date"]);
  });

  it("is a fixpoint: a second pass yields the identical column set", () => {
    const profile: DatasetProfile = {
      shortDescription: "",
      dateColumns: ["Date"],
    } as DatasetProfile;
    const data = [
      { Date: "2024-01-15", Region: "North" },
      { Date: "2024-06-20", Region: "South" },
    ];
    const first = applyUploadPipelineWithProfile(data, profile);
    const second = applyUploadPipelineWithProfile(first.data, profile);
    assert.deepEqual(
      Object.keys(second.data[0]!).sort(),
      Object.keys(first.data[0]!).sort(),
      "re-running the pipeline on its own output must not change the column set"
    );
  });
});
