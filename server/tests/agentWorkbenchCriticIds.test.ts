import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentSseEventToWorkbenchEntries } from "../services/chat/agentWorkbench.util.js";

describe("agentWorkbench critic entries", () => {
  it("uses unique ids for repeated critic_verdict with same stepId (final only)", () => {
    const a = agentSseEventToWorkbenchEntries("critic_verdict", {
      stepId: "final",
      verdict: "revise",
    });
    const b = agentSseEventToWorkbenchEntries("critic_verdict", {
      stepId: "final",
      verdict: "pass",
    });
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.notEqual(a[0].id, b[0].id);
  });

  it("omits non-final critic_verdict from workbench by default", () => {
    const out = agentSseEventToWorkbenchEntries("critic_verdict", {
      stepId: "execute_query_plan_trend",
      verdict: "pass",
    });
    assert.equal(out.length, 0);
  });
});
