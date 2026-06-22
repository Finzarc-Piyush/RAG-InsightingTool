/**
 * ============================================================================
 * verifier.ts — the fact-checker that grades the agent's draft answer
 * ============================================================================
 * WHAT THIS FILE DOES
 *   After the agent drafts an answer (or part of one), this "verifier" double-
 *   checks it before it reaches the user. It assumes the draft might be WRONG
 *   and looks for problems: a chart pointing at a column that doesn't exist or
 *   the wrong chart type; numbers in the prose that no chart actually supports
 *   (fabrication); a filter the plan inferred but never actually applied;
 *   anomalous findings the narrative quietly dropped; or confidence claims that
 *   outrun the evidence. It runs cheap deterministic (pure-logic) checks first
 *   and short-circuits on those, then — if the draft survives — sends it to a
 *   powerful "deep verifier" LLM that returns a structured verdict.
 *
 *   A verdict is one of a fixed set: pass / revise_narrative (just rewrite the
 *   words) / retry_tool / replan / ask_user / abort_partial. Each comes with a
 *   list of issues (code, severity, description) and a recommended next action.
 *
 * WHY IT MATTERS
 *   This is the quality gate that makes answers "decision-grade" — it is what
 *   catches hallucinated numbers and unsupported causal claims before a user
 *   acts on them. The deterministic pre-checks save money by rejecting obvious
 *   problems without paying for the LLM, and `rewriteNarrative` lets the system
 *   fix wording issues in place instead of re-running the whole investigation.
 *
 * KEY PIECES
 *   - runVerifier(ctx, params, onLlmCall) — the orchestrator: runs the chart
 *     pre-check, filter-fidelity check, missing-findings check, confidence-
 *     overclaim check, and numeric-fabrication check; if all pass, calls the
 *     deep-verifier LLM and returns its verdict. Falls back to `pass` if the
 *     LLM call itself fails (never blocks an answer on verifier downtime).
 *   - chartPrecheck(candidate, ctx) — pure check for bad axes, bar-on-time, and
 *     unreadable high-cardinality series.
 *   - rewriteNarrative(ctx, bad, issues, ...) — given the issues, asks the LLM
 *     to rewrite the draft while staying grounded in the evidence.
 *   - Re-exports `checkInferredFilterFidelity` / `checkMissingFindings` from
 *     ./verifierHelpers.js (pure fns kept separate so they're testable without
 *     the OpenAI dependency).
 *
 * HOW IT CONNECTS
 *   Reads the shared evidence board (./analyticalBlackboard.js) and the
 *   narrator's output (./narratorAgent.js). Verdicts use the
 *   VERIFIER_VERDICT constants from ./schemas.ts (invariant: never raw string
 *   literals). Helper checks live in ./verifierHelpers.js,
 *   ./verifierConfidenceCheck.js, and ./verifyNarrativeNumbers.js. The deep
 *   verifier call goes through `completeJson` (./llmJson.js) routed by
 *   LLM_PURPOSE.VERIFIER_DEEP. Called by the act loop to gate each step and the
 *   final answer.
 */
import type { AgentExecutionContext, PlanStep } from "./types.js";
import { formatAnalysisBriefForPrompt } from "./analysisBrief.js";
import type { VerifierResult, VerdictType } from "./types.js";
import { verifierOutputSchema, VERIFIER_VERDICT } from "./schemas.js";
import { completeJson } from "./llmJson.js";
import { LLM_PURPOSE } from "./llmCallPurpose.js";
import { ANALYST_PREAMBLE } from "./sharedPrompts.js";
import { chartSpecSchema } from "../../../shared/schema.js";
import { isTemporalChartX } from "../../chartTypeAuthority.js";
import type { AnalyticalBlackboard } from "./analyticalBlackboard.js";
import { checkInferredFilterFidelity } from "./verifierHelpers.js";
import { detectConfidenceOverclaims } from "./verifierConfidenceCheck.js";
import { detectUnsupportedCausalClaims } from "./verifierCausalCheck.js";
import type { NarratorOutput } from "./narratorAgent.js";
export { checkInferredFilterFidelity };

