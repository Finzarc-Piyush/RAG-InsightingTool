import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runSpawnedFollowUpPass } from "../lib/agents/runtime/spawnedFollowUpPass.js";
import { runSubInvestigation } from "../lib/agents/runtime/investigationOrchestrator.js";
import { createBlackboard, addOpenQuestion } from "../lib/agents/runtime/analyticalBlackboard.js";
import type { SpawnedFollowUpConfig, SpawnedQuestion } from "../lib/agents/runtime/investigationTree.js";
import type { AgentExecutionContext, AgentLoopResult } from "../lib/agents/runtime/types.js";

/**
 * Wave W4 · the spawned-question follow-up engine. runSubInvestigation is
 * dependency-injected, so this is a pure test of the pass orchestration:
 * chart forwarding + provenance tagging, blackboard resolution, aggregate
 * budget halt, best-effort skip of a throwing sub-turn, dedup, and SSE hygiene.
 */

type Chart = NonNullable<AgentLoopResult["charts"]>[number];
const chart = (title: string, provenance?: unknown) =>
  ({ type: "bar", title, x: "Day", y: "Sales", points: [], ...(provenance ? { _agentProvenance: provenance } : {}) } as unknown as Chart);

const sq = (id: string, question: string): SpawnedQuestion => ({
  id,
  question,
  spawnReason: "anomaly",
  priority: "high",
  suggestedColumns: [],
});

const cfg = (over: Partial<SpawnedFollowUpConfig> = {}): SpawnedFollowUpConfig => ({
  maxLlmCalls: 1000,
  maxWallMs: 1_000_000,
  parallel: 2,
  perSubLlmCalls: 8,
  perSubWallMs: 60_000,
  perSubMaxSteps: 6,
  perSubMaxToolCalls: 15,
  ...over,
});

const ctxWith = (bb: ReturnType<typeof createBlackboard>) =>
  ({ question: "ROOT", blackboard: bb, summary: { columns: [] }, mode: "analysis" } as unknown as AgentExecutionContext);

// Build a fake runSubInvestigation with controllable per-question behavior.
function fakeRunSub(
  behavior: (question: string, onEvent?: (e: string, d: unknown) => void) => Awaited<ReturnType<typeof runSubInvestigation>> | Promise<never>
): typeof runSubInvestigation {
  return (async (_ctx: unknown, question: string, _cfg: unknown, onEvent?: (e: string, d: unknown) => void) =>
    behavior(question, onEvent)) as unknown as typeof runSubInvestigation;
}

