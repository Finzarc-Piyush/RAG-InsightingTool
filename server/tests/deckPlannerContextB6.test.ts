import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDeckPlannerUserPrompt,
  type DeckPlannerInputs,
} from "../lib/agents/runtime/deckPlanner.js";
import type { Dashboard } from "../shared/schema.js";

/**
 * Wave B6 · Pins that the deck planner's user prompt includes the four
 * optional ambient-context blocks when provided (USER PREFERENCES,
 * DIMENSION HIERARCHIES, DATASET SHAPE) and stays clean when absent.
 *
 * Pre-B6 the deck planner saw only dashboard contents (charts,
 * narrative blocks, answer envelope, business actions, captured filter).
 * If the user added a permanent context note AFTER the analysis was
 * authored, the deck planner had no way to honour it. Same for
 * hierarchies (BAI-style "FEMALE SHOWER GEL is a category total")
 * and wide-format shape.
 *
 * Tests run against the pure `buildDeckPlannerUserPrompt` function so we
 * don't need to invoke the LLM. The caller-side wiring
 * (`buildAndVerifyDeckPlan` resolving session context from the chat
 * doc) is verified separately by the WEXP-13 golden fixture passing.
 */

const minimalDashboard: Dashboard = {
  id: "dash_test",
  sessionId: "sess_test",
  username: "test@test.test",
  title: "Test Dashboard",
  fileName: "test.csv",
  charts: [],
  sheets: [
    {
      id: "sheet_0",
      name: "Overview",
      orderIndex: 0,
      chartIndices: [],
    },
  ],
  createdAt: 1_730_000_000_000,
  updatedAt: 1_730_000_000_000,
} as unknown as Dashboard;

describe("Wave B6 · deck planner user prompt — optional ambient-context blocks", () => {
  it("USER PREFERENCES block appears when permanentContext is set", () => {
    const inputs: DeckPlannerInputs = {
      dashboard: minimalDashboard,
      permanentContext:
        "always include the cost-of-goods caveat in exec summaries; flag Q1 data quality issues",
    };
    const prompt = buildDeckPlannerUserPrompt(inputs);
    assert.match(prompt, /USER PREFERENCES/);
    assert.ok(prompt.includes("cost-of-goods caveat"));
  });

  it("DIMENSION HIERARCHIES block appears when hierarchies are declared", () => {
    const inputs: DeckPlannerInputs = {
      dashboard: minimalDashboard,
      dimensionHierarchies: [
        {
          column: "Products",
          rollupValue: "FEMALE SHOWER GEL",
          itemValues: ["MARICO", "PURITE", "OLIV", "LASHE"],
          description: "Female shower gel category, sub-brands within",
          source: "user",
        },
      ],
    };
    const prompt = buildDeckPlannerUserPrompt(inputs);
    assert.match(prompt, /DIMENSION HIERARCHIES/);
    assert.ok(prompt.includes("FEMALE SHOWER GEL"));
    assert.ok(prompt.includes("MARICO"));
    // Critical: tells the planner what NOT to do (treat rollup as peer).
    assert.ok(prompt.includes("category totals"));
  });

  it("DATASET SHAPE block appears when wideFormatShape.detected is true", () => {
    const inputs: DeckPlannerInputs = {
      dashboard: minimalDashboard,
      wideFormatShape: {
        detected: true,
        shape: "compound",
        periodColumn: "Period",
        periodIsoColumn: "PeriodIso",
        valueColumn: "Value",
        metricColumn: "Metric",
        meltedColumns: [
          "Q1 24 Value Sales",
          "Q1 24 Volume",
          "Q2 24 Value Sales",
          "Q2 24 Volume",
        ],
      },
    };
    const prompt = buildDeckPlannerUserPrompt(inputs);
    assert.match(prompt, /DATASET SHAPE/);
    assert.ok(prompt.includes("post-melt"));
    assert.ok(prompt.includes("compound"));
    // Critical: tells the planner the original wide names are dead.
    assert.ok(prompt.includes("NO LONGER EXIST"));
    assert.ok(prompt.includes("Q1 24 Value Sales"));
  });

  it("DATASET SHAPE block stays out when wideFormatShape.detected is false", () => {
    const inputs: DeckPlannerInputs = {
      dashboard: minimalDashboard,
      wideFormatShape: { detected: false },
    };
    const prompt = buildDeckPlannerUserPrompt(inputs);
    assert.ok(!prompt.includes("DATASET SHAPE"));
  });

  it("absent context blocks DO NOT leak (clean baseline matches pre-B6 behavior)", () => {
    const inputs: DeckPlannerInputs = {
      dashboard: minimalDashboard,
    };
    const prompt = buildDeckPlannerUserPrompt(inputs);
    assert.ok(!prompt.includes("USER PREFERENCES"));
    assert.ok(!prompt.includes("DIMENSION HIERARCHIES"));
    assert.ok(!prompt.includes("DATASET SHAPE"));
  });

  it("all three blocks together — well-formed and contains the closing 'Compose the SlideDeckPlan' rule reminder", () => {
    const inputs: DeckPlannerInputs = {
      dashboard: minimalDashboard,
      permanentContext: "flag Q1",
      dimensionHierarchies: [
        { column: "Products", rollupValue: "ALL", source: "user" },
      ],
      wideFormatShape: { detected: true, shape: "pure_period" },
    };
    const prompt = buildDeckPlannerUserPrompt(inputs);
    assert.ok(prompt.includes("USER PREFERENCES"));
    assert.ok(prompt.includes("DIMENSION HIERARCHIES"));
    assert.ok(prompt.includes("DATASET SHAPE"));
    // The 'Compose the SlideDeckPlan now' rule block must still be at the end.
    assert.ok(prompt.includes("Compose the SlideDeckPlan now"));
    assert.ok(prompt.includes("Methodology in the back third"));
  });
});
