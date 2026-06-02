/**
 * ============================================================================
 * verifierHelpers.ts — evidence assembly + sanity checks for the verifier
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Helpers for the "verifier" — the final agent that fact-checks the drafted
 *   answer against the evidence before it ships. This file (1) builds the
 *   evidence text the verifier reads, and (2) provides two deterministic checks
 *   that catch specific mistakes and raise "issues" with a severity and code.
 *
 * WHY IT MATTERS
 *   The verifier needs the same facts the narrator had, plus cheap rule-based
 *   checks that don't require an LLM. These catch (a) plans that ignored filters
 *   the user named, and (b) standout ("anomalous") findings the narrative failed
 *   to mention — both common, high-impact errors.
 *
 * KEY PIECES
 *   - buildFinalEvidence(...) — concatenate observations, chart titles,
 *     blackboard detail, and magnitudes into one capped evidence string.
 *   - checkInferredFilterFidelity(ctx, steps) — flag MISSING_INFERRED_FILTER
 *     when no plan step applied a filter the user explicitly named.
 *   - checkMissingFindings(candidate, blackboard) — flag MISSING_FINDING when an
 *     anomalous finding's keywords don't appear in the narrative.
 *
 * HOW IT CONNECTS
 *   Reads blackboard data via analyticalBlackboard.js (formatForNarrator),
 *   filter logic via planArgRepairs.js, and types from types.js. Used by the
 *   verifier / narrative-rewrite step. Pure functions — no I/O, no LLM calls.
 */
import type { AnalyticalBlackboard } from "./analyticalBlackboard.js";
import { formatForNarrator } from "./analyticalBlackboard.js";
import type {
  AgentExecutionContext,
  PlanStep,
  VerifierIssue,
  VerifierResult,
} from "./types.js";
import { checkMissingInferredFilters } from "./planArgRepairs.js";

/**
 * Build the evidence string for the Final Verifier and rewriteNarrative.
 * Includes full blackboard finding detail (with numeric facts) and narrator
 * magnitudes — the same data the Narrator had when writing the narrative body.
 *
 * Pure function — no I/O, no LLM calls.
 */
export function buildFinalEvidence(
  observations: string[],
  chartTitles: string,
  blackboard: AnalyticalBlackboard | undefined,
  magnitudes: Array<{ label: string; value: string; confidence?: string }> | undefined
): string {
  const parts: string[] = [];

  if (observations.length > 0) parts.push(observations.join("\n"));
  if (chartTitles) parts.push(`Charts: ${chartTitles}`);

  if (blackboard && (blackboard.findings.length > 0 || blackboard.hypotheses.length > 0)) {
    const bbBlock = formatForNarrator(blackboard);
    if (bbBlock.trim()) parts.push(`\nBLACKBOARD:\n${bbBlock}`);
  }

  if (magnitudes?.length) {
    const magLines = magnitudes
      .map((m) => `- ${m.label}: ${m.value}${m.confidence ? ` (${m.confidence})` : ""}`)
      .join("\n");
    parts.push(`\nMAGNITUDES:\n${magLines}`);
  }

  // Capped here at 14 000; runVerifier still truncates to 6 000 at call time.
  return parts.join("\n").slice(0, 14000);
}

/**
 * Backstop: if any inferred filter column is absent from every plan step
 * that accepts dimensionFilters, emit a `MISSING_INFERRED_FILTER` issue with
 * a replan verdict. The planner's `ensureInferredFiltersOnStep` auto-repair
 * handles the common case; this fires only when the plan never produced a
 * filter-capable step at all. Pure function — no I/O, no LLM calls.
 */
export function checkInferredFilterFidelity(
  ctx: AgentExecutionContext,
  steps: PlanStep[]
): VerifierIssue[] {
  const missing = checkMissingInferredFilters(steps, ctx.inferredFilters);
  if (!missing.length) return [];
  const detail = ctx
    .inferredFilters!.filter((f) => missing.includes(f.column))
    .map(
      (f) =>
        `${f.column} ∈ [${f.values.join(", ")}] (tokens: ${f.matchedTokens.join(", ")})`
    )
    .join("; ");
  return [
    {
      code: "MISSING_INFERRED_FILTER",
      severity: "high",
      description: `Plan does not apply filters the user named in the question: ${detail}. Replan with these filters included in execute_query_plan.dimensionFilters (or the equivalent arg on correlation/breakdown tools).`,
      evidenceRefs: [],
    },
  ];
}

/** Flag anomalous blackboard findings whose label/detail text doesn't appear in the candidate narrative. */
export function checkMissingFindings(
  candidate: string,
  blackboard: AnalyticalBlackboard
): VerifierResult["issues"] {
  const issues: VerifierResult["issues"] = [];
  for (const f of blackboard.findings) {
    if (f.significance !== "anomalous") continue;
    const keyWords = [f.label, ...f.detail.split(/\s+/).filter((w) => w.length >= 4).slice(0, 6)];
    const cited = keyWords.some((w) => candidate.toLowerCase().includes(w.toLowerCase()));
    if (!cited) {
      issues.push({
        code: "MISSING_FINDING",
        severity: "medium",
        description: `Anomalous finding not cited in narrative: "${f.label.slice(0, 120)}"`,
        evidenceRefs: [f.id],
      });
    }
  }
  return issues;
}
