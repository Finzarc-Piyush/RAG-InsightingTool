import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estimateExcelRowsFromRef } from "../lib/fileParser.js";

describe("Phase 0 · estimateExcelRowsFromRef", () => {
  it("estimates inclusive row count from a range", () => {
    assert.equal(estimateExcelRowsFromRef("A1:Z500000"), 500_000);
    assert.equal(estimateExcelRowsFromRef("A1:C10"), 10);
  });

  it("handles multi-letter columns", () => {
    assert.equal(estimateExcelRowsFromRef("AA5:ZZ15"), 11);
  });

  it("returns 0 for missing / garbage refs", () => {
    assert.equal(estimateExcelRowsFromRef(undefined), 0);
    assert.equal(estimateExcelRowsFromRef(null), 0);
    assert.equal(estimateExcelRowsFromRef(""), 0);
    assert.equal(estimateExcelRowsFromRef("not-a-ref"), 0);
  });

  it("returns 1 for a single-cell ref", () => {
    assert.equal(estimateExcelRowsFromRef("B7"), 1);
  });

  it("returns 0 for a malformed range where end < start", () => {
    assert.equal(estimateExcelRowsFromRef("A10:A2"), 0);
  });
});
