import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createBlackboard,
  addHypothesis,
  resolveHypothesis,
  addFinding,
  addOpenQuestion,
  markQuestionActioned,
} from "../lib/agents/runtime/analyticalBlackboard.js";
import { buildInvestigationSummary } from "../lib/agents/runtime/buildInvestigationSummary.js";
import { investigationSummarySchema, messageSchema } from "../shared/schema.js";

describe("W13 · buildInvestigationSummary", () => {
  it("returns undefined for a totally empty blackboard", () => {
    const out = buildInvestigationSummary(createBlackboard());
    assert.equal(out, undefined);
  });

  it("returns undefined when blackboard is undefined", () => {
    assert.equal(buildInvestigationSummary(undefined), undefined);
  });

  it("includes hypothesis status + evidence count", () => {
    const bb = createBlackboard();
    const h1 = addHypothesis(bb, "MT erosion is brand-specific to Saffola edible oils.");
    const h2 = addHypothesis(bb, "Channel-mix shift toward GT explains the volume drop.");
    resolveHypothesis(bb, h1.id, "confirmed", "tool:execute_query_plan:1");
    resolveHypothesis(bb, h1.id, "confirmed", "tool:execute_query_plan:2");
    resolveHypothesis(bb, h2.id, "refuted", "tool:execute_query_plan:3");

    const out = buildInvestigationSummary(bb);
    assert.ok(out);
    assert.equal(out.hypotheses?.length, 2);
    const confirmed = out.hypotheses?.find((h) => h.text.includes("MT erosion"));
    assert.equal(confirmed?.status, "confirmed");
    assert.equal(confirmed?.evidenceCount, 2);
    const refuted = out.hypotheses?.find((h) => h.text.includes("Channel-mix"));
    assert.equal(refuted?.status, "refuted");
    assert.equal(refuted?.evidenceCount, 1);
  });

  it("sorts findings by significance (anomalous → notable → routine)", () => {
    const bb = createBlackboard();
    addFinding(bb, { sourceRef: "x", label: "Routine fact A", significance: "routine" });
    addFinding(bb, { sourceRef: "y", label: "Anomalous spike in East-MT", significance: "anomalous" });
    addFinding(bb, { sourceRef: "z", label: "Notable: Saffola pack-mix shift", significance: "notable" });

    const out = buildInvestigationSummary(bb);
    assert.ok(out);
    assert.equal(out.findings?.[0].label, "Anomalous spike in East-MT");
    assert.equal(out.findings?.[1].label, "Notable: Saffola pack-mix shift");
    assert.equal(out.findings?.[2].label, "Routine fact A");
  });

  it("filters out actioned open questions", () => {
    const bb = createBlackboard();
    addOpenQuestion(bb, "Does South-region distributor stockout explain the dip?", "anomaly", { priority: "high" });
    const q2 = addOpenQuestion(bb, "Did festive timing shift?", "context", { priority: "medium" });
    markQuestionActioned(bb, q2.id, "node-2");

    const out = buildInvestigationSummary(bb);
    assert.equal(out?.openQuestions?.length, 1);
    assert.match(out!.openQuestions![0].question, /distributor stockout/);
  });

  it("output validates against investigationSummarySchema", () => {
    const bb = createBlackboard();
    const h = addHypothesis(bb, "Saffola lost share due to pack downsizing");
    resolveHypothesis(bb, h.id, "partial", "tool:1");
    addFinding(bb, { sourceRef: "tool:1", label: "1L SKU volume −12% MoM", significance: "anomalous" });
    addOpenQuestion(bb, "Was promo depth different in MT vs GT?", "context", { priority: "medium" });

    const summary = buildInvestigationSummary(bb)!;
    const parsed = investigationSummarySchema.parse(summary);
    assert.deepEqual(parsed, summary);
  });

  it("messageSchema accepts an investigationSummary field", () => {
    const m = {
      role: "assistant",
      content: "x",
      timestamp: Date.now(),
      investigationSummary: {
        hypotheses: [
          { text: "Hypothesis text", status: "confirmed" as const, evidenceCount: 2 },
        ],
        findings: [{ label: "Notable finding", significance: "notable" as const }],
      },
    };
    const parsed = messageSchema.parse(m);
    assert.equal(parsed.investigationSummary?.hypotheses?.[0].evidenceCount, 2);
  });

  it("messageSchema parses legacy messages without investigationSummary", () => {
    const legacy = { role: "assistant", content: "x", timestamp: Date.now() };
    const parsed = messageSchema.parse(legacy);
    assert.equal(parsed.investigationSummary, undefined);
  });

  it("clips overly long hypothesis text and truncates with ellipsis", () => {
    const bb = createBlackboard();
    const long = "a".repeat(400);
    addHypothesis(bb, long);
    const out = buildInvestigationSummary(bb);
    assert.ok(out);
    assert.equal(out.hypotheses?.[0].text.length, 280);
    assert.match(out.hypotheses![0].text, /…$/);
  });
});
