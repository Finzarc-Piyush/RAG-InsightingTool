/**
 * Wave A5 · Pin the column-mapping rewriter contract.
 *
 * The rewriter is the only seam between user-confirmed column remap and
 * deterministic replay. If it misses a substitution site, the replay
 * tool will fail loudly (the replay loop halts on first error). If it
 * does the WRONG substitution (e.g. rewrites a label string), analysis
 * output silently corrupts. The tests here pin both directions.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyColumnMappingToRecipe,
  composeColumnMapping,
  type ColumnMapping,
} from "../lib/automations/applyColumnMapping.js";
import type { AutomationTurn } from "../shared/schema.js";

const mkTurn = (overrides: Partial<AutomationTurn> = {}): AutomationTurn => ({
  ordinal: 0,
  question: "Q",
  planSteps: [],
  ...overrides,
});

describe("Wave A5 · composeColumnMapping", () => {
  it("excludes identity mappings + nulls", () => {
    const m = composeColumnMapping(
      ["Region", "Date"],
      [
        { saved: "Sale Value", suggested: "Sales" },
        { saved: "Region", suggested: "Region" }, // identity → omit
        { saved: "Mystery", suggested: null }, // unmapped → omit
      ]
    );
    assert.deepEqual(m, { "Sale Value": "Sales" });
  });

  it("returns empty mapping when all matches are exact", () => {
    const m = composeColumnMapping(["a", "b"], []);
    assert.deepEqual(m, {});
  });
});

describe("Wave A5 · applyColumnMappingToRecipe — plan-step args", () => {
  const mapping: ColumnMapping = {
    "Sale Value": "Sales",
    "PJP Adherence": "Adherence",
  };

  it("rewrites scalar column fields", () => {
    const out = applyColumnMappingToRecipe(
      [
        mkTurn({
          planSteps: [
            {
              id: "s1",
              tool: "execute_query_plan",
              args: {
                valueColumn: "Sale Value",
                breakdownColumn: "Region",
                x: "Date",
                y: "Sale Value",
              },
            },
          ],
        }),
      ],
      mapping
    );
    const args = out[0].planSteps[0].args as Record<string, unknown>;
    assert.equal(args.valueColumn, "Sales");
    assert.equal(args.y, "Sales");
    assert.equal(args.breakdownColumn, "Region");
  });

  it("rewrites groupBy / columns / rows / values arrays", () => {
    const out = applyColumnMappingToRecipe(
      [
        mkTurn({
          planSteps: [
            {
              id: "s1",
              tool: "execute_query_plan",
              args: {
                groupBy: ["Region", "Sale Value"],
                rows: ["PJP Adherence"],
                values: ["Sale Value"],
              },
            },
          ],
        }),
      ],
      mapping
    );
    const args = out[0].planSteps[0].args as Record<string, unknown>;
    assert.deepEqual(args.groupBy, ["Region", "Sales"]);
    assert.deepEqual(args.rows, ["Adherence"]);
    assert.deepEqual(args.values, ["Sales"]);
  });

  it("rewrites dimensionFilters[].column", () => {
    const out = applyColumnMappingToRecipe(
      [
        mkTurn({
          planSteps: [
            {
              id: "s1",
              tool: "execute_query_plan",
              args: {
                dimensionFilters: [
                  { column: "PJP Adherence", op: "in", values: ["yes"] },
                  { column: "Region", op: "in", values: ["North"] },
                ],
              },
            },
          ],
        }),
      ],
      mapping
    );
    const filters = (out[0].planSteps[0].args as Record<string, unknown>)
      .dimensionFilters as Array<Record<string, unknown>>;
    assert.equal(filters[0].column, "Adherence");
    assert.equal(filters[1].column, "Region");
    assert.deepEqual(filters[0].values, ["yes"]); // value not remapped
  });

  it("rewrites aggregations[].column and sort[].column", () => {
    const out = applyColumnMappingToRecipe(
      [
        mkTurn({
          planSteps: [
            {
              id: "s1",
              tool: "execute_query_plan",
              args: {
                aggregations: [
                  { column: "Sale Value", op: "sum" },
                  { column: "Volume", op: "avg" },
                ],
                sort: [{ column: "Sale Value", direction: "desc" }],
              },
            },
          ],
        }),
      ],
      mapping
    );
    const args = out[0].planSteps[0].args as Record<string, unknown>;
    const aggs = args.aggregations as Array<Record<string, unknown>>;
    const sort = args.sort as Array<Record<string, unknown>>;
    assert.equal(aggs[0].column, "Sales");
    assert.equal(aggs[1].column, "Volume");
    assert.equal(sort[0].column, "Sales");
  });

  it("recurses into nested plan structures (e.g. args.plan)", () => {
    const out = applyColumnMappingToRecipe(
      [
        mkTurn({
          planSteps: [
            {
              id: "s1",
              tool: "execute_query_plan",
              args: {
                plan: {
                  groupBy: ["Sale Value"],
                  aggregations: [{ column: "Sale Value", op: "sum" }],
                  dimensionFilters: [
                    { column: "PJP Adherence", op: "in", values: ["No"] },
                  ],
                },
              },
            },
          ],
        }),
      ],
      mapping
    );
    const plan = (out[0].planSteps[0].args as Record<string, unknown>)
      .plan as Record<string, unknown>;
    assert.deepEqual(plan.groupBy, ["Sales"]);
    assert.equal(
      (plan.aggregations as Array<Record<string, unknown>>)[0].column,
      "Sales"
    );
    assert.equal(
      (
        (plan.dimensionFilters as Array<Record<string, unknown>>)[0]
          .column
      ),
      "Adherence"
    );
  });
});

describe("Wave A5 · applyColumnMappingToRecipe — add_computed_columns", () => {
  it("rewrites formula but NOT the new column's name", () => {
    const out = applyColumnMappingToRecipe(
      [
        mkTurn({
          planSteps: [
            {
              id: "s1",
              tool: "add_computed_columns",
              args: {
                persistToSession: true,
                columns: [
                  {
                    name: "SaleK", // user-named output column — must stay
                    formula: "Sale Value / 1000",
                  },
                ],
              },
            },
          ],
        }),
      ],
      { "Sale Value": "Sales" }
    );
    const cols = (out[0].planSteps[0].args as Record<string, unknown>)
      .columns as Array<Record<string, unknown>>;
    assert.equal(cols[0].name, "SaleK"); // unchanged
    assert.equal(cols[0].formula, "Sales / 1000");
  });

  it("respects word boundaries (does not match column substrings)", () => {
    const out = applyColumnMappingToRecipe(
      [
        mkTurn({
          planSteps: [
            {
              id: "s1",
              tool: "add_computed_columns",
              args: {
                columns: [
                  { name: "X", formula: "Sale + Sales + SaleValue" },
                ],
              },
            },
          ],
        }),
      ],
      { Sale: "Revenue" }
    );
    const cols = (out[0].planSteps[0].args as Record<string, unknown>)
      .columns as Array<Record<string, unknown>>;
    // "Sale" alone → "Revenue"; "Sales" and "SaleValue" preserved.
    assert.equal(cols[0].formula, "Revenue + Sales + SaleValue");
  });

  it("longest-key-first ordering: 'Sales' rewritten before 'Sale'", () => {
    const out = applyColumnMappingToRecipe(
      [
        mkTurn({
          planSteps: [
            {
              id: "s1",
              tool: "add_computed_columns",
              args: {
                columns: [{ name: "X", formula: "Sales + Sale" }],
              },
            },
          ],
        }),
      ],
      { Sales: "Revenue", Sale: "Income" }
    );
    const cols = (out[0].planSteps[0].args as Record<string, unknown>)
      .columns as Array<Record<string, unknown>>;
    assert.equal(cols[0].formula, "Revenue + Income");
  });
});

describe("Wave A5 · applyColumnMappingToRecipe — pivotDefaults + charts", () => {
  it("rewrites pivotDefaults rows/columns/values + filterFields", () => {
    const out = applyColumnMappingToRecipe(
      [
        mkTurn({
          pivotDefaults: {
            rows: ["Region", "Sale Value"],
            columns: ["Date"],
            values: ["Sale Value"],
            filterFields: ["PJP Adherence"],
            filterSelections: { "PJP Adherence": ["No"] },
          },
        }),
      ],
      { "Sale Value": "Sales", "PJP Adherence": "Adherence" }
    );
    const pd = out[0].pivotDefaults as Record<string, unknown>;
    assert.deepEqual(pd.rows, ["Region", "Sales"]);
    assert.deepEqual(pd.values, ["Sales"]);
    assert.deepEqual(pd.filterFields, ["Adherence"]);
    assert.deepEqual(pd.filterSelections, { Adherence: ["No"] });
  });

  it("rewrites chart x/y/seriesColumn", () => {
    const out = applyColumnMappingToRecipe(
      [
        mkTurn({
          charts: [
            {
              type: "line",
              title: "Sales over time", // label NOT rewritten
              x: "Date",
              y: "Sale Value",
              seriesColumn: "Region",
              data: [],
            },
          ],
        }),
      ],
      { "Sale Value": "Sales" }
    );
    const chart = out[0].charts![0];
    assert.equal(chart.title, "Sales over time"); // unchanged
    assert.equal(chart.x, "Date");
    assert.equal(chart.y, "Sales");
    assert.equal(chart.seriesColumn, "Region");
  });
});

describe("Wave A5 · applyColumnMappingToRecipe — identity + safety", () => {
  it("empty mapping is a structural deep-clone (no mutation)", () => {
    const original = mkTurn({
      planSteps: [
        {
          id: "s1",
          tool: "x",
          args: { groupBy: ["a"], dimensionFilters: [{ column: "a" }] },
        },
      ],
    });
    const out = applyColumnMappingToRecipe([original], {});
    assert.notEqual(out[0], original);
    assert.notEqual(out[0].planSteps[0], original.planSteps[0]);
    assert.deepEqual(out[0].planSteps[0].args, original.planSteps[0].args);
    // Mutating the output must not affect the input
    (out[0].planSteps[0].args as Record<string, unknown>).groupBy = ["z"];
    assert.deepEqual(
      (original.planSteps[0].args as Record<string, unknown>).groupBy,
      ["a"]
    );
  });
});
