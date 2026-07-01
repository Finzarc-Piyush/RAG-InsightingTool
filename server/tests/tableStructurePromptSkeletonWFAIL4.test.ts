import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SYSTEM_PROMPT } from "../lib/tableStructure/llmAdjudicate.js";

/**
 * W-FAIL4 · The table-structure adjudicator prompt previously said only "Return
 * ONLY JSON matching the schema" with no field skeleton, so gpt-5.4-mini kept
 * omitting the six required numeric fields (llm_json_retry x2 on every upload
 * before the safe Tier-1 fallback). It now shows the exact required shape and a
 * worked example — mirroring the SEED_SYSTEM pattern that does NOT fail.
 */
describe("W-FAIL4 table-structure prompt skeleton", () => {
  it("names all six required region fields + marks them REQUIRED", () => {
    for (const field of [
      "headerRowStart",
      "headerRowEnd",
      "dataRowStart",
      "dataRowEnd",
      "colStart",
      "colEnd",
    ]) {
      assert.ok(SYSTEM_PROMPT.includes(field), `prompt should mention ${field}`);
    }
    assert.match(SYSTEM_PROMPT, /REQUIRED/);
  });

  it("includes a concrete worked example object", () => {
    // The example line demonstrates a valid, fully-populated object.
    assert.match(SYSTEM_PROMPT, /Example/);
    assert.match(SYSTEM_PROMPT, /"headerRowStart":\s*1/);
    assert.match(SYSTEM_PROMPT, /"dataRowEnd":\s*-1/);
  });
});
