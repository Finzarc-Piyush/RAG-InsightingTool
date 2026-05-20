/**
 * Wave W61-references-scan · pure-function tests for the downstream
 * reference counter that powers the future W61-delete-entry confirmation.
 *
 * Tests walk every advertised field location in both v1 ChartSpec and
 * v2 ChartSpecV2, plus the defensive guards on the top-level
 * `countSemanticModelReferences(name, charts[])` entry point. Coverage
 * is exact-equality only (matches the implementation's contract);
 * substring matching is explicitly NOT tested because it isn't a
 * supported semantic.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  countReferencesInChartSpec,
  countReferencesInChartSpecV2,
  countSemanticModelReferences,
} from "../lib/semantic/semanticModelReferences.js";
import type { ChartSpec, ChartSpecV2 } from "../shared/schema.js";

const NAME = "net_sales_value";

function makeV1(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    type: "bar",
    title: "Sales by region",
    x: "region",
    y: "sales",
    ...overrides,
  };
}

function makeV2(overrides: Partial<ChartSpecV2> = {}): ChartSpecV2 {
  return {
    version: 2,
    mark: "bar",
    encoding: {},
    source: { kind: "session-ref", sessionId: "s1" },
    ...overrides,
  };
}

// ─── Top-level guard tests ───────────────────────────────────────────

test("W61-references-scan · empty name returns zero (defensive against malformed semantic-model entries)", () => {
  const charts: ChartSpec[] = [makeV1({ y: NAME })];
  const out = countSemanticModelReferences("", charts);
  assert.deepEqual(out, { chartCount: 0, totalOccurrences: 0 });
});

test("W61-references-scan · empty chart array returns zero", () => {
  const out = countSemanticModelReferences(NAME, []);
  assert.deepEqual(out, { chartCount: 0, totalOccurrences: 0 });
});

test("W61-references-scan · non-object items in the array are silently skipped", () => {
  // The handler hands us whatever's at doc.charts — a stray null /
  // primitive / undefined slot must not throw.
  const charts: unknown[] = [
    null,
    undefined,
    42,
    "string",
    makeV1({ y: NAME }),
  ];
  const out = countSemanticModelReferences(NAME, charts);
  assert.deepEqual(
    out,
    { chartCount: 1, totalOccurrences: 1 },
    "only the well-formed v1 chart contributes",
  );
});

// ─── v1 ChartSpec field-walk tests ───────────────────────────────────

test("W61-references-scan · v1 · single-field match (y === name) yields 1 occurrence", () => {
  const chart = makeV1({ y: NAME });
  assert.equal(countReferencesInChartSpec(chart, NAME), 1);
});

test("W61-references-scan · v1 · multiple-field match (x === y === name) counts as 2 occurrences in one chart", () => {
  const chart = makeV1({ x: NAME, y: NAME });
  assert.equal(countReferencesInChartSpec(chart, NAME), 2);
});

test("W61-references-scan · v1 · walks z / seriesColumn / y2 / y2Series", () => {
  // All four optional v1 string fields + array.
  const cases: Array<[Partial<ChartSpec>, number]> = [
    [{ z: NAME }, 1],
    [{ seriesColumn: NAME }, 1],
    [{ y2: NAME }, 1],
    [{ y2Series: [NAME] }, 1],
    [{ y2Series: [NAME, NAME, "other"] }, 2],
  ];
  for (const [overrides, expected] of cases) {
    const chart = makeV1(overrides);
    assert.equal(
      countReferencesInChartSpec(chart, NAME),
      expected,
      JSON.stringify(overrides),
    );
  }
});

test("W61-references-scan · v1 · walks _agentProvenance.columnsUsed", () => {
  const chart = makeV1({
    _agentProvenance: {
      toolCalls: [],
      columnsUsed: [NAME, "other", NAME],
    },
  });
  assert.equal(countReferencesInChartSpec(chart, NAME), 2);
});

test("W61-references-scan · v1 · walks _agentProvenance.rangeFilters[].column", () => {
  const chart = makeV1({
    _agentProvenance: {
      toolCalls: [],
      rangeFilters: [
        { column: NAME, op: ">=", value: "100" },
        { column: "other", op: "<", value: "50" },
      ],
    },
  });
  assert.equal(countReferencesInChartSpec(chart, NAME), 1);
});

test("W61-references-scan · v1 · no match returns 0", () => {
  const chart = makeV1({ x: "other_column", y: "another" });
  assert.equal(countReferencesInChartSpec(chart, NAME), 0);
});

// ─── v2 ChartSpecV2 field-walk tests ─────────────────────────────────

test("W61-references-scan · v2 · walks encoding.{x,y,x2,y2,color,size,shape,pattern,facetRow,facetCol,detail,text,order}", () => {
  const channels: Array<keyof ChartSpecV2["encoding"]> = [
    "x",
    "y",
    "x2",
    "y2",
    "color",
    "size",
    "shape",
    "pattern",
    "facetRow",
    "facetCol",
    "detail",
    "text",
    "order",
  ];
  for (const ch of channels) {
    const chart = makeV2({
      encoding: { [ch]: { field: NAME, type: "q" } },
    });
    assert.equal(
      countReferencesInChartSpecV2(chart, NAME),
      1,
      `encoding.${String(ch)}.field should be walked`,
    );
  }
});

test("W61-references-scan · v2 · walks encoding.y2Series[].field", () => {
  const chart = makeV2({
    encoding: {
      y2Series: [
        { field: NAME, type: "q" },
        { field: "other", type: "q" },
        { field: NAME, type: "q" },
      ],
    },
  });
  assert.equal(countReferencesInChartSpecV2(chart, NAME), 2);
});

test("W61-references-scan · v2 · walks encoding.tooltip[].field", () => {
  const chart = makeV2({
    encoding: {
      tooltip: [{ field: NAME }, { field: "other" }, { field: NAME }],
    },
  });
  assert.equal(countReferencesInChartSpecV2(chart, NAME), 2);
});

test("W61-references-scan · v2 · walks encoding.opacity when it's a channel (not the literal-value branch)", () => {
  // opacity is union of channel | { value: number } — the literal-value
  // branch must NOT be walked (its `value` is a number, not a field name).
  const chartChannel = makeV2({
    encoding: { opacity: { field: NAME, type: "q" } },
  });
  assert.equal(countReferencesInChartSpecV2(chartChannel, NAME), 1);
  const chartValue = makeV2({
    encoding: { opacity: { value: 0.5 } },
  });
  assert.equal(countReferencesInChartSpecV2(chartValue, NAME), 0);
});

test("W61-references-scan · v2 · walks transform.aggregate (groupby + ops)", () => {
  const chart = makeV2({
    transform: [
      {
        type: "aggregate",
        groupby: [NAME, "other"],
        ops: [
          { op: "sum", field: NAME, as: "total" },
          { op: "mean", field: "other", as: "avg" },
        ],
      },
    ],
  });
  assert.equal(
    countReferencesInChartSpecV2(chart, NAME),
    2,
    "1 in groupby + 1 in ops",
  );
});

test("W61-references-scan · v2 · walks transform.fold / bin / window / regression", () => {
  const cases: Array<[ChartSpecV2["transform"], number]> = [
    [[{ type: "fold", fields: [NAME, "other"], as: ["k", "v"] }], 1],
    [[{ type: "bin", field: NAME, as: "bucket" }], 1],
    [
      [
        {
          type: "window",
          ops: [{ op: "cumsum", field: NAME, as: "running" }],
          groupby: [NAME],
          sort: [NAME],
        },
      ],
      3,
    ],
    [[{ type: "regression", on: NAME, method: "linear" }], 1],
  ];
  for (const [transform, expected] of cases) {
    const chart = makeV2({ transform });
    assert.equal(
      countReferencesInChartSpecV2(chart, NAME),
      expected,
      JSON.stringify(transform),
    );
  }
});

test("W61-references-scan · v2 · transform.filter.expr and transform.calculate.expr are NOT walked (SQL-expression noise)", () => {
  // Load-bearing: if a future "include expressions" mode is added,
  // it must be opt-in. The default must remain exact-identifier-only.
  const chart = makeV2({
    transform: [
      { type: "filter", expr: `${NAME} > 0` },
      { type: "calculate", as: "x", expr: `${NAME} * 2` },
    ],
  });
  assert.equal(countReferencesInChartSpecV2(chart, NAME), 0);
});

test("W61-references-scan · v2 · walks _agentProvenance.columnsUsed / rangeFilters", () => {
  const chart = makeV2({
    _agentProvenance: {
      toolCalls: [],
      columnsUsed: [NAME],
      rangeFilters: [{ column: NAME, op: ">=", value: "100" }],
    },
  });
  assert.equal(countReferencesInChartSpecV2(chart, NAME), 2);
});

// ─── Mixed-array integration ─────────────────────────────────────────

test("W61-references-scan · mixed v1 + v2 array aggregates correctly", () => {
  const v1Hit = makeV1({ y: NAME });
  const v1NoHit = makeV1({ x: "region", y: "sales" });
  const v2Hit = makeV2({
    encoding: { y: { field: NAME, type: "q" } },
  });
  const v2DoubleHit = makeV2({
    encoding: {
      x: { field: NAME, type: "n" },
      y: { field: NAME, type: "q" },
    },
  });
  const out = countSemanticModelReferences(NAME, [
    v1Hit,
    v1NoHit,
    v2Hit,
    v2DoubleHit,
  ]);
  assert.deepEqual(
    out,
    { chartCount: 3, totalOccurrences: 4 },
    "3 distinct charts match; v2DoubleHit contributes 2 to totalOccurrences",
  );
});

test("W61-references-scan · empty-name short-circuits even with hitting charts", () => {
  // Defense in depth: a malformed entry whose `name` field is the
  // empty string must not accidentally chart-count every chart that
  // happens to have an empty `seriesColumn`. The empty-name guard
  // fires at the top-level entry point AND in each per-spec scanner.
  const chartEmpty = makeV1({ seriesColumn: "" });
  assert.equal(countReferencesInChartSpec(chartEmpty, ""), 0);
  assert.equal(
    countSemanticModelReferences("", [chartEmpty]).totalOccurrences,
    0,
  );
});
