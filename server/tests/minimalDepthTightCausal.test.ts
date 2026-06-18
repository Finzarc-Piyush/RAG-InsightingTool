import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ANSWER_ENVELOPE_CONTRACT,
  CAUSAL_HEDGE_TERMS,
} from "../lib/agents/runtime/sharedPrompts.js";

/**
 * W-CP1 · the causal "why" is a first-class envelope field available at ALL
 * depths — the conciseness waves gate the heavy investigation/hypothesis
 * machinery for minimal asks, but they must NOT suppress the tight hedged "why".
 * The mechanism that guarantees this is the SHARED ANSWER_ENVELOPE_CONTRACT
 * (used verbatim by both the narrator and the synthesizer fallback, regardless of
 * depthBudget). These source-inspection assertions pin that the contract:
 *   (a) segregates causation (measured layer stays factual),
 *   (b) opens the hedged likelyDrivers lane with its three hard rails,
 *   (c) permits world-knowledge ("general") basis ONLY in that lane.
 * If a future edit re-bans causation or moves it behind a depth gate, this fails.
 */
describe("W-CP1 · ANSWER_ENVELOPE_CONTRACT permits a hedged causal lane at all depths", () => {
  it("segregates causation rather than banning it", () => {
    assert.match(ANSWER_ENVELOPE_CONTRACT, /CAUSATION IS SEGREGATED/);
    // the old absolute prohibition must be gone
    assert.doesNotMatch(
      ANSWER_ENVELOPE_CONTRACT,
      /Never speculate about causes the data does not show/
    );
  });

  it("specifies the likelyDrivers lane with all three hard rails", () => {
    assert.match(ANSWER_ENVELOPE_CONTRACT, /"likelyDrivers"/);
    assert.match(ANSWER_ENVELOPE_CONTRACT, /ALWAYS HEDGE/);
    assert.match(ANSWER_ENVELOPE_CONTRACT, /DECLARE GROUNDING via `basis`/);
    assert.match(ANSWER_ENVELOPE_CONTRACT, /NEVER A NUMBER IN A MECHANISM/);
  });

  it("permits world-knowledge ('general') basis only inside likelyDrivers", () => {
    assert.match(ANSWER_ENVELOPE_CONTRACT, /`general` is allowed HERE and nowhere else/);
  });

  it("uses at least one canonical hedge term in its own worked example", () => {
    const usesAHedge = CAUSAL_HEDGE_TERMS.some((t) =>
      ANSWER_ENVELOPE_CONTRACT.toLowerCase().includes(t)
    );
    assert.equal(usesAHedge, true);
  });
});
