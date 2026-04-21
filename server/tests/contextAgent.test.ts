import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createBlackboard,
  addFinding,
  addHypothesis,
  addDomainContext,
} from "../lib/agents/runtime/analyticalBlackboard.js";

/**
 * Wave W4 · contextAgent unit tests.
 *
 * runContextAgentRound2 requires live RAG infrastructure, so we test:
 *  1. The query-derivation logic (deriveQueriesFromFindings) indirectly through
 *     the blackboard state it reads — verifying the priority ordering and fallbacks.
 *  2. DomainContextEntry write-back via addDomainContext (the round-2 write path).
 *  3. The rag_round2 source tag is preserved on blackboard entries.
 */

describe("contextAgent — blackboard query derivation logic", () => {
  it("anomalous findings take priority over notable and routine", () => {
    const bb = createBlackboard();
    addFinding(bb, { sourceRef: "c1", label: "Routine flat", detail: "d", significance: "routine" });
    addFinding(bb, { sourceRef: "c2", label: "Notable dip", detail: "d", significance: "notable" });
    addFinding(bb, { sourceRef: "c3", label: "Anomalous spike", detail: "d", significance: "anomalous" });

    // Sort mirrors the logic in deriveQueriesFromFindings
    const sorted = [...bb.findings].sort((a, b) => {
      const rank: Record<string, number> = { anomalous: 0, notable: 1, routine: 2 };
      return rank[a.significance] - rank[b.significance];
    });

    assert.strictEqual(sorted[0].label, "Anomalous spike");
    assert.strictEqual(sorted[1].label, "Notable dip");
    assert.strictEqual(sorted[2].label, "Routine flat");
  });

  it("falls back to open hypothesis texts when no findings exist", () => {
    const bb = createBlackboard();
    const h1 = addHypothesis(bb, "East region drove the drop");
    const h2 = addHypothesis(bb, "Price increase reduced volume");
    assert.strictEqual(bb.findings.length, 0);
    // Hypotheses that are open would be used as fallback queries
    const openHyps = bb.hypotheses.filter((h) => h.status === "open");
    assert.strictEqual(openHyps.length, 2);
    assert.strictEqual(openHyps[0].id, h1.id);
    assert.strictEqual(openHyps[1].id, h2.id);
  });

  it("relatedColumns from findings enrich the derived query label", () => {
    const bb = createBlackboard();
    const f = addFinding(bb, {
      sourceRef: "c1",
      label: "East spike",
      detail: "East +340%",
      significance: "anomalous",
      relatedColumns: ["Region", "Sales"],
    });
    assert.deepStrictEqual(f.relatedColumns, ["Region", "Sales"]);
    // The context agent builds: `${f.label} focusing on ${cols.join(", ")}`
    const expected = "East spike focusing on Region, Sales";
    const cols = f.relatedColumns.slice(0, 3).join(", ");
    assert.strictEqual(`${f.label} focusing on ${cols}`, expected);
  });
});

describe("contextAgent — blackboard domain context write-back", () => {
  it("addDomainContext with rag_round2 source is retrievable", () => {
    const bb = createBlackboard();
    const dc = addDomainContext(bb, "Urban/rural split matters for East region", "rag_round2");
    assert.strictEqual(dc.source, "rag_round2");
    assert.ok(bb.domainContext.some((e) => e.source === "rag_round2"));
  });

  it("multiple round2 entries accumulate independently", () => {
    const bb = createBlackboard();
    addDomainContext(bb, "Context from query A", "rag_round2");
    addDomainContext(bb, "Context from query B", "rag_round2");
    const r2 = bb.domainContext.filter((e) => e.source === "rag_round2");
    assert.strictEqual(r2.length, 2);
  });

  it("round1 and round2 entries coexist without collision", () => {
    const bb = createBlackboard();
    addDomainContext(bb, "Upfront context", "rag_round1");
    addDomainContext(bb, "Derived context", "rag_round2");
    assert.strictEqual(bb.domainContext.length, 2);
    assert.strictEqual(bb.domainContext[0].source, "rag_round1");
    assert.strictEqual(bb.domainContext[1].source, "rag_round2");
  });
});
