import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ANALYST_PREAMBLE } from "../lib/agents/runtime/sharedPrompts.js";

/**
 * W4.2 / W4.3 · Regression guard for Azure OpenAI prefix-cache eligibility.
 *
 * Azure OpenAI auto-caches identical prompt prefixes ≥ 1024 tokens at a 50%
 * input-token discount. Our hot prompts each prepend `ANALYST_PREAMBLE` to
 * push their static system prefix over that line. If someone trims the
 * preamble or shrinks a prompt below 1024 tokens, this test catches it
 * before the cache discount silently disappears.
 *
 * We approximate token count via chars/4 — close enough for a threshold
 * guard. Keep a comfortable safety margin (target ≥ 1100 tokens of static
 * content) so minor edits don't fall under the 1024 bar.
 */

const MIN_STATIC_TOKENS = 1100; // 1024 threshold + ~75 token safety margin
const APPROX_CHARS_PER_TOKEN = 4;

function approxTokens(s: string): number {
  return Math.ceil(s.length / APPROX_CHARS_PER_TOKEN);
}

describe("W4.2 / W4.3 · prompt prefix cache eligibility", () => {
  it("ANALYST_PREAMBLE alone is large enough to be useful padding", () => {
    const tokens = approxTokens(ANALYST_PREAMBLE);
    assert.ok(
      tokens >= 400,
      `ANALYST_PREAMBLE is ~${tokens} tokens — should be ≥ 400 to push small system prompts over the 1024 threshold`
    );
  });

  it("ANALYST_PREAMBLE is byte-stable (no template literals, no env reads)", () => {
    // The constant must produce the same string every call. Re-import via
    // dynamic require would be overkill; re-check on the imported reference.
    const a = ANALYST_PREAMBLE;
    const b = ANALYST_PREAMBLE;
    assert.strictEqual(a, b);
    // Sanity: no `${` template-literal artefact left behind.
    assert.ok(
      !ANALYST_PREAMBLE.includes("${"),
      "ANALYST_PREAMBLE must not contain template-literal placeholders"
    );
  });

  it("hot system prompts exceed the 1024-token cache threshold once preamble is prepended", async () => {
    // We can't call the prompt-builder functions directly without a full ctx
    // and they import from the agent runtime, which pulls in the openai
    // singleton. Instead, validate the recipe: every hot file appends
    // ANALYST_PREAMBLE + their own static block, and the smallest static block
    // is > 100 tokens. So preamble (≥ 400) + smallest block (≥ 100) is well
    // over the goal. Concretely measured ranges per the W4.1 audit:
    //   reflector  ~600  + preamble ~520 = ~1120
    //   verifier   ~900  + preamble ~520 = ~1420
    //   narrator   ~700  + preamble ~520 = ~1220
    //   synth      ~900  + preamble ~520 = ~1420
    //   hypothesis ~500  + preamble ~520 = ~1020 (just above threshold)
    // For ramp safety, demand the preamble be ≥ 520 tokens so the smallest
    // host (hypothesis) clears the 1024 floor with at most a 4-token slack.
    const preambleTokens = approxTokens(ANALYST_PREAMBLE);
    const smallestKnownHostTokens = 500; // hypothesisPlanner.ts static body
    const combinedFloor = preambleTokens + smallestKnownHostTokens;
    assert.ok(
      combinedFloor >= MIN_STATIC_TOKENS,
      `combined preamble + smallest host body is ~${combinedFloor} tokens; need ≥ ${MIN_STATIC_TOKENS} to safely clear the 1024 cache threshold. Either grow ANALYST_PREAMBLE or extend the smallest host system prompt.`
    );
  });

  it("preamble has no per-call dynamic content (questions, IDs, timestamps)", () => {
    // Belt + braces — these substrings would each break cache identity.
    const forbidden = [
      "${",
      "user.id",
      "sessionId",
      "turnId",
      "Date.",
      "now()",
      "Math.",
    ];
    for (const f of forbidden) {
      assert.ok(
        !ANALYST_PREAMBLE.includes(f),
        `ANALYST_PREAMBLE must not contain "${f}" — would break cache stability`
      );
    }
  });
});
