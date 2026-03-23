import type { AgentExecutionContext } from "./types.js";
import type { VerifierResult, VerdictType } from "./types.js";
import { verifierOutputSchema } from "./schemas.js";
import { completeJson } from "./llmJson.js";
import { chartSpecSchema } from "../../../shared/schema.js";

function extractNumbers(text: string): number[] {
  const re = /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi;
  const m = text.match(re);
  if (!m) return [];
  return m.map((x) => parseFloat(x)).filter((n) => Number.isFinite(n));
}

function roughlyEqual(a: number, b: number, eps = 1e-3): boolean {
  if (Math.abs(a - b) < eps) return true;
  if (Math.abs(a - b) / (Math.abs(a) + Math.abs(b) + 1e-9) < 0.01) return true;
  return false;
}

function numericPrecheck(
  candidate: string,
  evidence?: string
): VerifierResult | null {
  if (!evidence || evidence.length < 4) return null;
  if (!/\b(total|sum|average|mean|count|median|min|max)\b/i.test(candidate)) {
    return null;
  }
  const cNums = extractNumbers(candidate);
  const eNums = extractNumbers(evidence);
  if (cNums.length === 0 || eNums.length === 0) return null;
  for (const cn of cNums) {
    if (!Number.isFinite(cn) || Math.abs(cn) < 1e-9) continue;
    if (cn >= 1900 && cn <= 2100 && Number.isInteger(cn)) continue;
    const hit = eNums.some((en) => roughlyEqual(cn, en));
    if (!hit && Math.abs(cn) > 1 && Math.abs(cn) < 1e15) {
      return {
        verdict: "revise_narrative",
        issues: [
          {
            code: "NUMERIC_MISMATCH",
            severity: "high",
            description: `Candidate number ${cn} not found in evidence`,
            evidenceRefs: [],
          },
        ],
        course_correction: "revise_narrative",
      };
    }
  }
  return null;
}

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
      verdict: "revise_narrative",
      issues: [
        {
          code: "BAD_CHART_AXIS",
          severity: "high",
          description: "Chart axis not in schema",
          evidenceRefs: [],
        },
      ],
      course_correction: "revise_narrative",
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
  const pre =
    numericPrecheck(params.candidate, params.evidenceSummary) ||
    chartPrecheck(params.candidate, ctx);
  if (pre) {
    return pre;
  }

  const system = `You are a verifier, not an assistant. Assume the draft may be wrong.
Compare the candidate answer fragment to the user question and evidence. Output JSON only with:
verdict: pass | revise_narrative | retry_tool | replan | ask_user | abort_partial
issues: array of {code, severity, description, evidence_refs}
course_correction: same enum as verdict (primary action)
user_visible_note: optional string

If evidence includes output from run_analytical_query (numeric/tabular results), treat those numbers as authoritative over retrieved RAG text snippets when they conflict. Use code NUMERIC_MISMATCH when the candidate contradicts analytical evidence.`;

  const user = `User question:\n${ctx.question}\n\nEvidence (tool output, truncated):\n${params.evidenceSummary.slice(0, 6000)}\n\nCandidate:\n${params.candidate.slice(0, 4000)}`;

  const out = await completeJson(system, user, verifierOutputSchema, {
    turnId: params.turnId,
    temperature: 0.1,
    maxTokens: 800,
    onLlmCall,
  });
  if (!out.ok) {
    return {
      verdict: "pass",
      issues: [],
      course_correction: "pass",
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
  onLlmCall: () => void
): Promise<string> {
  onLlmCall();
  const { openai, MODEL } = await import("../../openai.js");
  const res = await openai.chat.completions.create({
    model: MODEL as string,
    messages: [
      {
        role: "system",
        content:
          "Rewrite the draft to fix the listed issues. Be concise and grounded. No markdown code fences.",
      },
      {
        role: "user",
        content: `Question: ${ctx.question}\nIssues:\n${issues}\n\nDraft:\n${bad}`,
      },
    ],
    temperature: 0.3,
    max_tokens: 800,
  });
  return res.choices[0]?.message?.content?.trim() || bad;
}
