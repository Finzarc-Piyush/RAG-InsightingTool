import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveSeriesKeysFromWideDataRow } from "../lib/ensureChartSpecSeriesKeys.js";

describe("deriveSeriesKeysFromWideDataRow", () => {
  it("returns non-x keys as series keys for wide rows", () => {
    const sk = deriveSeriesKeysFromWideDataRow(
      "line",
      "Month · Order Date",
      "Sales",
      "Category",
      {
        "Month · Order Date": "2015-01",
        Office_Supplies: 100,
        Furniture: 200,
        Technology: 300,
      }
    );
    assert.ok(sk);
    assert.deepEqual(sk!.sort(), ["Furniture", "Office_Supplies", "Technology"].sort());
  });

  it("returns undefined for long-format row (x + series + y)", () => {
    const sk = deriveSeriesKeysFromWideDataRow("line", "Month", "Sales", "Category", {
      Month: "2015-01",
      Category: "Office_Supplies",
      Sales: 42,
    });
    assert.equal(sk, undefined);
  });
});
