import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  agentWorkbenchEntrySchema,
  agentWorkbenchEntryKindSchema,
  flowDecisionDetailSchema,
} from "../shared/schema.js";

describe("flow_decision workbench entry (Wave W1)", () => {
  it("accepts 'flow_decision' as a valid kind", () => {
    assert.ok(agentWorkbenchEntryKindSchema.safeParse("flow_decision").success);
  });

  it("parses a routing entry with layer + chosen + reason", () => {
    const r = agentWorkbenchEntrySchema.safeParse({
      id: "fd-1",
      kind: "flow_decision",
      title: "Routed: agentic loop",
      code: "{}",
      flowDecision: {
        layer: "agentic-or-legacy",
        chosen: "agentic",
        reason: "AGENTIC_LOOP_ENABLED=true",
      },
    });
    assert.ok(r.success, r.success ? "" : String(r.error));
  });

  it("parses an override entry with overriddenBy + candidates", () => {
    const r = agentWorkbenchEntrySchema.safeParse({
      id: "fd-2",
      kind: "flow_decision",
      title: "Override: dataOps → analysis",
      code: "{}",
      flowDecision: {
        layer: "mode-override",
        chosen: "analysis",
        overriddenBy: "correlation-detector",
        reason: "User asked for correlation; not a data op.",
        candidates: ["dataOps", "analysis"],
      },
    });
    assert.ok(r.success, r.success ? "" : String(r.error));
  });

  it("parses an intent entry with confidence in [0,1]", () => {
    const r = agentWorkbenchEntrySchema.safeParse({
      id: "fd-3",
      kind: "flow_decision",
      title: "Intent classified",
      code: "{}",
      flowDecision: {
        layer: "intent",
        chosen: "correlation",
        confidence: 0.82,
      },
    });
    assert.ok(r.success, r.success ? "" : String(r.error));
  });

  it("rejects confidence outside [0,1]", () => {
    const r = flowDecisionDetailSchema.safeParse({
      layer: "intent",
      chosen: "correlation",
      confidence: 1.5,
    });
    assert.ok(!r.success);
  });

  it("rejects empty payload (layer + chosen required)", () => {
    const r = flowDecisionDetailSchema.safeParse({});
    assert.ok(!r.success);
  });

  it("caps candidates length to 8", () => {
    const r = flowDecisionDetailSchema.safeParse({
      layer: "coordinator-decompose",
      chosen: "multi-thread",
      candidates: Array.from({ length: 9 }, (_, i) => `topic-${i}`),
    });
    assert.ok(!r.success);
  });

  it("flowDecision is optional on non-flow_decision kinds", () => {
    const r = agentWorkbenchEntrySchema.safeParse({
      id: "p-1",
      kind: "plan",
      title: "Initial plan",
      code: "{ steps: [] }",
    });
    assert.ok(r.success, r.success ? "" : String(r.error));
  });
});
