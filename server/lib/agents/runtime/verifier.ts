import type { AgentExecutionContext } from "./types.js";
import { formatAnalysisBriefForPrompt } from "./analysisBrief.js";
import type { VerifierResult, VerdictType } from "./types.js";
import { verifierOutputSchema, VERIFIER_VERDICT } from "./schemas.js";
import { completeJson } from "./llmJson.js";
import { chartSpecSchema } from "../../../shared/schema.js";

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
  return null;
}

export async function runVerifier(
  ctx: AgentExecutionContext,
  params: {
    candidate: string;
    evidenceSummary: string;
    stepId: string;
    turnId: string;
  },
  onLlmCall: () => void
): Promise<VerifierResult> {
  const pre = chartPrecheck(params.candidate, ctx);
  if (pre) {
    return pre;
  }

  const system = `You are a verifier, not an assistant. Assume the draft may be wrong.
Compare the candidate answer fragment to the user question and evidence. Output JSON only with:
verdict: pass | revise_narrative | retry_tool | replan | ask_user | abort_partial
issues: array of {code, severity, description, evidence_refs}
course_correction: same enum as verdict (primary action)
user_visible_note: optional string

If evidence includes output from run_analytical_query (numeric/tabular results), treat those numbers as authoritative over retrieved RAG text snippets when they conflict. Use code NUMERIC_MISMATCH when the candidate contradicts analytical evidence.
If evidence states zero rows with diagnostic distinct samples, pass verdict "pass" when the candidate explains that outcome and uses those samples (do not force revise_narrative for grounded empty-result explanations).
When ANALYSIS_BRIEF_JSON is provided, flag UNSUPPORTED_CAUSAL_CLAIM if the candidate states definitive root causes not backed by experimental design; prefer "consistent with" / "largest downward contribution" language aligned with epistemicNotes in the brief.

Phase-1 completeness checks (only when ANALYSIS_BRIEF_JSON.questionShape is set):
- questionShape="driver_discovery": the candidate should discuss each column in candidateDriverDimensions — at least note whether it was tested. Flag INCOMPLETE_DRIVERS (severity "medium") when one or more candidates are ignored without justification.
- questionShape="variance_diagnostic": the candidate should decompose the change into at least two of (time effect, segment-composition shift, intra-segment metric change) with supporting numbers. Flag MISSING_DECOMPOSITION (severity "medium") when the narrative is one-dimensional.
- For every Phase-1 shape (driver_discovery, variance_diagnostic, trend, comparison, exploration): flag MISSING_MAGNITUDES (severity "low") when the candidate does not cite at least one numeric magnitude (percentage, delta, or absolute value) supporting its main claim.
Prefer course_correction "revise_narrative" for completeness issues (evidence is usually present; the narrative just didn't surface it). Only escalate to "replan" when the required evidence is actually absent from the tool output.`;

  const brief = formatAnalysisBriefForPrompt(ctx);
  const user = `User question:\n${ctx.question}\n${brief}\n\nEvidence (tool output, truncated):\n${params.evidenceSummary.slice(0, 6000)}\n\nCandidate:\n${params.candidate.slice(0, 4000)}`;

  const out = await completeJson(system, user, verifierOutputSchema, {
    turnId: params.turnId,
    temperature: 0.1,
    maxTokens: 800,
    onLlmCall,
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
    issues: j.issues.map((i) => ({
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
  const { openai, MODEL } = await import("../../openai.js");
  const evBlock =
    evidenceSummary?.trim().length ?
      `\nEvidence (tool output; cite only facts supported here):\n${evidenceSummary.trim().slice(0, 6000)}\n`
      : "";
  const res = await openai.chat.completions.create({
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
    max_tokens: 800,
  });
  return res.choices[0]?.message?.content?.trim() || bad;
}
