/**
 * Wave WV3 · verifier.ts wiring of WV1's `detectConfidenceOverclaims`.
 *
 * Confirms the new pre-LLM short-circuit:
 *  - When narrator inflates confidence (block / warning flag), `runVerifier`
 *    returns `revise_narrative` with the `CONFIDENCE_OVERCLAIM` issue code
 *    BEFORE incurring the deep-verifier LLM cost.
 *  - When `narratorOutput` is omitted (per-step rounds), the detector path
 *    is skipped (asserted via source inspection — the per-step runVerifier
 *    call site in agentLoop.service.ts does not pass narratorOutput).
 *  - Severity mapping: `block` → "high", `warning` → "medium".
 *  - `user_visible_note` is populated on block severity.
 *
 * The detector itself is unit-tested in `verifierConfidenceCheckWV1.test.ts`;
 * this test covers the verifier-side wiring + the agentLoop call site.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { runVerifier } from "../lib/agents/runtime/verifier.js";
import { VERIFIER_VERDICT } from "../lib/agents/runtime/schemas.js";
import {
  addFinding,
  createBlackboard,
} from "../lib/agents/runtime/analyticalBlackboard.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { NarratorOutput } from "../lib/agents/runtime/narratorAgent.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeCtx(): AgentExecutionContext {
  return {
    sessionId: "wv3-test",
    question: "Why did sales drop in Q3?",
    data: [],
    summary: {
      rowCount: 0,
      columns: [],
      numericColumns: [],
      dateColumns: [],
    },
    chatHistory: [],
    mode: "analysis",
  } as unknown as AgentExecutionContext;
}

describe("Wave WV3 · verifier wires detectConfidenceOverclaims (pre-LLM)", () => {
  it("returns revise_narrative with CONFIDENCE_OVERCLAIM when narrator marks every magnitude high and blackboard has a low finding (block severity)", async () => {
    const ctx = makeCtx();
    const bb = createBlackboard();
    addFinding(bb, {
      sourceRef: "weak",
      label: "Tentative regional dip",
      detail: "Sample of 4 stores; no significance test.",
      significance: "notable",
    });
    addFinding(bb, {
      sourceRef: "strong",
      label: "Strong price effect",
      detail: "R² = 0.78, n = 1200, p < 0.001.",
      significance: "notable",
    });
    const narratorOutput: NarratorOutput = {
      body: "Sales declined.",
      magnitudes: [
        { label: "Volume drop", value: "-12%", confidence: "high" },
        { label: "Price elasticity", value: "1.4", confidence: "high" },
      ],
    };

    // onLlmCall must NOT fire — WV3 short-circuit returns before the LLM.
    let llmCalls = 0;
    const out = await runVerifier(
      ctx,
      {
        candidate: "Plain narrative without chart JSON or magnitudes.",
        evidenceSummary: "(unused)",
        stepId: "final",
        turnId: "t-wv3-block",
        blackboard: bb,
        narratorOutput,
      },
      () => {
        llmCalls += 1;
      },
    );

    assert.equal(out.verdict, VERIFIER_VERDICT.reviseNarrative);
    assert.equal(out.course_correction, VERIFIER_VERDICT.reviseNarrative);
    assert.equal(llmCalls, 0, "WV3 must short-circuit before any LLM call");
    const codes = out.issues.map((i) => i.code);
    assert.ok(codes.includes("CONFIDENCE_OVERCLAIM"), "expected CONFIDENCE_OVERCLAIM in issues");
    // Block severity present → at least one issue at severity "high".
    assert.ok(out.issues.some((i) => i.severity === "high"), "block flag should map to severity=high");
    assert.ok(
      typeof out.user_visible_note === "string" && out.user_visible_note.length > 0,
      "block severity should populate user_visible_note",
    );
  });

  it("returns revise_narrative with CONFIDENCE_OVERCLAIM (medium severity) when narrator high count exceeds blackboard high count without a block-level flag", async () => {
    const ctx = makeCtx();
    const bb = createBlackboard();
    // Single low-evidence finding — no high in blackboard.
    addFinding(bb, {
      sourceRef: "weak1",
      label: "Tentative dip",
      detail: "Sample of 5 stores.",
      significance: "notable",
    });
    // Narrator hedges ONE magnitude as medium → not "all high" → block rule
    // does not fire. high count (1) still exceeds blackboard high count (0)
    // → warning rule fires.
    const narratorOutput: NarratorOutput = {
      body: "Mixed signals.",
      magnitudes: [
        { label: "Volume drop", value: "-12%", confidence: "high" },
        { label: "Channel mix", value: "+3pt", confidence: "medium" },
      ],
    };

    let llmCalls = 0;
    const out = await runVerifier(
      ctx,
      {
        candidate: "Plain narrative without chart JSON.",
        evidenceSummary: "(unused)",
        stepId: "final",
        turnId: "t-wv3-warning",
        blackboard: bb,
        narratorOutput,
      },
      () => {
        llmCalls += 1;
      },
    );

    assert.equal(out.verdict, VERIFIER_VERDICT.reviseNarrative);
    assert.equal(llmCalls, 0, "warning flag must also short-circuit before LLM");
    assert.ok(out.issues.every((i) => i.code === "CONFIDENCE_OVERCLAIM"));
    assert.ok(
      out.issues.every((i) => i.severity === "medium"),
      "warning-only should map to severity=medium",
    );
    assert.equal(
      out.user_visible_note,
      undefined,
      "non-block severity should leave user_visible_note unset",
    );
  });

  it("verifier.ts imports detectConfidenceOverclaims + NarratorOutput (wiring is present in source)", () => {
    const src = readFileSync(
      resolve(__dirname, "../lib/agents/runtime/verifier.ts"),
      "utf8",
    );
    assert.ok(
      src.includes('from "./verifierConfidenceCheck.js"'),
      "verifier.ts must import detectConfidenceOverclaims",
    );
    assert.ok(
      src.includes("detectConfidenceOverclaims("),
      "verifier.ts must call detectConfidenceOverclaims",
    );
    assert.ok(
      src.includes('code: "CONFIDENCE_OVERCLAIM"'),
      "verifier.ts must emit the new CONFIDENCE_OVERCLAIM issue code",
    );
    assert.ok(
      src.includes("narratorOutput?: NarratorOutput"),
      "runVerifier must accept an optional narratorOutput param",
    );
  });

  it("agentLoop.service.ts final-verifier call site passes narratorOutput; per-step call site does not", () => {
    const src = readFileSync(
      resolve(__dirname, "../lib/agents/runtime/agentLoop.service.ts"),
      "utf8",
    );
    // Final verifier round constructs wv3NarratorOutput from hoisted envelope state.
    assert.ok(
      src.includes("wv3NarratorOutput"),
      "agentLoop must construct wv3NarratorOutput for the final verifier",
    );
    assert.ok(
      /narratorOutput:\s*wv3NarratorOutput/.test(src),
      "agentLoop must pass narratorOutput: wv3NarratorOutput to the final runVerifier",
    );
  });
});
