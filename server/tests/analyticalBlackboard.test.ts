import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createBlackboard,
  addHypothesis,
  resolveHypothesis,
  addFinding,
  addOpenQuestion,
  markQuestionActioned,
  addDomainContext,
  isConverged,
  formatForPlanner,
  formatForNarrator,
} from "../lib/agents/runtime/analyticalBlackboard.js";

describe("createBlackboard", () => {
  it("returns empty board with _seq=0", () => {
    const bb = createBlackboard();
    assert.strictEqual(bb.hypotheses.length, 0);
    assert.strictEqual(bb.findings.length, 0);
    assert.strictEqual(bb.openQuestions.length, 0);
    assert.strictEqual(bb.domainContext.length, 0);
    assert.strictEqual(bb._seq, 0);
  });
});

describe("addHypothesis", () => {
  it("assigns sequential id and sets status=open", () => {
    const bb = createBlackboard();
    const h = addHypothesis(bb, "Sales dropped due to East region");
    assert.strictEqual(h.id, "h1");
    assert.strictEqual(h.status, "open");
    assert.strictEqual(h.text, "Sales dropped due to East region");
    assert.strictEqual(bb.hypotheses.length, 1);
  });

  it("accepts optional targetColumn", () => {
    const bb = createBlackboard();
    const h = addHypothesis(bb, "Variance in Units", { targetColumn: "Units" });
    assert.strictEqual(h.targetColumn, "Units");
  });
});

describe("resolveHypothesis", () => {
  it("confirms a hypothesis and adds evidence ref", () => {
    const bb = createBlackboard();
    const h = addHypothesis(bb, "Test hypothesis");
    resolveHypothesis(bb, h.id, "confirmed", "callId-abc");
    assert.strictEqual(h.status, "confirmed");
    assert.deepStrictEqual(h.evidenceRefs, ["callId-abc"]);
  });

  it("returns false for unknown id", () => {
    const bb = createBlackboard();
    const ok = resolveHypothesis(bb, "nonexistent", "refuted", "ref1");
    assert.strictEqual(ok, false);
  });

  it("does not duplicate evidence refs", () => {
    const bb = createBlackboard();
    const h = addHypothesis(bb, "Dup test");
    resolveHypothesis(bb, h.id, "confirmed", "ref1");
    resolveHypothesis(bb, h.id, "confirmed", "ref1");
    assert.strictEqual(h.evidenceRefs.length, 1);
  });
});

describe("addFinding", () => {
  it("defaults significance to routine", () => {
    const bb = createBlackboard();
    const f = addFinding(bb, { sourceRef: "c1", label: "Flat trend", detail: "No change" });
    assert.strictEqual(f.significance, "routine");
    assert.strictEqual(f.id, "f1");
  });

  it("stores anomalous significance", () => {
    const bb = createBlackboard();
    const f = addFinding(bb, {
      sourceRef: "c2",
      label: "March spike",
      detail: "+340% in March",
      significance: "anomalous",
    });
    assert.strictEqual(f.significance, "anomalous");
  });
});

describe("addOpenQuestion", () => {
  it("defaults priority to medium", () => {
    const bb = createBlackboard();
    const q = addOpenQuestion(bb, "What drove March?", "Anomalous spike found");
    assert.strictEqual(q.priority, "medium");
    assert.strictEqual(q.actionedByNodeId, undefined);
  });
});

describe("markQuestionActioned", () => {
  it("sets actionedByNodeId", () => {
    const bb = createBlackboard();
    const q = addOpenQuestion(bb, "Why did East spike?", "found anomaly");
    markQuestionActioned(bb, q.id, "node-42");
    assert.strictEqual(q.actionedByNodeId, "node-42");
  });

  it("returns false for unknown id", () => {
    const bb = createBlackboard();
    assert.strictEqual(markQuestionActioned(bb, "unknown", "node-1"), false);
  });
});

