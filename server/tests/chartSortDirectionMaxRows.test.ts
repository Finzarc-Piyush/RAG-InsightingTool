/**
 * Wave MW3 · processChartData honours sortDirection + maxRows on categorical
 * bar charts — enabling bottom-N "worst performers" views and (when omitted)
 * never truncating the full breakdown.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { processChartData } from "../lib/chartGenerator.js";
import type { ChartSpec } from "../shared/schema.js";

const rows = [
  { ASM: "A", Visits: 10 },
  { ASM: "B", Visits: 40 },
  { ASM: "C", Visits: 20 },
  { ASM: "D", Visits: 30 },
];
const base: ChartSpec = { type: "bar", title: "Visits by ASM", x: "ASM", y: "Visits", aggregate: "sum" };

describe("MW3 · processChartData sortDirection + maxRows", () => {
  it("defaults to descending (best-first), shows ALL categories", () => {
    const out = processChartData(rows, base, []);
    assert.deepEqual(out.map((r) => r.ASM), ["B", "D", "C", "A"]);
  });

  it("sortDirection 'asc' surfaces the WORST performers first", () => {
    const out = processChartData(rows, { ...base, sortDirection: "asc" }, []);
    assert.deepEqual(out.map((r) => r.ASM), ["A", "C", "D", "B"]);
  });

  it("maxRows caps a bottom-N view (worst 2)", () => {
    const out = processChartData(rows, { ...base, sortDirection: "asc", maxRows: 2 }, []);
    assert.deepEqual(out.map((r) => r.ASM), ["A", "C"]);
  });

  it("maxRows caps a top-N view (best 2)", () => {
    const out = processChartData(rows, { ...base, sortDirection: "desc", maxRows: 2 }, []);
    assert.deepEqual(out.map((r) => r.ASM), ["B", "D"]);
  });

  it("no maxRows = no truncation (all 4 categories)", () => {
    const out = processChartData(rows, base, []);
    assert.equal(out.length, 4);
  });
});
