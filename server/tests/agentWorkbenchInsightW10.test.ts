import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentSseEventToWorkbenchEntries } from "../services/chat/agentWorkbench.util.js";
import { agentWorkbenchEntrySchema } from "../shared/schema.js";

/**
 * W10 · per-entry `insight` is populated deterministically from the SSE
 * payload at emission time. No LLM calls. Older Cosmos rows without the
 * field continue to parse cleanly (back-compat).
 */
describe("W10 · plan kind", () => {
  it("uses the rationale's first sentence", () => {
    const [entry] = agentSseEventToWorkbenchEntries("plan", {
      rationale:
        "Pivot Saffola sales by Region first to localise the share loss before drilling into channel mix. Subsequent steps confirm or refute the regional hypothesis.",
      steps: [
        { id: "s1", tool: "execute_query_plan", args_summary: "{}" },
        { id: "s2", tool: "compute_correlation", args_summary: "{}" },
      ],
    });
    assert.equal(entry.kind, "plan");
    assert.match(entry.insight!, /Pivot Saffola sales by Region first to localise the share loss before drilling into channel mix\./);
  });

  it("falls back to a step summary when no rationale", () => {
    const [entry] = agentSseEventToWorkbenchEntries("plan", {
      steps: [
        { id: "s1", tool: "execute_query_plan", args_summary: "{}" },
        { id: "s2", tool: "compute_correlation", args_summary: "{}" },
      ],
    });
    assert.match(entry.insight!, /Planning 2 steps: execute_query_plan, compute_correlation\./);
  });
});

describe("W10 · tool_call kind", () => {
  it("emits a one-line `Calling \\`tool\\`` insight with arg preview", () => {
    const [entry] = agentSseEventToWorkbenchEntries("tool_call", {
      id: "c1",
      name: "execute_query_plan",
      args_summary: '{"metric":"Volume_MT","groupBy":"Brand"}',
    });
    assert.match(entry.insight!, /Calling `execute_query_plan` with .*Volume_MT/);
  });
});

describe("W10 · tool_result kind", () => {
  it("returns first sentence of summary on success", () => {
    const [entry] = agentSseEventToWorkbenchEntries("tool_result", {
      id: "c1",
      ok: true,
      summary:
        "Aggregated 1,240 rows across 6 brands. Saffola Volume_MT is highest at 412 MT in Q3. Other brands trail by 30%+.",
    });
    assert.match(entry.insight!, /Aggregated 1,240 rows across 6 brands\./);
  });

  it("flags failure with context when ok=false", () => {
    const [entry] = agentSseEventToWorkbenchEntries("tool_result", {
      id: "c2",
      ok: false,
      summary: "Column 'Volume_MT' not found in dataset. Did you mean 'Volume_KG'?",
    });
    assert.match(entry.insight!, /Tool failed: Column 'Volume_MT' not found in dataset\./);
  });
});

describe("W10 · flow_decision kind", () => {
  it("uses the reason verbatim when present", () => {
    const [entry] = agentSseEventToWorkbenchEntries("flow_decision", {
      layer: "synthesis_writer",
      chosen: "narrator",
      reason: "Blackboard has 3 confirmed findings — narrator owns evidence-based synthesis.",
    });
    assert.match(entry.insight!, /Blackboard has 3 confirmed findings/);
  });

  it("falls back to a `routed to` line when no reason", () => {
    const [entry] = agentSseEventToWorkbenchEntries("flow_decision", {
      layer: "synthesis_writer",
      chosen: "narrator",
    });
    assert.match(entry.insight!, /synthesis_writer routed to narrator\./);
  });

  it("calls out overrides", () => {
    const [entry] = agentSseEventToWorkbenchEntries("flow_decision", {
      layer: "synthesis_writer",
      chosen: "fallback",
      overriddenBy: "verifier",
    });
    assert.match(entry.insight!, /synthesis_writer overridden to fallback \(by verifier\)\./);
  });
});

describe("W10 · critic kind (final-only by default)", () => {
  it("uses course_correction's first sentence when present", () => {
    const [entry] = agentSseEventToWorkbenchEntries("critic_verdict", {
      stepId: "final",
      verdict: "revise_narrative",
      course_correction: "Add a Saffola South-region paragraph. The current draft over-indexes on East.",
    });
    assert.match(entry.insight!, /Add a Saffola South-region paragraph\./);
  });

  it("falls back to verdict + issue codes", () => {
    const [entry] = agentSseEventToWorkbenchEntries("critic_verdict", {
      stepId: "final",
      verdict: "pass",
      issue_codes: ["NUMBER_MISMATCH", "MISSING_FILTER"],
    });
    assert.match(entry.insight!, /pass — NUMBER_MISMATCH, MISSING_FILTER\./);
  });
});

describe("W10 · handoff kind", () => {
  it("emits a `from → to: intent` insight", () => {
    const [entry] = agentSseEventToWorkbenchEntries("handoff", {
      from: "Planner",
      to: "Executor",
      intent: "execute approved plan",
    });
    assert.match(entry.insight!, /Planner → Executor: execute approved plan/);
  });
});

describe("W10 · back-compat", () => {
  it("agentWorkbenchEntrySchema accepts legacy entries without `insight`", () => {
    const legacy = {
      id: "x1",
      kind: "tool_call" as const,
      title: "Tool: execute_query_plan",
      code: "{}",
    };
    const parsed = agentWorkbenchEntrySchema.parse(legacy);
    assert.equal(parsed.insight, undefined);
  });

  it("agentWorkbenchEntrySchema rejects insight over 400 chars", () => {
    const tooLong = {
      id: "x1",
      kind: "tool_call" as const,
      title: "Tool: x",
      code: "{}",
      insight: "x".repeat(401),
    };
    assert.throws(() => agentWorkbenchEntrySchema.parse(tooLong));
  });
});
