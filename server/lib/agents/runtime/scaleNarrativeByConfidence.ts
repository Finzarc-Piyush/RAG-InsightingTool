/**
 * ============================================================================
 * scaleNarrativeByConfidence.ts — grade each finding's statistical confidence
 * ============================================================================
 * WHAT THIS FILE DOES
 *   When the tool gives an answer (e.g. "Saffola sales rose 12%"), how sure
 *   are we that the number is real and not just noise? This file looks at the
 *   statistical evidence behind a finding — sample size (n), p-value (the
 *   "is this just luck?" probability), confidence-interval width (how fuzzy
 *   the estimate is), R² (how well a model fits), and effect size (does the
 *   difference actually matter?) — and stamps each finding with a confidence
 *   tier: "high", "medium", or "low". It also hands back plain-English reasons
 *   and a "hedge" phrase (e.g. "treat as directional") the writer should use.
 *
 * WHY IT MATTERS
 *   The final answer the user reads is written by an LLM "narrator". Without
 *   confidence grading, the narrator could state a shaky finding from 5 rows
 *   with the same swagger as one from 5,000 rows. This file lets the narrator
 *   speak loudly when the data is solid and hedge honestly when it isn't — so
 *   the tool earns trust instead of overclaiming. A key trick: a result can be
 *   "statistically significant" yet practically meaningless; a "negligible"
 *   effect size is treated as LOW no matter how big the sample.
 *
 * KEY PIECES
 *   - FindingEvidence — the optional statistical inputs for one finding.
 *   - assessConfidence — the deterministic classifier: evidence in, tier out.
 *   - decorateFindings — attaches a confidence assessment to a list of findings.
 *   - summarizeConfidenceTiers — one-line tier tally for the narrator prompt.
 *   - narratorBudget / hedgeFor — per-tier prose limits and hedge phrasing.
 *
 * HOW IT CONNECTS
 *   Pure, side-effect-free, zero-dependency logic — importable from anywhere
 *   in the agent runtime. Callers (skills, the narrator prompt builder, a
 *   fact-check pre-pass) feed it findings + evidence and use the result to
 *   shape the answer envelope's wording. Thresholds are hard-coded on purpose
 *   so confidence grading stays reproducible across runs.
 */

/** Statistical evidence behind a single finding. All fields optional. */
export interface FindingEvidence {
  /** Underlying sample size that produced the finding. */
  n?: number;
  /** Two-tailed p-value, if a significance test was run. */
  pValue?: number;
  /** Headline effect-size magnitude (post-normalisation; not used directly
   *  in classification but carried through for completeness). */
  magnitude?: number;
  /** R² for regression-backed findings (e.g., elasticity, MMM driver). */
  rSquared?: number;
  /** 95% CI width as a fraction of the point estimate. 0 = perfectly
   *  tight; > 0.5 = noisy. */
  ciRelativeWidth?: number;
  /** Categorical effect-size bucket from significance tests
   *  (Cohen's d on welch_t / paired_t; Cramér's V on chi_square). Lets the
   *  classifier distinguish "statistically significant but practically
   *  negligible" (p ≤ 0.05 with `effectMagnitude = "negligible"`) from "real
   *  and large" (p ≤ 0.05 with `effectMagnitude = "large"`). p-value answers
   *  "is it noise?"; effect-magnitude answers "does it matter?". A finding
   *  that clears the significance bar with a negligible effect is LOW-tier
   *  regardless of n / p / CI. */
  effectMagnitude?: "negligible" | "small" | "medium" | "large";
}

export type ConfidenceTier = "high" | "medium" | "low";

export interface ConfidenceAssessment {
  tier: ConfidenceTier;
  /** Human-readable reasons explaining the tier — useful for debugging
   *  and for surfacing in the verifier prompt. */
  reasons: string[];
  /** Hedge phrase the narrator should use when stating this finding.
   *  Empty string when no hedge is necessary. */
  hedge: string;
}

