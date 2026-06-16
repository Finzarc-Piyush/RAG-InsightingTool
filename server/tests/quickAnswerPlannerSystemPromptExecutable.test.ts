/**
 * Executable companion to quickAnswerPlanner.test.ts's source-level check
 * ("the system prompt mentions user notes / domain knowledge / prior-
 * investigations rules"), which asserts via readFileSync + src.includes(...).
 *
 * This version proves the same contract by EXECUTING runQuickLookupPlanner
 * through the hermetic LLM stub and inspecting the SYSTEM message the planner
 * actually sends. That is strictly stronger than a source grep: it confirms the
 * rule lines reach the model at call time, not merely that the bytes exist
 * somewhere in the .ts file.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { runQuickLookupPlanner } from "../lib/agents/runtime/quickAnswerPlanner.js";
import { installLlmStub, clearLlmStub } from "./helpers/llmStub.js";
import { LLM_PURPOSE } from "../lib/agents/runtime/llmCallPurpose.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { DataSummary } from "../shared/schema.js";

const baseSummary: DataSummary = {
  rowCount: 100,
  columnCount: 2,
  numericColumns: ["Sales"],
  dateColumns: [],
  columns: [
    {
      name: "State",
      type: "string",
      sampleValues: ["CA", "TX"],
      topValues: [{ value: "CA", count: 40 }, { value: "TX", count: 30 }],
    },
    { name: "Sales", type: "number", sampleValues: [100, 200] },
  ],
};

function makeCtx(): AgentExecutionContext {
  return {
    sessionId: "test-session",
    question: "top 10 states by sales",
    data: [
      { State: "CA", Sales: 100 },
      { State: "TX", Sales: 200 },
    ],
    summary: baseSummary,
    chatHistory: [],
    mode: "analysis",
  } as AgentExecutionContext;
}

afterEach(() => {
  clearLlmStub();
});

describe("quickAnswerPlanner (executable) · system prompt carries the context-block rules", () => {
  it("the SYSTEM message sent to the model references user-notes, domain-knowledge, and prior-investigations rules", async () => {
    let lastSystem = "";
    installLlmStub({
      [LLM_PURPOSE.QUICK_LOOKUP_PLANNER]: (params) => {
        const msgs =
          (params.messages as Array<{ role: string; content: string }>) ?? [];
        lastSystem = msgs.find((m) => m.role === "system")?.content ?? "";
        return {
          plan: {
            groupBy: ["State"],
            aggregations: [
              { column: "Sales", operation: "sum", alias: "Total Sales" },
            ],
            limit: 10,
          },
          questionRestated: "Top 10 states by Sales",
        };
      },
    });

    const out = await runQuickLookupPlanner(makeCtx(), { turnId: "exec-sys" });
    assert.ok(out, "planner should produce a plan via the stub");

    assert.ok(lastSystem.length > 0, "a system message should be sent");
    assert.ok(
      lastSystem.includes("User-provided notes block"),
      "system prompt must reference the user-notes rule",
    );
    assert.ok(
      lastSystem.includes("Domain knowledge block"),
      "system prompt must reference the domain-knowledge rule",
    );
    assert.ok(
      lastSystem.includes("Prior investigations block"),
      "system prompt must reference the prior-investigations rule",
    );
  });
});
