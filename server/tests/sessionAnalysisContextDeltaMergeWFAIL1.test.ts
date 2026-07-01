import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyAssistantTurnDelta } from "../lib/sessionAnalysisContext.js";
import type { SessionAnalysisContext } from "../shared/schema.js";

/**
 * W-FAIL1 · The assistant-turn merge now uses a small DELTA the mini model can
 * reliably produce, merged deterministically onto the previous context. These
 * cover the merge arithmetic (append/dedup/cap, replace-vs-preserve follow-ups,
 * carry-forward of untouched fields, lastUpdated stamping).
 */

const baseCtx = (): SessionAnalysisContext => ({
  version: 1,
  dataset: {
    shortDescription: "Channel P&L by brand",
    columnRoles: [{ name: "Brand_Code", role: "dimension" }],
    caveats: ["sample only"],
    dimensionHierarchies: [
      { column: "Region", rollupValue: "ALL", source: "user" },
    ],
  },
  userIntent: {
    verbatimNotes: "focus on GT vs Q-com",
    interpretedConstraints: ["GT only"],
  },
  sessionKnowledge: {
    facts: [{ statement: "Existing fact", source: "assistant", confidence: "medium" }],
    analysesDone: ["count by region"],
    priorInvestigations: [
      { question: "old q", summary: "old summary", at: "2026-06-01T00:00:00.000Z" } as never,
    ],
  },
  suggestedFollowUps: ["What drives NR?"],
  lastUpdated: { reason: "seed", at: "2026-06-01T00:00:00.000Z" },
});

describe("W-FAIL1 applyAssistantTurnDelta", () => {
  it("appends new facts + analyses, dedups case-insensitively, replaces follow-ups", () => {
    const prev = baseCtx();
    const next = applyAssistantTurnDelta(
      prev,
      {
        newFacts: [
          { statement: "PCNO(R) has the largest MRP-NR gap (1.35B)", source: "data", confidence: "high" },
          { statement: "existing FACT", source: "assistant", confidence: "low" }, // dup of "Existing fact"
        ],
        newAnalysesDone: ["brand-level gap between MRP Value and NR", "COUNT BY REGION"],
        suggestedFollowUps: ["Why is PCNO(R) leading?", "sales by cluster or state"],
      },
      false,
    );

    // facts: existing + 1 new (dup dropped)
    assert.equal(next.sessionKnowledge.facts.length, 2);
    assert.ok(next.sessionKnowledge.facts.some((f) => f.statement.includes("1.35B")));
    // analysesDone: existing + 1 new (case-insensitive dup dropped)
    assert.deepEqual(next.sessionKnowledge.analysesDone, [
      "count by region",
      "brand-level gap between MRP Value and NR",
    ]);
    // follow-ups replaced; the "or" question stripped by the guard
    assert.deepEqual(next.suggestedFollowUps, ["Why is PCNO(R) leading?"]);
    // untouched carry-forwards
    assert.deepEqual(next.dataset, prev.dataset);
    assert.deepEqual(next.userIntent, prev.userIntent);
    assert.deepEqual(next.sessionKnowledge.priorInvestigations, prev.sessionKnowledge.priorInvestigations);
    // stamp
    assert.equal(next.lastUpdated.reason, "assistant_turn");
    assert.notEqual(next.lastUpdated.at, prev.lastUpdated.at);
  });

  it("preserves follow-ups when the delta omits them; mid_turn sets reason", () => {
    const prev = baseCtx();
    const next = applyAssistantTurnDelta(prev, { newFacts: [] }, true);
    assert.deepEqual(next.suggestedFollowUps, prev.suggestedFollowUps);
    assert.equal(next.lastUpdated.reason, "mid_turn");
  });

  it("an empty delta loses no prior data (only stamps lastUpdated)", () => {
    const prev = baseCtx();
    const next = applyAssistantTurnDelta(prev, {}, false);
    assert.deepEqual(next.sessionKnowledge.facts, prev.sessionKnowledge.facts);
    assert.deepEqual(next.sessionKnowledge.analysesDone, prev.sessionKnowledge.analysesDone);
    assert.deepEqual(next.suggestedFollowUps, prev.suggestedFollowUps);
  });

  it("FIFO-caps facts at 50, dropping the oldest", () => {
    const prev = baseCtx();
    prev.sessionKnowledge.facts = Array.from({ length: 50 }, (_, i) => ({
      statement: `fact ${i}`,
      source: "assistant" as const,
      confidence: "low" as const,
    }));
    const next = applyAssistantTurnDelta(
      prev,
      { newFacts: [{ statement: "the newest fact", source: "data", confidence: "high" }] },
      false,
    );
    assert.equal(next.sessionKnowledge.facts.length, 50);
    assert.equal(next.sessionKnowledge.facts[0]!.statement, "fact 1"); // "fact 0" dropped
    assert.equal(next.sessionKnowledge.facts[49]!.statement, "the newest fact");
  });
});
