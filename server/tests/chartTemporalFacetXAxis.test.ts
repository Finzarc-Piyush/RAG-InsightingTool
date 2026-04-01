import { test } from "node:test";
import assert from "node:assert/strict";
import { processChartData } from "../lib/chartGenerator.js";
import type { ChartSpec } from "../shared/schema.js";

test("processChartData sorts line chart by month facet chronologically without dateColumns listing facet", () => {
  const x = "Month · Order Date";
  const spec: ChartSpec = {
    type: "line",
    title: "Sales trend",
    x,
    y: "Sales",
    aggregate: "none",
  };
  const data = [
    { [x]: "2024-03", Sales: 30 },
    { [x]: "2024-01", Sales: 10 },
    { [x]: "2024-02", Sales: 20 },
  ];
  const out = processChartData(data, spec, []);
  assert.equal(out.length, 3);
  assert.equal(out[0]![spec.x], "2024-01");
  assert.equal(out[1]![spec.x], "2024-02");
  assert.equal(out[2]![spec.x], "2024-03");
});
