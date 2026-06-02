/**
 * ============================================================================
 * formatFindingEvidence.ts — write a finding's stats as canonical prose
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Turns a finding's statistical evidence (sample size n, p-value, R², a
 *   confidence-interval width, an effect size) into a short, standard-format
 *   suffix appended to the finding's free-text detail, e.g.
 *   " (n = 850; p < 0.001; R² = 0.71)". p-value = chance the result is noise;
 *   R² = how much of the variation the model explains; both are common stats.
 *
 * WHY IT MATTERS
 *   It is the encoding half of a roundtrip with the regex EXTRACTOR
 *   (extractFindingEvidence). The load-bearing contract is:
 *     extractFindingEvidence(formatEvidenceForFindingDetail(ev)) ≈ ev
 *   Writing the numbers in exactly the shape the extractor expects lets the
 *   stats be recovered later WITHOUT adding fields to the Finding type.
 *
 * KEY PIECES
 *   - formatEvidenceForFindingDetail(evidence) — the canonical suffix (or "" if
 *     no evidence; the leading space lets callers concatenate cleanly).
 *   - composeFindingDetail(prefix, evidence) — prefix + suffix convenience.
 *
 * HOW IT CONNECTS
 *   FindingEvidence is defined in scaleNarrativeByConfidence.js. Tools call this
 *   when adding findings to the blackboard; the matching extractor reads it back.
 */

import type { FindingEvidence } from "./scaleNarrativeByConfidence.js";

/** Format a p-value for prose. Matches the extractor's accepted shapes. */
function formatP(p: number): string {
  if (p < 0.001) return "0.001"; // emitted as "p < 0.001"; helper handles the prefix.
  if (p < 0.01) return p.toFixed(3);
  return p.toFixed(2);
}

/**
 * Emit a canonical evidence suffix safe to append to a finding's `detail`
 * string. Format: ` (n = N; p = X; R² = Y; ±Z% of the estimate)` — each
 * present field separated by `; ` inside one parenthesised block.
 *
 * Leading space is intentional: callers concatenate `detailPrefix + suffix`
 * without managing whitespace. When `evidence` is empty, returns "".
 */
export function formatEvidenceForFindingDetail(evidence: FindingEvidence): string {
  const parts: string[] = [];
  if (evidence.n !== undefined && Number.isFinite(evidence.n) && evidence.n >= 0) {
    parts.push(`n = ${Math.round(evidence.n)}`);
  }
  if (
    evidence.pValue !== undefined &&
    Number.isFinite(evidence.pValue) &&
    evidence.pValue >= 0 &&
    evidence.pValue <= 1
  ) {
    if (evidence.pValue < 0.001) {
      parts.push("p < 0.001");
    } else {
      parts.push(`p = ${formatP(evidence.pValue)}`);
    }
  }
  if (
    evidence.rSquared !== undefined &&
    Number.isFinite(evidence.rSquared) &&
    evidence.rSquared >= 0 &&
    evidence.rSquared <= 1
  ) {
    parts.push(`R² = ${evidence.rSquared.toFixed(2)}`);
  }
  if (
    evidence.ciRelativeWidth !== undefined &&
    Number.isFinite(evidence.ciRelativeWidth) &&
    evidence.ciRelativeWidth >= 0 &&
    evidence.ciRelativeWidth <= 1
  ) {
    const pct = Math.round(evidence.ciRelativeWidth * 100);
    parts.push(`±${pct}% of the estimate`);
  }
  // Canonical categorical effect-size token. Trails the
  // numeric fields so prose reads "n=…; p=…; effect = large".
  if (
    evidence.effectMagnitude === "negligible" ||
    evidence.effectMagnitude === "small" ||
    evidence.effectMagnitude === "medium" ||
    evidence.effectMagnitude === "large"
  ) {
    parts.push(`effect = ${evidence.effectMagnitude}`);
  }
  if (parts.length === 0) return "";
  return ` (${parts.join("; ")})`;
}

/**
 * Compose a full canonical detail string from a human-readable prefix and a
 * FindingEvidence struct. Convenience wrapper — callers can equivalently
 * write `prefix + formatEvidenceForFindingDetail(ev)`.
 */
export function composeFindingDetail(
  prefix: string,
  evidence: FindingEvidence,
): string {
  return `${prefix.trim()}${formatEvidenceForFindingDetail(evidence)}`;
}
