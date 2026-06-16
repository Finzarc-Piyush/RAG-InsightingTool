/**
 * Behavioral coverage for applyDeriveDimensionBucket + registerDerivedColumnOnSummary
 * (server/lib/deriveDimensionBucket.ts). The module imports only zod + the
 * (zod-only) shared schema type, so it is hermetic — no Cosmos/Azure/LLM.
 *
 * We assert real input→output: bucket mapping, default-label fallbacks,
 * case-insensitive matching, schema guards, no-mutation of the input rows,
 * and that the function only reads `summary.columns[].name` (so a minimal,
 * structurally-typed summary suffices).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyDeriveDimensionBucket,
  registerDerivedColumnOnSummary,
  type DeriveDimensionBucketArgs,
} from "../lib/deriveDimensionBucket.js";
import type { DataSummary } from "../shared/schema.js";

// The function only touches summary.columns[].name, so a minimal object cast to
// DataSummary keeps the test hermetic and focused on the mapping behaviour.
function summaryWithColumns(names: string[]): DataSummary {
  return {
    columns: names.map((name) => ({ name })),
  } as unknown as DataSummary;
}

describe("applyDeriveDimensionBucket", () => {
  const rows = [
    { region: "West", sales: 10 },
    { region: "East", sales: 20 },
    { region: "North", sales: 30 },
  ];
  const args: DeriveDimensionBucketArgs = {
    sourceColumn: "region",
    newColumnName: "macro_region",
    buckets: [
      { label: "Coastal", values: ["West", "East"] },
      { label: "Interior", values: ["North"] },
    ],
  };

  it("maps source values into bucket labels", () => {
    const summary = summaryWithColumns(["region", "sales"]);
    const res = applyDeriveDimensionBucket(rows, summary, args);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.deepEqual(
      res.rows.map((r) => r.macro_region),
      ["Coastal", "Coastal", "Interior"]
    );
  });

  it("does NOT mutate the input rows (shallow copy)", () => {
    const summary = summaryWithColumns(["region", "sales"]);
    const before = JSON.parse(JSON.stringify(rows));
    applyDeriveDimensionBucket(rows, summary, args);
    assert.deepEqual(rows, before);
    assert.equal("macro_region" in rows[0]!, false);
  });

  it("falls back to the raw cell value when no bucket matches and no defaultLabel", () => {
    const summary = summaryWithColumns(["region"]);
    const res = applyDeriveDimensionBucket(
      [{ region: "Central" }],
      summary,
      { ...args, buckets: [{ label: "Coastal", values: ["West"] }] }
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.rows[0]!.macro_region, "Central");
  });

  it("uses defaultLabel for unmatched cells when provided", () => {
    const summary = summaryWithColumns(["region"]);
    const res = applyDeriveDimensionBucket(
      [{ region: "Central" }, { region: "West" }],
      summary,
      {
        ...args,
        defaultLabel: "Unknown",
        buckets: [{ label: "Coastal", values: ["West"] }],
      }
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.deepEqual(
      res.rows.map((r) => r.macro_region),
      ["Unknown", "Coastal"]
    );
  });

  it("labels a blank/null source cell as 'Other' when no defaultLabel", () => {
    const summary = summaryWithColumns(["region"]);
    const res = applyDeriveDimensionBucket(
      [{ region: null }, { region: "" }, {}],
      summary,
      { ...args, buckets: [{ label: "Coastal", values: ["West"] }] }
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.deepEqual(
      res.rows.map((r) => r.macro_region),
      ["Other", "Other", "Other"]
    );
  });

  it("matches case-insensitively when matchMode is case_insensitive", () => {
    const summary = summaryWithColumns(["region"]);
    const res = applyDeriveDimensionBucket(
      [{ region: "wEsT" }],
      summary,
      {
        sourceColumn: "region",
        newColumnName: "macro_region",
        matchMode: "case_insensitive",
        buckets: [{ label: "Coastal", values: ["West"] }],
      }
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.rows[0]!.macro_region, "Coastal");
  });

  it("is case-SENSITIVE by default (exact mode)", () => {
    const summary = summaryWithColumns(["region"]);
    const res = applyDeriveDimensionBucket(
      [{ region: "wEsT" }],
      summary,
      { ...args, buckets: [{ label: "Coastal", values: ["West"] }] }
    );
    assert.equal(res.ok, true);
    if (!res.ok) return;
    // No case-insensitive normalization → falls back to the raw cell value.
    assert.equal(res.rows[0]!.macro_region, "wEsT");
  });

  it("errors when the source column is not in the schema", () => {
    const summary = summaryWithColumns(["sales"]); // no "region"
    const res = applyDeriveDimensionBucket(rows, summary, args);
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.error, /Column not in schema/);
  });

  it("errors when the new column name already exists", () => {
    const summary = summaryWithColumns(["region", "macro_region"]);
    const res = applyDeriveDimensionBucket(rows, summary, args);
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.error, /already exists/);
  });
});

describe("registerDerivedColumnOnSummary", () => {
  it("appends a string column with deduped, capped sample values", () => {
    const summary = summaryWithColumns(["region"]);
    registerDerivedColumnOnSummary(
      summary,
      "macro_region",
      [
        { macro_region: "Coastal" },
        { macro_region: "Coastal" }, // duplicate → deduped
        { macro_region: "Interior" },
        { macro_region: null }, // skipped
      ],
      8
    );
    const added = summary.columns.find((c) => c.name === "macro_region");
    assert.ok(added, "new column should be appended");
    assert.equal(added!.type, "string");
    assert.deepEqual(added!.sampleValues, ["Coastal", "Interior"]);
  });

  it("respects the maxSamples cap", () => {
    const summary = summaryWithColumns(["x"]);
    registerDerivedColumnOnSummary(
      summary,
      "bucket",
      [{ bucket: "a" }, { bucket: "b" }, { bucket: "c" }],
      2
    );
    const added = summary.columns.find((c) => c.name === "bucket");
    assert.equal(added!.sampleValues!.length, 2);
  });

  it("is a no-op when the column already exists", () => {
    const summary = summaryWithColumns(["bucket"]);
    const before = summary.columns.length;
    registerDerivedColumnOnSummary(summary, "bucket", [{ bucket: "a" }]);
    assert.equal(summary.columns.length, before);
  });
});
