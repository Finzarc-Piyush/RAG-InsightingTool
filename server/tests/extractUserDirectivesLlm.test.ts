// Wave W-UD5 · pins the LLM-based directive extractor and the
// deterministic/LLM merge.
//
// We exercise the LLM extractor against the W18 stub harness so the
// MINI-tier call short-circuits without touching the network. The
// merge function is exercised directly with synthetic inputs.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installLlmStub, clearLlmStub } from "./helpers/llmStub.js";
import { LLM_PURPOSE } from "../lib/agents/runtime/llmCallPurpose.js";
import {
  extractUserDirectivesLlm,
  mergeDirectiveExtractions,
  __clearDirectiveLlmCacheForTesting,
  __structuralKeyForTesting,
} from "../lib/agents/runtime/extractUserDirectivesLlm.js";
import type {
  DataSummary,
  UserDirective,
} from "../shared/schema.js";
import type { ExtractedDirective } from "../lib/agents/runtime/extractUserDirectives.js";

function fakeSummary(): DataSummary {
  return {
    rowCount: 100,
    columns: [
      {
        name: "Brand",
        type: "string",
        topValues: [
          { value: "Pure Sense", count: 10 },
          { value: "Marico", count: 30 },
          { value: "Parachute", count: 20 },
        ],
      },
      { name: "Sales", type: "number" },
    ],
    numericColumns: ["Sales"],
    dateColumns: [],
  } as unknown as DataSummary;
}

function fakeActive(id: string, column = "Brand", values = ["Pure Sense"], op: "in" | "not_in" = "not_in"): UserDirective {
  return {
    id,
    scope: "dataset",
    kind: op === "in" ? "include-only" : "exclude",
    text: `prior ${id}`,
    structured: { column, op, values },
    source: "chat-message",
    addedAt: 1,
    status: "active",
  };
}

beforeEach(() => {
  __clearDirectiveLlmCacheForTesting();
});

afterEach(() => {
  clearLlmStub();
  __clearDirectiveLlmCacheForTesting();
});

test("extractUserDirectivesLlm returns drafts when the model emits structured exclusions", async () => {
  installLlmStub({
    [LLM_PURPOSE.DIRECTIVE_EXTRACTION]: () => ({
      directives: [
        {
          kind: "exclude",
          text: "I'd really prefer that we not bring up Hair Oil any more",
          column: "Brand",
          op: "not_in",
          values: ["Pure Sense"],
        },
      ],
    }),
  });

  const out = await extractUserDirectivesLlm({
    message: "I'd really prefer that we not bring up Hair Oil any more",
    summary: fakeSummary(),
    existingDirectives: [],
    sourceSessionId: "sess-1",
    sourceTurnId: "turn-1",
    datasetFingerprint: "fp-x",
  });

  assert.equal(out.length, 1);
  assert.equal(out[0]!.draft.kind, "exclude");
  assert.equal(out[0]!.draft.structured?.column, "Brand");
  assert.equal(out[0]!.draft.structured?.op, "not_in");
  assert.deepEqual(out[0]!.draft.structured?.values, ["Pure Sense"]);
  assert.equal(out[0]!.draft.scope, "dataset");
  assert.equal(out[0]!.draft.source, "chat-message");
  assert.equal(out[0]!.draft.sourceSessionId, "sess-1");
});

test("hallucinated supersedeIds are filtered against the active-directive set", async () => {
  const existing = [fakeActive("real-1")];
  installLlmStub({
    [LLM_PURPOSE.DIRECTIVE_EXTRACTION]: () => ({
      directives: [
        {
          kind: "include-only",
          text: "actually include Pure Sense going forward",
          column: "Brand",
          op: "in",
          values: ["Pure Sense"],
          supersedeIds: ["real-1", "ghost-id", "another-ghost"],
        },
      ],
    }),
  });

  const out = await extractUserDirectivesLlm({
    message: "actually include Pure Sense going forward",
    summary: fakeSummary(),
    existingDirectives: existing,
    datasetFingerprint: "fp-x",
  });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0]!.draft.supersedes, ["real-1"]);
});

test("free-text directives (no column) survive the prompt round-trip", async () => {
  installLlmStub({
    [LLM_PURPOSE.DIRECTIVE_EXTRACTION]: () => ({
      directives: [
        {
          kind: "free-text",
          text: "from now on never use the word 'segment' in any answer",
        },
      ],
    }),
  });

  const out = await extractUserDirectivesLlm({
    message: "from now on never use the word 'segment' in any answer",
    summary: fakeSummary(),
    existingDirectives: [],
    datasetFingerprint: "fp-x",
  });

  assert.equal(out.length, 1);
  assert.equal(out[0]!.draft.kind, "free-text");
  assert.equal(out[0]!.draft.structured, undefined);
});

