import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import {
  createBlackboard,
  addFinding,
  addHypothesis,
  resolveHypothesis,
  addDomainContext,
  formatForNarrator,
  shouldUseNarrator,
} from "../lib/agents/runtime/analyticalBlackboard.js";

/**
 * Wave W5 · narratorAgent unit tests.
 *
 * runNarrator requires a live LLM. We test:
 *  1. shouldUseNarrator — the gate condition.
 *  2. The Zod schema (narratorOutputSchema) applied to sample LLM outputs.
 *  3. The formatForNarrator block that feeds the narrator's user prompt.
 */

// Mirror of narratorOutputSchema from narratorAgent.ts
const narratorOutputSchema = z.object({
  body: z.string(),
  keyInsight: z.string().nullable().optional(),
  ctas: z.array(z.string()).default([]),
  magnitudes: z
    .array(
      z.object({
        label: z.string(),
        value: z.string(),
        confidence: z.enum(["low", "medium", "high"]).optional(),
      })
    )
    .optional(),
  unexplained: z.string().optional(),
});

describe("shouldUseNarrator", () => {
  it("returns false when blackboard has no findings", () => {
    const bb = createBlackboard();
    addHypothesis(bb, "H1");
    assert.strictEqual(shouldUseNarrator(bb), false);
  });

  it("returns false when blackboard has no hypotheses", () => {
    const bb = createBlackboard();
    addFinding(bb, { sourceRef: "c1", label: "F1", detail: "d" });
    assert.strictEqual(shouldUseNarrator(bb), false);
  });

  it("returns false for empty blackboard", () => {
    const bb = createBlackboard();
    assert.strictEqual(shouldUseNarrator(bb), false);
  });

  it("returns true when both hypotheses and findings exist", () => {
    const bb = createBlackboard();
    addHypothesis(bb, "H1");
    addFinding(bb, { sourceRef: "c1", label: "F1", detail: "detail" });
    assert.strictEqual(shouldUseNarrator(bb), true);
  });

  it("returns true even when all hypotheses are still open", () => {
    const bb = createBlackboard();
    addHypothesis(bb, "H still open");
    addFinding(bb, { sourceRef: "c1", label: "Preliminary finding", detail: "d" });
    assert.strictEqual(shouldUseNarrator(bb), true);
  });
});

describe("narratorOutputSchema — LLM response guard", () => {
  it("accepts minimal valid output (body + ctas only)", () => {
    const r = narratorOutputSchema.safeParse({
      body: "East region drove the March drop by -23%.",
      ctas: ["Break down by category", "Compare vs last year"],
    });
    assert.ok(r.success);
    assert.strictEqual(r.data?.ctas.length, 2);
  });

  it("accepts null keyInsight", () => {
    const r = narratorOutputSchema.safeParse({
      body: "Flat trend observed.",
      keyInsight: null,
      ctas: [],
    });
    assert.ok(r.success);
    assert.strictEqual(r.data?.keyInsight, null);
  });

  it("accepts magnitudes array", () => {
    const r = narratorOutputSchema.safeParse({
      body: "March spike.",
      ctas: [],
      magnitudes: [
        { label: "East tech decline", value: "-23.4%", confidence: "high" },
        { label: "National avg", value: "+2.1%" },
      ],
    });
    assert.ok(r.success);
    assert.strictEqual(r.data?.magnitudes?.length, 2);
    assert.strictEqual(r.data?.magnitudes?.[0].confidence, "high");
    assert.strictEqual(r.data?.magnitudes?.[1].confidence, undefined);
  });

  it("rejects missing body field", () => {
    const r = narratorOutputSchema.safeParse({ ctas: [] });
    assert.ok(!r.success);
  });

  it("defaults ctas to empty array when omitted", () => {
    const r = narratorOutputSchema.safeParse({ body: "Answer here." });
    assert.ok(r.success);
    assert.deepStrictEqual(r.data?.ctas, []);
  });
});

describe("formatForNarrator — narrator prompt block", () => {
  it("includes HYPOTHESIS_OUTCOMES section", () => {
    const bb = createBlackboard();
    const h = addHypothesis(bb, "East region drove the drop");
    resolveHypothesis(bb, h.id, "confirmed", "callId-abc");
    addFinding(bb, { sourceRef: "callId-abc", label: "East -23%", detail: "detail" });
    const block = formatForNarrator(bb);
    assert.ok(block.includes("HYPOTHESIS_OUTCOMES:"));
    assert.ok(block.includes("CONFIRMED"));
    assert.ok(block.includes("East region drove the drop"));
  });

  it("sorts anomalous findings before routine in narrator block", () => {
    const bb = createBlackboard();
    addHypothesis(bb, "H1");
    addFinding(bb, { sourceRef: "c1", label: "Routine", detail: "d", significance: "routine" });
    addFinding(bb, { sourceRef: "c2", label: "Anomaly", detail: "d", significance: "anomalous" });
    const block = formatForNarrator(bb);
    assert.ok(block.indexOf("Anomaly") < block.indexOf("Routine"));
  });

  it("includes DOMAIN_CONTEXT when present", () => {
    const bb = createBlackboard();
    addHypothesis(bb, "H1");
    addFinding(bb, { sourceRef: "c1", label: "F1", detail: "d" });
    addDomainContext(bb, "Nielsen urban/rural context", "rag_round2");
    const block = formatForNarrator(bb);
    assert.ok(block.includes("DOMAIN_CONTEXT:"));
    assert.ok(block.includes("Nielsen urban/rural context"));
  });

  it("returns empty string for empty blackboard", () => {
    const bb = createBlackboard();
    assert.strictEqual(formatForNarrator(bb), "");
  });
});
