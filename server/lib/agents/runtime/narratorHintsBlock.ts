/**
 * ============================================================================
 * narratorHintsBlock.ts — grade each finding's statistical confidence and tell
 * the narrator how strongly to phrase it
 * ============================================================================
 * WHAT THIS FILE DOES
 *   During an analysis, tools post "findings" to a shared scratchpad called the
 *   blackboard. Each finding is plain prose that may mention statistics (e.g.
 *   "n = 2500, p < 0.001, R² = 0.71"). This file mines those numbers back out
 *   of the text with regexes, grades each finding's confidence (high / medium /
 *   low) using a separate scoring helper, and builds ONE compact prompt block
 *   that tells the narrator: which tier each finding is, how many sentences it
 *   deserves, and the exact "hedge" phrase to use verbatim for shakier findings.
 *
 * WHY IT MATTERS
 *   It prevents the narrator from stating weak, small-sample results with the
 *   same confidence as rock-solid ones. By pinning the per-finding tier and
 *   forcing a hedge phrase for medium/low findings, the answer's confidence
 *   labels stay honest and consistent instead of being the LLM's guess.
 *
 * KEY PIECES
 *   - extractFindingEvidence — regex out n / p-value / R² / CI width / effect size from prose
 *   - tierBlackboardFindings — decorate every blackboard finding with a confidence assessment
 *   - buildNarratorConfidenceBlock — the FINDING_CONFIDENCE prompt block (empty when no findings)
 *   - summarizeNarratorConfidence — counts per tier, for telemetry
 *
 * HOW IT CONNECTS
 *   Pure (blackboard in, string out — no LLM, no side effects). Uses
 *   `scaleNarrativeByConfidence.js` for the grading/hedge logic and reads the
 *   `AnalyticalBlackboard` from `analyticalBlackboard.js`. The returned block is
 *   concatenated into the narrator's user message by the synthesis path.
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
import type { AgentExecutionContext } from "./types.js";
import { deriveWeekdayPattern } from "../../insightGenerator/weekdayPattern.js";
import { formatCompactNumber } from "../../formatCompactNumber.js";
import {
  parseTemporalFacetDisplayKey,
  isTemporalFacetColumnKey,
} from "../../temporalFacetColumns.js";

/**
 * Regex-extract `FindingEvidence` from a finding's detail string. The agent
 * runtime does not (today) carry structured statistical fields on findings —
 * tools write prose that mentions n / p / R² / CI inline, so we mine those
 * back out so the grader can score the finding.
 *
 * Conservative: returns an empty object when nothing matches. The grader then
 * tiers the finding as "medium" with the canonical "no evidence supplied"
 * reason (NEVER silently "high").
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

  // Categorical effect size: "effect = large", "effect: small",
  // "effect-size: medium", "effect_magnitude: negligible". Matches the
  // significance-test formatter output AND the sig-test tool's
  // `effect_magnitude` table column when it lands in narrator prose.
  const effMatch =
    /\beffect(?:[-_\s]?(?:size|magnitude))?\s*[=:]\s*(negligible|small|medium|large)\b/i.exec(text);
  if (effMatch) {
    evidence.effectMagnitude = effMatch[1]!.toLowerCase() as FindingEvidence["effectMagnitude"];
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

/**
 * Build the narrator's TEMPORAL CALENDAR block from the turn's daily analytical
 * table, when present. Mirrors the per-chart Key-Insight grounding so the MAIN
 * narrative also explains a trend's ups-and-downs by the weekly calendar (e.g.
 * "the dips are Sundays") instead of speculating. Returns "" when the table is
 * not a simple day-grain series, or no recurring off-day is detected.
 *
 * Conservative shape gate: exactly one day-grain temporal column + exactly one
 * numeric measure column. Anything richer is ambiguous, so we stay silent rather
 * than risk attaching the note to the wrong measure.
 */
export function buildNarratorCalendarBlock(ctx: AgentExecutionContext): string {
  const table = ctx.lastAnalyticalTable;
  if (!table?.rows?.length || !Array.isArray(table.columns)) return "";

  const dateCols = ctx.summary?.dateColumns ?? [];
  const isDailyTemporal = (col: string): boolean => {
    const parsed = parseTemporalFacetDisplayKey(col);
    if (parsed) return parsed.grain === "date";
    return dateCols.includes(col);
  };
  const temporalCols = table.columns.filter(isDailyTemporal);
  if (temporalCols.length !== 1) return "";
  const xCol = temporalCols[0]!;

  const isNumericMeasure = (col: string): boolean => {
    if (col === xCol || isTemporalFacetColumnKey(col) || dateCols.includes(col)) {
      return false;
    }
    let seen = 0;
    let numeric = 0;
    for (const r of table.rows) {
      const v = r[col];
      if (v === null || v === undefined || v === "") continue;
      seen += 1;
      if (Number.isFinite(typeof v === "number" ? v : Number(String(v).replace(/[%,]/g, "")))) {
        numeric += 1;
      }
      if (seen >= 12) break;
    }
    return seen > 0 && numeric / seen >= 0.8;
  };
  const measureCols = table.columns.filter(isNumericMeasure);
  if (measureCols.length !== 1) return "";

  const pattern = deriveWeekdayPattern(
    table.rows as Record<string, any>[],
    xCol,
    measureCols[0]!,
    (n) => formatCompactNumber(n)
  );
  return pattern ? pattern.block : "";
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
