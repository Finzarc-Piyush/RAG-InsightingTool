import { test } from "node:test";
import assert from "node:assert/strict";
import { processChartData } from "../lib/chartGenerator.js";
import type { ChartSpec } from "../shared/schema.js";

test("processChartData sorts line chart by __tf_month facet chronologically without dateColumns listing facet", () => {
  const spec: ChartSpec = {
    type: "line",
    title: "Sales trend",
    x: "__tf_month__Order_Date",
    y: "Sales",
    aggregate: "none",
  };
  const data = [
    { __tf_month__Order_Date: "2024-03", Sales: 30 },
    { __tf_month__Order_Date: "2024-01", Sales: 10 },
    { __tf_month__Order_Date: "2024-02", Sales: 20 },
  ];
  const out = processChartData(data, spec, []);
  assert.equal(out.length, 3);
  assert.equal(out[0]![spec.x], "2024-01");
  assert.equal(out[1]![spec.x], "2024-02");
  assert.equal(out[2]![spec.x], "2024-03");
});
