// Wave V-AT2 · pins the "auto-title once, then only the user renames" rule.
// `isAutoTitleEligible` is the pure gate the mutator re-checks against the FRESH
// doc inside `mutateChatDocument`, so a user rename that races the background
// titler always wins (eligibility flips to false → the mutator aborts).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

process.env.AZURE_OPENAI_API_KEY ??= "test";
process.env.AZURE_OPENAI_ENDPOINT ??= "https://test.openai.azure.com";
process.env.AZURE_OPENAI_DEPLOYMENT_NAME ??= "test-deployment";

const { isAutoTitleEligible } = await import("../models/chat.model.js");

const U = "owner@x.com";

describe("V-AT2 · auto-title eligibility", () => {
  it("eligible when the name is still the default (no titleSource)", () => {
    assert.equal(isAutoTitleEligible({ username: U }, U), true);
  });

  it("NOT eligible once auto-titled", () => {
    assert.equal(
      isAutoTitleEligible({ username: U, titleSource: "auto" }, U),
      false
    );
  });

  it("NOT eligible once the user has renamed it", () => {
    assert.equal(
      isAutoTitleEligible({ username: U, titleSource: "user" }, U),
      false
    );
  });

  it("NOT eligible for a different user (defensive auth)", () => {
    assert.equal(
      isAutoTitleEligible({ username: "someone@else.com" }, U),
      false
    );
  });
});