function chartPrecheck(
  candidate: string,
  ctx: AgentExecutionContext
): VerifierResult | null {
  const allow = new Set(ctx.summary.columns.map((c) => c.name));
  const tryParse = (s: string) => {
    try {
      const j = JSON.parse(s);
      return chartSpecSchema.safeParse(j);
    } catch {
      return null;
    }
  };
  if (!candidate.includes('"x"') || !candidate.includes('"y"')) return null;
  const block = candidate.match(/\{[\s\S]*"x"[\s\S]*"y"[\s\S]*\}/);
  if (!block) return null;
  const p = tryParse(block[0]);
  if (!p || !p.success) return null;
  if (!allow.has(p.data.x) || !allow.has(p.data.y)) {
    return {
      verdict: VERIFIER_VERDICT.reviseNarrative,
      issues: [
        {
          code: "BAD_CHART_AXIS",
          severity: "high",
          description: "Chart axis not in schema",
          evidenceRefs: [],
        },
      ],
      course_correction: VERIFIER_VERDICT.reviseNarrative,
    };
  }
  // Guard: bar chart with a temporal X axis → should be line/area. Uses the
  // single chart-type authority so this predicate stays uniform with
  // chartFromTable / the feature sweep / build_chart (L-019). This stays a
  // VISIBILITY backstop: per the single-flow policy (invariant #6) the verifier
  // flags but does not rewrite — the deterministic FIX lives at construction
  // (build_chart coercion + the feature-sweep facet→line branch).
  const isTemporalX = isTemporalChartX(p.data.x, {
    dateColumns: ctx.summary.dateColumns,
  });
  if (p.data.type === "bar" && isTemporalX) {
    return {
      verdict: VERIFIER_VERDICT.reviseNarrative,
      issues: [
        {
          code: "BAR_ON_TEMPORAL_X",
          severity: "medium",
          description: `x='${p.data.x}' is a temporal column — use type 'line' or 'area' instead of 'bar' for trend charts`,
          evidenceRefs: [],
        },
      ],
      course_correction: VERIFIER_VERDICT.reviseNarrative,
    };
  }
  // Guard: high-cardinality seriesColumn → charts become unreadable
  if (p.data.seriesColumn) {
    const seriesColMeta = ctx.summary.columns.find((c) => c.name === p.data.seriesColumn);
    // topValues is only populated for low-cardinality columns; absent = high cardinality
    const topValCount = seriesColMeta?.topValues?.length ?? 99;
    if (topValCount > 15) {
      return {
        verdict: VERIFIER_VERDICT.reviseNarrative,
        issues: [
          {
            code: "HIGH_SERIES_CARDINALITY",
            severity: "medium",
            description: `seriesColumn '${p.data.seriesColumn}' has >15 distinct values — set max_series (≤15) or use a single-series bar chart sorted by y`,
            evidenceRefs: [],
          },
        ],
        course_correction: VERIFIER_VERDICT.reviseNarrative,
      };
    }
  }
  return null;
}

// Re-exported from verifierHelpers so the pure fn is testable without the OpenAI dep.
export { checkMissingFindings } from "./verifierHelpers.js";
import { checkMissingFindings } from "./verifierHelpers.js";
// Narrative-vs-numbers prefilter (pure logic, no LLM cost).
import { verifyNarrativeAgainstCharts } from "./verifyNarrativeNumbers.js";
import type { ChartSpec } from "../../../shared/schema.js";

/**
 * Tunable thresholds for the narrative-vs-numbers prefilter:
 *  - Need at least N unsupported claims AND at least P% of total claims unsupported
 *    before we early-return revise_narrative. Both gates protect against
 *    single-outlier false positives (e.g. a rounded year mistakenly extracted).
 */
const NARRATIVE_FABRICATION_MIN_COUNT = 2;
const NARRATIVE_FABRICATION_MIN_FRACTION = 0.5;

