/**
 * Fix D · datasetProfileSchema tolerates common LLM shape drift so the
 * upload-path dataset-profile call doesn't burn a full retry round-trip (each
 * retry is a fresh, possibly multi-second LLM call) on a deployment that returns
 * `notes` as an array or `currencyOverrides` as an object.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { datasetProfileSchema } from "../shared/schema.js";

const base = {
  shortDescription: "x",
  dateColumns: [],
  suggestedQuestions: [],
};

describe("datasetProfileSchema · tolerant coercion", () => {
  it("coerces `notes` array → joined string", () => {
    const out = datasetProfileSchema.parse({ ...base, notes: ["PII present", "mixed date formats"] });
    assert.equal(out.notes, "PII present; mixed date formats");
  });

  it("passes a correct `notes` string through unchanged", () => {
    const out = datasetProfileSchema.parse({ ...base, notes: "fiscal year starts in April" });
    assert.equal(out.notes, "fiscal year starts in April");
  });

  it("coerces a single `currencyOverrides` object → one-element array", () => {
    const out = datasetProfileSchema.parse({
      ...base,
      currencyOverrides: { columnName: "Sales", isoCode: "INR" },
    });
    assert.deepEqual(out.currencyOverrides, [{ columnName: "Sales", isoCode: "INR" }]);
  });

  it("coerces a {column: iso} map → array", () => {
    const out = datasetProfileSchema.parse({
      ...base,
      currencyOverrides: { Sales: "INR", Revenue: "USD" },
    });
    assert.deepEqual(out.currencyOverrides, [
      { columnName: "Sales", isoCode: "INR" },
      { columnName: "Revenue", isoCode: "USD" },
    ]);
  });

  it("passes a correct `currencyOverrides` array through unchanged", () => {
    const arr = [{ columnName: "Sales", isoCode: "INR" }];
    const out = datasetProfileSchema.parse({ ...base, currencyOverrides: arr });
    assert.deepEqual(out.currencyOverrides, arr);
  });
});
