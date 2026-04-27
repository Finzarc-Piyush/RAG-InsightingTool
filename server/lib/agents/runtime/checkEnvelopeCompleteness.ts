/**
 * Wave W17 · checkEnvelopeCompleteness
 *
 * Deterministic pre-LLM gate that decides whether an analytical answer's
 * structured envelope carries enough decision-grade content to ship.
 *
 * Why pre-LLM and separate from `runVerifier`: the deep verifier is an
 * LLM-judged check (expensive, sometimes wrong). Envelope completeness is
 * objective — `implications.length < 2` is a fact, not an opinion — so we
 * gate it deterministically. Failures route through the same
 * `NarratorRepairContext` pathway the W4 deep verifier used to use, but
 * because the check is objective the agent loop is willing to retry it
 * even though the single-flow policy suppresses LLM-judged repairs.
 *
 * Bounded by `config.maxVerifierRoundsFinal` at the call site so we can't
 * loop forever if the narrator can't satisfy the floor.
 */
import type { Message } from "../../../shared/schema.js";

export type AnswerEnvelope = NonNullable<Message["answerEnvelope"]>;

export type CompletenessResult =
  | { ok: true }
  | {
      ok: false;
      code: "MISSING_DECISION_GRADE_SECTIONS";
      description: string;
      courseCorrection: string;
    };

const MIN_IMPLICATIONS = 2;
const MIN_RECOMMENDATIONS = 2;

/**
 * @param envelope Optional — when undefined we always pass (the synthesizer
 *   fallback path emits no envelope; nothing to enforce).
 * @param questionShape From `ctx.analysisBrief?.questionShape`. When `undefined`
 *   or `"none"` (conversational turn) the check always passes.
 * @param domainContextWasSupplied `Boolean(ctx.domainContext?.trim())` at the
 *   call site. Required so we don't demand `domainLens` on turns where no
 *   pack was loaded — the narrator would have nothing to cite.
 */
export function checkEnvelopeCompleteness(
  envelope: AnswerEnvelope | undefined,
  questionShape: string | undefined,
  domainContextWasSupplied: boolean
): CompletenessResult {
  if (!envelope) return { ok: true };
  if (!questionShape || questionShape === "none") return { ok: true };

  const missing: string[] = [];
  const implCount = envelope.implications?.length ?? 0;
  const recCount = envelope.recommendations?.length ?? 0;
  const hasDomainLens = Boolean(envelope.domainLens?.trim());

  if (implCount < MIN_IMPLICATIONS) {
    missing.push(
      `implications (have ${implCount}, need ≥${MIN_IMPLICATIONS}; each {statement, soWhat})`
    );
  }
  if (recCount < MIN_RECOMMENDATIONS) {
    missing.push(
      `recommendations (have ${recCount}, need ≥${MIN_RECOMMENDATIONS}; each {action, rationale, horizon?})`
    );
  }
  if (domainContextWasSupplied && !hasDomainLens) {
    missing.push(
      "domainLens (one paragraph framing findings against the FMCG/Marico domain context; cite the pack id verbatim)"
    );
  }

  if (missing.length === 0) return { ok: true };

  const description = `The previous draft is missing required decision-grade sections for an analytical question (questionShape=${questionShape}): ${missing.join("; ")}.`;
  const courseCorrection = `Re-emit the JSON envelope with these sections populated using the existing findings and the supplied CONTEXT BUNDLE — do not invent new numbers, and keep the body / TL;DR / findings / methodology / caveats / magnitudes you already produced. ${
    domainContextWasSupplied
      ? "Cite the relevant FMCG/Marico domain pack id (e.g. `marico-haircare-portfolio`) verbatim in `domainLens`."
      : ""
  }`.trim();

  return {
    ok: false,
    code: "MISSING_DECISION_GRADE_SECTIONS",
    description,
    courseCorrection,
  };
}
