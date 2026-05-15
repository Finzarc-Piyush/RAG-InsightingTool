/**
 * Wave A6 · Pin the upfront-transformations planner contract.
 *
 * The planner decides which schema/state operations need to be applied
 * to a fresh chat session before recipe replay starts. Mistakes here
 * are user-visible: skip a needed remelt → tools fail at replay; force
 * an unnecessary remelt → corrupt the new dataset.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planSessionTransformations } from "../lib/automations/planSessionTransformations.js";
import type { Automation, DataSummary } from "../shared/schema.js";

const baseAutomation: Automation = {
  id: "automation_x",
  username: "u@x.com",
  name: "X",
  sourceSessionId: "s",
  sourceFileName: "s.xlsx",
  createdAt: new Date().toISOString(),
  runCount: 0,
  expectedSchema: { rawColumns: [], finalColumns: [] },
  sessionTransformations: {},
  recipe: [],
};

const longSummary: DataSummary = {
  rowCount: 0,
  columnCount: 4,
  columns: [
    { name: "Markets", type: "string", sampleValues: [] },
    { name: "Period", type: "string", sampleValues: [] },
    { name: "PeriodIso", type: "string", sampleValues: [] },
    { name: "Value", type: "number", sampleValues: [] },
  ],
  numericColumns: ["Value"],
  dateColumns: [],
};

const wideSummary: DataSummary = {
  rowCount: 0,
  columnCount: 3,
  columns: [
    { name: "Markets", type: "string", sampleValues: [] },
    { name: "Q1 24 Value Sales", type: "number", sampleValues: [] },
    { name: "Q2 24 Value Sales", type: "number", sampleValues: [] },
  ],
  numericColumns: ["Q1 24 Value Sales", "Q2 24 Value Sales"],
  dateColumns: [],
};

const wfSaved = {
  detected: true as const,
  shape: "pure_period" as const,
  idColumns: ["Markets"],
  meltedColumns: ["Q1 23 Value Sales"],
  periodCount: 4,
  periodColumn: "Period",
  periodIsoColumn: "PeriodIso",
  periodKindColumn: "PeriodKind",
  valueColumn: "Value",
};

describe("Wave A6 · planSessionTransformations", () => {
  it("returns noOp when no transformations are saved", () => {
    const plan = planSessionTransformations(longSummary, baseAutomation);
    assert.equal(plan.noOp, true);
    assert.equal(plan.steps.length, 0);
  });

  it("plans wide_format_remelt when saved expects long but new is wide", () => {
    const plan = planSessionTransformations(wideSummary, {
      ...baseAutomation,
      sessionTransformations: { wideFormatTransform: wfSaved },
    });
    const remelt = plan.steps.find((s) => s.kind === "wide_format_remelt");
    assert.ok(remelt);
  });

  it("does NOT plan remelt when new dataset is already long-form", () => {
    const plan = planSessionTransformations(longSummary, {
      ...baseAutomation,
      sessionTransformations: { wideFormatTransform: wfSaved },
    });
    const remelt = plan.steps.find((s) => s.kind === "wide_format_remelt");
    assert.equal(remelt, undefined);
  });

  it("does NOT plan remelt when auto-detection on new dataset already produced long form", () => {
    const plan = planSessionTransformations(
      {
        ...longSummary,
        wideFormatTransform: {
          detected: true,
          shape: "pure_period",
          idColumns: ["Markets"],
          meltedColumns: ["Q1 24 Value Sales"],
          periodCount: 4,
          periodColumn: "Period",
          periodIsoColumn: "PeriodIso",
          periodKindColumn: "PeriodKind",
          valueColumn: "Value",
        },
      },
      {
        ...baseAutomation,
        sessionTransformations: { wideFormatTransform: wfSaved },
      }
    );
    const remelt = plan.steps.find((s) => s.kind === "wide_format_remelt");
    assert.equal(remelt, undefined);
  });

  it("plans copy_permanent_context when set + non-empty", () => {
    const plan = planSessionTransformations(longSummary, {
      ...baseAutomation,
      sessionTransformations: {
        permanentContext: "Always weight by population.",
      },
    });
    const ctx = plan.steps.find((s) => s.kind === "copy_permanent_context");
    assert.ok(ctx && ctx.kind === "copy_permanent_context");
    assert.equal(ctx.charCount, "Always weight by population.".length);
  });

  it("does NOT plan permanent_context for empty/whitespace strings", () => {
    const plan = planSessionTransformations(longSummary, {
      ...baseAutomation,
      sessionTransformations: { permanentContext: "   " },
    });
    assert.equal(
      plan.steps.find((s) => s.kind === "copy_permanent_context"),
      undefined
    );
  });

  it("plans seed_session_analysis_context when set", () => {
    const plan = planSessionTransformations(longSummary, {
      ...baseAutomation,
      sessionTransformations: {
        seedSessionAnalysisContext: { sessionKnowledge: undefined },
      },
    });
    assert.ok(
      plan.steps.find((s) => s.kind === "seed_session_analysis_context")
    );
  });

  it("composes multiple steps in a single plan", () => {
    const plan = planSessionTransformations(wideSummary, {
      ...baseAutomation,
      sessionTransformations: {
        wideFormatTransform: wfSaved,
        permanentContext: "Note A",
        seedSessionAnalysisContext: {},
      },
    });
    assert.equal(plan.steps.length, 3);
    assert.equal(plan.noOp, false);
  });
});
