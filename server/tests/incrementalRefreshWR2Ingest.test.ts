/**
 * Wave WR2 (incremental refresh) · replace-mode ingest core.
 *
 * `ingestReplaceFromRows` swaps the session dataset via `saveModifiedData`
 * (Cosmos + blob I/O, covered by the data-ops tests). This file pins the pure,
 * deterministic core — `prepareRefreshRows` — which is what makes the new
 * month get processed IDENTICALLY to the original upload:
 *   1. With a saved `datasetProfile`, the upload pipeline runs (dates
 *      canonicalized, temporal facet columns derived) — same as April.
 *   2. With no profile (legacy session), raw rows pass through untouched
 *      (saveModifiedData's own canonicalize handles them).
 *   3. An empty refresh dataset is rejected before any write.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { prepareRefreshRows } from "../lib/refresh/ingestNewVersion.js";
import type { DatasetProfile } from "../shared/schema.js";

const profile: DatasetProfile = {
  shortDescription: "Monthly haircare secondary sales.",
  dateColumns: ["Date"],
  dirtyStringDateColumns: [],
  suggestedQuestions: [],
  measureColumns: ["Sales"],
  idColumns: ["Brand"],
};

const mayRows = [
  { Date: "2026-05-01", Brand: "PARACHUTE", Sales: 412330 },
  { Date: "2026-05-02", Brand: "NIHAR", Sales: 221100 },
];

describe("WR2 · prepareRefreshRows", () => {
  it("with a profile, runs the upload pipeline and derives temporal facets", () => {
    const { data, summary } = prepareRefreshRows(mayRows, profile);
    assert.equal(data.length, 2);
    // The pipeline derives temporal facet columns from the Date column, so the
    // processed rows carry MORE keys than the 3 source columns.
    const keys = Object.keys(data[0]!);
    assert.ok(
      keys.length > 3,
      `expected derived facet columns, got keys: ${keys.join(", ")}`
    );
    assert.ok(
      keys.some((k) => k.includes("Date")),
      "a Date-derived facet column should be present"
    );
    assert.ok(summary, "a fresh DataSummary is returned");
    assert.equal(summary?.rowCount, 2);
  });

  it("with no profile, passes raw rows through unchanged", () => {
    const { data, summary } = prepareRefreshRows(mayRows, undefined);
    assert.deepEqual(data, mayRows);
    assert.equal(summary, undefined);
  });

  it("rejects an empty refresh dataset before any write", () => {
    assert.throws(() => prepareRefreshRows([], profile), /empty/i);
  });
});
