// Wave W-UD8 · pins the integration contract between the four cap sites
// (synthesis, business-actions, blackboard, datasetProfile) and the
// `TrimmedBlockInfo` sink threaded through `AgentExecutionContext`.
//
// We exercise each cap site in isolation with synthetic input that
// exceeds the historical fixed cap, and assert that a row is appended
// to the sink with the right id + char counts. The intent is to lock
// the SSE contract: if the cap site silently stops trimming, this test
// will fail.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSynthesisContext } from "../lib/agents/runtime/buildSynthesisContext.js";
import { formatForNarrator, createBlackboard, type DomainContextEntry } from "../lib/agents/runtime/analyticalBlackboard.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { TrimmedBlockInfo } from "../lib/agents/runtime/promptBudget.js";

function makeCtx(overrides: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
  return {
    sessionId: "s",
    question: "q",
    data: [],
    summary: { rowCount: 0, columns: [], numericColumns: [], dateColumns: [] } as any,
    chatHistory: [],
    mode: "analysis",
    ...overrides,
  } as AgentExecutionContext;
}

test("buildSynthesisContext.permanentNotes — user notes are surfaced IN FULL, never trimmed", () => {
  const sink: TrimmedBlockInfo[] = [];
  // A long "Give Additional Context" note must reach the writer verbatim — no cap.
  const ctx = makeCtx({ permanentContext: "x".repeat(5000) });
  const bundle = buildSynthesisContext(ctx, { contextTrimmedSink: sink });
  // The full 5000 chars appear (would fail if any cap clipped it).
  assert.ok(bundle.userBlock.includes("x".repeat(5000)));
  // And NO trim event is recorded for user notes.
  const evt = sink.find((s) => s.id === "synthesis.permanentNotes");
  assert.equal(evt, undefined, "user notes must not record a trim event");
});

test("buildSynthesisContext.domainBlock — over-cap domain context records a trim event", () => {
  const sink: TrimmedBlockInfo[] = [];
  const ctx = makeCtx({ domainContext: "d".repeat(20000) });
  const bundle = buildSynthesisContext(ctx, { contextTrimmedSink: sink });
  assert.equal(bundle.domainBlock.length, 9000);
  const evt = sink.find((s) => s.id === "synthesis.domainBlock");
  assert.ok(evt);
  assert.equal(evt!.inputChars, 20000);
  assert.equal(evt!.outputChars, 9000);
});

test("buildSynthesisContext — under-cap inputs do NOT push trim events", () => {
  const sink: TrimmedBlockInfo[] = [];
  const ctx = makeCtx({
    permanentContext: "y".repeat(100),
    domainContext: "z".repeat(100),
  });
  buildSynthesisContext(ctx, { contextTrimmedSink: sink });
  assert.equal(sink.length, 0);
});

test("formatForNarrator — blackboard domainContext entry over MAX_CONTEXT_CHARS records a trim", () => {
  const sink: TrimmedBlockInfo[] = [];
  const bb = createBlackboard();
  // domainContext entry > 400 chars triggers truncation.
  const big = "b".repeat(900);
  bb.domainContext.push({ source: "marico-stub", content: big } as DomainContextEntry);
  const formatted = formatForNarrator(bb, sink);
  // The block is included but truncated to 400 chars per entry.
  assert.ok(formatted.includes("b".repeat(400)));
  assert.ok(!formatted.includes("b".repeat(401)));
  const evt = sink.find((s) => s.id.startsWith("blackboard.domainContext"));
  assert.ok(evt);
  assert.equal(evt!.inputChars, 900);
  assert.equal(evt!.outputChars, 400);
});

test("formatForNarrator — under-cap blackboard entry does NOT trim", () => {
  const sink: TrimmedBlockInfo[] = [];
  const bb = createBlackboard();
  bb.domainContext.push({ source: "marico-stub", content: "short fact" } as DomainContextEntry);
  formatForNarrator(bb, sink);
  assert.equal(sink.length, 0);
});

test("buildSynthesisContext — directives slot is reserved (never trimmed)", () => {
  const sink: TrimmedBlockInfo[] = [];
  // Very large directive list; the bundle MUST not push a sink event for it.
  const longDirective = "this is a critical persistent directive ".repeat(200);
  const ctx = makeCtx({
    activeDirectives: [
      {
        id: "d1",
        scope: "dataset",
        kind: "free-text",
        text: longDirective,
        source: "chat-message",
        addedAt: 1,
        status: "active",
      },
    ],
  });
  buildSynthesisContext(ctx, { contextTrimmedSink: sink });
  // No sink event for directives — they are reserved budget.
  for (const evt of sink) {
    assert.ok(
      !evt.id.toLowerCase().includes("directive"),
      `unexpected trim event for directives: ${evt.id}`
    );
  }
});
