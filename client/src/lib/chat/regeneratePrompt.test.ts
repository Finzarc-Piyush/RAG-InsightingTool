import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRegenerateQuestion } from "./regeneratePrompt.js";

/**
 * W9 · regenerate constraint prompt builder.
 *
 * The host (Home page) re-submits `questionToSubmit` verbatim. If the
 * constraint phrasing here drifts, "Make it longer" might silently stop
 * making it longer — we want the test to flag that.
 */
describe("buildRegenerateQuestion", () => {
  const q = "Why did Q3 sales drop in West?";

  it("default constraint passes the question through unchanged", () => {
    assert.strictEqual(buildRegenerateQuestion(q, "default"), q);
  });

  it("longer prepends a 'more thorough' instruction", () => {
    const out = buildRegenerateQuestion(q, "longer");
    assert.match(out, /thorough/i);
    assert.match(out, /longer/i);
    assert.ok(out.endsWith(q));
  });

  it("shorter prepends a 'tighter' instruction", () => {
    const out = buildRegenerateQuestion(q, "shorter");
    assert.match(out, /tighter|shorter/i);
    assert.ok(out.endsWith(q));
  });

  it("more_technical and less_technical are distinct prompts", () => {
    const more = buildRegenerateQuestion(q, "more_technical");
    const less = buildRegenerateQuestion(q, "less_technical");
    assert.notStrictEqual(more, less);
    assert.match(more, /technical/i);
    assert.match(less, /simpler|less technical/i);
  });
});
