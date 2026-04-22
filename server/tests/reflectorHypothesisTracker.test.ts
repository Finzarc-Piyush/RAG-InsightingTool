import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reflectorOutputSchema, gapFillSchema } from "../lib/agents/runtime/schemas.js";

/**
 * Wave W11 · reflectorHypothesisTracker
 *
 * Tests validate:
 * 1. The `investigate_gap` action is accepted by reflectorOutputSchema
 * 2. `gapFill` is parsed correctly when action=investigate_gap
 * 3. `gapFill` is optional for other actions
 * 4. Schema rejects unknown actions
 */

describe("reflectorOutputSchema — investigate_gap action (W11)", () => {
  it("parses investigate_gap with a valid gapFill", () => {
    const raw = {
      action: "investigate_gap",
      gapFill: {
        hypothesisId: "h2",
        tool: "run_analytical_query",
        rationale: "H2 has no evidence — query brand dimension to cover it.",
      },
    };
    const result = reflectorOutputSchema.safeParse(raw);
    assert.ok(result.success, `parse should succeed: ${!result.success ? result.error.message : ""}`);
    assert.strictEqual(result.data.action, "investigate_gap");
    assert.deepStrictEqual(result.data.gapFill, {
      hypothesisId: "h2",
      tool: "run_analytical_query",
      rationale: "H2 has no evidence — query brand dimension to cover it.",
    });
    assert.deepStrictEqual(result.data.spawnedQuestions, []);
  });

  it("parses investigate_gap without gapFill (gapFill optional)", () => {
    const raw = { action: "investigate_gap" };
    const result = reflectorOutputSchema.safeParse(raw);
    assert.ok(result.success);
    assert.strictEqual(result.data.gapFill, undefined);
  });

  it("gapFill not required for finish action", () => {
    const raw = { action: "finish", note: "all done" };
    const result = reflectorOutputSchema.safeParse(raw);
    assert.ok(result.success);
    assert.strictEqual(result.data.gapFill, undefined);
  });

  it("gapFill not required for continue action", () => {
    const raw = { action: "continue" };
    const result = reflectorOutputSchema.safeParse(raw);
    assert.ok(result.success);
    assert.strictEqual(result.data.gapFill, undefined);
  });

  it("rejects unknown action", () => {
    const raw = { action: "unknown_action" };
    const result = reflectorOutputSchema.safeParse(raw);
    assert.ok(!result.success, "should reject unknown action");
  });

  it("parses investigate_gap alongside spawnedQuestions", () => {
    const raw = {
      action: "investigate_gap",
      gapFill: {
        hypothesisId: "h3",
        tool: "get_column_values",
        rationale: "Need region breakdown",
      },
      spawnedQuestions: [
        {
          question: "What regions drove the spike?",
          spawnReason: "30% spike in March",
          priority: "high",
          suggestedColumns: ["region", "sales"],
        },
      ],
    };
    const result = reflectorOutputSchema.safeParse(raw);
    assert.ok(result.success);
    assert.strictEqual(result.data.spawnedQuestions.length, 1);
    assert.strictEqual(result.data.spawnedQuestions[0].priority, "high");
    assert.strictEqual(result.data.gapFill?.hypothesisId, "h3");
  });
});

describe("gapFillSchema (W11)", () => {
  it("requires hypothesisId, tool, and rationale", () => {
    const valid = { hypothesisId: "h1", tool: "run_analytical_query", rationale: "test" };
    assert.ok(gapFillSchema.safeParse(valid).success);
  });

  it("rejects missing tool", () => {
    const invalid = { hypothesisId: "h1", rationale: "test" };
    assert.ok(!gapFillSchema.safeParse(invalid).success);
  });

  it("rejects missing hypothesisId", () => {
    const invalid = { tool: "run_analytical_query", rationale: "test" };
    assert.ok(!gapFillSchema.safeParse(invalid).success);
  });
});

describe("gapFillSchema — W12a args extension", () => {
  it("accepts and preserves gapFill.args", () => {
    const valid = {
      hypothesisId: "h2",
      tool: "run_analytical_query",
      rationale: "test",
      args: { question_override: "sum of Sales by Region" },
    };
    const r = gapFillSchema.safeParse(valid);
    assert.ok(r.success);
    assert.deepStrictEqual(r.data.args, { question_override: "sum of Sales by Region" });
  });

  it("parses without args (backward compatible)", () => {
    const valid = { hypothesisId: "h1", tool: "run_analytical_query", rationale: "test" };
    const r = gapFillSchema.safeParse(valid);
    assert.ok(r.success);
    assert.strictEqual(r.data.args, undefined);
  });

  it("reflectorOutputSchema round-trips gapFill.args through investigate_gap", () => {
    const raw = {
      action: "investigate_gap",
      gapFill: {
        hypothesisId: "h4",
        tool: "run_analytical_query",
        rationale: "Need brand breakdown",
        args: { question_override: "Sales by Brand in 2016", groupBy: ["Brand"] },
      },
    };
    const r = reflectorOutputSchema.safeParse(raw);
    assert.ok(r.success, `parse should succeed: ${!r.success ? r.error.message : ""}`);
    assert.strictEqual((r.data.gapFill?.args as Record<string, unknown>)?.question_override, "Sales by Brand in 2016");
  });
});
