/**
 * Wave W25 · chat.service workbench parity
 *
 * Confirms that the non-streaming code path now accumulates workbench
 * entries (W10) and that an `onAgentEvent` listener attached to the agent
 * loop's `safeEmit` produces the same shape `agentSseEventToWorkbenchEntries`
 * does in the streaming path. We don't drive `chat.service` end-to-end here
 * (that would require Cosmos + many service mocks); instead we verify the
 * behaviour that wave introduced: an in-memory accumulator that any caller
 * can install on `agentOpts.onAgentEvent` and rely on for parity.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentWorkbenchEntry } from "../shared/schema.js";

process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { agentSseEventToWorkbenchEntries, appendWorkbenchEntry } = await import(
  "../services/chat/agentWorkbench.util.js"
);

describe("W25 · workbench accumulator parity", () => {
  it("collects entries from a typical event sequence (plan → tool_call → tool_result → critic_verdict)", () => {
    const workbench: AgentWorkbenchEntry[] = [];
    const onAgentEvent = (event: string, data: unknown) => {
      for (const entry of agentSseEventToWorkbenchEntries(event, data)) {
        appendWorkbenchEntry(workbench, entry);
      }
    };

    onAgentEvent("plan", {
      rationale: "Pivot Saffola sales by Region first.",
      steps: [{ id: "s1", tool: "execute_query_plan", args_summary: "{}" }],
    });
    onAgentEvent("tool_call", {
      id: "c1",
      name: "execute_query_plan",
      args_summary: '{"metric":"Volume_MT"}',
    });
    onAgentEvent("tool_result", {
      id: "c1",
      ok: true,
      summary: "Aggregated 1,240 rows across 6 brands.",
    });
    onAgentEvent("critic_verdict", {
      stepId: "final",
      verdict: "pass",
      issue_codes: [],
    });

    assert.equal(workbench.length, 4);
    assert.deepEqual(
      workbench.map((w) => w.kind),
      ["plan", "tool_call", "tool_result", "critic"]
    );

    // W10 · every accumulated entry carries a deterministic insight.
    for (const entry of workbench) {
      assert.ok(entry.insight && entry.insight.length > 0, `kind=${entry.kind} missing insight`);
    }
    assert.match(workbench[0].insight!, /Pivot Saffola sales by Region first/);
    assert.match(workbench[2].insight!, /Aggregated 1,240 rows/);
  });

  it("filters non-final critic verdicts by default (matches streaming path's gating)", () => {
    const prev = process.env.AGENT_SSE_CRITIC_FINAL_ONLY;
    delete process.env.AGENT_SSE_CRITIC_FINAL_ONLY;
    const workbench: AgentWorkbenchEntry[] = [];
    const onAgentEvent = (event: string, data: unknown) => {
      for (const entry of agentSseEventToWorkbenchEntries(event, data)) {
        appendWorkbenchEntry(workbench, entry);
      }
    };
    onAgentEvent("critic_verdict", {
      stepId: "step-1",
      verdict: "pass",
    });
    assert.equal(workbench.length, 0, "non-final critic verdict skipped by default");
    if (prev !== undefined) process.env.AGENT_SSE_CRITIC_FINAL_ONLY = prev;
  });

  it("appendWorkbenchEntry caps at 48 entries (FIFO)", () => {
    const workbench: AgentWorkbenchEntry[] = [];
    for (let i = 0; i < 60; i++) {
      appendWorkbenchEntry(workbench, {
        id: `e${i}`,
        kind: "tool_call",
        title: `Tool: x${i}`,
        code: "{}",
      });
    }
    assert.equal(workbench.length, 48);
    // Earliest evicted: first kept is e12 (60 - 48 = 12 dropped).
    assert.equal(workbench[0].id, "e12");
    assert.equal(workbench[47].id, "e59");
  });
});