test("empty model output returns [] and is cached", async () => {
  let callCount = 0;
  installLlmStub({
    [LLM_PURPOSE.DIRECTIVE_EXTRACTION]: () => {
      callCount += 1;
      return { directives: [] };
    },
  });

  const args = {
    message: "show me brand-wise sales",
    summary: fakeSummary(),
    existingDirectives: [],
    datasetFingerprint: "fp-x",
  };
  const first = await extractUserDirectivesLlm(args);
  const second = await extractUserDirectivesLlm(args);
  assert.deepEqual(first, []);
  assert.deepEqual(second, []);
  // The second call must have hit the cache.
  assert.equal(callCount, 1);
});

test("cache key changes when existing directive ids change", async () => {
  let callCount = 0;
  installLlmStub({
    [LLM_PURPOSE.DIRECTIVE_EXTRACTION]: () => {
      callCount += 1;
      return { directives: [] };
    },
  });

  const base = {
    message: "from now on omit Pure Sense",
    summary: fakeSummary(),
    datasetFingerprint: "fp-x",
  };
  await extractUserDirectivesLlm({ ...base, existingDirectives: [] });
  await extractUserDirectivesLlm({ ...base, existingDirectives: [fakeActive("d1")] });
  await extractUserDirectivesLlm({ ...base, existingDirectives: [fakeActive("d1"), fakeActive("d2", "Brand", ["Marico"])] });
  // Three distinct cache keys → three LLM calls.
  assert.equal(callCount, 3);
});

test("LLM extractor never throws — non-ok completeJson collapses to []", async () => {
  installLlmStub({
    [LLM_PURPOSE.DIRECTIVE_EXTRACTION]: () => {
      throw new Error("simulated provider 500");
    },
  });
  const out = await extractUserDirectivesLlm({
    message: "always omit Pure Sense",
    summary: fakeSummary(),
    existingDirectives: [],
    datasetFingerprint: "fp-x",
  });
  assert.deepEqual(out, []);
});

test("mergeDirectiveExtractions — deterministic wins on structural overlap", () => {
  const sharedSpan = "from now on omit Pure Sense";
  const deterministic: ExtractedDirective[] = [
    {
      draft: {
        scope: "dataset",
        kind: "exclude",
        text: sharedSpan,
        structured: { column: "Brand", op: "not_in", values: ["Pure Sense"] },
        source: "chat-message",
        supersedes: ["det-supersede"],
      },
      triggerSpan: sharedSpan,
    },
  ];
  const llm: ExtractedDirective[] = [
    {
      draft: {
        scope: "dataset",
        kind: "exclude",
        text: sharedSpan,
        structured: { column: "Brand", op: "not_in", values: ["Pure Sense"] },
        source: "chat-message",
        supersedes: ["llm-hallucinated"],
      },
      triggerSpan: sharedSpan,
    },
  ];
  const merged = mergeDirectiveExtractions(deterministic, llm);
  assert.equal(merged.length, 1);
  // Deterministic entry — its supersedes wins.
  assert.deepEqual(merged[0]!.draft.supersedes, ["det-supersede"]);
});

test("mergeDirectiveExtractions — LLM-only items survive deduplication", () => {
  const det: ExtractedDirective[] = [
    {
      draft: {
        scope: "dataset",
        kind: "exclude",
        text: "from now on omit Pure Sense",
        structured: { column: "Brand", op: "not_in", values: ["Pure Sense"] },
        source: "chat-message",
      },
      triggerSpan: "from now on omit Pure Sense",
    },
  ];
  const llm: ExtractedDirective[] = [
    {
      draft: {
        scope: "dataset",
        kind: "free-text",
        text: "by default keep your answers under 200 words",
        source: "chat-message",
      },
      triggerSpan: "by default keep your answers under 200 words",
    },
  ];
  const merged = mergeDirectiveExtractions(det, llm);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]!.draft.kind, "exclude");
  assert.equal(merged[1]!.draft.kind, "free-text");
});

test("structuralKey is invariant to value ordering", () => {
  const a: ExtractedDirective = {
    draft: {
      scope: "dataset",
      kind: "exclude",
      text: "x",
      structured: { column: "Brand", op: "not_in", values: ["A", "B", "C"] },
      source: "chat-message",
    },
    triggerSpan: "x",
  };
  const b: ExtractedDirective = {
    draft: {
      scope: "dataset",
      kind: "exclude",
      text: "x",
      structured: { column: "Brand", op: "not_in", values: ["C", "A", "B"] },
      source: "chat-message",
    },
    triggerSpan: "x",
  };
  assert.equal(__structuralKeyForTesting(a), __structuralKeyForTesting(b));
});

test("empty input message short-circuits with no LLM call", async () => {
  let calls = 0;
  installLlmStub({
    [LLM_PURPOSE.DIRECTIVE_EXTRACTION]: () => {
      calls += 1;
      return { directives: [] };
    },
  });
  const out = await extractUserDirectivesLlm({
    message: "   ",
    summary: fakeSummary(),
    existingDirectives: [],
    datasetFingerprint: "fp-x",
  });
  assert.deepEqual(out, []);
  assert.equal(calls, 0);
});
