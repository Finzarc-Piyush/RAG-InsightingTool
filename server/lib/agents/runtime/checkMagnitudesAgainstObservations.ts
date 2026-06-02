/**
 * ============================================================================
 * checkMagnitudesAgainstObservations.ts — catches made-up numbers in the answer
 * ============================================================================
 * WHAT THIS FILE DOES
 *   The final answer carries a "magnitudes" block — 2–4 headline numbers like
 *   `{ label: "South-MT volume drop", value: "-8% MoM" }`. The narrator is TOLD
 *   to only use numbers it actually computed, but telling isn't enforcing — a
 *   hallucinated "-23%" can slip through. This pure helper pulls every numeric
 *   token out of each magnitude and verifies each one appears (within a ±2%
 *   tolerance) somewhere in the legitimate evidence pool. The pool is built from:
 *   the tool observations (the figures the agent actually computed), the retrieved
 *   RAG background block, and the composed FMCG/Marico domain context (authored
 *   industry-pack figures). All three count because a number can be legitimately
 *   cited from background even if this turn's tools didn't produce it.
 *
 * WHY IT MATTERS
 *   This is the anti-fabrication gate for headline figures — the numbers a reader
 *   is most likely to quote. If too many are unsupported it asks the loop to
 *   re-emit the magnitudes block, keeping the answer's numbers traceable.
 *
 * KEY PIECES
 *   - checkMagnitudesAgainstObservations — the check. Returns {ok:true} or
 *     {ok:false, code:"FABRICATED_MAGNITUDES", description, courseCorrection,
 *     fabricated[]}, the same result shape as the other verifier checks so they
 *     share one repair flow / budget.
 *   - MIN_FABRICATED_TO_FLAG (= 2) — needs at least two unsupported magnitudes
 *     before flagging; a single one is usually a harmless rounding artefact
 *     ("8.2%" computed vs "8%" written) and not worth burning a retry on.
 *
 * HOW IT CONNECTS
 *   Uses extractNumbersFromNarrative (verifyNarrativeNumbers.js) to tokenise both
 *   the claims and the evidence. Called by the verifier stage of the agent loop.
 *   No I/O, no LLM calls.
 */
import {
  extractNumbersFromNarrative,
  type ExtractedNumber,
} from "./verifyNarrativeNumbers.js";

/**
 * Magnitude shape emitted by the narrator / synthesizer (matches the
 * `magnitudeSchema` zod type in agentLoop.service.ts). Kept as a structural
 * type here to avoid a circular import.
 */
export interface MagnitudeForCheck {
  label: string;
  value: string;
  confidence?: "low" | "medium" | "high";
}

const DEFAULT_TOLERANCE = 0.02;
/**
 * Minimum claim count before we trigger a repair. Two reasons:
 *   1. Single-magnitude fabrication is sometimes a rounding artefact
 *      (e.g. observation says "8.2%" and narrator says "8% MoM");
 *      ±2% catches most but edge cases slip.
 *   2. We don't want to retry-loop on a borderline case and burn budget.
 * Tuned conservatively — same threshold as the narrative-numbers check.
 */
const MIN_FABRICATED_TO_FLAG = 2;

export type MagnitudeCheckResult =
  | { ok: true }
  | {
      ok: false;
      code: "FABRICATED_MAGNITUDES";
      description: string;
      courseCorrection: string;
      fabricated: Array<{
        label: string;
        value: string;
        unsupportedNumbers: string[];
      }>;
    };

/** Match `claim` to any pool entry within ±tolerance. */
function isSupported(claim: number, pool: number[], tolerance: number): boolean {
  for (const v of pool) {
    if (v === 0) {
      if (Math.abs(claim) < 1e-9) return true;
      continue;
    }
    const rel = Math.abs((v - claim) / Math.abs(v));
    if (rel <= tolerance) return true;
  }
  return false;
}

/** Build a numeric pool from text sources (observations / RAG / domain). */
function buildPoolFromText(sources: Array<string | undefined>): number[] {
  const pool: number[] = [];
  for (const s of sources) {
    if (!s) continue;
    const found = extractNumbersFromNarrative(s);
    for (const n of found) pool.push(n.value);
  }
  return pool;
}

/**
 * Anti-fabrication check for `envelope.magnitudes`. Returns `ok: true`
 * when every magnitude with extractable numbers is supported by the
 * evidence pool, OR when fewer than `MIN_FABRICATED_TO_FLAG` magnitudes
 * are unsupported (rounding-artefact tolerance).
 */
export function checkMagnitudesAgainstObservations(
  magnitudes: ReadonlyArray<MagnitudeForCheck> | undefined,
  evidence: {
    observations: string[];
    ragBlock?: string;
    domainContext?: string;
  },
  tolerance: number = DEFAULT_TOLERANCE
): MagnitudeCheckResult {
  if (!Array.isArray(magnitudes) || magnitudes.length === 0) {
    return { ok: true };
  }

  const pool = buildPoolFromText([
    ...evidence.observations,
    evidence.ragBlock,
    evidence.domainContext,
  ]);
  if (pool.length === 0) {
    // No evidence pool to check against → can't verify. Pass through;
    // the narrative-vs-charts check handles the chart-data case.
    return { ok: true };
  }

  const fabricated: Array<{
    label: string;
    value: string;
    unsupportedNumbers: string[];
  }> = [];
  for (const m of magnitudes) {
    const claims: ExtractedNumber[] = extractNumbersFromNarrative(
      `${m.value} ${m.label}`
    );
    if (claims.length === 0) continue; // Symbolic magnitude (no digits) — skip.
    const unsupported = claims.filter((c) => !isSupported(c.value, pool, tolerance));
    if (unsupported.length > 0) {
      fabricated.push({
        label: m.label,
        value: m.value,
        unsupportedNumbers: unsupported.map((u) => u.raw),
      });
    }
  }

  if (fabricated.length < MIN_FABRICATED_TO_FLAG) {
    // Single-magnitude fabrication is often a rounding artefact;
    // require at least two before we trigger a repair.
    return { ok: true };
  }

  const description = `${fabricated.length} of ${magnitudes.length} magnitudes cite numbers that don't appear (within ±${(tolerance * 100).toFixed(0)}%) in the tool observations, RAG block, or domain context. Offenders: ${fabricated
    .map((f) => `"${f.label}: ${f.value}" (cites ${f.unsupportedNumbers.join(", ")})`)
    .join("; ")}.`;
  const courseCorrection =
    "Re-emit the magnitudes block. Each magnitude's `value` MUST contain a number that appears verbatim (or within 2%) in the supplied observations / CONTEXT BUNDLE. Drop any magnitude whose number you can't trace to a specific observation line — the magnitude block is the evidence summary, not a place for plausible-sounding figures.";

  return {
    ok: false,
    code: "FABRICATED_MAGNITUDES",
    description,
    courseCorrection,
    fabricated,
  };
}