/** Narrator verbosity budget per tier — caps prose without dictating it. */
export interface NarratorBudget {
  /** Max sentences the narrator should spend on a finding of this tier. */
  maxSentences: number;
  /** Whether the hedge phrase MUST appear in the narrator's prose. */
  hedgeRequired: boolean;
}

const HEDGE_BY_TIER: Record<ConfidenceTier, string> = {
  high: "",
  medium: "The pattern is suggestive but the sample is moderate.",
  low: "This is a tentative observation given the limited data; treat as directional.",
};

const BUDGET_BY_TIER: Record<ConfidenceTier, NarratorBudget> = {
  high: { maxSentences: 4, hedgeRequired: false },
  medium: { maxSentences: 3, hedgeRequired: true },
  low: { maxSentences: 2, hedgeRequired: true },
};

/** Classifier — deterministic, priority-ordered. */
export function assessConfidence(evidence: FindingEvidence): ConfidenceAssessment {
  const reasons: string[] = [];

  // No evidence at all → medium (caller asserted the finding without
  // statistical support — never silently "high").
  const hasAnyEvidence =
    evidence.n !== undefined ||
    evidence.pValue !== undefined ||
    evidence.rSquared !== undefined ||
    evidence.ciRelativeWidth !== undefined ||
    evidence.effectMagnitude !== undefined;
  if (!hasAnyEvidence) {
    return {
      tier: "medium",
      reasons: ["no statistical evidence supplied"],
      hedge: HEDGE_BY_TIER.medium,
    };
  }

  // Hard-fail signals → LOW.
  const lowReasons: string[] = [];
  if (evidence.n !== undefined && evidence.n < 10) {
    lowReasons.push(`small sample (n=${evidence.n})`);
  }
  if (evidence.pValue !== undefined && evidence.pValue > 0.15) {
    lowReasons.push(`weak significance (p=${formatP(evidence.pValue)})`);
  }
  if (evidence.ciRelativeWidth !== undefined && evidence.ciRelativeWidth > 0.6) {
    lowReasons.push(`wide CI (±${Math.round(evidence.ciRelativeWidth * 100)}% of estimate)`);
  }
  if (evidence.rSquared !== undefined && evidence.rSquared < 0.2) {
    lowReasons.push(`poor model fit (R²=${evidence.rSquared.toFixed(2)})`);
  }
  // A "negligible" effect-size bucket is itself a hard-fail
  // signal: even if p ≤ 0.05 and n is large, the finding is practically
  // immaterial. This is the load-bearing wedge that lets the narrator
  // hedge "significant but trivial" results instead of overclaiming.
  if (evidence.effectMagnitude === "negligible") {
    lowReasons.push("negligible effect size");
  }
  if (lowReasons.length > 0) {
    return { tier: "low", reasons: lowReasons, hedge: HEDGE_BY_TIER.low };
  }

  // High-confidence signals — all conditions must hold.
  const passesHigh =
    (evidence.n === undefined || evidence.n >= 30) &&
    (evidence.pValue === undefined || evidence.pValue <= 0.05) &&
    (evidence.ciRelativeWidth === undefined || evidence.ciRelativeWidth <= 0.3) &&
    (evidence.rSquared === undefined || evidence.rSquared >= 0.5) &&
    (evidence.effectMagnitude === undefined ||
      evidence.effectMagnitude === "medium" ||
      evidence.effectMagnitude === "large");
  if (passesHigh) {
    if (evidence.n !== undefined && evidence.n >= 30) reasons.push(`solid sample (n=${evidence.n})`);
    if (evidence.pValue !== undefined && evidence.pValue <= 0.05) {
      reasons.push(`statistically significant (p=${formatP(evidence.pValue)})`);
    }
    if (evidence.ciRelativeWidth !== undefined && evidence.ciRelativeWidth <= 0.3) {
      reasons.push(`tight CI (±${Math.round(evidence.ciRelativeWidth * 100)}% of estimate)`);
    }
    if (evidence.rSquared !== undefined && evidence.rSquared >= 0.5) {
      reasons.push(`good model fit (R²=${evidence.rSquared.toFixed(2)})`);
    }
    if (evidence.effectMagnitude === "large") {
      reasons.push("large effect size");
    } else if (evidence.effectMagnitude === "medium") {
      reasons.push("medium effect size");
    }
    if (reasons.length === 0) reasons.push("no weakening signals detected");
    return { tier: "high", reasons, hedge: HEDGE_BY_TIER.high };
  }

  // Otherwise → MEDIUM.
  const midReasons: string[] = [];
  if (evidence.n !== undefined && evidence.n < 30) {
    midReasons.push(`moderate sample (n=${evidence.n})`);
  }
  if (evidence.pValue !== undefined && evidence.pValue > 0.05 && evidence.pValue <= 0.15) {
    midReasons.push(`marginal significance (p=${formatP(evidence.pValue)})`);
  }
  if (
    evidence.ciRelativeWidth !== undefined &&
    evidence.ciRelativeWidth > 0.3 &&
    evidence.ciRelativeWidth <= 0.6
  ) {
    midReasons.push(`wider CI (±${Math.round(evidence.ciRelativeWidth * 100)}% of estimate)`);
  }
  if (
    evidence.rSquared !== undefined &&
    evidence.rSquared >= 0.2 &&
    evidence.rSquared < 0.5
  ) {
    midReasons.push(`modest fit (R²=${evidence.rSquared.toFixed(2)})`);
  }
  if (evidence.effectMagnitude === "small") {
    midReasons.push("small effect size");
  } else if (evidence.effectMagnitude === "medium") {
    midReasons.push("medium effect size");
  }
  if (midReasons.length === 0) midReasons.push("evidence partially supports this finding");
  return { tier: "medium", reasons: midReasons, hedge: HEDGE_BY_TIER.medium };
}

