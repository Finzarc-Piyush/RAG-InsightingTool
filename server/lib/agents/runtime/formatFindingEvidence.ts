/**
 * Wave WV2 · canonical `FindingEvidence → detail prose` formatter.
 *
 * Companion to WW2's `extractFindingEvidence` regex extractor. Tools that
 * produce findings can opt into this canonical phrasing so the downstream
 * WW2 extractor reliably recovers the statistical fields — closing the
 * deterministic-evidence loop without forcing a schema migration on the
 * `Finding` interface.
 *
 * The roundtrip property is the load-bearing contract:
 *   extractFindingEvidence(formatEvidenceForFindingDetail(ev)) ≈ ev
 *
 * Tools call:
 *   const detailPrefix = "Driver model fit on revenue.";
 *   const evSuffix = formatEvidenceForFindingDetail({ n: 850, pValue: 0.001, rSquared: 0.71 });
 *   addFinding(bb, { ..., detail: detailPrefix + evSuffix });
 *
 * Returns "" when no evidence is supplied so callers can concatenate safely.
 */

import type { FindingEvidence } from "./scaleNarrativeByConfidence.js";

/** Format a p-value for prose. Matches the WW2 extractor's accepted shapes. */
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
  // Wave WQ8 · canonical categorical effect-size token. Trails the
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