export async function runVerifier(
  ctx: AgentExecutionContext,
  params: {
    candidate: string;
    evidenceSummary: string;
    stepId: string;
    turnId: string;
    blackboard?: AnalyticalBlackboard;
    /** Current plan steps — used to detect inferred filters that never reached execution. */
    planSteps?: PlanStep[];
    /** Charts produced this turn; powers the narrative-vs-numbers check. */
    charts?: ChartSpec[];
    /**
     * Prior verifier verdicts emitted earlier in THIS turn. Lets the verifier
     * escalate when a previously-flagged issue is being reasserted (e.g.
     * magnitude FABRICATED at step 2 surfaces again at step 5 — bump severity /
     * flip course_correction toward replan).
     */
    priorVerifierVerdicts?: ReadonlyArray<{
      stepIndex: number;
      verdict: string;
      rationale: string;
    }>;
    /**
     * Narrator output (or a partial view of it carrying `magnitudes` +
     * `implications`) so the pre-LLM confidence-overclaim detector can fire.
     * Only meaningful at the FINAL verifier round — per-step rounds pass
     * `undefined` since the narrator hasn't synthesised yet. When present
     * alongside `blackboard`, `detectConfidenceOverclaims` runs and may
     * short-circuit to `revise_narrative` with the `CONFIDENCE_OVERCLAIM`
     * issue code.
     */
    narratorOutput?: NarratorOutput;
  },
  onLlmCall: () => void
): Promise<VerifierResult> {
  const pre = chartPrecheck(params.candidate, ctx);
  if (pre) {
    return pre;
  }

  if (params.planSteps?.length) {
    const missing = checkInferredFilterFidelity(ctx, params.planSteps);
    if (missing.length) {
      return {
        verdict: VERIFIER_VERDICT.replan,
        issues: missing,
        course_correction: VERIFIER_VERDICT.replan,
      };
    }
  }

  // Flag anomalous blackboard findings that the narrative didn't cite.
  if (params.blackboard) {
    const missingIssues = checkMissingFindings(params.candidate, params.blackboard);
    if (missingIssues.length > 0) {
      return {
        verdict: VERIFIER_VERDICT.reviseNarrative,
        issues: missingIssues,
        course_correction: VERIFIER_VERDICT.reviseNarrative,
      };
    }
  }

  // Confidence-overclaim short-circuit. Compares narrator-claimed tier counts
  // on magnitudes + implications against a deterministic assessment of the
  // blackboard's evidence. When the narrator inflated confidence past what the
  // evidence supports (warning or block severity), demand `revise_narrative`
  // BEFORE incurring the deep-verifier LLM cost — an enforcement gate so the
  // deterministic confidence floor actually bites.
  if (params.blackboard && params.narratorOutput) {
    const report = detectConfidenceOverclaims(params.narratorOutput, params.blackboard);
    if (report.shouldRevise) {
      const blocking = report.flags.filter(
        (f) => f.severity === "block" || f.severity === "warning",
      );
      const hasBlock = blocking.some((f) => f.severity === "block");
      return {
        verdict: VERIFIER_VERDICT.reviseNarrative,
        issues: blocking.map((f) => ({
          code: "CONFIDENCE_OVERCLAIM",
          severity: f.severity === "block" ? "high" : "medium",
          description: f.message,
          evidenceRefs: [],
        })),
        course_correction: VERIFIER_VERDICT.reviseNarrative,
        user_visible_note: hasBlock
          ? "Confidence overclaim detected — narrator marked findings high-confidence beyond what the evidence supports."
          : undefined,
        // Attach the report so agentLoop.service.ts can surface claimed-vs-
        // actual tier counts on the critic_verdict SSE payload. The workbench
        // renders these so the user sees what the deterministic floor disagreed
        // with, not just that *something* was overclaimed.
        confidenceOverclaim: report,
      };
    }
  }

  // W-SR2 · deterministic causal-claim rail. The hedged "Why" lane
  // (likelyDrivers) must never let a mechanism masquerade as a fact, carry a
  // fabricated statistic, or claim false data-grounding. This rail ships BEFORE
  // the contract opens the speculation permission (W-CP1), so a gate always
  // exists. Driver-level violations short-circuit to revise_narrative; measured-
  // layer causal connectives are reported (info) and left to the LLM verifier
  // below to avoid revise loops on borderline phrasing it can adjudicate.
  if (params.narratorOutput) {
    const causal = detectUnsupportedCausalClaims(
      params.narratorOutput,
      ctx.summary.columns.map((c) => c.name)
    );
    const blocking = causal.flags.filter(
      (f) => f.severity === "warning" || f.severity === "block"
    );
    if (causal.shouldRevise && blocking.length > 0) {
      return {
        verdict: VERIFIER_VERDICT.reviseNarrative,
        issues: blocking.map((f) => ({
          code: "UNSUPPORTED_CAUSAL_CLAIM",
          severity: f.severity === "block" ? "high" : "medium",
          description: f.message,
          evidenceRefs: [],
        })),
        course_correction: VERIFIER_VERDICT.reviseNarrative,
      };
    }
  }

  // Catch numerical fabrication (the agent quoted a figure no chart supports).
  // Cheap pure-logic check — fires only when there's actual chart data to
  // anchor against AND multiple unsupported claims (single outliers could be a
  // rounding artefact, the regex catching a date, etc.).
  if (params.charts && params.charts.length > 0) {
    const verdict = verifyNarrativeAgainstCharts(params.candidate, params.charts);
    const total = verdict.totalClaims;
    const unsupported = verdict.unsupported.length;
    if (
      unsupported >= NARRATIVE_FABRICATION_MIN_COUNT &&
      total > 0 &&
      unsupported / total >= NARRATIVE_FABRICATION_MIN_FRACTION
    ) {
      const offending = verdict.unsupported
        .slice(0, 6)
        .map((c) => c.raw)
        .join(", ");
      return {
        verdict: VERIFIER_VERDICT.reviseNarrative,
        issues: [
          {
            code: "UNSUPPORTED_NUMERIC_CLAIM",
            severity: "medium",
            description: `Narrative cites ${unsupported}/${total} numbers that no chart row or keyInsight supports within 2% tolerance: ${offending}. Either remove these figures or replace them with values from the chart data.`,
            evidenceRefs: [],
          },
        ],
        course_correction: VERIFIER_VERDICT.reviseNarrative,
      };
    }
  }

  // ANALYST_PREAMBLE prefix → prompt-cache eligibility (>1024 tokens). Below
  // is purely static; everything dynamic (question, brief, evidence, candidate)
  // lives in the user message.
  const system = `${ANALYST_PREAMBLE}You are a verifier, not an assistant. Assume the draft may be wrong.
Compare the candidate answer fragment to the user question and evidence. Output JSON only with:
verdict: pass | revise_narrative | retry_tool | replan | ask_user | abort_partial
issues: array of {code, severity, description, evidence_refs}
course_correction: same enum as verdict (primary action)
user_visible_note: optional string

If evidence includes output from run_analytical_query (numeric/tabular results), treat those numbers as authoritative over retrieved RAG text snippets when they conflict. Use code NUMERIC_MISMATCH when the candidate contradicts analytical evidence.
If evidence states zero rows with diagnostic distinct samples, pass verdict "pass" when the candidate explains that outcome and uses those samples (do not force revise_narrative for grounded empty-result explanations).
CAUSATION IS SEGREGATED. Flag UNSUPPORTED_CAUSAL_CLAIM ONLY for definitive, unhedged causation in the MEASURED layer (body, tldr, findings[], implications[], magnitudes, methodology) — that layer must state WHAT the numbers show, never WHY. The likelyDrivers[] section ("Why this might be happening") is the EXPECTED home for hedged mechanism language and must NOT be flagged when each entry is hedged ("likely" / "consistent with" / "may reflect") and carries a basis tag; basis="general" world knowledge is permitted there and ONLY there. Separately, flag FABRICATED_MECHANISM_NUMBER if any likelyDrivers explanation contains a statistic — numbers belong in findings/magnitudes, never inside a mechanism. Prefer "consistent with" / "largest downward contribution" language aligned with epistemicNotes in the brief.

Phase-1 completeness checks (only when ANALYSIS_BRIEF_JSON.questionShape is set):
- questionShape="driver_discovery": the candidate should discuss each column in candidateDriverDimensions — at least note whether it was tested. Flag INCOMPLETE_DRIVERS (severity "medium") when one or more candidates are ignored without justification.
- questionShape="variance_diagnostic": the candidate should decompose the change into at least two of (time effect, segment-composition shift, intra-segment metric change) with supporting numbers. Flag MISSING_DECOMPOSITION (severity "medium") when the narrative is one-dimensional.
- For every Phase-1 shape (driver_discovery, variance_diagnostic, trend, comparison, exploration): flag MISSING_MAGNITUDES (severity "low") when the candidate does not cite at least one numeric magnitude (percentage, delta, or absolute value) supporting its main claim.
Prefer course_correction "revise_narrative" for completeness issues (evidence is usually present; the narrative just didn't surface it). Only escalate to "replan" when the required evidence is actually absent from the tool output.`;

  const brief = formatAnalysisBriefForPrompt(ctx);
  // Prior in-turn verifier verdicts so this round can detect re-assertion of
  // already-flagged issues. Cap at 4 KB total.
  const priorVerdictsBlock =
    params.priorVerifierVerdicts && params.priorVerifierVerdicts.length > 0
      ? `\n\nPast verifier verdicts in this turn (most recent last; escalate when the candidate reasserts a previously-flagged issue):\n${params.priorVerifierVerdicts
          .slice(-6)
          .map(
            (v) =>
              `  step ${v.stepIndex}: ${v.verdict} — ${v.rationale.slice(0, 320)}`
          )
          .join("\n")
          .slice(0, 4_000)}`
      : "";
  // Wide evidence/candidate caps (16k / 8k chars). The deep verifier runs on a
  // large model, so the bigger window catches numeric-fabrication errors that
  // would otherwise hide past truncation boundaries.
  const user = `User question:\n${ctx.question}\n${brief}\n\nEvidence (tool output, truncated):\n${params.evidenceSummary.slice(0, 16_000)}\n\nCandidate:\n${params.candidate.slice(0, 8_000)}${priorVerdictsBlock}`;

  const out = await completeJson(system, user, verifierOutputSchema, {
    turnId: params.turnId,
    temperature: 0.1,
    maxTokens: 800,
    onLlmCall,
    purpose: LLM_PURPOSE.VERIFIER_DEEP,
  });
  if (!out.ok) {
    return {
      verdict: VERIFIER_VERDICT.pass,
      issues: [],
      course_correction: VERIFIER_VERDICT.pass,
    };
  }
  const j = out.data;
  return {
    verdict: j.verdict as VerdictType,
    scores: j.scores,
    issues: (j.issues ?? []).map((i) => ({
      code: i.code,
      severity: i.severity,
      description: i.description,
      evidenceRefs: i.evidence_refs || [],
    })),
    course_correction: j.course_correction as VerdictType,
    user_visible_note: j.user_visible_note,
  };
}

