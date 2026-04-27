import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  PriorInvestigationItem,
  SessionAnalysisContext,
} from "../shared/schema.js";

process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { appendPriorInvestigation } = await import(
  "../lib/agents/runtime/priorInvestigations.js"
);

/**
 * W40 pins the contract that `appendPriorInvestigation` is referentially
 * pure and produces a new SAC each call — required for the per-session
 * mutex serialisation in `persistMergeAssistantSessionContext` to work
 * correctly. (The mutex itself is exercised at runtime; we don't drive
 * a real Cosmos client in tests.)
 *
 * The mutex's contract: when N concurrent persists are queued for the
 * same session, the FINAL state is "all N entries appended in arrival
 * order". The pure-helper proves the math: each appendPriorInvestigation
 * takes the OUTPUT of the previous append, not a stale base.
 */
describe("W40 · sequential append produces all entries", () => {
  const baseSac = (): SessionAnalysisContext => ({
    version: 1,
    dataset: { shortDescription: "x", columnRoles: [], caveats: [] },
    userIntent: { interpretedConstraints: [] },
    sessionKnowledge: { facts: [], analysesDone: [] },
    suggestedFollowUps: [],
    lastUpdated: { reason: "seed", at: new Date().toISOString() },
  });
  const digest = (label: string): PriorInvestigationItem => ({
    at: label,
    question: `Q-${label}`,
    hypothesesConfirmed: [`Confirmed-${label}`],
    hypothesesRefuted: [],
    hypothesesOpen: [],
    headlineFinding: `Headline-${label}`,
  });

  it("3 sequential appends yield all 3 entries in order", () => {
    let sac = baseSac();
    sac = appendPriorInvestigation(sac, digest("a"));
    sac = appendPriorInvestigation(sac, digest("b"));
    sac = appendPriorInvestigation(sac, digest("c"));
    const arr = sac.sessionKnowledge.priorInvestigations!;
    assert.equal(arr.length, 3);
    assert.deepEqual(
      arr.map((e) => e.at),
      ["a", "b", "c"]
    );
  });

  it("appending against a STALE base loses entries (the bug W40 prevents)", () => {
    // This is what would happen WITHOUT serialisation: two callers
    // both read `base` (no priors) and each appends in parallel, but
    // since each append starts from `base` (not from the other's
    // result), only the last-write-wins entry survives.
    const base = baseSac();
    const sacA = appendPriorInvestigation(base, digest("a"));
    const sacB = appendPriorInvestigation(base, digest("b")); // stale base
    // Whichever was written last to Cosmos via upsert, only its single
    // entry survives. Verify both branches each have ONLY their own
    // entry — i.e. the bug pattern.
    assert.equal(sacA.sessionKnowledge.priorInvestigations?.length, 1);
    assert.equal(sacA.sessionKnowledge.priorInvestigations?.[0].at, "a");
    assert.equal(sacB.sessionKnowledge.priorInvestigations?.length, 1);
    assert.equal(sacB.sessionKnowledge.priorInvestigations?.[0].at, "b");
    // The combined "wanted" outcome (a,b) cannot be reconstructed from
    // either branch alone — only chained-from-result appends preserve
    // both. That's exactly what the W40 mutex enforces at runtime.
  });
});

describe("W40 · sessionPersistChain mutex (smoke)", () => {
  // The mutex itself is exercised by importing the module and confirming
  // the exported function is callable. Real concurrency exercise needs a
  // mocked Cosmos client; out of scope for a unit test.
  it("persistMergeAssistantSessionContext is async and exported", async () => {
    const mod = await import("../lib/sessionAnalysisContext.js");
    assert.equal(typeof mod.persistMergeAssistantSessionContext, "function");
    assert.equal(mod.persistMergeAssistantSessionContext.constructor.name, "AsyncFunction");
  });
});
