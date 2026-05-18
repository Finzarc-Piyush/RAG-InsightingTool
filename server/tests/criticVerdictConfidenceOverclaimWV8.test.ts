/**
 * Wave WV8 · workbench surfaces ConfidenceOverclaimReport tier counts.
 *
 * WV3 wired the verifier-side short-circuit: when the narrator inflates
 * confidence past WQ1's deterministic floor, `runVerifier` returns
 * `revise_narrative` with a `CONFIDENCE_OVERCLAIM` issue. But the
 * underlying `ConfidenceOverclaimReport` (claimed vs. actual tier counts)
 * was discarded — the user only saw the verdict + issue code in the
 * workbench, not what the deterministic floor actually disagreed with.
 *
 * WV8 closes the loop: verifier attaches the report to `VerifierResult`,
 * agentLoop.service.ts forwards `claimed` + `actual` on the
 * `critic_verdict` SSE event as a `confidence_overclaim` field, and
 * `agentSseEventToWorkbenchEntries` renders a one-line summary
 * "Narrator confidence: claimed Xh/Ym/Zl; blackboard supports Xh/Ym/Zl".
 *
 * Coverage:
 *  - VerifierResult interface carries the optional report (source).
 *  - verifier.ts WV3 short-circuit attaches the report (source).
 *  - agentLoop.service.ts spreads `confidence_overclaim` on both
 *    critic_verdict emit sites (source).
 *  - agentWorkbench.util.ts CriticSse type + `formatConfidenceOverclaim`
 *    helper exists (source).
 *  - agentSseEventToWorkbenchEntries renders the WV8 line when the field
 *    is present + skips it when absent (behaviour).
 *  - Defensive parsing: missing/garbage counts default to "0h/0m/0l";
 *    all-zero counts suppress the line.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { agentSseEventToWorkbenchEntries } from "../services/chat/agentWorkbench.util.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("Wave WV8 · VerifierResult carries the WV3 report (source-inspection)", () => {
  it("types.ts adds optional confidenceOverclaim to VerifierResult", () => {
    const src = readFileSync(
      resolve(__dirname, "../lib/agents/runtime/types.ts"),
      "utf8",
    );
    assert.ok(
      /confidenceOverclaim\?:\s*import\("\.\/verifierConfidenceCheck\.js"\)\.ConfidenceOverclaimReport/.test(
        src,
      ),
      "VerifierResult must carry an optional confidenceOverclaim field typed against verifierConfidenceCheck.ConfidenceOverclaimReport",
    );
  });

  it("verifier.ts WV3 short-circuit attaches the report to the returned verdict", () => {
    const src = readFileSync(
      resolve(__dirname, "../lib/agents/runtime/verifier.ts"),
      "utf8",
    );
    // The block returns must include confidenceOverclaim: report so
    // agentLoop.service.ts can read it on the FINAL critic_verdict path.
    assert.ok(
      src.includes("confidenceOverclaim: report"),
      "verifier.ts WV3 short-circuit return must include confidenceOverclaim: report",
    );
  });
});

describe("Wave WV8 · agentLoop forwards the report on critic_verdict (source-inspection)", () => {
  it("both critic_verdict safeEmit sites spread confidence_overclaim when populated", () => {
    const src = readFileSync(
      resolve(__dirname, "../lib/agents/runtime/agentLoop.service.ts"),
      "utf8",
    );
    // Per-step site uses `verdict.confidenceOverclaim`; final site uses
    // `fv.confidenceOverclaim`. Both must spread the shaped payload.
    assert.ok(
      src.includes("verdict.confidenceOverclaim"),
      "per-step critic_verdict emit must check verdict.confidenceOverclaim",
    );
    assert.ok(
      src.includes("fv.confidenceOverclaim"),
      "final critic_verdict emit must check fv.confidenceOverclaim",
    );
    // The shaped payload — claimed + actual nested under confidence_overclaim.
    const occurrences = (
      src.match(/confidence_overclaim: \{\s*claimed: /g) ?? []
    ).length;
    assert.ok(
      occurrences >= 2,
      `expected ≥2 critic_verdict emit sites to forward confidence_overclaim.claimed, saw ${occurrences}`,
    );
  });
});

describe("Wave WV8 · agentWorkbench.util.ts renders the WV8 line", () => {
  it("CriticSse type carries the optional confidence_overclaim field", () => {
    const src = readFileSync(
      resolve(__dirname, "../services/chat/agentWorkbench.util.ts"),
      "utf8",
    );
    assert.ok(
      /confidence_overclaim\?:/.test(src),
      "CriticSse must include confidence_overclaim?: nested shape",
    );
    assert.ok(
      src.includes("formatConfidenceOverclaim"),
      "agentWorkbench.util.ts must define formatConfidenceOverclaim",
    );
  });

  it("renders 'Narrator confidence:' line on critic_verdict when overclaim is present", () => {
    const entries = agentSseEventToWorkbenchEntries("critic_verdict", {
      stepId: "final",
      verdict: "revise_narrative",
      issue_codes: ["CONFIDENCE_OVERCLAIM"],
      course_correction: "revise_narrative",
      confidence_overclaim: {
        claimed: { high: 5, medium: 0, low: 0, total: 5 },
        actual: { high: 2, medium: 1, low: 1, total: 4 },
      },
    });
    assert.equal(entries.length, 1, "exactly one workbench entry for the critic_verdict");
    const code = entries[0].code ?? "";
    assert.ok(
      code.includes("Narrator confidence: claimed 5h/0m/0l; blackboard supports 2h/1m/1l"),
      `workbench entry code must surface the claimed-vs-actual line; got:\n${code}`,
    );
    // Other parts still rendered.
    assert.ok(code.includes("Verdict: revise_narrative"));
    assert.ok(code.includes("Issues: CONFIDENCE_OVERCLAIM"));
  });

  it("omits the WV8 line entirely when confidence_overclaim is absent (no regression)", () => {
    const entries = agentSseEventToWorkbenchEntries("critic_verdict", {
      stepId: "final",
      verdict: "pass",
      issue_codes: [],
      course_correction: "",
    });
    assert.equal(entries.length, 1);
    const code = entries[0].code ?? "";
    assert.ok(
      !code.includes("Narrator confidence"),
      `pass verdicts must NOT carry the WV8 line; got:\n${code}`,
    );
    assert.ok(code.includes("Verdict: pass"));
  });

  it("defensive parsing: missing/garbage counts default to 0h/0m/0l, all-zero suppresses the line", () => {
    // All-zero counts → formatConfidenceOverclaim returns "" → line dropped by filter(Boolean).
    const allZero = agentSseEventToWorkbenchEntries("critic_verdict", {
      stepId: "final",
      verdict: "revise_narrative",
      issue_codes: ["CONFIDENCE_OVERCLAIM"],
      course_correction: "revise_narrative",
      confidence_overclaim: {
        claimed: { high: 0, medium: 0, low: 0, total: 0 },
        actual: { high: 0, medium: 0, low: 0, total: 0 },
      },
    });
    const code1 = allZero[0].code ?? "";
    assert.ok(
      !code1.includes("Narrator confidence"),
      "all-zero counts must suppress the WV8 line",
    );

    // Missing actual → defaults to 0h/0m/0l on that side, line still renders
    // (claimed side is non-zero so the comparison is meaningful).
    const missingActual = agentSseEventToWorkbenchEntries("critic_verdict", {
      stepId: "final",
      verdict: "revise_narrative",
      issue_codes: ["CONFIDENCE_OVERCLAIM"],
      course_correction: "revise_narrative",
      confidence_overclaim: {
        claimed: { high: 3, medium: 0, low: 0, total: 3 },
      },
    });
    const code2 = missingActual[0].code ?? "";
    assert.ok(
      code2.includes("Narrator confidence: claimed 3h/0m/0l; blackboard supports 0h/0m/0l"),
      `missing actual must default to 0h/0m/0l; got:\n${code2}`,
    );

    // Garbage numbers (NaN, negative) clamp to 0 via Math.max + Math.floor.
    const garbage = agentSseEventToWorkbenchEntries("critic_verdict", {
      stepId: "final",
      verdict: "revise_narrative",
      issue_codes: ["CONFIDENCE_OVERCLAIM"],
      course_correction: "revise_narrative",
      confidence_overclaim: {
        claimed: { high: NaN as unknown as number, medium: -3, low: 1.7, total: 5 },
        actual: { high: 1, medium: 0, low: 0, total: 1 },
      },
    });
    const code3 = garbage[0].code ?? "";
    assert.ok(
      code3.includes("Narrator confidence: claimed 0h/0m/1l; blackboard supports 1h/0m/0l"),
      `garbage counts must clamp to non-negative integers; got:\n${code3}`,
    );
  });
});
