import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyFrame,
  compileChartSpec,
  columnIsMeasureLike,
} from "../lib/chartSpecCompiler.js";

describe("chartSpecCompiler", () => {
  it("fills seriesColumn for long Category × Region × Sales bar", () => {
    const rows = [
      { Category: "A", Region: "East", Sales_sum: 10 },
      { Category: "A", Region: "West", Sales_sum: 20 },
      { Category: "B", Region: "East", Sales_sum: 5 },
    ];
    const summary = { numericColumns: [] as string[] };
    const { merged, warnings } = compileChartSpec(
      rows as Record<string, unknown>[],
      summary,
      { type: "bar", x: "Category", y: "Sales_sum" }
    );
    assert.equal(merged.seriesColumn, "Region");
    assert.equal(merged.barLayout, "stacked");
    assert.ok(warnings.some((w) => w.includes("seriesColumn")));
    assert.equal(merged.aggregate, "none");
  });

  it("does not add seriesColumn when y2 is set", () => {
    const rows = [
      { Day: "Mon", A: 1, B: 2 },
      { Day: "Tue", A: 3, B: 4 },
    ];
    const { merged } = compileChartSpec(
      rows as Record<string, unknown>[],
      { numericColumns: ["A", "B"] },
      { type: "line", x: "Day", y: "A", y2: "B" }
    );
    assert.equal(merged.seriesColumn, undefined);
  });

  it("upgrades bar to heatmap for 3+ dimensions when cardinality allows", () => {
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        for (let k = 0; k < 3; k++) {
          rows.push({
            R: `r${i}`,
            C: `c${j}`,
            S: `s${k}`,
            V: i + j + k,
          });
        }
      }
    }
    const { merged } = compileChartSpec(
      rows,
      { numericColumns: [] },
      { type: "bar", x: "R", y: "V" }
    );
    assert.equal(merged.type, "heatmap");
    assert.equal(merged.x, "R");
    assert.ok(merged.y === "C" || merged.y === "S");
    assert.equal(merged.z, "V");
  });

  it("respects disallowHeatmapUpgrade", () => {
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        for (let k = 0; k < 3; k++) {
          rows.push({ R: `r${i}`, C: `c${j}`, S: `s${k}`, V: 1 });
        }
      }
    }
    const { merged } = compileChartSpec(
      rows,
      { numericColumns: [] },
      { type: "bar", x: "R", y: "V" },
      { disallowHeatmapUpgrade: true }
    );
    assert.equal(merged.type, "bar");
    assert.ok(merged.seriesColumn);
  });

  it("classifyFrame separates dimensions and measures", () => {
    const rows = [{ a: "x", b: 1 }];
    const { dimensions, measures } = classifyFrame(rows, {
      numericColumns: ["b"],
    });
    assert.deepEqual(dimensions, ["a"]);
    assert.deepEqual(measures, ["b"]);
  });

  it("columnIsMeasureLike detects _sum suffix", () => {
    assert.equal(
      columnIsMeasureLike("Sales_sum", [], new Set()),
      true
    );
  });
});
