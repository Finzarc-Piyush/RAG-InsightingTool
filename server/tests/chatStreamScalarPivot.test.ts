import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergePivotDefaultsForResponse } from "../services/chat/chatStream.service.js";
import type { DataSummary } from "../shared/schema.js";

function summary(): DataSummary {
  return {
    rowCount: 100,
    columnCount: 3,
    columns: [
      { name: "Sales", type: "number", sampleValues: [] },
      { name: "Region", type: "string", sampleValues: [] },
    ],
    numericColumns: ["Sales"],
    dateColumns: [],
  } as DataSummary;
}

describe("mergePivotDefaultsForResponse · scalar suppression", () => {
  it("returns undefined when executionPivot.scalar=true even if parserPivot has rows", () => {
    const out = mergePivotDefaultsForResponse({
      dataSummary: summary(),
      parsedQuery: { groupBy: [], aggregations: [] },
      parserPivot: {
        rows: ["Order Date", "Ship Date"],
        values: ["Shipping Time (Days)"],
      },
      executionPivot: { rows: [], values: [], scalar: true },
    });
    assert.equal(out, undefined);
  });

  it("falls back to parserPivot when executionPivot has no scalar tag and empty rows", () => {
    const out = mergePivotDefaultsForResponse({
      dataSummary: summary(),
      parsedQuery: { groupBy: ["Region"] },
      parserPivot: { rows: ["Region"], values: ["Sales"] },
      executionPivot: { rows: [], values: [] },
    });
    assert.deepEqual(out?.rows, ["Region"]);
    assert.deepEqual(out?.values, ["Sales"]);
  });

  it("uses executionPivot rows when populated (regression — group-by case)", () => {
    const out = mergePivotDefaultsForResponse({
      dataSummary: summary(),
      parsedQuery: { groupBy: ["Region"] },
      parserPivot: { rows: ["Region"], values: ["Sales"] },
      executionPivot: { rows: ["Region"], values: ["Sales"] },
    });
    assert.deepEqual(out?.rows, ["Region"]);
    assert.deepEqual(out?.values, ["Sales"]);
  });
});