/** Decorate a list of findings with their confidence assessment. The
 *  evidence map is keyed by finding id (or any other stable key the caller
 *  uses). Findings without evidence get a "medium" tier with an explicit
 *  "no evidence supplied" reason — never silently "high". */
export function decorateFindings<F extends { id: string }>(
  findings: F[],
  evidenceById: Map<string, FindingEvidence> | Record<string, FindingEvidence>,
): Array<F & { confidence: ConfidenceAssessment }> {
  const getEvidence = (id: string): FindingEvidence | undefined => {
    if (evidenceById instanceof Map) return evidenceById.get(id);
    return (evidenceById as Record<string, FindingEvidence>)[id];
  };
  return findings.map((f) => {
    const evidence = getEvidence(f.id);
    if (!evidence) {
      return {
        ...f,
        confidence: {
          tier: "medium" as ConfidenceTier,
          reasons: ["no evidence supplied — defaulted to medium"],
          hedge: HEDGE_BY_TIER.medium,
        },
      };
    }
    return { ...f, confidence: assessConfidence(evidence) };
  });
}

/** Compact tier summary for the narrator prompt block. */
export function summarizeConfidenceTiers(
  assessments: ConfidenceAssessment[],
): {
  total: number;
  high: number;
  medium: number;
  low: number;
  promptLine: string;
} {
  const total = assessments.length;
  let high = 0;
  let medium = 0;
  let low = 0;
  for (const a of assessments) {
    if (a.tier === "high") high += 1;
    else if (a.tier === "medium") medium += 1;
    else low += 1;
  }
  const promptLine = `Findings · ${total} total · ${high} high-confidence, ${medium} medium, ${low} low. Hedge low/medium findings explicitly.`;
  return { total, high, medium, low, promptLine };
}

/** Get the narrator's per-tier prose budget. */
export function narratorBudget(tier: ConfidenceTier): NarratorBudget {
  return BUDGET_BY_TIER[tier];
}

/** Get the canonical hedge phrase for a tier (or "" for high). */
export function hedgeFor(tier: ConfidenceTier): string {
  return HEDGE_BY_TIER[tier];
}

function formatP(p: number): string {
  if (p < 0.001) return "<0.001";
  if (p < 0.01) return p.toFixed(3);
  return p.toFixed(2);
}
