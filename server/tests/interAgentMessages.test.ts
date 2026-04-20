import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AgentTrace } from "../lib/agents/runtime/types.js";
import {
  isInterAgentTraceEnabled,
} from "../lib/agents/runtime/types.js";
import {
  appendInterAgentMessage,
  formatInterAgentHandoffsForPrompt,
} from "../lib/agents/runtime/interAgentMessages.js";
import { agentSseEventToWorkbenchEntries } from "../services/chat/agentWorkbench.util.js";

function minimalTrace(): AgentTrace {
  return {
    turnId: "t1",
    startedAt: 0,
    endedAt: 0,
    steps: [],
    toolCalls: [],
    criticRounds: [],
    reflectorNotes: [],
    budgetHits: [],
    parseFailures: 0,
  };
}

describe("interAgentMessages", () => {
  let prevInter: string | undefined;

  beforeEach(() => {
    prevInter = process.env.AGENT_INTER_AGENT_MESSAGES;
  });

  afterEach(() => {
    if (prevInter === undefined) delete process.env.AGENT_INTER_AGENT_MESSAGES;
    else process.env.AGENT_INTER_AGENT_MESSAGES = prevInter;
  });

  it("isInterAgentTraceEnabled is false by default / when unset", () => {
    delete process.env.AGENT_INTER_AGENT_MESSAGES;
    assert.equal(isInterAgentTraceEnabled(), false);
    process.env.AGENT_INTER_AGENT_MESSAGES = "false";
    assert.equal(isInterAgentTraceEnabled(), false);
  });

  it("isInterAgentTraceEnabled is true only for exact true string", () => {
    process.env.AGENT_INTER_AGENT_MESSAGES = "true";
    assert.equal(isInterAgentTraceEnabled(), true);
  });

  it("appendInterAgentMessage is a no-op when flag off", () => {
    delete process.env.AGENT_INTER_AGENT_MESSAGES;
    const trace = minimalTrace();
    appendInterAgentMessage(trace, {
      from: "Planner",
      to: "Coordinator",
      intent: "plan_accepted",
    });
    assert.equal(trace.interAgentMessages, undefined);
  });

  it("appendInterAgentMessage records and caps when flag on", () => {
    process.env.AGENT_INTER_AGENT_MESSAGES = "true";
    const trace = minimalTrace();
    for (let i = 0; i < 60; i++) {
      appendInterAgentMessage(trace, {
        from: "Planner",
        to: "Coordinator",
        intent: `m${i}`,
      });
    }
    assert.ok(trace.interAgentMessages);
    assert.equal(trace.interAgentMessages!.length, 48);
    assert.equal(trace.interAgentMessages!.at(-1)?.intent, "m59");
  });

  it("formatInterAgentHandoffsForPrompt keeps tail when over maxChars", () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({
      at: i,
      from: "Planner" as const,
      to: "Coordinator" as const,
      intent: `intent_${i}`,
      evidenceRefs: [`e${i}`],
    }));
    const s = formatInterAgentHandoffsForPrompt(messages, 400)!;
    assert.ok(s.includes("…(truncated)"));
    assert.ok(s.includes("intent_29"));
    assert.ok(!s.includes("intent_0"));
  });

  it("appendInterAgentMessage forwards handoff to emit when provided", () => {
    process.env.AGENT_INTER_AGENT_MESSAGES = "true";
    const trace = minimalTrace();
    const seen: string[] = [];
    appendInterAgentMessage(
      trace,
      {
        from: "Verifier",
        to: "Coordinator",
        intent: "step_verdict",
        evidenceRefs: ["call-1"],
      },
      (ev, data) => {
        seen.push(ev);
        assert.ok(data && typeof data === "object");
      }
    );
    assert.deepEqual(seen, ["handoff"]);
    const wb = agentSseEventToWorkbenchEntries("handoff", {
      from: "Verifier",
      to: "Coordinator",
      intent: "step_verdict",
      evidenceRefs: ["call-1"],
    });
    assert.equal(wb.length, 1);
    assert.equal(wb[0].kind, "handoff");
  });
});
