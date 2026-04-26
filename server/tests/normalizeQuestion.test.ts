import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeQuestionForCache } from "../lib/cache/normalizeQuestion.js";

/**
 * W5.1 · normalizeQuestionForCache.
 *
 * Critical contract: the function is called at WRITE time (when the chat
 * stream persists `pastAnalysisDoc.normalizedQuestion`) and at LOOKUP time
 * (the AI Search exact-match filter `normalizedQuestion eq @nq`). If the two
 * code paths produce different strings for the same input, every cache lookup
 * misses. These tests pin both behaviours and edge cases.
 */

describe("normalizeQuestionForCache · trivial folds", () => {
  it("lowercases", () => {
    assert.strictEqual(
      normalizeQuestionForCache("What Is the Total Sales?"),
      "what is the total sales"
    );
  });

  it("collapses runs of whitespace into a single space", () => {
    assert.strictEqual(
      normalizeQuestionForCache("show   sales   by  region"),
      "show sales by region"
    );
  });

  it("collapses tabs and newlines as whitespace", () => {
    assert.strictEqual(
      normalizeQuestionForCache("show\tsales\nby region"),
      "show sales by region"
    );
  });

  it("strips leading and trailing whitespace", () => {
    assert.strictEqual(
      normalizeQuestionForCache("   what are q3 sales   "),
      "what are q3 sales"
    );
  });

  it("strips trailing punctuation runs", () => {
    assert.strictEqual(normalizeQuestionForCache("how are sales???"), "how are sales");
    assert.strictEqual(normalizeQuestionForCache("show me revenue!"), "show me revenue");
    assert.strictEqual(normalizeQuestionForCache("regions."), "regions");
    assert.strictEqual(normalizeQuestionForCache("regions...!?!"), "regions");
  });
});

describe("normalizeQuestionForCache · idempotence (write/read symmetry)", () => {
  it("calling twice produces the same result", () => {
    const inputs = [
      "What is the trend of Sales by Order Date?",
      "  show   me  by REGION ",
      "anomalies in Q3 sales???",
      "Compare west to east revenue YoY.",
    ];
    for (const q of inputs) {
      const a = normalizeQuestionForCache(q);
      const b = normalizeQuestionForCache(a);
      assert.strictEqual(a, b, `not idempotent for: ${q}`);
    }
  });
});

describe("normalizeQuestionForCache · collisions to reject", () => {
  it("treats empty / whitespace-only input as ungueessable empty string", () => {
    // The chatStream writer treats "" as "do not cache" so an empty question
    // can't poison the cache via collision.
    assert.strictEqual(normalizeQuestionForCache(""), "");
    assert.strictEqual(normalizeQuestionForCache("   "), "");
    assert.strictEqual(normalizeQuestionForCache("\n\n\t"), "");
  });

  it("does NOT merge questions that differ in non-trailing punctuation", () => {
    // mid-sentence punctuation must be preserved — "what's q3?" vs
    // "what is q3?" are typed differently and may signal different intent.
    const a = normalizeQuestionForCache("what's q3 sales?");
    const b = normalizeQuestionForCache("whats q3 sales?");
    assert.notStrictEqual(a, b);
  });

  it("does NOT fold synonyms (revenue / sales stay distinct)", () => {
    assert.notStrictEqual(
      normalizeQuestionForCache("what is total revenue"),
      normalizeQuestionForCache("what is total sales")
    );
  });

  it("does NOT strip leading question marks (would change meaning)", () => {
    // Realistic: someone writing "?? what now" — keep that quirk.
    assert.strictEqual(
      normalizeQuestionForCache("?? what now"),
      "?? what now"
    );
  });

  it("preserves numeric distinctions", () => {
    assert.notStrictEqual(
      normalizeQuestionForCache("top 5 customers"),
      normalizeQuestionForCache("top 10 customers")
    );
  });
});

describe("normalizeQuestionForCache · type-safety", () => {
  it("returns empty string for non-string input rather than throwing", () => {
    // Callers may pass through user-typed JSON / undefined fields. Be tolerant.
    assert.strictEqual(
      normalizeQuestionForCache(undefined as unknown as string),
      ""
    );
    assert.strictEqual(
      normalizeQuestionForCache(null as unknown as string),
      ""
    );
    assert.strictEqual(
      normalizeQuestionForCache(123 as unknown as string),
      ""
    );
  });
});
