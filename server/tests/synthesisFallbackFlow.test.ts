import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * W4 invariants — when the answer came from the deterministic fallback
 * renderer (answerSource === "fallback"), the final verifier MUST be skipped
 * and a flow_decision { layer: "verifier-rewrite-final", chosen:
 * "fallback-skipped" } MUST be emitted. The verifier critiques narratives;
 * a fallback render is data, not narrative.
 *
 * Pinning the skip in source rather than via an integration test keeps the
 * cost low while still catching accidental re-introduction of the
 * always-runs-final-verifier behaviour.
 */

describe("final verifier skipped on fallback (Wave W4)", () => {
  let src = "";
  it("loads agentLoop source", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const srcPath = join(here, "../lib/agents/runtime/agentLoop.service.ts");
    src = await readFile(srcPath, "utf8");
    assert.ok(src.length > 0);
  });

  it("emits a 'fallback-skipped' flow_decision before the verifier loop", () => {
    // The skip block must appear *above* the `while` that drives the verifier
    // rounds, so the runVerifier call never fires for fallback answers.
    const skipChosenIdx = src.indexOf('chosen: "fallback-skipped"');
    const skipReasonIdx = src.indexOf("Synthesis fallback used; verifier skipped");
    assert.ok(skipChosenIdx > 0, "Expected `chosen: \"fallback-skipped\"` flow_decision");
    assert.ok(skipReasonIdx > 0, "Expected the skip-reason string in source");

    const finalVerifierWhileIdx = src.indexOf(
      'while (answerSource !== "fallback" && finalRound < config.maxVerifierRoundsFinal)'
    );
    assert.ok(
      finalVerifierWhileIdx > 0,
      "Expected the final-verifier `while` loop to be guarded on answerSource !== 'fallback'"
    );
    assert.ok(
      skipChosenIdx < finalVerifierWhileIdx,
      "fallback-skipped emission must precede the final-verifier loop in source order"
    );
  });

  it("guards the verifier `while` loop on answerSource !== 'fallback'", () => {
    // Direct text match — if anyone refactors this and removes the guard,
    // the test fails immediately.
    assert.match(
      src,
      /while \(answerSource !== "fallback" && finalRound < config\.maxVerifierRoundsFinal\)/,
      "final-verifier loop must be gated on answerSource !== 'fallback'"
    );
  });

  it("treats every SynthesisSource except fallback_dump as a real narrative", () => {
    // The mapping `env.source === 'fallback_dump' ? 'fallback' : 'synthesizer'`
    // ensures narrative_retry / plain_text_retry / json_envelope all keep the
    // verifier engaged.
    assert.match(
      src,
      /env\.source === "fallback_dump" \? "fallback" : "synthesizer"/,
      "answerSource mapping must classify only fallback_dump as 'fallback'"
    );
  });

  it("the synthesizer's failure path also marks answerSource as 'fallback'", () => {
    const collapsed = src.replace(/\s+/g, " ");
    assert.match(
      collapsed,
      /agentLog\("synthesis_error", \{[^}]+\}\); answer = observationsFallbackAnswer\(\); answerSource = "fallback";/,
      "synthesis_error catch block must set answerSource = 'fallback'"
    );
    assert.match(
      collapsed,
      /preservedAnswer = fb; answerSource = "fallback"; agentLog\("synthesis_empty_fallback"/,
      "post-visual-planner emergency rescue must set answerSource = 'fallback'"
    );
  });
});
