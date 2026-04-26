import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import {
  tryExactQuestionCacheHit,
  trySemanticQuestionCacheHit,
  projectHitToPastAnalysis,
} from "../lib/cache/questionCacheLookup.js";
import type { PastAnalysisSearchDoc } from "../lib/rag/pastAnalysesStore.js";

/**
 * W5.2 · The lookup wrapper must:
 *   - Silently no-op when the feature flag is off (default state).
 *   - Silently no-op when the normalized question is empty.
 *   - Never throw — every failure path returns null so the chat turn proceeds.
 *
 * These tests exercise the pure-logic paths without hitting Azure AI Search.
 * The actual search call is covered by integration tests in `chatStream`.
 */

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("tryExactQuestionCacheHit · feature flag gating", () => {
  it("returns null when QUESTION_CACHE_EXACT_ENABLED is unset", async () => {
    delete process.env.QUESTION_CACHE_EXACT_ENABLED;
    const result = await tryExactQuestionCacheHit({
      sessionId: "sess_x",
      dataVersion: 1,
      question: "what is the total revenue",
    });
    assert.strictEqual(result, null);
  });

  it("returns null when QUESTION_CACHE_EXACT_ENABLED=false", async () => {
    process.env.QUESTION_CACHE_EXACT_ENABLED = "false";
    const result = await tryExactQuestionCacheHit({
      sessionId: "sess_x",
      dataVersion: 1,
      question: "what is the total revenue",
    });
    assert.strictEqual(result, null);
  });

  it("returns null when question normalizes to empty", async () => {
    process.env.QUESTION_CACHE_EXACT_ENABLED = "true";
    // Whitespace-only would hit Azure search with empty filter — refuse instead.
    const result = await tryExactQuestionCacheHit({
      sessionId: "sess_x",
      dataVersion: 1,
      question: "   \n\t   ",
    });
    assert.strictEqual(result, null);
  });
});

describe("trySemanticQuestionCacheHit · feature flag gating", () => {
  it("returns null when QUESTION_CACHE_SEMANTIC_ENABLED is unset", async () => {
    delete process.env.QUESTION_CACHE_SEMANTIC_ENABLED;
    const result = await trySemanticQuestionCacheHit({
      sessionId: "sess_x",
      dataVersion: 1,
      question: "what is the total revenue",
    });
    assert.strictEqual(result, null);
  });

  it("returns null when QUESTION_CACHE_SEMANTIC_ENABLED=false", async () => {
    process.env.QUESTION_CACHE_SEMANTIC_ENABLED = "false";
    const result = await trySemanticQuestionCacheHit({
      sessionId: "sess_x",
      dataVersion: 1,
      question: "what is the total revenue",
    });
    assert.strictEqual(result, null);
  });

  it("returns null when question normalizes to empty", async () => {
    process.env.QUESTION_CACHE_SEMANTIC_ENABLED = "true";
    const result = await trySemanticQuestionCacheHit({
      sessionId: "sess_x",
      dataVersion: 1,
      question: "   \n\t   ",
    });
    assert.strictEqual(result, null);
  });

  it("returns null (never throws) when Azure creds are missing and the embedding call errors", async () => {
    // The function lazy-imports embeddings.ts; in this test env there are no
    // Azure creds so the underlying openai client throws. The outer try/catch
    // MUST swallow that and return null so the chat turn continues normally.
    process.env.QUESTION_CACHE_SEMANTIC_ENABLED = "true";
    const result = await trySemanticQuestionCacheHit({
      sessionId: "sess_x",
      dataVersion: 1,
      question: "what is the total revenue",
    });
    assert.strictEqual(result, null);
  });
});

describe("projectHitToPastAnalysis", () => {
  const searchDoc: PastAnalysisSearchDoc = {
    id: "sess_1__turn_old",
    sessionId: "sess_1",
    userId: "u@example.com",
    turnId: "turn_old",
    dataVersion: 3,
    question: "What is Q3 revenue?",
    normalizedQuestion: "what is q3 revenue",
    answer: "Q3 revenue was $4.2M.",
    feedback: "up",
    outcome: "ok",
    createdAt: 1_773_000_000_000,
    questionVector: [],
  };

  it("projects the search doc + annotates the source + current turnIds", () => {
    const hit = {
      doc: searchDoc,
      source: "exact" as const,
      ageMs: 1000,
    };
    const projected = projectHitToPastAnalysis(hit, "turn_new");
    assert.strictEqual(projected.answer, "Q3 revenue was $4.2M.");
    assert.strictEqual(projected.sessionId, "sess_1");
    assert.strictEqual(projected.dataVersion, 3);
    assert.strictEqual(projected.outcome, "ok");
    assert.strictEqual(projected.sourceTurnId, "turn_old");
    assert.strictEqual(projected.currentTurnId, "turn_new");
  });
});
