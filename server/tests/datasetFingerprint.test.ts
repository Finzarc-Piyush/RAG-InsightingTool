// Wave W-UD1 · datasetFingerprint helper tests
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeDatasetFingerprint,
  fingerprintFromSummary,
} from "../lib/datasetFingerprint.js";

describe("computeDatasetFingerprint", () => {
  it("returns a stable sentinel for empty / null / undefined input", () => {
    const empty = computeDatasetFingerprint({ columns: [] });
    const nullish = computeDatasetFingerprint(null);
    const missing = computeDatasetFingerprint(undefined);
    assert.equal(empty, nullish, "empty and null should collapse to same sentinel");
    assert.equal(nullish, missing, "null and undefined should collapse");
    assert.equal(
      empty.length,
      16,
      "fingerprint length contract is 16 hex chars"
    );
  });

  it("produces a deterministic 16-hex string for a populated summary", () => {
    const fp = computeDatasetFingerprint({
      columns: [
        { name: "Brand", type: "string" },
        { name: "Sales", type: "number" },
        { name: "Date", type: "date" },
      ],
    });
    assert.equal(fp.length, 16);
    assert.match(fp, /^[0-9a-f]{16}$/, "must be 16 hex chars");
    // Re-run: must be identical
    const fp2 = computeDatasetFingerprint({
      columns: [
        { name: "Brand", type: "string" },
        { name: "Sales", type: "number" },
        { name: "Date", type: "date" },
      ],
    });
    assert.equal(fp, fp2, "must be deterministic");
  });

  it("is column-order invariant (sorted before hashing)", () => {
    const a = computeDatasetFingerprint({
      columns: [
        { name: "Brand", type: "string" },
        { name: "Sales", type: "number" },
      ],
    });
    const b = computeDatasetFingerprint({
      columns: [
        { name: "Sales", type: "number" },
        { name: "Brand", type: "string" },
      ],
    });
    assert.equal(a, b, "column order must not affect fingerprint");
  });

  it("is case-insensitive on column names", () => {
    const a = computeDatasetFingerprint({
      columns: [{ name: "Brand", type: "string" }],
    });
    const b = computeDatasetFingerprint({
      columns: [{ name: "BRAND", type: "string" }],
    });
    assert.equal(a, b, "name casing must not affect fingerprint");
  });

  it("ignores leading / trailing whitespace on name and type", () => {
    const a = computeDatasetFingerprint({
      columns: [{ name: "Brand", type: "string" }],
    });
    const b = computeDatasetFingerprint({
      columns: [{ name: "  Brand  ", type: " string " }],
    });
    assert.equal(a, b);
  });

  it("changes when a new column is added", () => {
    const a = computeDatasetFingerprint({
      columns: [{ name: "Brand", type: "string" }],
    });
    const b = computeDatasetFingerprint({
      columns: [
        { name: "Brand", type: "string" },
        { name: "Sales", type: "number" },
      ],
    });
    assert.notEqual(a, b, "adding a column must change the fingerprint");
  });

  it("changes when a column's type changes", () => {
    const a = computeDatasetFingerprint({
      columns: [{ name: "Year", type: "number" }],
    });
    const b = computeDatasetFingerprint({
      columns: [{ name: "Year", type: "date" }],
    });
    assert.notEqual(a, b, "changing a type must change the fingerprint");
  });

  it("filters out entries with empty name AND empty type", () => {
    const a = computeDatasetFingerprint({
      columns: [{ name: "Brand", type: "string" }],
    });
    const b = computeDatasetFingerprint({
      columns: [
        { name: "Brand", type: "string" },
        { name: "", type: "" },
      ],
    });
    assert.equal(a, b, "empty entries should be filtered, not contribute");
  });

  it("fingerprintFromSummary delegates to computeDatasetFingerprint", () => {
    const summary = {
      columns: [
        { name: "A", type: "string" },
        { name: "B", type: "number" },
      ],
    };
    assert.equal(
      fingerprintFromSummary(summary as any),
      computeDatasetFingerprint(summary)
    );
  });

  it("collision-resistance smoke: 50 distinct shapes produce 50 distinct fingerprints", () => {
    const fps = new Set<string>();
    for (let i = 0; i < 50; i++) {
      fps.add(
        computeDatasetFingerprint({
          columns: [
            { name: `col_${i}`, type: "string" },
            { name: "shared", type: "number" },
          ],
        })
      );
    }
    assert.equal(fps.size, 50, "every distinct shape should hash uniquely");
  });
});
