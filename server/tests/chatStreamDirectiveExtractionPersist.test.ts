// Wave W-UD-integration · pins the `persistDirectivesFromUserMessage`
// helper that the chatStream service invokes on every user turn.
//
// Tested in isolation (against the helper's injectable seams) rather
// than the 4 KLOC `processStreamChat` host so the contract — extract →
// append → onAdded loop, per-draft failure isolation, no-throw on
// extractor blowup — is pinned without dragging in SSE plumbing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { persistDirectivesFromUserMessage } from "../services/chat/chatStreamDirectivePersist.js";
import type { DirectiveDraft } from "../models/datasetDirectives.model.js";
import type { DataSummary, UserDirective } from "../shared/schema.js";
import type { ExtractedDirective } from "../lib/agents/runtime/extractUserDirectives.js";

const FINGERPRINT = "fp_test_0000000a";
const USERNAME = "tida@example.com";

function fakeSummary(): DataSummary {
  return {
    rowCount: 100,
    columns: [
      { name: "Brand", type: "string", topValues: [{ value: "Pure Sense", count: 10 }] },
      { name: "Sales", type: "number" },
    ],
    numericColumns: ["Sales"],
    dateColumns: [],
  } as unknown as DataSummary;
}

function fakeDraft(text: string, columnValue = "Pure Sense"): DirectiveDraft {
  return {
    scope: "dataset",
    kind: "exclude",
    text,
    structured: { column: "Brand", op: "not_in", values: [columnValue] },
    source: "chat-message",
    sourceSessionId: "sess-1",
    sourceTurnId: "turn-1",
  };
}

function fakeExtracted(text: string, columnValue = "Pure Sense"): ExtractedDirective {
  return { draft: fakeDraft(text, columnValue), triggerSpan: text };
}

function makeFakeAppender() {
  const calls: Array<{ username: string; fingerprint: string; draft: DirectiveDraft }> = [];
  let counter = 0;
  const fn = async (
    username: string,
    fingerprint: string,
    draft: DirectiveDraft
  ): Promise<{ directive: UserDirective }> => {
    calls.push({ username, fingerprint, draft });
    counter += 1;
    const directive: UserDirective = {
      id: `id-${counter}`,
      scope: draft.scope ?? "dataset",
      kind: draft.kind,
      text: draft.text,
      structured: draft.structured,
      source: draft.source,
      sourceSessionId: draft.sourceSessionId,
      sourceTurnId: draft.sourceTurnId,
      addedAt: 1000 + counter,
      status: "active",
    };
    return { directive };
  };
  return { fn, calls };
}

test("extract → append → onAdded fires once per persisted directive", async () => {
  const extracted = [
    fakeExtracted("from now on omit Pure Sense from brand breakdown"),
    fakeExtracted("always exclude Marico from brand views", "Marico"),
  ];
  const { fn: appendDirective, calls } = makeFakeAppender();
  const onAddedCalls: UserDirective[] = [];

  const result = await persistDirectivesFromUserMessage({
    username: USERNAME,
    fingerprint: FINGERPRINT,
    message: "(ignored — extractor is stubbed)",
    summary: fakeSummary(),
    existingDirectives: [],
    sourceSessionId: "sess-1",
    sourceTurnId: "turn-1",
    appendDirective,
    onAdded: (d) => onAddedCalls.push(d),
    extractor: () => extracted,
  });

  assert.equal(result.extracted.length, 2);
  assert.equal(result.persisted.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(onAddedCalls.length, 2);
  // username + fingerprint are forwarded verbatim.
  for (const c of calls) {
    assert.equal(c.username, USERNAME);
    assert.equal(c.fingerprint, FINGERPRINT);
  }
  // Persisted records are returned in append order with assigned ids.
  assert.equal(result.persisted[0]!.id, "id-1");
  assert.equal(result.persisted[1]!.id, "id-2");
});

test("empty extractor result short-circuits — no appender calls, no onAdded", async () => {
  const { fn: appendDirective, calls } = makeFakeAppender();
  let onAddedCalls = 0;

  const result = await persistDirectivesFromUserMessage({
    username: USERNAME,
    fingerprint: FINGERPRINT,
    message: "show me brand-wise sales",
    summary: fakeSummary(),
    existingDirectives: [],
    appendDirective,
    onAdded: () => onAddedCalls++,
    extractor: () => [],
  });

  assert.equal(result.extracted.length, 0);
  assert.equal(result.persisted.length, 0);
  assert.equal(calls.length, 0);
  assert.equal(onAddedCalls, 0);
});

test("a throwing appender on one draft does not abort the rest of the loop", async () => {
  const extracted = [
    fakeExtracted("from now on omit Pure Sense", "Pure Sense"),
    fakeExtracted("always exclude Marico", "Marico"),
    fakeExtracted("always exclude Parachute", "Parachute"),
  ];
  let call = 0;
  const errors: unknown[] = [];
  const appendDirective = async (
    _u: string,
    _f: string,
    draft: DirectiveDraft
  ): Promise<{ directive: UserDirective }> => {
    call += 1;
    if (call === 2) throw new Error("transient Cosmos write failure");
    return {
      directive: {
        id: `ok-${call}`,
        scope: draft.scope ?? "dataset",
        kind: draft.kind,
        text: draft.text,
        structured: draft.structured,
        source: draft.source,
        addedAt: call,
        status: "active",
      },
    };
  };

  const onAddedIds: string[] = [];
  const result = await persistDirectivesFromUserMessage({
    username: USERNAME,
    fingerprint: FINGERPRINT,
    message: "(stubbed)",
    summary: fakeSummary(),
    existingDirectives: [],
    appendDirective,
    onAdded: (d) => onAddedIds.push(d.id),
    extractor: () => extracted,
    onError: (e) => errors.push(e),
  });

  // All three drafts attempted, two succeeded, one error captured.
  assert.equal(call, 3);
  assert.equal(result.extracted.length, 3);
  assert.equal(result.persisted.length, 2);
  assert.deepEqual(onAddedIds, ["ok-1", "ok-3"]);
  assert.equal(errors.length, 1);
});

test("extractor throw is swallowed and returns empty result (never bubbles)", async () => {
  const { fn: appendDirective, calls } = makeFakeAppender();
  const errors: unknown[] = [];

  const result = await persistDirectivesFromUserMessage({
    username: USERNAME,
    fingerprint: FINGERPRINT,
    message: "(stubbed)",
    summary: fakeSummary(),
    existingDirectives: [],
    appendDirective,
    extractor: () => {
      throw new Error("regex blew up");
    },
    onError: (e, ctx) => errors.push({ ctx, e }),
  });

  assert.deepEqual(result, { extracted: [], persisted: [] });
  assert.equal(calls.length, 0);
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as { ctx: { phase: string } }).ctx.phase, "extract");
});

