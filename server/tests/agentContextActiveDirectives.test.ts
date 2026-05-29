// Wave W-UD3 · pin that `buildAgentExecutionContext` accepts and propagates
// `activeDirectives` through to the runtime context.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAgentExecutionContext } from "../lib/agents/runtime/context.js";
import type { UserDirective, DataSummary } from "../shared/schema.js";

const emptySummary: DataSummary = {
  rowCount: 0,
  columnCount: 0,
  columns: [],
  numericColumns: [],
  dateColumns: [],
};

const sampleDirective: UserDirective = {
  id: "01HXTEST",
  scope: "dataset",
  kind: "exclude",
  text: "from now on omit Hair Oil from any category breakdown",
  source: "chat-message",
  addedAt: Date.now(),
  status: "active",
};

describe("W-UD3 · buildAgentExecutionContext threads activeDirectives", () => {
  it("propagates an empty list as undefined when not provided", () => {
    const ctx = buildAgentExecutionContext({
      sessionId: "s1",
      question: "show me brand-wise sales",
      data: [],
      summary: emptySummary,
      chatHistory: [],
      mode: "analysis",
    });
    assert.equal(ctx.activeDirectives, undefined);
  });

  it("propagates a provided directives array verbatim", () => {
    const ctx = buildAgentExecutionContext({
      sessionId: "s1",
      question: "show me brand-wise sales",
      data: [],
      summary: emptySummary,
      chatHistory: [],
      mode: "analysis",
      activeDirectives: [sampleDirective],
    });
    assert.equal(ctx.activeDirectives?.length, 1);
    assert.equal(ctx.activeDirectives?.[0]?.id, "01HXTEST");
    assert.equal(ctx.activeDirectives?.[0]?.kind, "exclude");
  });

  it("preserves multiple directives in order", () => {
    const a: UserDirective = { ...sampleDirective, id: "id-a", text: "first" };
    const b: UserDirective = { ...sampleDirective, id: "id-b", text: "second" };
    const c: UserDirective = { ...sampleDirective, id: "id-c", text: "third" };
    const ctx = buildAgentExecutionContext({
      sessionId: "s1",
      question: "anything",
      data: [],
      summary: emptySummary,
      chatHistory: [],
      mode: "analysis",
      activeDirectives: [a, b, c],
    });
    assert.deepEqual(
      ctx.activeDirectives?.map((d) => d.id),
      ["id-a", "id-b", "id-c"]
    );
  });

  it("does not mutate the input directives array", () => {
    const input = [sampleDirective];
    const ctx = buildAgentExecutionContext({
      sessionId: "s1",
      question: "anything",
      data: [],
      summary: emptySummary,
      chatHistory: [],
      mode: "analysis",
      activeDirectives: input,
    });
    assert.equal(ctx.activeDirectives, input, "passed by reference, not cloned");
    assert.equal(input.length, 1, "input still untouched");
  });
});
