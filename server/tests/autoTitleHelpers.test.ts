// Wave V-AT3 · pins the deterministic title helpers — the always-available
// fallback the auto-titler uses when the LLM times out / errors. The LLM path
// and the Cosmos RMW write are exercised by hand; here we lock the pure shaping
// so a refactor can't silently produce ugly or oversized sidebar names.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { sanitizeTitle, deterministicTitleFromQuestion } = await import(
  "../services/chat/autoTitleAnalysis.js"
);

describe("V-AT3 · sanitizeTitle", () => {
  it("strips surrounding quotes and trailing punctuation", () => {
    assert.equal(sanitizeTitle('"Q3 Haircare Decline."'), "Q3 Haircare Decline");
  });

  it("drops a trailing file extension", () => {
    assert.equal(sanitizeTitle("sales.xlsx"), "sales");
  });

  it("collapses whitespace and clamps to 60 chars", () => {
    const out = sanitizeTitle("word ".repeat(40));
    assert.ok(out.length <= 60, `expected <=60, got ${out.length}`);
    assert.ok(!/\s{2,}/.test(out), "should not contain double whitespace");
  });
});

describe("V-AT3 · deterministicTitleFromQuestion", () => {
  it("keeps the first ~8 words and drops the trailing question mark", () => {
    const out = deterministicTitleFromQuestion(
      "Why did haircare sales decline in Q3 across the south region last year?"
    );
    assert.equal(out, "Why did haircare sales decline in Q3 across");
  });

  it("returns an empty string for an empty question", () => {
    assert.equal(deterministicTitleFromQuestion("   "), "");
  });
});
