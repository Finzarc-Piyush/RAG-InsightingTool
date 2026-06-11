import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runSubInvestigation } from "../lib/agents/runtime/investigationOrchestrator.js";
import { createBlackboard } from "../lib/agents/runtime/analyticalBlackboard.js";
import type { AgentExecutionContext, AgentConfig, AgentLoopResult } from "../lib/agents/runtime/types.js";

/**
 * Wave W2 (B3) · runSubInvestigation forwards the sub-turn's charts (previously
 * discarded by investigateNode), shares the parent blackboard, and sets the
 * recursion guard. runAgentTurn is dependency-injected so the test is pure.
 */

const chart = (title: string) =>
  ({ type: "bar", title, x: "Day", y: "Sales", points: [] } as unknown as NonNullable<AgentLoopResult["charts"]>[number]);

const baseCtx = (blackboard: ReturnType<typeof createBlackboard>) =>
  ({ question: "ROOT", blackboard, summary: { columns: [] }, mode: "analysis" } as unknown as AgentExecutionContext);

const cfg = { maxSteps: 6, maxToolCalls: 15 } as unknown as AgentConfig;

describe("W2 · runSubInvestigation (B3 chart forwarding)", () => {
  it("forwards the sub-turn charts instead of discarding them", async () => {
    const charts = [chart("TSOE compliance"), chart("Cluster compliance")];
    const fakeTurn = (async () => ({ answer: "sub answer", charts })) as unknown as typeof import("../lib/agents/runtime/agentLoop.service.js").runAgentTurn;

    const out = await runSubInvestigation(baseCtx(createBlackboard()), "Which TSOE has highest compliance?", cfg, undefined, fakeTurn);

    assert.equal(out.answer, "sub answer");
    assert.equal(out.charts.length, 2);
    assert.deepEqual(out.charts.map((c) => (c as { title: string }).title), ["TSOE compliance", "Cluster compliance"]);
  });

  it("sets the recursion guard and shares the parent blackboard on the sub-turn ctx", async () => {
    const bb = createBlackboard();
    let seenCtx: AgentExecutionContext | undefined;
    const fakeTurn = (async (ctx: AgentExecutionContext) => {
      seenCtx = ctx;
      return { answer: "x" };
    }) as unknown as typeof import("../lib/agents/runtime/agentLoop.service.js").runAgentTurn;

    await runSubInvestigation(baseCtx(bb), "Sub Q?", cfg, undefined, fakeTurn);

    assert.equal(seenCtx?.question, "Sub Q?");
    assert.equal(seenCtx?.suppressSpawnedFollowUp, true, "recursion guard must be set");
    assert.equal(seenCtx?.blackboard, bb, "sub-turn must share the parent blackboard");
  });

  it("counts llm_call events and forwards them to the caller's onAgentEvent", async () => {
    const events: string[] = [];
    const fakeTurn = (async (_ctx: AgentExecutionContext, _cfg: AgentConfig, cb?: (e: string, p: unknown) => void) => {
      cb?.("llm_call", {});
      cb?.("tool_result", {});
      cb?.("llm_call", {});
      return { answer: "y", charts: [], spawnedQuestions: [] };
    }) as unknown as typeof import("../lib/agents/runtime/agentLoop.service.js").runAgentTurn;

    const out = await runSubInvestigation(
      baseCtx(createBlackboard()),
      "Q?",
      cfg,
      (e) => events.push(e),
      fakeTurn
    );

    assert.equal(out.llmCalls, 2);
    assert.ok(out.wallMs >= 0);
    assert.deepEqual(events, ["llm_call", "tool_result", "llm_call"]);
  });

  it("degrades to empty result fields when the sub-turn returns null", async () => {
    const fakeTurn = (async () => null) as unknown as typeof import("../lib/agents/runtime/agentLoop.service.js").runAgentTurn;
    const out = await runSubInvestigation(baseCtx(createBlackboard()), "Q?", cfg, undefined, fakeTurn);
    assert.equal(out.answer, "");
    assert.deepEqual(out.charts, []);
    assert.deepEqual(out.spawnedQuestions, []);
  });
});