export async function rewriteNarrative(
  ctx: AgentExecutionContext,
  bad: string,
  issues: string,
  onLlmCall: () => void,
  evidenceSummary?: string
): Promise<string> {
  onLlmCall();
  const { MODEL } = await import("../../openai.js");
  const { callLlm } = await import("./callLlm.js");
  // Evidence cap (16k chars) matched to the deep verifier's window.
  const evBlock =
    evidenceSummary?.trim().length ?
      `\nEvidence (tool output; cite only facts supported here):\n${evidenceSummary.trim().slice(0, 16_000)}\n`
      : "";
  const res = await callLlm(
    {
      model: MODEL as string,
      messages: [
        {
          role: "system",
          content:
            "Rewrite the draft to fix the listed issues. Be concise and grounded in evidence when provided; do not invent numbers not in evidence. No markdown code fences.",
        },
        {
          role: "user",
          content: `Question: ${ctx.question}\nIssues:\n${issues}${evBlock}\nDraft:\n${bad}`,
        },
      ],
      temperature: 0.3,
      // Generous token budget — course corrections often include a full
      // multi-paragraph rewrite, and a smaller cap clipped late paragraphs.
      max_tokens: 3500,
    },
    // Route the rewrite through VERIFIER_DEEP so it uses the same large model
    // that produced the verdict, keeping the rewrite as analytically careful as
    // the critique that prompted it.
    { purpose: LLM_PURPOSE.VERIFIER_DEEP }
  );
  return res.choices[0]?.message?.content?.trim() || bad;
}
