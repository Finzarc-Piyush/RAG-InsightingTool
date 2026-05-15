/**
 * Wave A1+A2 · Automation schema contract.
 *
 * Pins the round-trip shape so future schema changes don't silently drop
 * fields that the replay loop and capture controller depend on. The Cosmos
 * model layer is mostly a thin wrapper over `automationSchema` — if the
 * schema accepts a payload, the model can persist it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  automationSchema,
  automationTurnSchema,
  automationDryRunResultSchema,
  automationColumnMappingSchema,
  createAutomationRequestSchema,
  runAutomationRequestSchema,
  automationSummarySchema,
  type Automation,
} from "../shared/schema.js";

const sampleTurn = {
  ordinal: 0,
  question: "What were total sales by region in Q3?",
  mode: "analytical",
  planSteps: [
    {
      id: "s1",
      tool: "execute_query_plan",
      args: {
        plan: {
          groupBy: ["Region"],
          aggregations: [{ column: "Sales", op: "sum" }],
        },
      },
    },
  ],
  charts: [
    {
      type: "bar" as const,
      title: "Sales by region (Q3)",
      x: "Region",
      y: "Sales",
      data: [],
    },
  ],
  pivotDefaults: {
    rows: ["Region"],
    values: ["Sales"],
  },
};

const sampleAutomation: Automation = {
  id: "automation_q3_review_1700000000000",
  username: "piyush@finzarc.com",
  name: "Q3 Marico-VN review",
  description: "Weekly competitive review against Nielsen long-form.",
  sourceSessionId: "session_1699999999999_abcdef",
  sourceFileName: "Marico-VN-Q3-2024.xlsx",
  createdAt: new Date("2026-05-05T00:00:00Z").toISOString(),
  runCount: 0,
  expectedSchema: {
    rawColumns: [
      { name: "Markets", type: "string" },
      { name: "Q1 23 Value Sales", type: "number" },
      { name: "Q2 23 Value Sales", type: "number" },
    ],
    finalColumns: [
      { name: "Markets", type: "string" },
      { name: "Period", type: "string" },
      { name: "PeriodIso", type: "string" },
      { name: "Value", type: "number" },
    ],
  },
  sessionTransformations: {
    wideFormatTransform: {
      detected: true,
      shape: "pure_period",
      idColumns: ["Markets"],
      meltedColumns: ["Q1 23 Value Sales", "Q2 23 Value Sales"],
      periodCount: 4,
      periodColumn: "Period",
      periodIsoColumn: "PeriodIso",
      periodKindColumn: "PeriodKind",
      valueColumn: "Value",
    },
    sessionComputedColumns: [
      {
        name: "ValueK",
        formula: "Value / 1000",
        sourceTurnOrdinal: 1,
      },
    ],
    permanentContext: "Always weight by population per region.",
  },
  recipe: [sampleTurn],
};

describe("Wave A1 · automationSchema", () => {
  it("round-trips a fully-populated automation without loss", () => {
    const parsed = automationSchema.parse(sampleAutomation);
    assert.equal(parsed.id, sampleAutomation.id);
    assert.equal(parsed.recipe.length, 1);
    assert.equal(parsed.recipe[0].planSteps.length, 1);
    assert.equal(
      parsed.sessionTransformations.wideFormatTransform?.shape,
      "pure_period"
    );
    assert.equal(
      parsed.sessionTransformations.sessionComputedColumns?.length,
      1
    );
  });

  it("rejects empty name", () => {
    assert.throws(() =>
      automationSchema.parse({ ...sampleAutomation, name: "" })
    );
  });

  it("rejects recipe over the 200-turn cap", () => {
    const bigRecipe = Array.from({ length: 201 }, (_, i) => ({
      ...sampleTurn,
      ordinal: i,
    }));
    assert.throws(() =>
      automationSchema.parse({ ...sampleAutomation, recipe: bigRecipe })
    );
  });

  it("accepts an automation with empty optional transformations", () => {
    const minimal = {
      ...sampleAutomation,
      sessionTransformations: {},
    };
    const parsed = automationSchema.parse(minimal);
    assert.equal(parsed.sessionTransformations.wideFormatTransform, undefined);
    assert.equal(
      parsed.sessionTransformations.sessionComputedColumns,
      undefined
    );
  });
});

describe("Wave A1 · automationTurnSchema", () => {
  it("accepts loose plan steps (server validates strict shape at replay)", () => {
    const parsed = automationTurnSchema.parse({
      ordinal: 0,
      question: "Anything works as a plan step at this layer",
      planSteps: [
        { id: "x", tool: "y", args: { foo: "bar", nested: { ok: true } } },
        { freeform: "fields are allowed" },
      ],
    });
    assert.equal(parsed.planSteps.length, 2);
  });

  it("rejects question = empty string", () => {
    assert.throws(() =>
      automationTurnSchema.parse({
        ordinal: 0,
        question: "",
        planSteps: [],
      })
    );
  });

  it("caps planSteps at 60", () => {
    assert.throws(() =>
      automationTurnSchema.parse({
        ordinal: 0,
        question: "Q",
        planSteps: Array.from({ length: 61 }, (_, i) => ({ id: `s${i}` })),
      })
    );
  });
});

describe("Wave A1 · request + response schemas", () => {
  it("createAutomationRequestSchema requires sessionId + name", () => {
    assert.doesNotThrow(() =>
      createAutomationRequestSchema.parse({
        sessionId: "session_x",
        name: "My automation",
      })
    );
    assert.throws(() =>
      createAutomationRequestSchema.parse({ sessionId: "session_x" })
    );
  });

  it("runAutomationRequestSchema accepts mapping omitted (identity)", () => {
    const parsed = runAutomationRequestSchema.parse({
      sessionId: "session_x",
    });
    assert.equal(parsed.columnMapping, undefined);
  });

  it("runAutomationRequestSchema accepts mapping object", () => {
    const parsed = runAutomationRequestSchema.parse({
      sessionId: "session_x",
      columnMapping: { "Sale Value": "Sales" },
    });
    assert.equal(parsed.columnMapping?.["Sale Value"], "Sales");
  });

  it("automationDryRunResultSchema round-trips a typical response", () => {
    const parsed = automationDryRunResultSchema.parse({
      exactMatches: ["Region", "Date"],
      proposedMappings: [
        {
          saved: "Sale Value",
          suggested: "Sales",
          confidence: "high",
          reason: "Tokens 'sale' and 'sales' rhyme.",
        },
      ],
      unmatchable: [],
    });
    assert.equal(parsed.proposedMappings[0].confidence, "high");
  });

  it("automationColumnMappingSchema accepts arbitrary string→string mapping", () => {
    const parsed = automationColumnMappingSchema.parse({ a: "b", c: "d" });
    assert.equal(parsed.a, "b");
  });

  it("automationSummarySchema matches the model summariser output shape", () => {
    const parsed = automationSummarySchema.parse({
      id: "automation_x_1",
      name: "X",
      sourceFileName: "x.xlsx",
      createdAt: new Date().toISOString(),
      runCount: 0,
      recipeLength: 0,
      expectedColumnCount: 0,
    });
    assert.equal(parsed.runCount, 0);
  });
});
