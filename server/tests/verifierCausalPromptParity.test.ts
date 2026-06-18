import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * W-CP2 · the LLM verifier prompt must accept the hedged likelyDrivers lane,
 * not fight it. Without this scoping, the advisory rail false-flags the new
 * section and the narrator/verifier loop thrashes on revise_narrative. This is a
 * source-inspection test (mirrors the repo's prompt-pin convention): it asserts
 * the prompt scopes UNSUPPORTED_CAUSAL_CLAIM to the MEASURED layer and exempts
 * the hedged section, so a future edit can't silently re-block it.
 */
const src = readFileSync(
  resolve(new URL("../lib/agents/runtime/verifier.ts", import.meta.url).pathname),
  "utf-8"
);

describe("W-CP2 · verifier prompt scopes causal flagging to the measured layer", () => {
  it("scopes UNSUPPORTED_CAUSAL_CLAIM to the measured layer", () => {
    assert.match(src, /UNSUPPORTED_CAUSAL_CLAIM ONLY for definitive, unhedged causation in the MEASURED layer/);
  });

  it("exempts the hedged likelyDrivers lane (incl. basis=general)", () => {
    assert.match(src, /likelyDrivers\[\] section[^.]*EXPECTED home for hedged mechanism language and must NOT be flagged/);
    assert.match(src, /basis="general" world knowledge is permitted there and ONLY there/);
  });

  it("still guards against a fabricated number inside a mechanism", () => {
    assert.match(src, /FABRICATED_MECHANISM_NUMBER/);
  });
});
