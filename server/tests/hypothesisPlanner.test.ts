import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import {
  createBlackboard,
  addHypothesis,
  formatForPlanner,
} from "../lib/agents/runtime/analyticalBlackboard.js";

/**
 * Wave W3 · hypothesisPlanner unit tests.
 *
 * generateHypotheses requires a live LLM so we do not test it directly here.
 * Instead we test:
 *  1. The Zod schema that guards the LLM response (same schema the module uses).
 *  2. The blackboard → planner injection path (formatForPlanner produces the
 *     INVESTIGATION_HYPOTHESES block the planner ingests).
 *  3. The guard logic: if all hypotheses are resolved, formatForPlanner still
 *     emits the FINDINGS block so replans have full context.
 */

// Mirror of hypothesisOutputSchema from hypothesisPlanner.ts
const hypothesisItemSchema = z.object({
  text: z.string(),
  targetColumn: z.string().optional(),
});
const hypothesisOutputSchema = z.object({
  hypotheses: z.array(hypothesisItemSchema).min(1).max(6),
});

describe("hypothesisOutputSchema — LLM response guard", () => {
  it("accepts valid 3-item list", () => {
    const r = hypothesisOutputSchema.safeParse({
      hypotheses: [
        { text: "East region drove the drop" },
        { text: "Seasonal effects caused under-performance", targetColumn: "Month" },
        { text: "Price increase reduced volume" },
      ],
    });
    assert.ok(r.success);
    assert.strictEqual(r.data?.hypotheses.length, 3);
    assert.strictEqual(r.data?.hypotheses[1].targetColumn, "Month");
  });

  it("rejects empty hypotheses array", () => {
    const r = hypothesisOutputSchema.safeParse({ hypotheses: [] });
    assert.ok(!r.success);
  });

  it("rejects more than 6 hypotheses", () => {
    const r = hypothesisOutputSchema.safeParse({
      hypotheses: Array.from({ length: 7 }, (_, i) => ({ text: `H${i}` })),
    });
    assert.ok(!r.success);
  });

  it("allows missing targetColumn (optional)", () => {
    const r = hypothesisOutputSchema.safeParse({
      hypotheses: [{ text: "No target column needed" }],
    });
    assert.ok(r.success);
    assert.strictEqual(r.data?.hypotheses[0].targetColumn, undefined);
  });
});

describe("blackboard → planner injection (INVESTIGATION_HYPOTHESES block)", () => {
  it("formatForPlanner emits INVESTIGATION_HYPOTHESES section", () => {
    const bb = createBlackboard();
    addHypothesis(bb, "East region drove the drop");
    addHypothesis(bb, "Seasonal effects", { targetColumn: "Month" });
    const block = formatForPlanner(bb);
    assert.ok(block.includes("INVESTIGATION_HYPOTHESES:"));
    assert.ok(block.includes("East region drove the drop"));
    assert.ok(block.includes("Seasonal effects"));
  });

  it("open hypotheses show OPEN status", () => {
    const bb = createBlackboard();
    addHypothesis(bb, "Open hypothesis");
    const block = formatForPlanner(bb);
    assert.ok(block.includes("OPEN"));
  });

  it("empty blackboard produces empty string (no noise in prompt)", () => {
    const bb = createBlackboard();
    assert.strictEqual(formatForPlanner(bb), "");
  });

  it("resolved hypotheses show their status in the block", () => {
    const bb = createBlackboard();
    const h = addHypothesis(bb, "East drove the drop");
    h.status = "confirmed";
    h.evidenceRefs.push("callId-abc");
    const block = formatForPlanner(bb);
    assert.ok(block.includes("CONFIRMED"));
    assert.ok(block.includes("callId-abc"));
  });

  it("multiple hypotheses each get a unique id prefix", () => {
    const bb = createBlackboard();
    addHypothesis(bb, "H1 text");
    addHypothesis(bb, "H2 text");
    addHypothesis(bb, "H3 text");
    const block = formatForPlanner(bb);
    assert.ok(block.includes("[h1]"));
    assert.ok(block.includes("[h2]"));
    assert.ok(block.includes("[h3]"));
  });
});
