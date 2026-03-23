import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  plannerOutputSchema,
  reflectorOutputSchema,
  verifierOutputSchema,
  agentPlanEventSchema,
  agentCriticVerdictEventSchema,
} from "../lib/agents/runtime/schemas.js";
import {
  isAgenticLoopEnabled,
  isAgenticStrictEnabled,
  loadAgentConfigFromEnv,
} from "../lib/agents/runtime/types.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import {
  formatUserAndSessionJsonBlocks,
  appendixForReflectorPrompt,
} from "../lib/agents/runtime/context.js";

describe("agent runtime schemas (golden JSON)", () => {
  it("parses planner output", () => {
    const j = {
      rationale: "Use schema then analytical query",
      steps: [
        { id: "1", tool: "get_schema_summary", args: {} },
        { id: "2", tool: "run_analytical_query", args: { question_override: "total sales" } },
      ],
    };
    const p = plannerOutputSchema.safeParse(j);
    assert.ok(p.success, p.success ? "" : String(p.error));
  });

  it("parses planner output with dependsOn for chained steps", () => {
    const p = plannerOutputSchema.safeParse({
      rationale: "RAG then chart using discovered columns",
      steps: [
        { id: "r1", tool: "retrieve_semantic_context", args: { query: "regions" } },
        {
          id: "c1",
          tool: "build_chart",
          args: { type: "bar", x: "Region", y: "Sales" },
          dependsOn: "r1",
        },
      ],
    });
    assert.ok(p.success, p.success ? "" : String(p.error));
  });

  it("parses reflector output", () => {
    const p = reflectorOutputSchema.safeParse({
      action: "finish",
      note: "Enough data",
    });
    assert.ok(p.success);
  });

  it("parses verifier output", () => {
    const p = verifierOutputSchema.safeParse({
      verdict: "pass",
      issues: [],
      course_correction: "pass",
    });
    assert.ok(p.success);
  });

  it("parses SSE-shaped payloads", () => {
    assert.ok(
      agentPlanEventSchema.safeParse({
        rationale: "r",
        steps: [{ id: "1", tool: "get_schema_summary", args_summary: "{}" }],
      }).success
    );
    assert.ok(
      agentCriticVerdictEventSchema.safeParse({
        stepId: "1",
        verdict: "pass",
        issue_codes: [],
        course_correction: "pass",
      }).success
    );
  });
});

describe("agent config env defaults", () => {
  it("loadAgentConfigFromEnv returns finite numbers", () => {
    const c = loadAgentConfigFromEnv();
    assert.ok(c.maxSteps > 0);
    assert.ok(c.maxWallTimeMs > 0);
    assert.ok(!isAgenticLoopEnabled() || process.env.AGENTIC_LOOP_ENABLED === "true");
    assert.ok(!isAgenticStrictEnabled() || process.env.AGENTIC_STRICT === "true");
  });
});

function minimalExecCtx(
  overrides: Partial<AgentExecutionContext> = {}
): AgentExecutionContext {
  return {
    sessionId: "s1",
    question: "What is total?",
    data: [],
    summary: {
      rowCount: 10,
      columnCount: 2,
      columns: [
        { name: "Region", type: "string", sampleValues: ["A"] },
        { name: "Sales", type: "number", sampleValues: [1] },
      ],
      numericColumns: ["Sales"],
      dateColumns: [],
    },
    chatHistory: [],
    mode: "analysis",
    permanentContext: "Focus on Q4",
    sessionAnalysisContext: {
      version: 1,
      dataset: {
        shortDescription: "Sales by region",
        columnRoles: [],
        caveats: [],
      },
      userIntent: { interpretedConstraints: [] },
      sessionKnowledge: { facts: [], analysesDone: [] },
      suggestedFollowUps: ["Trend by month?"],
      lastUpdated: { reason: "seed", at: "2025-01-01T00:00:00.000Z" },
    },
    ...overrides,
  };
}

describe("context appendix for reflector / planner", () => {
  it("formatUserAndSessionJsonBlocks includes user notes and JSON label", () => {
    const ctx = minimalExecCtx();
    const s = formatUserAndSessionJsonBlocks(ctx, {
      maxUserChars: 6000,
      maxJsonChars: 12000,
    });
    assert.ok(s.includes("User-provided notes"));
    assert.ok(s.includes("Focus on Q4"));
    assert.ok(s.includes("SessionAnalysisContextJSON"));
    assert.ok(s.includes("Sales by region"));
  });

  it("appendixForReflectorPrompt truncates long user notes", () => {
    const longNote = "x".repeat(5000);
    const ctx = minimalExecCtx({ permanentContext: longNote });
    const a = appendixForReflectorPrompt(ctx);
    assert.ok(a.includes("User-provided notes"));
    assert.ok(!a.includes("xxxx".repeat(1000)));
    assert.ok(a.length < longNote.length + 500);
  });
});