describe("addDomainContext", () => {
  it("stores content with source tag", () => {
    const bb = createBlackboard();
    const dc = addDomainContext(bb, "Nielsen tracks urban/rural split", "rag_round1");
    assert.strictEqual(dc.source, "rag_round1");
    assert.strictEqual(bb.domainContext.length, 1);
  });
});

describe("isConverged", () => {
  it("returns false with no findings", () => {
    const bb = createBlackboard();
    addHypothesis(bb, "Test");
    assert.strictEqual(isConverged(bb), false);
  });

  it("returns false with open hypotheses", () => {
    const bb = createBlackboard();
    addHypothesis(bb, "Open H");
    addFinding(bb, { sourceRef: "c1", label: "F1", detail: "detail" });
    assert.strictEqual(isConverged(bb), false);
  });

  it("returns false with unactioned high-priority question", () => {
    const bb = createBlackboard();
    const h = addHypothesis(bb, "H1");
    resolveHypothesis(bb, h.id, "confirmed", "c1");
    addFinding(bb, { sourceRef: "c1", label: "F1", detail: "d" });
    addOpenQuestion(bb, "Critical gap", "must investigate", { priority: "high" });
    assert.strictEqual(isConverged(bb), false);
  });

  it("returns true when all hypotheses resolved and no unactioned high-priority questions", () => {
    const bb = createBlackboard();
    const h = addHypothesis(bb, "H1");
    resolveHypothesis(bb, h.id, "confirmed", "c1");
    addFinding(bb, { sourceRef: "c1", label: "F1", detail: "d" });
    assert.strictEqual(isConverged(bb), true);
  });

  it("returns true even with actioned high-priority question", () => {
    const bb = createBlackboard();
    const h = addHypothesis(bb, "H1");
    resolveHypothesis(bb, h.id, "confirmed", "c1");
    addFinding(bb, { sourceRef: "c1", label: "F1", detail: "d" });
    const q = addOpenQuestion(bb, "Follow-up", "because", { priority: "high" });
    markQuestionActioned(bb, q.id, "node-99");
    assert.strictEqual(isConverged(bb), true);
  });
});

describe("formatForPlanner", () => {
  it("returns empty string for empty board", () => {
    const bb = createBlackboard();
    assert.strictEqual(formatForPlanner(bb), "");
  });

  it("includes hypothesis status and finding significance", () => {
    const bb = createBlackboard();
    const h = addHypothesis(bb, "East drove drop");
    resolveHypothesis(bb, h.id, "confirmed", "c1");
    addFinding(bb, {
      sourceRef: "c1",
      label: "East -23%",
      detail: "East region fell 23% in March",
      significance: "anomalous",
    });
    const out = formatForPlanner(bb);
    assert.ok(out.includes("CONFIRMED"));
    assert.ok(out.includes("anomalous"));
    assert.ok(out.includes("East -23%"));
  });

  it("omits actioned questions from OPEN_QUESTIONS", () => {
    const bb = createBlackboard();
    const q = addOpenQuestion(bb, "Why East?", "anomaly");
    markQuestionActioned(bb, q.id, "node-1");
    addFinding(bb, { sourceRef: "c1", label: "F1", detail: "d" });
    const out = formatForPlanner(bb);
    assert.ok(!out.includes("Why East?"));
  });
});

describe("formatForNarrator", () => {
  it("sorts findings anomalous first", () => {
    const bb = createBlackboard();
    addFinding(bb, { sourceRef: "c1", label: "Routine finding", detail: "...", significance: "routine" });
    addFinding(bb, { sourceRef: "c2", label: "Anomalous spike", detail: "...", significance: "anomalous" });
    const out = formatForNarrator(bb);
    const iRoutine = out.indexOf("Routine finding");
    const iAnomaly = out.indexOf("Anomalous spike");
    assert.ok(iAnomaly < iRoutine, "anomalous findings should appear before routine ones");
  });

  it("includes domain context", () => {
    const bb = createBlackboard();
    addDomainContext(bb, "Urban/rural split matters", "rag_round2");
    const out = formatForNarrator(bb);
    assert.ok(out.includes("Urban/rural split matters"));
  });
});
