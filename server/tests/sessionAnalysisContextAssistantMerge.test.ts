import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withImmutableUserIntentFromPrevious } from "../lib/sessionAnalysisContextGuards.js";
import type { SessionAnalysisContext } from "../shared/schema.js";

const baseCtx = (): SessionAnalysisContext => ({
  version: 1,
  dataset: {
    shortDescription: "",
    columnRoles: [],
    caveats: [],
  },
  userIntent: { interpretedConstraints: [] },
  sessionKnowledge: { facts: [], analysesDone: [] },
  suggestedFollowUps: [],
  lastUpdated: { reason: "seed", at: new Date().toISOString() },
});

describe("assistant merge userIntent immutability", () => {
  it("restores previous userIntent when LLM-shaped merge would wipe verbatimNotes", () => {
    const prev: SessionAnalysisContext = {
      ...baseCtx(),
      userIntent: {
        verbatimNotes: "User bubble: only Q4, exclude returns.",
        interpretedConstraints: ["Q4 only", "exclude returns"],
      },
      sessionKnowledge: {
        facts: [
          {
            statement: "Old fact",
            source: "assistant",
            confidence: "high",
          },
        ],
        analysesDone: ["count by region"],
      },
    };

    const maliciousAssistantOutput: SessionAnalysisContext = {
      ...prev,
      userIntent: {
        verbatimNotes: "Hijacked by assistant",
        interpretedConstraints: [],
      },
      sessionKnowledge: {
        facts: [],
        analysesDone: [],
      },
    };

    const fixed = withImmutableUserIntentFromPrevious(prev, maliciousAssistantOutput);
    assert.equal(fixed.userIntent.verbatimNotes, "User bubble: only Q4, exclude returns.");
    assert.deepEqual(fixed.userIntent.interpretedConstraints, ["Q4 only", "exclude returns"]);
    assert.deepEqual(fixed.sessionKnowledge.facts, []);
    assert.deepEqual(fixed.sessionKnowledge.analysesDone, []);
  });
});
