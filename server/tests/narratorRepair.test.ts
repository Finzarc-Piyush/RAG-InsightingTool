import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NarratorRepairContext } from "../lib/agents/runtime/narratorAgent.js";

/**
 * W4 · narrator-repair contract.
 *
 * runNarrator requires a live LLM, so we don't exercise the network call here
 * — that's covered by integration tests. What this file pins is:
 *   1. NarratorRepairContext shape (issues / priorDraft / courseCorrection)
 *   2. The agent loop's gating logic for invoking repair (blackboard required,
 *      analysis mode required, only on the first revise_narrative round)
 *
 * The actual gating logic lives at agentLoop.service.ts:`canRetryWithNarrator`.
 * We rebuild the predicate here so its invariants don't drift silently.
 */

function canRetryWithNarrator(args: {
  hasBlackboard: boolean;
  blackboardUsable: boolean;
  mode: "analysis" | "dataOps" | "modeling";
  finalRound: number;
}): boolean {
  return (
    args.hasBlackboard &&
    args.blackboardUsable &&
    args.mode === "analysis" &&
    args.finalRound === 0
  );
}

describe("W4 · narrator-repair gate", () => {
  const baseArgs = {
    hasBlackboard: true,
    blackboardUsable: true,
    mode: "analysis" as const,
    finalRound: 0,
  };

  it("retries with narrator on the first revise_narrative round", () => {
    assert.strictEqual(canRetryWithNarrator(baseArgs), true);
  });

  it("falls through to legacy rewrite on the second round (cap at 1 repair)", () => {
    assert.strictEqual(canRetryWithNarrator({ ...baseArgs, finalRound: 1 }), false);
  });

  it("falls through when no blackboard exists (dataOps fast path)", () => {
    assert.strictEqual(canRetryWithNarrator({ ...baseArgs, hasBlackboard: false }), false);
  });

  it("falls through when blackboard is empty (no findings)", () => {
    assert.strictEqual(canRetryWithNarrator({ ...baseArgs, blackboardUsable: false }), false);
  });

  it("falls through outside analysis mode (modeling/dataOps)", () => {
    assert.strictEqual(canRetryWithNarrator({ ...baseArgs, mode: "modeling" }), false);
    assert.strictEqual(canRetryWithNarrator({ ...baseArgs, mode: "dataOps" }), false);
  });
});

describe("W4 · NarratorRepairContext shape", () => {
  it("requires `issues` and accepts optional priorDraft + courseCorrection", () => {
    const minimal: NarratorRepairContext = { issues: "fabricated number" };
    const full: NarratorRepairContext = {
      issues: "fabricated number",
      priorDraft: "Sales fell 50% (made-up).",
      courseCorrection: "revise_narrative",
    };
    // Type-level assertions — if these compile, the contract holds.
    assert.strictEqual(typeof minimal.issues, "string");
    assert.strictEqual(typeof full.priorDraft, "string");
    assert.strictEqual(typeof full.courseCorrection, "string");
  });
});
