import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentSseEventToWorkbenchEntries } from "../services/chat/agentWorkbench.util.js";
import { agentWorkbenchEntrySchema } from "../shared/schema.js";

describe("agentSseEventToWorkbenchEntries · flow_decision (Wave W2)", () => {
  it("maps a routing event to a 'flow_decision' workbench entry", () => {
    const out = agentSseEventToWorkbenchEntries("flow_decision", {
      layer: "agentic-or-legacy",
      chosen: "agentic",
      reason: "AGENTIC_LOOP_ENABLED=true",
    });
    assert.equal(out.length, 1);
    const entry = out[0]!;
    assert.equal(entry.kind, "flow_decision");
    assert.equal(entry.title, "Routed: agentic-or-legacy → agentic");
    assert.equal(entry.flowDecision?.layer, "agentic-or-legacy");
    assert.equal(entry.flowDecision?.chosen, "agentic");
    assert.equal(entry.flowDecision?.reason, "AGENTIC_LOOP_ENABLED=true");
    assert.ok(agentWorkbenchEntrySchema.safeParse(entry).success);
  });

  it("renders an override with overriddenBy in the title and payload", () => {
    const [entry] = agentSseEventToWorkbenchEntries("flow_decision", {
      layer: "mode-override",
      chosen: "analysis",
      overriddenBy: "correlation-detector",
      candidates: ["dataOps", "analysis"],
    });
    assert.ok(entry);
    assert.equal(entry.title, "Override: mode-override → analysis");
    assert.equal(entry.flowDecision?.overriddenBy, "correlation-detector");
    assert.deepEqual(entry.flowDecision?.candidates, ["dataOps", "analysis"]);
  });

  it("retains valid confidence and drops out-of-range confidence", () => {
    const [okEntry] = agentSseEventToWorkbenchEntries("flow_decision", {
      layer: "intent",
      chosen: "correlation",
      confidence: 0.91,
    });
    assert.equal(okEntry?.flowDecision?.confidence, 0.91);

    const [badEntry] = agentSseEventToWorkbenchEntries("flow_decision", {
      layer: "intent",
      chosen: "correlation",
      confidence: 1.7,
    });
    assert.equal(badEntry?.flowDecision?.confidence, undefined);
  });

  it("returns no entry when payload is not an object", () => {
    assert.equal(agentSseEventToWorkbenchEntries("flow_decision", null).length, 0);
    assert.equal(agentSseEventToWorkbenchEntries("flow_decision", "x").length, 0);
  });

  it("clamps candidates to first 8 entries", () => {
    const [entry] = agentSseEventToWorkbenchEntries("flow_decision", {
      layer: "coordinator-decompose",
      chosen: "multi-thread",
      candidates: Array.from({ length: 12 }, (_, i) => `t-${i}`),
    });
    assert.equal(entry?.flowDecision?.candidates?.length, 8);
  });
});
