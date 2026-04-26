import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  summarizeContextForPrompt,
  appendixForReflectorPrompt,
} from "../lib/agents/runtime/context.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { DataSummary } from "../shared/schema.js";

const baseSummary: DataSummary = {
  rowCount: 1,
  columnCount: 1,
  columns: [{ name: "Sales", type: "number", sampleValues: [1] }],
  numericColumns: ["Sales"],
  dateColumns: [],
};

function ctxWith(domain?: string): AgentExecutionContext {
  return {
    sessionId: "s1",
    question: "trend in sales",
    data: [],
    summary: baseSummary,
    chatHistory: [],
    mode: "analysis",
    domainContext: domain,
  };
}

describe("WD7 · domainContext wiring", () => {
  it("planner summary includes the DOMAIN PACK marker when domainContext is set", () => {
    const text = summarizeContextForPrompt(
      ctxWith("<<DOMAIN PACK: marico-haircare-portfolio>>\nbody\n<</DOMAIN PACK>>")
    );
    assert.match(text, /<<DOMAIN PACK: marico-haircare-portfolio>>/);
    assert.match(text, /Domain knowledge \(Marico\/FMCG/);
    assert.match(text, /never as numeric evidence/);
  });

  it("reflector appendix includes the DOMAIN PACK marker when domainContext is set", () => {
    const text = appendixForReflectorPrompt(
      ctxWith("<<DOMAIN PACK: marico-haircare-portfolio>>\nbody\n<</DOMAIN PACK>>")
    );
    assert.match(text, /<<DOMAIN PACK: marico-haircare-portfolio>>/);
  });

  it("emits no domain block when domainContext is undefined", () => {
    const planner = summarizeContextForPrompt(ctxWith(undefined));
    const reflector = appendixForReflectorPrompt(ctxWith(undefined));
    assert.doesNotMatch(planner, /Domain knowledge/);
    assert.doesNotMatch(planner, /<<DOMAIN PACK:/);
    assert.doesNotMatch(reflector, /<<DOMAIN PACK:/);
  });

  it("emits no domain block when domainContext is empty/whitespace", () => {
    const planner = summarizeContextForPrompt(ctxWith("   \n  \t  "));
    assert.doesNotMatch(planner, /<<DOMAIN PACK:/);
    assert.doesNotMatch(planner, /Domain knowledge/);
  });

  it("truncates the domain block at the configured cap", () => {
    const longBody = "x".repeat(20_000);
    const text = summarizeContextForPrompt(ctxWith(longBody));
    // Default cap is 12_000; we expect the prefix label + 12_000 chars from the
    // domain string. Allow a little slack for the surrounding label characters.
    const labelIdx = text.indexOf("never as numeric evidence");
    assert.ok(labelIdx >= 0, "label must be present");
    const tail = text.slice(labelIdx);
    // The tail should NOT contain the full 20_000 x's; cap to 12_000 means the
    // total length including the label/header is well under 13_000.
    assert.ok(tail.length < 13_000, `expected <13000 chars after label, got ${tail.length}`);
  });
});
