import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectMultiPartQuestion } from "../lib/agents/runtime/detectMultiPartQuestion.js";

/**
 * Wave D1 · Pins the multi-part question detector. The detector returns
 * a split intent when the question matches a multi-part conjunction
 * pattern AND each sub-question has substantive content.
 *
 * Conservative — anything ambiguous returns null so the agent loop
 * proceeds to single-flow.
 */

describe("Wave D1 · detectMultiPartQuestion — primary phrasings", () => {
  it("'show me top brands AND why MARICO is leading' splits into two sub-questions", () => {
    const r = detectMultiPartQuestion(
      "Show me the top 10 brands by sales and why MARICO is leading"
    );
    assert.ok(r);
    assert.equal(r!.subQuestions.length, 2);
    assert.match(r!.subQuestions[0]!, /top 10 brands/i);
    assert.match(r!.subQuestions[1]!, /why MARICO/i);
  });

  it("comma-separated 'A, and tell me B' splits cleanly", () => {
    const r = detectMultiPartQuestion(
      "Compare Q3 sales vs Q2, and tell me which channel drove the difference"
    );
    assert.ok(r);
    assert.equal(r!.subQuestions.length, 2);
    assert.match(r!.subQuestions[0]!, /Compare Q3/i);
    assert.match(r!.subQuestions[1]!, /tell me which channel/i);
  });

  it("'X. additionally Y' splits on 'additionally'", () => {
    const r = detectMultiPartQuestion(
      "What's our revenue this quarter; additionally check for anomalies"
    );
    assert.ok(r);
    assert.equal(r!.subQuestions.length, 2);
    assert.match(r!.subQuestions[1]!, /check for anomalies/i);
  });

  it("three-part question splits into 3 sub-questions (max 4)", () => {
    const r = detectMultiPartQuestion(
      "Show top brands, and tell me why MARICO leads, and forecast next quarter"
    );
    assert.ok(r);
    assert.equal(r!.subQuestions.length, 3);
  });
});

describe("Wave D1 · single-shape questions (must NOT split)", () => {
  it("plain 'top 10 brands by sales' → null", () => {
    assert.equal(
      detectMultiPartQuestion("top 10 brands by sales"),
      null
    );
  });

  it("compound metric 'sales and growth by region' → null (not split on 'and')", () => {
    // "sales and growth by region" — the 'and' joins two NOUNS, not two
    // verb-led clauses. The detector must NOT split this.
    assert.equal(
      detectMultiPartQuestion("Show me sales and growth by region"),
      null
    );
  });

  it("'and' between adjectives → null", () => {
    assert.equal(
      detectMultiPartQuestion("Average daily and weekly visit count"),
      null
    );
  });

  it("question too short → null", () => {
    assert.equal(detectMultiPartQuestion("a and b"), null);
  });

  it("empty / nullish → null", () => {
    assert.equal(detectMultiPartQuestion(""), null);
    assert.equal(detectMultiPartQuestion(undefined), null);
  });
});

describe("Wave D1 · explicit-question-word triggers", () => {
  it("'... and what should we do about it' splits", () => {
    const r = detectMultiPartQuestion(
      "What drove the Q3 drop and what should we do about it"
    );
    assert.ok(r);
    assert.equal(r!.subQuestions.length, 2);
  });

  it("'... and how does it compare' splits", () => {
    const r = detectMultiPartQuestion(
      "What's our share in metro stores and how does it compare to rural"
    );
    assert.ok(r);
    assert.equal(r!.subQuestions.length, 2);
  });
});

describe("Wave D1 · cap at 4 sub-questions", () => {
  it("six-clause question caps at 4", () => {
    const r = detectMultiPartQuestion(
      "Show top brands, and tell me why, and forecast next quarter, and check anomalies, and compare regions, and explain Q3"
    );
    assert.ok(r);
    assert.ok(r!.subQuestions.length <= 4);
  });
});
