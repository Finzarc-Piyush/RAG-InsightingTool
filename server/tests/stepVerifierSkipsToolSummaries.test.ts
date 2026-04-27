import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * W1 invariant — the step-level verifier must only run when the tool emitted
 * an actual narrative `answerFragment`. Analytical tools (execute_query_plan,
 * run_analytical_query, derive_dimension_bucket, add_computed_columns,
 * run_readonly_sql) emit `result.summary` only — a structured data digest, not
 * a prose answer — and feeding that to the narrative-quality verifier produces
 * false-positive MISSING_NARRATIVE / MISSING_MAGNITUDES verdicts plus noisy
 * verifier-rewrite-step flow_decisions.
 *
 * This test pins the gate in source so a refactor cannot silently re-enable
 * the false-positive path.
 */
describe("step-level verifier skips analytical tool summaries (Wave W1)", () => {
  it("agentLoop.service.ts gates the per-step verifier on result.answerFragment", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const srcPath = join(here, "../lib/agents/runtime/agentLoop.service.ts");
    const src = await readFile(srcPath, "utf8");

    // The new gate constant must exist.
    assert.match(
      src,
      /const\s+hasNarrativeCandidate\s*=\s*Boolean\(result\.answerFragment\?\.trim\(\)\)/,
      "Expected `hasNarrativeCandidate` gate based on answerFragment to be present"
    );

    // The per-step verifier loop must live inside the `if (hasNarrativeCandidate) { ... }` branch.
    const gateIndex = src.indexOf("if (hasNarrativeCandidate)");
    const verifierCallIndex = src.indexOf("await runVerifier(");
    assert.ok(gateIndex > 0, "Expected `if (hasNarrativeCandidate)` branch");
    assert.ok(
      verifierCallIndex > gateIndex,
      "Expected per-step `runVerifier` call to follow the hasNarrativeCandidate gate"
    );

    // The flow_decision for verifier-rewrite-step must also be inside the gate
    // (so analytical tools do not emit it).
    const stepFlowDecisionIndex = src.indexOf('layer: "verifier-rewrite-step"');
    assert.ok(
      stepFlowDecisionIndex > gateIndex,
      "Expected verifier-rewrite-step flow_decision to be emitted only inside hasNarrativeCandidate branch"
    );
  });

  it("Verifier→Coordinator step_verdict inter-agent message is gated on a real verdict", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const srcPath = join(here, "../lib/agents/runtime/agentLoop.service.ts");
    const src = await readFile(srcPath, "utf8");

    // Collapse whitespace so the regex tolerates indentation tweaks.
    const collapsed = src.replace(/\s+/g, " ");

    // The Verifier step_verdict block must be wrapped in `if (lv) { … }` so
    // skipped-verifier steps do not emit a fake handoff message with an empty
    // verdict field.
    assert.match(
      collapsed,
      /if \(lv\) \{ appendInterAgentMessage\( trace, \{ from: "Verifier", to: "Coordinator", intent: "step_verdict",/,
      "Expected step_verdict inter-agent message to be gated on a non-empty verdict"
    );
  });
});
