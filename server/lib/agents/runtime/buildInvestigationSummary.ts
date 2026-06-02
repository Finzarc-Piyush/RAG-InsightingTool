/**
 * ============================================================================
 * buildInvestigationSummary.ts — digest the blackboard for the saved message
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Boils the full "analytical blackboard" (the engine's working notes for a
 *   turn — every hypothesis, finding, and open question) down to a small
 *   InvestigationSummary that gets saved on the assistant message. It keeps only
 *   what the UI needs for a digest card: hypotheses tested, headline findings,
 *   and unresolved questions — trimmed and length-capped.
 *
 * WHY IT MATTERS
 *   Clients render a short summary card, not a forensic audit trail, so the
 *   saved shape deliberately drops evidence refs and bookkeeping ids. The full
 *   detail still lives on ctx.blackboard for server-side telemetry / verifier rules.
 *
 * KEY PIECES
 *   - buildInvestigationSummary(blackboard) — returns the compact summary, or
 *     undefined when there's nothing worth showing (no hypotheses, findings, or
 *     open questions) so the caller can skip persisting the field.
 *
 * HOW IT CONNECTS
 *   Reads AnalyticalBlackboard/Finding from analyticalBlackboard.js; output type
 *   InvestigationSummary comes from shared/schema.ts. Pure function, no I/O.
 */
import type { AnalyticalBlackboard, Finding } from "./analyticalBlackboard.js";
import type { InvestigationSummary } from "../../../shared/schema.js";

const MAX_HYPOTHESES = 8;
const MAX_FINDINGS = 8;
const MAX_OPEN_QUESTIONS = 6;
const MAX_HYPOTHESIS_TEXT = 280;
const MAX_FINDING_LABEL = 200;
const MAX_QUESTION_TEXT = 280;

const SIGNIFICANCE_RANK: Record<Finding["significance"], number> = {
  anomalous: 0,
  notable: 1,
  routine: 2,
};

function clip(s: string | undefined, max: number): string {
  const trimmed = s?.replace(/\s+/g, " ").trim() ?? "";
  if (!trimmed) return "";
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

export function buildInvestigationSummary(
  blackboard: AnalyticalBlackboard | undefined
): InvestigationSummary | undefined {
  if (!blackboard) return undefined;

  const hypotheses = blackboard.hypotheses
    .slice(0, MAX_HYPOTHESES)
    .map((h) => ({
      text: clip(h.text, MAX_HYPOTHESIS_TEXT),
      status: h.status,
      // Cap at 20 to match the schema (`evidenceCount.max(20)`); larger
      // counts are unusual and don't add information for the user.
      evidenceCount: Math.min(h.evidenceRefs.length, 20),
    }))
    .filter((h) => h.text.length > 0);

  const findings = [...blackboard.findings]
    .sort((a, b) => SIGNIFICANCE_RANK[a.significance] - SIGNIFICANCE_RANK[b.significance])
    .slice(0, MAX_FINDINGS)
    .map((f) => ({
      label: clip(f.label, MAX_FINDING_LABEL),
      significance: f.significance,
    }))
    .filter((f) => f.label.length > 0);

  const openQuestions = blackboard.openQuestions
    .filter((q) => !q.actionedByNodeId)
    .slice(0, MAX_OPEN_QUESTIONS)
    .map((q) => ({
      question: clip(q.question, MAX_QUESTION_TEXT),
      priority: q.priority,
    }))
    .filter((q) => q.question.length > 0);

  if (hypotheses.length === 0 && findings.length === 0 && openQuestions.length === 0) {
    return undefined;
  }

  // Build the object with only non-empty arrays so the persisted shape stays
  // minimal — the schema marks each section optional and the client renders
  // section headings only when their array is present.
  const out: InvestigationSummary = {};
  if (hypotheses.length > 0) out.hypotheses = hypotheses;
  if (findings.length > 0) out.findings = findings;
  if (openQuestions.length > 0) out.openQuestions = openQuestions;
  return out;
}
