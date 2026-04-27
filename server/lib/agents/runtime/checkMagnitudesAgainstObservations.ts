/**
 * Wave W35 · `magnitudes` numerical fabrication check
 *
 * The W8 envelope requires 2–4 `magnitudes` entries (e.g.
 * `{ label: "South-MT volume drop", value: "-8% MoM" }`) for analytical
 * questions. The narrator is *prompted* to use only observation numbers,
 * but no deterministic check fires — a hallucinated `-23%` slips through.
 *
 * This helper extracts every numeric token from each magnitude's `value`
 * (and `label` as a fallback) and confirms each one appears within ±2%
 * tolerance somewhere in the supporting evidence pool. The pool spans:
 *   - Tool observations (primary — the figures the agent computed)
 *   - The W7 RAG block (legitimate cited background numbers)
 *   - The composed FMCG/Marico domain context (industry-pack figures)
 *
 * Domain + RAG inclusion is critical: the narrator may cite
 * `marico-foods-edible-oils-portfolio`'s authored figures, which don't
 * appear in this turn's tool output but ARE legitimate.
 *
 * Returns the same `{ ok: true } | { ok: false, code, ... }` shape as
 * `checkEnvelopeCompleteness` (W17) and `checkDomainLensCitations` (W22)
 * so the agent loop can integrate it into the same repair flow with the
 * shared `maxVerifierRoundsFinal` budget.
 *
 * Pure-logic helper. No I/O. No LLM calls.
 */
import {
  extractNumbersFromNarrative,
  type ExtractedNumber,
} from "./verifyNarrativeNumbers.js";

/**
 * Magnitude shape emitted by the narrator / synthesizer (matches the
 * `magnitudeSchema` zod type at `agentLoop.service.ts:312`). Kept as a
 * structural type here to avoid a circular import.
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
 * Tuned conservatively — same threshold as the W7.5 narrative-numbers
 * check.
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
    // the W7.5 narrative-vs-charts check handles the chart-data case.
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
