import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import {
  isSpawnedFollowUpEnabled,
  loadSpawnedFollowUpConfig,
  shouldRunSpawnedFollowUp,
} from "../lib/agents/runtime/investigationTree.js";

/**
 * Wave W3 · the spawned-question follow-up flag + budget config.
 *
 * Invariant #6: the pass is gated behind SPAWNED_FOLLOWUP_ENABLED (default off).
 * "No cap on the NUMBER of sub-questions" is honored by the config having NO
 * count field — only aggregate resource budgets bound the pass.
 */

const FLAG_VARS = [
  "SPAWNED_FOLLOWUP_ENABLED",
  "SPAWNED_FOLLOWUP_MAX_LLM_CALLS",
  "SPAWNED_FOLLOWUP_MAX_WALL_MS",
  "SPAWNED_FOLLOWUP_PARALLEL",
  "SPAWNED_FOLLOWUP_PER_SUB_LLM",
  "SPAWNED_FOLLOWUP_PER_SUB_WALL_MS",
  "SPAWNED_FOLLOWUP_PER_SUB_STEPS",
  "SPAWNED_FOLLOWUP_PER_SUB_TOOL_CALLS",
];

afterEach(() => {
  for (const v of FLAG_VARS) delete process.env[v];
});

describe("W3 · isSpawnedFollowUpEnabled", () => {
  it("defaults to OFF (invariant #6 — single-flow preserved)", () => {
    delete process.env.SPAWNED_FOLLOWUP_ENABLED;
    assert.equal(isSpawnedFollowUpEnabled(), false);
  });

  it("is on for 'true' and '1' only", () => {
    process.env.SPAWNED_FOLLOWUP_ENABLED = "true";
    assert.equal(isSpawnedFollowUpEnabled(), true);
    process.env.SPAWNED_FOLLOWUP_ENABLED = "1";
    assert.equal(isSpawnedFollowUpEnabled(), true);
    process.env.SPAWNED_FOLLOWUP_ENABLED = "yes";
    assert.equal(isSpawnedFollowUpEnabled(), false);
  });
});

describe("W3 · loadSpawnedFollowUpConfig", () => {
  it("provides safe defaults and has NO count cap (resource-bounded only)", () => {
    const c = loadSpawnedFollowUpConfig();
    assert.ok(c.maxLlmCalls >= 1, "aggregate LLM ceiling present");
    assert.ok(c.maxWallMs >= 1, "aggregate wall ceiling present");
    assert.ok(c.parallel >= 1, "parallelism clamped to >= 1");
    assert.ok(c.perSubLlmCalls >= 1);
    assert.ok(c.perSubWallMs >= 1);
    assert.ok(c.perSubMaxSteps >= 1);
    assert.ok(c.perSubMaxToolCalls >= 1);
    // The "no cap on number" intent: the config exposes no maxQuestions/maxNodes.
    assert.equal((c as Record<string, unknown>).maxQuestions, undefined);
    assert.equal((c as Record<string, unknown>).maxNodes, undefined);
  });

  it("reads env overrides and clamps parallel to >= 1", () => {
    process.env.SPAWNED_FOLLOWUP_MAX_LLM_CALLS = "200";
    process.env.SPAWNED_FOLLOWUP_MAX_WALL_MS = "300000";
    process.env.SPAWNED_FOLLOWUP_PARALLEL = "0";
    process.env.SPAWNED_FOLLOWUP_PER_SUB_LLM = "10";
    const c = loadSpawnedFollowUpConfig();
    assert.equal(c.maxLlmCalls, 200);
    assert.equal(c.maxWallMs, 300_000);
    assert.equal(c.parallel, 1, "parallel=0 clamps up to 1");
    assert.equal(c.perSubLlmCalls, 10);
  });

  it("falls back to defaults on non-numeric env", () => {
    process.env.SPAWNED_FOLLOWUP_MAX_LLM_CALLS = "not-a-number";
    const c = loadSpawnedFollowUpConfig();
    assert.equal(c.maxLlmCalls, 60);
  });
});

describe("W5 · shouldRunSpawnedFollowUp gate", () => {
  const ok = { suppress: false, mode: "analysis", questionCount: 3 };

  it("fires only when all conditions hold", () => {
    assert.equal(shouldRunSpawnedFollowUp(true, ok), true);
  });

  it("never fires when the flag is off (invariant #6 — flag-off = no-op)", () => {
    assert.equal(shouldRunSpawnedFollowUp(false, ok), false);
  });

  it("never fires inside a sub-investigation (recursion guard)", () => {
    assert.equal(shouldRunSpawnedFollowUp(true, { ...ok, suppress: true }), false);
  });

  it("only fires on analysis-mode turns", () => {
    assert.equal(shouldRunSpawnedFollowUp(true, { ...ok, mode: "dashboard" }), false);
    assert.equal(shouldRunSpawnedFollowUp(true, { ...ok, mode: undefined }), false);
  });

  it("does nothing when no sub-questions were spawned", () => {
    assert.equal(shouldRunSpawnedFollowUp(true, { ...ok, questionCount: 0 }), false);
  });
});
