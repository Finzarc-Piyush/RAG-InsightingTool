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

/**
 * W22 · anti-hallucination check on `domainLens` citations.
 *
 * The narrator + synthesizer prompts instruct: "cite the pack id verbatim"
 * (e.g. `marico-haircare-portfolio`). This check confirms that any backtick-
 * quoted token in `domainLens` that *looks like* a pack id is actually one
 * of the ids that was supplied in the prompt's CONTEXT BUNDLE. If the LLM
 * cited a pack id we never gave it, that's hallucination and the answer
 * should be repaired.
 *
 * Heuristic id extraction: backtick-quoted tokens matching the
 * `[a-z][a-z0-9-]+` shape and ≥ 5 chars (filters out cited column names
 * and acronyms like `MT`). False positives (e.g. function names cited in
 * backticks) are extremely rare given the narrator's prompt constrains
 * domainLens to a single paragraph about FMCG context.
 */
export type CitationResult =
  | { ok: true }
  | {
      ok: false;
      code: "HALLUCINATED_DOMAIN_CITATION";
      description: string;
      courseCorrection: string;
      fabricatedIds: string[];
    };

const CITATION_TOKEN_RE = /`([a-z][a-z0-9-]{4,})`/g;

export function checkDomainLensCitations(
  envelope: AnswerEnvelope | undefined,
  /** Pack ids that were actually present in the supplied domain context. */
  suppliedPackIds: ReadonlyArray<string>
): CitationResult {
  if (!envelope?.domainLens) return { ok: true };
  if (suppliedPackIds.length === 0) {
    // No packs were supplied — the narrator shouldn't have a domainLens to
    // cite from. Completeness check (separate path) handles "missing
    // domainLens"; this function only flags fabrication, so pass.
    return { ok: true };
  }

  const supplied = new Set(suppliedPackIds);
  const cited = new Set<string>();
  for (const match of envelope.domainLens.matchAll(CITATION_TOKEN_RE)) {
    cited.add(match[1]);
  }
  if (cited.size === 0) return { ok: true };

  // Only flag tokens that *look* like pack ids — kebab-case with at least
  // one hyphen — to avoid false positives on cited column names like
  // `Volume_MT` or unrelated short backticks. A pack id always contains a
  // hyphen by convention (e.g. `marico-haircare-portfolio`).
  const candidates = [...cited].filter((c) => c.includes("-"));
  if (candidates.length === 0) return { ok: true };

  const fabricated = candidates.filter((c) => !supplied.has(c));
  if (fabricated.length === 0) return { ok: true };

  const description = `domainLens cites pack id(s) that were not in the supplied CONTEXT BUNDLE: ${fabricated.join(", ")}. Available packs were: ${suppliedPackIds.slice(0, 6).join(", ")}${suppliedPackIds.length > 6 ? ", …" : ""}.`;
  const courseCorrection = `Re-emit the envelope. In \`domainLens\`, cite ONLY pack ids that appear verbatim in the DOMAIN KNOWLEDGE block of the CONTEXT BUNDLE — do not invent ids. If no pack is materially relevant to the answer, omit \`domainLens\` entirely (it is optional). Available pack ids: ${suppliedPackIds.slice(0, 8).join(", ")}.`;

  return {
    ok: false,
    code: "HALLUCINATED_DOMAIN_CITATION",
    description,
    courseCorrection,
    fabricatedIds: fabricated,
  };
}

/**
 * Extract pack ids from the composed domain-context block emitted by
 * `loadEnabledDomainContext`. The composer wraps each pack with
 * `<<DOMAIN PACK: id>> ... <</DOMAIN PACK>>` markers (see
 * loadEnabledDomainContext.ts). This pure helper finds the ids without
 * importing the loader (which is async + cached + module-scoped).
 */
const PACK_MARKER_RE = /<<DOMAIN PACK:\s*([a-z][a-z0-9-]+)\s*>>/g;
export function extractSuppliedPackIds(domainContext: string | undefined): string[] {
  if (!domainContext) return [];
  const ids = new Set<string>();
  for (const match of domainContext.matchAll(PACK_MARKER_RE)) {
    ids.add(match[1]);
  }
  return [...ids];
}
