import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSynthesisContext,
  formatSynthesisContextBundle,
} from "../lib/agents/runtime/buildSynthesisContext.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { DataSummary } from "../shared/schema.js";

/**
 * Wave B7 · Pins that `buildUserBlock` (inside `buildSynthesisContext`)
 * always surfaces `userIntent.verbatimNotes` and `userIntent.interpretedConstraints`
 * when they exist on the session.
 *
 * Pre-B7 the narrator only saw these if the hypothesis planner happened
 * to encode them in the blackboard. When the blackboard was empty
 * (synthesis-fallback path) or thin (single-tool turn), the constraints
 * were lost — and the narrator could emit findings that violated user-
 * stated rules. Now they ALWAYS appear, regardless of the blackboard
 * state.
 */

const baseSummary: DataSummary = {
  rowCount: 100,
  columnCount: 3,
  numericColumns: ["Sales"],
  dateColumns: [],
  columns: [
    { name: "State", type: "string", sampleValues: ["CA", "TX"] },
    { name: "Sales", type: "number", sampleValues: [100, 200] },
  ],
};

function makeCtx(overrides: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
  return {
    sessionId: "sess",
    question: "what's our sales trend",
    data: [],
    summary: baseSummary,
    chatHistory: [],
    mode: "analysis",
    username: "test@test",
    ...overrides,
  };
}

describe("Wave B7 · userIntent surfaces in synthesis user block", () => {
  it("verbatimNotes appears under 'User-stated intent (verbatim …)'", () => {
    const ctx = makeCtx({
      sessionAnalysisContext: {
        dataset: { columnRoles: [], caveats: [] },
        userIntent: {
          verbatimNotes:
            "We're focusing on Q4 metro stores; exclude e-commerce; flag any double-counted SKUs",
          interpretedConstraints: [],
        },
        sessionKnowledge: { facts: [], analysesDone: [] },
        suggestedFollowUps: [],
        lastUpdated: { reason: "test", at: "2026-05-15T10:00:00Z" },
        version: 1,
      } as AgentExecutionContext["sessionAnalysisContext"],
    });
    const bundle = buildSynthesisContext(ctx, { ragHits: [] });
    assert.ok(bundle.userBlock);
    assert.ok(
      bundle.userBlock.includes("User-stated intent (verbatim"),
      "expected the verbatim-intent label"
    );
    assert.ok(
      bundle.userBlock.includes("double-counted SKUs"),
      "expected verbatim content in user block"
    );
  });

  it("interpretedConstraints appears as bulleted list under 'User-stated constraints'", () => {
    const ctx = makeCtx({
      sessionAnalysisContext: {
        dataset: { columnRoles: [], caveats: [] },
        userIntent: {
          verbatimNotes: "",
          interpretedConstraints: [
            "Q4 2024 only",
            "metro stores only — exclude rural and e-commerce",
            "MARICO and PARACHUTE brands",
          ],
        },
        sessionKnowledge: { facts: [], analysesDone: [] },
        suggestedFollowUps: [],
        lastUpdated: { reason: "test", at: "2026-05-15T10:00:00Z" },
        version: 1,
      } as AgentExecutionContext["sessionAnalysisContext"],
    });
    const bundle = buildSynthesisContext(ctx, { ragHits: [] });
    assert.ok(
      bundle.userBlock.includes("User-stated constraints"),
      "expected the constraints label"
    );
    assert.ok(
      bundle.userBlock.includes("metro stores only"),
      "expected constraint content as bullet"
    );
    assert.ok(
      bundle.userBlock.includes("PARACHUTE"),
      "expected all listed constraints in bullets"
    );
  });

  it("both verbatim AND constraints together — both appear in the user block", () => {
    const ctx = makeCtx({
      sessionAnalysisContext: {
        dataset: { columnRoles: [], caveats: [] },
        userIntent: {
          verbatimNotes: "Quarterly review",
          interpretedConstraints: ["Q4 2024", "exclude internal"],
        },
        sessionKnowledge: { facts: [], analysesDone: [] },
        suggestedFollowUps: [],
        lastUpdated: { reason: "test", at: "2026-05-15T10:00:00Z" },
        version: 1,
      } as AgentExecutionContext["sessionAnalysisContext"],
    });
    const bundle = buildSynthesisContext(ctx, { ragHits: [] });
    assert.ok(bundle.userBlock.includes("Quarterly review"));
    assert.ok(bundle.userBlock.includes("Q4 2024"));
  });

  it("absent userIntent — no leak", () => {
    const ctx = makeCtx({
      sessionAnalysisContext: {
        dataset: { columnRoles: [], caveats: [] },
        userIntent: { interpretedConstraints: [] },
        sessionKnowledge: { facts: [], analysesDone: [] },
        suggestedFollowUps: [],
        lastUpdated: { reason: "test", at: "2026-05-15T10:00:00Z" },
        version: 1,
      } as AgentExecutionContext["sessionAnalysisContext"],
    });
    const bundle = buildSynthesisContext(ctx, { ragHits: [] });
    assert.ok(
      !bundle.userBlock.includes("User-stated intent"),
      "no verbatim-intent label when verbatimNotes empty"
    );
    assert.ok(
      !bundle.userBlock.includes("User-stated constraints"),
      "no constraints label when interpretedConstraints empty"
    );
  });

  it("formatSynthesisContextBundle includes the USER CONTEXT section when userBlock has userIntent", () => {
    const ctx = makeCtx({
      sessionAnalysisContext: {
        dataset: { columnRoles: [], caveats: [] },
        userIntent: {
          verbatimNotes: "Focus on growth segments",
          interpretedConstraints: ["YoY > 5%"],
        },
        sessionKnowledge: { facts: [], analysesDone: [] },
        suggestedFollowUps: [],
        lastUpdated: { reason: "test", at: "2026-05-15T10:00:00Z" },
        version: 1,
      } as AgentExecutionContext["sessionAnalysisContext"],
    });
    const bundle = buildSynthesisContext(ctx, { ragHits: [] });
    const formatted = formatSynthesisContextBundle(bundle);
    assert.match(formatted, /## USER CONTEXT/);
    assert.ok(formatted.includes("Focus on growth segments"));
    assert.ok(formatted.includes("YoY > 5%"));
  });
});
