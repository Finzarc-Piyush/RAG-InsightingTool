import { test } from "node:test";
import assert from "node:assert/strict";
import { processChartData } from "../lib/chartGenerator.js";
import { formatPeriodKeyForDisplay } from "../lib/dateUtils.js";
import type { ChartSpec } from "../shared/schema.js";

const MONTH_LABEL_RE = /^[A-Za-z]{3}-\d{2}$/; // "Jan-23" — the fabricated-month bug

test("quarter facet x stays canonical (2023-Qn), never a fabricated month label", () => {
  const x = "Quarter · Period";
  const spec: ChartSpec = {
    type: "line",
    title: "Sales_Value by Quarter · Period",
    x,
    y: "Sales_Value",
    aggregate: "none",
  };
  // Deliberately shuffled so a correct result proves chronological re-ordering.
  const data = [
    { [x]: "2024-Q2", Sales_Value: 5 },
    { [x]: "2023-Q1", Sales_Value: 1 },
    { [x]: "2025-Q4", Sales_Value: 9 },
    { [x]: "2023-Q3", Sales_Value: 3 },
    { [x]: "2024-Q1", Sales_Value: 4 },
    { [x]: "2023-Q2", Sales_Value: 2 },
  ];
  // dateColumns intentionally does NOT list the facet (matches real summaries).
  const out = processChartData(data, spec, []);

  const xs = out.map((r) => String(r[x]));
  assert.deepEqual(
    xs,
    ["2023-Q1", "2023-Q2", "2023-Q3", "2024-Q1", "2024-Q2", "2025-Q4"],
    "quarter keys must be canonical and chronological"
  );
  for (const v of xs) {
    assert.ok(!MONTH_LABEL_RE.test(v), `quarter must not be a month label: ${v}`);
  }
});

test("raw date column bucketed to quarter emits canonical quarter keys (not month)", () => {
  const spec: ChartSpec = {
    type: "line",
    title: "Sales by quarter",
    x: "Order Date",
    y: "Sales",
    aggregate: "sum",
  };
  const rows: Record<string, unknown>[] = [];
  // Two days inside each of 2023 Q1..Q4 → must collapse to four quarter buckets.
  for (const [mm, q] of [["01", 1], ["04", 2], ["07", 3], ["10", 4]] as const) {
    rows.push({ "Order Date": `2023-${mm}-05`, Sales: q });
    rows.push({ "Order Date": `2023-${mm}-20`, Sales: q });
  }
  const out = processChartData(rows, spec, ["Order Date"], {
    chartQuestion: "quarterly sales trend",
  });
  const xs = out.map((r) => String(r["Order Date"]));
  assert.deepEqual(xs, ["2023-Q1", "2023-Q2", "2023-Q3", "2023-Q4"]);
  for (const v of xs) {
    assert.ok(!MONTH_LABEL_RE.test(v), `must not fabricate a month: ${v}`);
  }
  // sum within each quarter (2 rows of value q each → 2q)
  assert.equal(out[0]!.Sales, 2);
  assert.equal(out[3]!.Sales, 8);
});

test("formatPeriodKeyForDisplay renders each grain (Q1 2023 style)", () => {
  assert.equal(formatPeriodKeyForDisplay("2023-Q1"), "Q1 2023");
  assert.equal(formatPeriodKeyForDisplay("2025-Q4"), "Q4 2025");
  assert.equal(formatPeriodKeyForDisplay("2023"), "2023");
  assert.equal(formatPeriodKeyForDisplay("2023-H1"), "H1 2023");
  assert.equal(formatPeriodKeyForDisplay("2023-01"), "Jan 2023");
  assert.equal(formatPeriodKeyForDisplay("2023-12"), "Dec 2023");
  assert.equal(formatPeriodKeyForDisplay("2023-W12"), "W12 2023");
  assert.equal(formatPeriodKeyForDisplay("2023-03-15"), "15 Mar 2023");
  // relative / unknown keys pass through verbatim
  assert.equal(formatPeriodKeyForDisplay("L12M"), "L12M");
  assert.equal(formatPeriodKeyForDisplay("YTD-TY"), "YTD-TY");
});
