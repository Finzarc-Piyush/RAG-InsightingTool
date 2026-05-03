/**
 * Wave B10 · cross-finding inconsistency detection + confidence propagation.
 *
 * Three responsibilities:
 *   1. **Inconsistency watcher**: when a new finding is emitted, compare its
 *      magnitude against existing findings on the same metric/scope. If the
 *      magnitudes diverge by > 20%, flag a `Contradiction` for the reflector
 *      to investigate.
 *   2. **Confidence propagation**: when the narrator composes implications /
 *      recommendations from findings, the composite's confidence = min of
 *      contributing findings' confidence. Pure function.
 *   3. **Magnitude audit graph completeness**: at narrator output time,
 *      every magnitude in the envelope must trace to a `MagnitudeAudit`
 *      (Wave C2). Magnitudes without an audit are flagged.
 */
import type {
  StructuredFinding,
  Contradiction,
  FindingId,
  MagnitudeAudit,
} from "./investigationState.js";

const DIVERGENCE_THRESHOLD_PCT = 20;

/**
 * Detect contradictions between a new finding and the existing set. Returns
 * the `Contradiction` records to add to state, or empty when consistent.
 */
export function detectContradictions(
  incoming: StructuredFinding,
  existing: ReadonlyArray<StructuredFinding>
): Contradiction[] {
  if (!incoming.magnitude) return [];
  const out: Contradiction[] = [];
  for (const e of existing) {
    if (e.id === incoming.id) continue;
    if (!e.magnitude) continue;
    if (!sameMetricAndScope(e, incoming)) continue;
    const a = e.magnitude.value;
    const b = incoming.magnitude.value;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const denom = Math.max(Math.abs(a), Math.abs(b), 1e-9);
    const deltaPct = (Math.abs(a - b) / denom) * 100;
    if (deltaPct > DIVERGENCE_THRESHOLD_PCT) {
      out.push({
        id: `contradict-${e.id}-${incoming.id}`,
        a: e.id,
        b: incoming.id,
        reason: `magnitudes differ by ${deltaPct.toFixed(1)}% on the same metric/scope (${e.magnitude.value} vs ${incoming.magnitude.value})`,
        deltaPct,
        detectedAt: Date.now(),
      });
    }
  }
  return out;
}

function sameMetricAndScope(a: StructuredFinding, b: StructuredFinding): boolean {
  if (!a.magnitude || !b.magnitude) return false;
  if (a.magnitude.metric !== b.magnitude.metric) return false;
  // Same filter scope = same JSON-stringified filter (best-effort comparison).
  const af = JSON.stringify(a.magnitude.filter ?? {});
  const bf = JSON.stringify(b.magnitude.filter ?? {});
  return af === bf;
}

/**
 * Compose-time confidence propagation. The narrator's implications and
 * recommendations cite findings by id; the composite confidence = min of
 * supporting findings' confidence.
 */
export function propagatedConfidence(
  supportingFindingIds: ReadonlyArray<FindingId>,
  findings: ReadonlyArray<StructuredFinding>
): "low" | "medium" | "high" | "unknown" {
  const rank = { low: 0, medium: 1, high: 2 } as const;
  let minRank: number = Infinity;
  for (const fid of supportingFindingIds) {
    const f = findings.find((x) => x.id === fid);
    if (!f) continue;
    const r = rank[f.confidence];
    if (r < minRank) minRank = r;
  }
  if (!Number.isFinite(minRank)) return "unknown";
  return ["low", "medium", "high"][minRank as 0 | 1 | 2];
}

/**
 * Verify that every magnitude in the envelope traces to at least one
 * MagnitudeAudit. Returns the set of magnitude labels lacking audit; the
 * narrator can include "spot-check unavailable for X" in caveats when the
 * set is non-empty.
 */
export function findUnauditedMagnitudes(args: {
  magnitudes: ReadonlyArray<{ label: string; value: string }>;
  audits: ReadonlyArray<MagnitudeAudit>;
  findings: ReadonlyArray<StructuredFinding>;
}): string[] {
  const auditedFindingIds = new Set(args.audits.map((a) => a.findingId));
  const out: string[] = [];
  for (const m of args.magnitudes) {
    // Match by best-effort label-vs-claim substring; if no finding matches
    // the magnitude label, mark as unaudited.
    const matched = args.findings.find((f) =>
      f.claim.toLowerCase().includes(m.label.slice(0, 40).toLowerCase())
    );
    if (!matched) {
      out.push(m.label);
      continue;
    }
    if (!auditedFindingIds.has(matched.id)) out.push(m.label);
  }
  return out;
}
