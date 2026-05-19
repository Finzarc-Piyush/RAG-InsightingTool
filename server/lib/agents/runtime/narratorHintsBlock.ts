/**
 * Wave WW2 · narrator-side wiring of WQ1's `scaleNarrativeByConfidence`.
 *
 * Reads the blackboard's findings, extracts statistical evidence from each
 * finding's `detail` text via regex (sample size, p-value, R², CI width),
 * decorates them with a `ConfidenceAssessment` via WQ1, and emits ONE
 * compact prompt block the narrator concatenates into its user message.
 *
 * Closes the WQ1 wiring debt the WW1 wave deferred. WW1 surfaced WQ1 as a
 * static *directive* in the planner's system prompt (nudging tool choice
 * toward statistical paths); WW2 surfaces the per-finding tier + canonical
 * hedge phrase to the narrator so it can vary verbosity, mark confidence
 * on magnitudes / implications, and use the hedge verbatim for low /
 * medium findings.
 *
 * Pure: blackboard in, string out. No LLM calls, no side effects.
 */

import {
  assessConfidence,
  hedgeFor,
  narratorBudget,
  type ConfidenceAssessment,
  type ConfidenceTier,
  type FindingEvidence,
} from "./scaleNarrativeByConfidence.js";
import type { AnalyticalBlackboard, Finding } from "./analyticalBlackboard.js";

/**
 * Regex-extract `FindingEvidence` from a finding's detail string. The agent
 * runtime does not (today) carry structured statistical fields on findings —
 * tools write prose that mentions n / p / R² / CI inline. WW2 mines those
 * back out so WQ1 can grade the finding.
 *
 * Conservative: returns an empty object when nothing matches. WQ1 then tiers
 * the finding as "medium" with the canonical "no evidence supplied" reason
 * (NEVER silently "high").
 */
export function extractFindingEvidence(detail: string): FindingEvidence {
  if (!detail) return {};
  const text = detail.replace(/\s+/g, " ");
  const evidence: FindingEvidence = {};

  // Sample size: "n = 2500", "sample of 2500", "across 2500 rows/records/observations".
  const nMatch =
    /\bn\s*=\s*(\d{1,9})\b/i.exec(text) ??
    /\bsample\s+of\s+(\d{1,9})\b/i.exec(text) ??
    /\bacross\s+(\d{1,9})\s+(?:rows|records|observations)\b/i.exec(text);
  if (nMatch) {
    const n = Number(nMatch[1]);
    if (Number.isFinite(n) && n >= 0) evidence.n = n;
  }

  // p-value: "p = 0.03", "p-value: 0.03", "p < 0.001".
  const pEq = /\bp(?:[-\s]value)?\s*[=:]\s*(0?\.\d+|\d+(?:\.\d+)?e-\d+)/i.exec(text);
  const pLt = /\bp\s*<\s*(0?\.\d+|\d+(?:\.\d+)?e-\d+)/i.exec(text);
  if (pEq) {
    const p = Number(pEq[1]);
    if (Number.isFinite(p) && p >= 0 && p <= 1) evidence.pValue = p;
  } else if (pLt) {
    const p = Number(pLt[1]);
    // "p < 0.001" → use the upper bound; the assess function only cares
    // whether p ≤ 0.05 or > 0.15. Using the bound is safe.
    if (Number.isFinite(p) && p > 0) evidence.pValue = p;
  }

  // R²: "R² = 0.71", "R^2 = 0.71", "r-squared: 0.71".
  const rSqMatch =
    /\bR\s*²\s*=\s*(0?\.\d+|1(?:\.0+)?)/i.exec(text) ??
    /\bR\s*\^?\s*2\s*=\s*(0?\.\d+|1(?:\.0+)?)/i.exec(text) ??
    /\br-?squared\s*[=:]\s*(0?\.\d+|1(?:\.0+)?)/i.exec(text);
  if (rSqMatch) {
    const r = Number(rSqMatch[1]);
    if (Number.isFinite(r) && r >= 0 && r <= 1) evidence.rSquared = r;
  }

  // CI: "±15%", "CI: ±15%", "95% CI ±15%" — interpreted as ciRelativeWidth = 0.15.
  const ciMatch =
    /(?:CI|confidence\s+interval)[^%]{0,40}±\s*(\d{1,3})\s*%/i.exec(text) ??
    /±\s*(\d{1,3})\s*%\s+(?:of|around|on)\s+(?:the\s+)?(?:estimate|mean|point)/i.exec(text);
  if (ciMatch) {
    const pct = Number(ciMatch[1]);
    if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
      evidence.ciRelativeWidth = pct / 100;
    }
  }

  // Wave WQ8 · categorical effect size: "effect = large", "effect: small",
  // "effect-size: medium", "effect_magnitude: negligible". Matches the WV2
  // formatter output AND the sig-test tool's `effect_magnitude` table column
  // when it lands in narrator prose.
  const effMatch =
    /\beffect(?:[-_\s]?(?:size|magnitude))?\s*[=:]\s*(negligible|small|medium|large)\b/i.exec(text);
  if (effMatch) {
    evidence.effectMagnitude = effMatch[1].toLowerCase() as FindingEvidence["effectMagnitude"];
  }

  return evidence;
}

