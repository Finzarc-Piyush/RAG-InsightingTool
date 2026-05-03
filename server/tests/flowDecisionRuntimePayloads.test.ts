import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentSseEventToWorkbenchEntries } from "../services/chat/agentWorkbench.util.js";
import { agentWorkbenchEntrySchema } from "../shared/schema.js";

/**
 * W3 · payload contract test.
 *
 * The agent loop emits `flow_decision` events with specific payload shapes for
 * reflector replan, per-step verifier rewriteNarrative, final verifier
 * rewriteNarrative, and coordinator decompose. W11-W13 changed the runtime to
 * suppress these overrides under the single-flow policy: instead of mutating
 * the plan or rewriting the narrative, the runtime emits a flow_decision with
 * `chosen: "continue-as-planned"` or `chosen: "kept-original"` (no
 * overriddenBy field). This test pins both the suppressed shapes (current
 * runtime) and the legacy override shapes (still valid against the schema, in
 * case the suppression is ever re-enabled or wired behind a flag).
 */

function expectValidEntry(payload: Record<string, unknown>) {
  const entries = agentSseEventToWorkbenchEntries("flow_decision", payload);
  assert.equal(entries.length, 1, "should produce one workbench entry");
  const e = entries[0]!;
  assert.equal(e.kind, "flow_decision");
  const parsed = agentWorkbenchEntrySchema.safeParse(e);
  assert.ok(parsed.success, parsed.success ? "" : String(parsed.error));
  return e;
}

describe("flow_decision runtime payloads (Wave W3)", () => {
  it("reflector-replan suppressed payload (W11): chosen='continue-as-planned', no overriddenBy", () => {
    const e = expectValidEntry({
      layer: "reflector-replan",
      chosen: "continue-as-planned",
      reason:
        "Replan suggested but suppressed (single-flow policy). Reflector note: schema_mismatch",
      candidates: ["s1:get_schema_summary", "s2:execute_query_plan"],
    });
    assert.match(e.title, /^Routed:/);
    assert.equal(e.flowDecision?.layer, "reflector-replan");
    assert.equal(e.flowDecision?.chosen, "continue-as-planned");
    assert.equal(e.flowDecision?.overriddenBy, undefined);
  });

  it("verifier-rewrite-step suppressed payload (W12): chosen='kept-original'", () => {
    const reason = "Rewrite suppressed (single-flow policy); Numeric mismatch: 50M vs 52M";
    const e = expectValidEntry({
      layer: "verifier-rewrite-step",
      chosen: "kept-original",
      reason,
      candidates: ["NUMERIC_MISMATCH"],
    });
    assert.equal(e.flowDecision?.chosen, "kept-original");
    assert.equal(e.flowDecision?.overriddenBy, undefined);
    assert.deepEqual(e.flowDecision?.candidates, ["NUMERIC_MISMATCH"]);
  });

  it("verifier-rewrite-final suppressed payload (W12): chosen='kept-original'", () => {
    const e = expectValidEntry({
      layer: "verifier-rewrite-final",
      chosen: "kept-original",
      reason: "Rewrite suppressed (single-flow policy); Unsupported claim about Q1 revenue",
      candidates: ["UNSUPPORTED_CLAIM", "NUMERIC_MISMATCH"],
    });
    assert.equal(e.flowDecision?.chosen, "kept-original");
    assert.equal(e.flowDecision?.overriddenBy, undefined);
  });

  it("legacy override shapes still validate (kept for opt-in re-enabling)", () => {
    expectValidEntry({
      layer: "reflector-replan",
      chosen: "new-plan",
      overriddenBy: "reflector",
      reason: "x",
    });
    expectValidEntry({
      layer: "verifier-rewrite-final",
      chosen: "rewritten",
      overriddenBy: "verifier",
      reason: "y",
    });
  });

  it("coordinator-decompose payload validates with N thread topics", () => {
    const e = expectValidEntry({
      layer: "coordinator-decompose",
      chosen: "multi-thread",
      overriddenBy: "coordinatorAgent",
      reason: "Decomposed root question into 3 parallel thread(s) (single-turn plan abandoned).",
      candidates: [
        "Trend over time of revenue",
        "Region-level breakdown of revenue",
        "Driver analysis on margin",
      ],
    });
    assert.equal(e.flowDecision?.candidates?.length, 3);
  });

  it("truncates an over-long reason without breaking validation", () => {
    const reason = "x".repeat(2000);
    const e = expectValidEntry({
      layer: "verifier-rewrite-final",
      chosen: "rewritten",
      reason: reason.slice(0, 500),
    });
    assert.ok((e.flowDecision?.reason ?? "").length <= 500);
  });
});
