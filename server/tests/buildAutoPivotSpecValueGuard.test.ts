import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAutoPivotSpecFromPreview } from "../lib/autoPivotSpec.js";
import type { DataSummary } from "../shared/schema.js";

const summary: DataSummary = {
  rowCount: 10000,
  columnCount: 4,
  columns: [
    { name: "Cluster Name", type: "string", sampleValues: ["Cluster 1 NORTH"] },
    { name: "MTD", type: "string", sampleValues: ["Apr 2026"] },
    { name: "Working Hrs", type: "number", sampleValues: [8] },
    { name: "Sales", type: "number", sampleValues: [100] },
  ],
  numericColumns: ["Working Hrs", "Sales"],
  dateColumns: [],
};

describe("buildAutoPivotSpecFromPreview · base-table value guard", () => {
  it("skips the pivot when every value is a computed alias (the binder-error case)", () => {
    // Reproduces the screenshot: preview columns are MTD + computed rate
    // helpers only, none of which exist on the raw `data` table.
    const spec = buildAutoPivotSpecFromPreview({
      rows: [{ MTD: "Apr 2026", matching: 2100, total: 10000, pjp_adherence_rate: 0.21 }],
      columns: ["MTD", "matching", "total", "pjp_adherence_rate"],
      summary,
      turnId: "t1",
      sessionId: "s1",
    });
    assert.equal(spec, undefined);
  });

  it("keeps only real base-table value fields when aliases are mixed in", () => {
    const spec = buildAutoPivotSpecFromPreview({
      rows: [
        {
          "Cluster Name": "Cluster 1 NORTH",
          "Working Hrs": 8,
          matching: 5,
          pjp_adherence_rate: 0.25,
        },
      ],
      columns: ["Cluster Name", "Working Hrs", "matching", "pjp_adherence_rate"],
      summary,
      turnId: "t2",
      sessionId: "s2",
    });
    assert.ok(spec, "expected a pivot spec");
    assert.deepEqual(
      spec!.pivotConfig.values.map((v) => v.field),
      ["Working Hrs"],
    );
    // Title no longer references the broken computed aliases.
    assert.ok(!/matching|pjp_adherence_rate/.test(spec!.title));
  });

  it("returns undefined for an empty preview", () => {
    const spec = buildAutoPivotSpecFromPreview({
      rows: [],
      columns: null,
      summary,
      turnId: "t3",
      sessionId: undefined,
    });
    assert.equal(spec, undefined);
  });
});