test("a throwing onAdded notifier does not block subsequent persists", async () => {
  const extracted = [
    fakeExtracted("from now on omit Pure Sense", "Pure Sense"),
    fakeExtracted("always exclude Marico", "Marico"),
  ];
  const { fn: appendDirective, calls } = makeFakeAppender();
  const errors: Array<{ phase: string }> = [];
  let notifyCount = 0;

  const result = await persistDirectivesFromUserMessage({
    username: USERNAME,
    fingerprint: FINGERPRINT,
    message: "(stubbed)",
    summary: fakeSummary(),
    existingDirectives: [],
    appendDirective,
    onAdded: () => {
      notifyCount += 1;
      throw new Error("sse stream broken");
    },
    extractor: () => extracted,
    onError: (_e, ctx) => errors.push(ctx),
  });

  // Both drafts still persisted, both notifiers attempted, both errors captured.
  assert.equal(result.persisted.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(notifyCount, 2);
  assert.equal(errors.length, 2);
  for (const e of errors) assert.equal(e.phase, "append");
});

test("W-UD-gate · a plain question with no persistence marker never persists an LLM-mined rule", async () => {
  // The LLM extractor mis-fires and mints a directive from a plain analytical
  // question; the deterministic gate must drop it before any append/onAdded.
  const { fn: appendDirective, calls } = makeFakeAppender();
  const onAddedCalls: UserDirective[] = [];

  const result = await persistDirectivesFromUserMessage({
    username: USERNAME,
    fingerprint: FINGERPRINT,
    message: "avg clock in time by cluster",
    summary: fakeSummary(),
    existingDirectives: [],
    appendDirective,
    onAdded: (d) => onAddedCalls.push(d),
    extractor: () => [], // deterministic finds nothing (no persistence marker)
    llmExtractor: async () => [fakeExtracted("avg clock in time by cluster")],
  });

  assert.equal(result.extracted.length, 0);
  assert.equal(result.persisted.length, 0);
  assert.equal(calls.length, 0);
  assert.equal(onAddedCalls.length, 0);
});

test("W-UD-gate · a marker-bearing instruction still persists the LLM-mined rule", async () => {
  // "from now on …" carries an explicit persistence marker → the gate must NOT
  // suppress; the genuine standing rule is persisted.
  const { fn: appendDirective, calls } = makeFakeAppender();

  const result = await persistDirectivesFromUserMessage({
    username: USERNAME,
    fingerprint: FINGERPRINT,
    message: "from now on always exclude Cluster 2 WEST",
    summary: fakeSummary(),
    existingDirectives: [],
    appendDirective,
    extractor: () => [], // isolate the LLM path
    llmExtractor: async () => [
      fakeExtracted("from now on always exclude Cluster 2 WEST", "Cluster 2 WEST"),
    ],
  });

  assert.equal(result.persisted.length, 1);
  assert.equal(calls.length, 1);
});

test("existingDirectives + sourceSessionId/sourceTurnId are forwarded to the extractor", async () => {
  const captured: Array<{
    existing: UserDirective[];
    sid?: string;
    tid?: string;
  }> = [];
  const existing: UserDirective[] = [
    {
      id: "pre-1",
      scope: "dataset",
      kind: "exclude",
      text: "old",
      structured: { column: "Brand", op: "not_in", values: ["Pure Sense"] },
      source: "chat-message",
      addedAt: 1,
      status: "active",
    },
  ];

  const { fn: appendDirective } = makeFakeAppender();
  await persistDirectivesFromUserMessage({
    username: USERNAME,
    fingerprint: FINGERPRINT,
    message: "always include Pure Sense",
    summary: fakeSummary(),
    existingDirectives: existing,
    sourceSessionId: "sess-99",
    sourceTurnId: "turn-77",
    appendDirective,
    extractor: (input) => {
      captured.push({
        existing: input.existingDirectives ?? [],
        sid: input.sourceSessionId,
        tid: input.sourceTurnId,
      });
      return [];
    },
  });

  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0]!.existing, existing);
  assert.equal(captured[0]!.sid, "sess-99");
  assert.equal(captured[0]!.tid, "turn-77");
});