export interface ConfidenceTieredFinding {
  finding: Finding;
  evidence: FindingEvidence;
  assessment: ConfidenceAssessment;
}

/** Decorate every blackboard finding with its (extracted-evidence-based)
 *  confidence assessment. Pure; doesn't mutate the blackboard. */
export function tierBlackboardFindings(
  blackboard: AnalyticalBlackboard,
): ConfidenceTieredFinding[] {
  return blackboard.findings.map((finding) => {
    const evidence = extractFindingEvidence(finding.detail);
    return {
      finding,
      evidence,
      assessment: assessConfidence(evidence),
    };
  });
}

/** Compact one-line summary of a tier's prose budget for the prompt block. */
function budgetSummary(tier: ConfidenceTier): string {
  const b = narratorBudget(tier);
  return `≤${b.maxSentences} sentences${b.hedgeRequired ? "; MUST include the hedge phrase verbatim" : ""}`;
}

/**
 * Build the narrator's FINDING_CONFIDENCE prompt block. Returns an empty
 * string when the blackboard has no findings (e.g. dataOps turns) so the
 * caller can short-circuit cleanly.
 *
 * The block lists every finding by id with its tier, the regex-extracted
 * reasons, and the canonical hedge phrase the narrator should weave into
 * the surrounding prose for medium / low findings. The narrator's existing
 * `magnitudes[].confidence` / `implications[].confidence` fields are pinned
 * to these tiers by the directive line.
 */
export function buildNarratorConfidenceBlock(
  blackboard: AnalyticalBlackboard,
): string {
  const tiered = tierBlackboardFindings(blackboard);
  if (tiered.length === 0) return "";

  const lines: string[] = [
    "### FINDING_CONFIDENCE (deterministic per-finding tiering — use these tiers verbatim in magnitudes[].confidence and implications[].confidence; weave the hedge phrase into prose for medium/low findings)",
  ];
  for (const { finding, assessment } of tiered) {
    const tier = assessment.tier;
    const reasons = assessment.reasons.join(", ");
    lines.push(`- ${finding.id} (${tier}): ${reasons}`);
    lines.push(`  budget: ${budgetSummary(tier)}`);
    const hedge = hedgeFor(tier);
    if (hedge) lines.push(`  hedge: "${hedge}"`);
  }

  return lines.join("\n");
}

/** Compact diagnostic summary — used for agentLog telemetry. */
export function summarizeNarratorConfidence(blackboard: AnalyticalBlackboard): {
  total: number;
  high: number;
  medium: number;
  low: number;
} {
  const tiered = tierBlackboardFindings(blackboard);
  let high = 0;
  let medium = 0;
  let low = 0;
  for (const t of tiered) {
    if (t.assessment.tier === "high") high += 1;
    else if (t.assessment.tier === "medium") medium += 1;
    else low += 1;
  }
  return { total: tiered.length, high, medium, low };
}
