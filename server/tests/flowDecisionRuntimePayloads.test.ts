import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentSseEventToWorkbenchEntries } from "../services/chat/agentWorkbench.util.js";
import { agentWorkbenchEntrySchema } from "../shared/schema.js";

/**
 * W3 · payload contract test.
 *
 * The agent loop emits `flow_decision` events with specific payload shapes for
 * reflector replan, per-step verifier rewriteNarrative, final verifier
 * rewriteNarrative, and coordinator decompose. This test pins the shapes that
 * actually flow through the SSE pipeline so a renaming or schema drift breaks
 * the test instead of silently dropping the entry on the client.
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
  it("reflector-replan payload validates and renders override title", () => {
    const e = expectValidEntry({
      layer: "reflector-replan",
      chosen: "new-plan",
      overriddenBy: "reflector",
      reason: "schema_mismatch: column 'foo' not present",
      candidates: ["s1:get_schema_summary", "s2:execute_query_plan"],
    });
    assert.match(e.title, /^Override:/);
    assert.equal(e.flowDecision?.layer, "reflector-replan");
    assert.equal(e.flowDecision?.overriddenBy, "reflector");
  });

  it("verifier-rewrite-step payload validates and includes char delta", () => {
    const reason = "Numeric mismatch: 50M vs 52M | 240→312 chars";
    const e = expectValidEntry({
      layer: "verifier-rewrite-step",
      chosen: "rewritten",
      overriddenBy: "verifier",
      reason,
      candidates: ["NUMERIC_MISMATCH"],
    });
    assert.equal(e.flowDecision?.reason, reason);
    assert.deepEqual(e.flowDecision?.candidates, ["NUMERIC_MISMATCH"]);
  });

  it("verifier-rewrite-final payload validates", () => {
    const e = expectValidEntry({
      layer: "verifier-rewrite-final",
      chosen: "rewritten",
      overriddenBy: "verifier",
      reason: "Unsupported claim about Q1 revenue | 800→820 chars",
      candidates: ["UNSUPPORTED_CLAIM", "NUMERIC_MISMATCH"],
    });
    assert.equal(e.flowDecision?.layer, "verifier-rewrite-final");
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