describe("W4 · runSpawnedFollowUpPass", () => {
  it("investigates every question and forwards + provenance-tags their charts", async () => {
    const bb = createBlackboard();
    const questions = [sq("a", "Which TSOE has highest compliance?"), sq("b", "Android/iOS usage by ASM?")];
    const runSub = fakeRunSub((q) => ({
      answer: `ans:${q}`,
      charts: [chart(`chart for ${q}`)],
      spawnedQuestions: [],
      llmCalls: 2,
      wallMs: 5,
    }));

    const out = await runSpawnedFollowUpPass(ctxWith(bb), questions, undefined, cfg(), runSub);

    assert.equal(out.investigated.length, 2);
    assert.equal(out.charts.length, 2);
    assert.equal(out.llmCalls, 4);
    assert.equal(out.budgetHalted, false);
    // provenance.sources names the originating sub-question, toolCalls preserved
    for (const c of out.charts) {
      const prov = (c as { _agentProvenance?: { toolCalls?: unknown[]; sources?: string[] } })._agentProvenance!;
      assert.ok(Array.isArray(prov.toolCalls), "toolCalls present (required field)");
      assert.ok(prov.sources?.some((s) => s.startsWith("Investigated sub-question:")), "sources tagged");
    }
  });

  it("preserves an existing _agentProvenance and appends the sub-question source", async () => {
    const bb = createBlackboard();
    const runSub = fakeRunSub((q) => ({
      answer: "a",
      charts: [chart(`c:${q}`, { toolCalls: [{ id: "t1", tool: "run_analytical_query" }], sources: ["orig"] })],
      spawnedQuestions: [],
      llmCalls: 1,
      wallMs: 1,
    }));
    const out = await runSpawnedFollowUpPass(ctxWith(bb), [sq("a", "Q one?")], undefined, cfg(), runSub);
    const prov = (out.charts[0] as { _agentProvenance: { toolCalls: unknown[]; sources: string[] } })._agentProvenance;
    assert.equal(prov.toolCalls.length, 1, "existing toolCalls preserved");
    assert.deepEqual(prov.sources[0], "orig");
    assert.ok(prov.sources[1].startsWith("Investigated sub-question:"));
  });

  it("resolves the matching open question on the blackboard (so it's not left pending)", async () => {
    const bb = createBlackboard();
    addOpenQuestion(bb, "Which TSOE has highest compliance?", "anomaly", { priority: "high" });
    assert.equal(bb.openQuestions[0].actionedByNodeId, undefined);
    const runSub = fakeRunSub(() => ({ answer: "a", charts: [], spawnedQuestions: [], llmCalls: 1, wallMs: 1 }));

    await runSpawnedFollowUpPass(ctxWith(bb), [sq("a", "Which TSOE has highest compliance?")], undefined, cfg(), runSub);

    assert.ok(bb.openQuestions[0].actionedByNodeId, "open question marked actioned");
  });

  it("honors NO count cap but halts on the aggregate LLM budget", async () => {
    const bb = createBlackboard();
    const questions = Array.from({ length: 10 }, (_, i) => sq(`id${i}`, `Question ${i}?`));
    // each sub costs 5 LLM calls; aggregate ceiling 8 → first batch (parallel=1)
    // costs 5, second batch would be checked at 5 < 8 (runs, ->10), third halts.
    const runSub = fakeRunSub(() => ({ answer: "a", charts: [], spawnedQuestions: [], llmCalls: 5, wallMs: 1 }));

    const out = await runSpawnedFollowUpPass(bb && ctxWith(bb), questions, undefined, cfg({ maxLlmCalls: 8, parallel: 1 }), runSub);

    assert.equal(out.budgetHalted, true, "halts on aggregate budget");
    assert.ok(out.investigated.length < questions.length, "did not investigate all (budget-bounded)");
    assert.ok(out.llmCalls >= 8, "spent at least the ceiling");
  });

  it("is best-effort: a throwing sub-turn is skipped, the pass continues", async () => {
    const bb = createBlackboard();
    const runSub = fakeRunSub((q) => {
      if (q.includes("boom")) throw new Error("sub blew up");
      return Promise.resolve({ answer: "ok", charts: [chart("c")], spawnedQuestions: [], llmCalls: 1, wallMs: 1 });
    });
    const out = await runSpawnedFollowUpPass(
      ctxWith(bb),
      [sq("a", "good question?"), sq("b", "boom question?"), sq("c", "another good?")],
      undefined,
      cfg({ parallel: 3 }),
      runSub
    );
    assert.equal(out.investigated.length, 2, "two good ones survive, boom skipped");
    assert.equal(out.charts.length, 2);
  });

  it("dedups identical sub-questions within the pass", async () => {
    const bb = createBlackboard();
    let calls = 0;
    const runSub = fakeRunSub(() => {
      calls++;
      return Promise.resolve({ answer: "a", charts: [], spawnedQuestions: [], llmCalls: 1, wallMs: 1 });
    });
    await runSpawnedFollowUpPass(
      ctxWith(bb),
      [sq("a", "Same question?"), sq("b", "same question?"), sq("c", "Other?")],
      undefined,
      cfg(),
      runSub
    );
    assert.equal(calls, 2, "duplicate (case-insensitive) investigated once");
  });

  it("suppresses sub-turn streaming events but emits sub_question_investigated to the parent", async () => {
    const bb = createBlackboard();
    const seen: string[] = [];
    const runSub = fakeRunSub((_q, onEvent) => {
      onEvent?.("answer_chunk", { t: "partial" }); // must be suppressed
      onEvent?.("thinking", {}); // must be suppressed
      onEvent?.("tool_result", { ok: true }); // must pass through
      return Promise.resolve({ answer: "a", charts: [], spawnedQuestions: [], llmCalls: 1, wallMs: 1 });
    });

    await runSpawnedFollowUpPass(ctxWith(bb), [sq("a", "Q?")], (e) => seen.push(e), cfg(), runSub);

    assert.ok(!seen.includes("answer_chunk"), "answer_chunk suppressed");
    assert.ok(!seen.includes("thinking"), "thinking suppressed");
    assert.ok(seen.includes("tool_result"), "tool_result passes through (workbench transparency)");
    assert.ok(seen.includes("sub_question_investigated"), "per-sub progress emitted to parent");
  });

  it("returns an empty result with no questions", async () => {
    const bb = createBlackboard();
    const out = await runSpawnedFollowUpPass(ctxWith(bb), [], undefined, cfg());
    assert.deepEqual(out, { charts: [], investigated: [], llmCalls: 0, wallMs: 0, budgetHalted: false });
  });
});
