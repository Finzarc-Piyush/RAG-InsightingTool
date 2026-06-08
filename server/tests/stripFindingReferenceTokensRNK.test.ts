import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripFindingReferenceTokens } from "../lib/agents/runtime/narratorAgent.js";

/**
 * RNK-f6 · the narrator sometimes echoes internal blackboard finding-reference
 * tokens ([f1], [f6], …) into user-facing prose. `stripFindingReferenceTokens`
 * removes them defensively before the answer is rendered. These tests pin the
 * behaviour: finding refs go, everything else stays.
 */
describe("RNK-f6 · stripFindingReferenceTokens", () => {
  it("strips a trailing finding ref (the reported [f6] bug)", () => {
    assert.equal(
      stripFindingReferenceTokens(
        "Arindam Mazumdar leads on GCPC with 257, a clear drop after the top three. [f6]"
      ),
      "Arindam Mazumdar leads on GCPC with 257, a clear drop after the top three."
    );
  });

  it("strips multiple refs anywhere in the text", () => {
    assert.equal(
      stripFindingReferenceTokens("First [f1] then second [f2] then tenth [f10]."),
      "First then second then tenth."
    );
  });

  it("is case-insensitive ([F6] also stripped)", () => {
    assert.equal(stripFindingReferenceTokens("Top performer [F6]"), "Top performer");
  });

  it("leaves backtick-wrapped domain-pack citations untouched", () => {
    const s = "Per `marico-haircare-portfolio`, premiumisation is rising.";
    assert.equal(stripFindingReferenceTokens(s), s);
  });

  it("leaves ordinary bracketed text and numbers untouched", () => {
    assert.equal(
      stripFindingReferenceTokens("Revenue was $257K [approx] in segment [A] (n=75)."),
      "Revenue was $257K [approx] in segment [A] (n=75)."
    );
  });

  it("is a no-op when there are no finding refs", () => {
    const s = "The top three TSOs are clearly separated from the rest.";
    assert.equal(stripFindingReferenceTokens(s), s);
  });
});
