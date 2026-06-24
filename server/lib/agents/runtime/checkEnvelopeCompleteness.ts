/**
 * ============================================================================
 * checkEnvelopeCompleteness.ts — objective quality gates on the final answer
 * ============================================================================
 * WHAT THIS FILE DOES
 *   The final answer is a structured "answer envelope" — TL;DR, findings,
 *   implications, recommendations, caveats, a domain lens, etc. This file holds
 *   a few DETERMINISTIC checks (plain code, no LLM) that decide whether that
 *   envelope is good enough to ship and, if not, produce a precise repair
 *   instruction for the narrator to fix it. The three gates are:
 *     1. Completeness — does an analytical answer actually have implications /
 *        recommendations / a domain lens (when domain context was supplied)?
 *     2. Citation honesty — does the `domainLens` only cite domain "pack" ids
 *        that were really given to it (not hallucinated ones)?
 *     3. Aggregation addressed — if the user asked a plain compute question
 *        ("total sales by region") but the draft says "not computable" AND no
 *        query was ever run, force the agent to actually run the calculation.
 *
 * WHY IT MATTERS
 *   The LLM "deep verifier" is expensive and sometimes wrong because it judges
 *   subjectively. These checks are objective facts ("implications.length < 1"
 *   is not an opinion), so they can run cheaply before the LLM and reliably
 *   catch the most common ways an answer falls short of "decision-grade". They
 *   route failures through the same narrator-repair path and are bounded at the
 *   call site so they can't loop forever.
 *
 * KEY PIECES
 *   - checkEnvelopeCompleteness — flags missing decision-grade sections.
 *   - checkDomainLensCitations — flags hallucinated domain-pack id citations.
 *   - extractSuppliedPackIds — finds which pack ids were actually supplied.
 *   - checkAggregationQuestionAddressed — catches "not computable" cop-outs on
 *       literal aggregation questions where the columns clearly exist.
 *
 * HOW IT CONNECTS
 *   Pure functions over the answer envelope (from shared/schema). Called by the
 *   agent loop after the narrator drafts an answer; a failed gate yields a
 *   description + courseCorrection the loop feeds back as a repair prompt.
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

const MIN_IMPLICATIONS = 1;
const MIN_RECOMMENDATIONS = 1;

/**
 * The ONLY question shapes for which a missing implications/recommendations
 * section is a HARD failure (forces a narrator re-emit). These are the
 * genuinely diagnostic asks where a decision-grade "so what + action" is the
 * point of the question. For the lighter analytical shapes — `comparison`,
 * `trend`, `exploration` (and `descriptive`/`none`) — the gate is ADVISORY: the
 * narrator already calibrates depth to the question (see ANSWER_ENVELOPE_CONTRACT),
 * so FORCING implications + recommendations onto "compare A vs B" or "show the
 * trend" manufactured exactly the unrequested-content bloat the product is
 * trying to avoid. (Finding #8 — the completeness gate was forcing a concise
 * draft to expand.) Magnitudes are still nudged by the verifier's low-severity
 * MISSING_MAGNITUDES for every shape — a key number is the answer, not padding.
 */
const HARD_COMPLETENESS_SHAPES: ReadonlySet<string> = new Set([
  "driver_discovery",
  "variance_diagnostic",
]);

/**
 * @param envelope Optional — when undefined we always pass (the synthesizer
 *   fallback path emits no envelope; nothing to enforce).
 * @param questionShape From `ctx.analysisBrief?.questionShape`. The check only
 *   HARD-fails for the diagnostic shapes in `HARD_COMPLETENESS_SHAPES`. Every
 *   other shape — `undefined`, `"none"`, `"descriptive"`, `"comparison"`,
 *   `"trend"`, `"exploration"` — passes: forcing padded implications/
 *   recommendations on them is the manufactured-content bloat we avoid.
 */
export function checkEnvelopeCompleteness(
  envelope: AnswerEnvelope | undefined,
  questionShape: string | undefined
): CompletenessResult {
  if (!envelope) return { ok: true };
  if (!questionShape || !HARD_COMPLETENESS_SHAPES.has(questionShape)) {
    return { ok: true };
  }

  const missing: string[] = [];
  const implCount = envelope.implications?.length ?? 0;
  const recCount = envelope.recommendations?.length ?? 0;

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

  if (missing.length === 0) return { ok: true };

  const description = `The previous draft is missing required decision-grade sections for an analytical question (questionShape=${questionShape}): ${missing.join("; ")}.`;
  const courseCorrection = `Re-emit the JSON envelope with these sections populated using the existing findings and the supplied CONTEXT BUNDLE — do not invent new numbers, and keep the body / TL;DR / findings / methodology / caveats / magnitudes you already produced.`;

  return {
    ok: false,
    code: "MISSING_DECISION_GRADE_SECTIONS",
    description,
    courseCorrection,
  };
}

/**
 * Anti-hallucination check on `domainLens` citations.
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
    cited.add(match[1]!);
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
    ids.add(match[1]!);
  }
  return [...ids];
}

// =============================================================================
// "Aggregation question not addressed" envelope gate
// =============================================================================
//
// Defense-in-depth for the deterministic synthesis floor. If that floor
// misfires (column binding ambiguous, intent regex misses an unusual
// phrasing) and the narrator still says "not computable" on a question whose
// columns clearly exist, this gate forces ONE repair round with explicit
// instructions to run the aggregation before narrating.
//
// Triggers strictly when ALL of:
//   1. The question carries aggregation intent (PD1, PD3, or simple-agg verb).
//   2. The narrator's tldr / findings text contains "not computable",
//      "cannot compute", "lack of aggregation", or similar give-up phrasing.
//   3. Zero `execute_query_plan` tool calls ran in the trace.
//
// Conservative — single false positive is preferable to silently shipping a
// "not computable" answer for a literal aggregation question.

const NOT_COMPUTABLE_RE =
  /\b(?:not\s+computable|cannot\s+(?:be\s+)?compute(?:d)?|unable\s+to\s+(?:compute|determine|calculate)|lack(?:s|ing)?\s+of\s+(?:direct\s+)?aggregation|no\s+aggregation\s+results?|insufficient\s+(?:direct\s+)?aggregation)\b/i;

export type AggregationAddressedResult =
  | { ok: true }
  | {
      ok: false;
      code: "AGGREGATION_QUESTION_NOT_ADDRESSED";
      description: string;
      courseCorrection: string;
    };

export interface AggregationAddressedInputs {
  /** The user's literal question. */
  question: string;
  /** Whether the trace ran AT LEAST ONE `execute_query_plan` tool call. */
  ranExecuteQueryPlan: boolean;
  /**
   * Whether deterministic aggregation intent was detected for this question
   * by the quick-lookup pipeline (PD1 / PD3 / simple-agg with metric
   * resolvable). Passed by the call site — the gate itself is question-agnostic.
   */
  hasAggregationIntent: boolean;
}

/**
 * Returns `{ ok: false }` only when the narrator's draft claims the question
 * is uncomputable AND aggregation intent was detected AND no
 * analytical query ran. Otherwise passes. The combined trigger makes false
 * positives nearly impossible — a why/driver/comparison question with a
 * legitimate "data doesn't support that" narration will not fire because
 * `hasAggregationIntent` is false.
 */
export function checkAggregationQuestionAddressed(
  envelope: AnswerEnvelope | undefined,
  inputs: AggregationAddressedInputs
): AggregationAddressedResult {
  if (!envelope) return { ok: true };
  if (!inputs.hasAggregationIntent) return { ok: true };
  if (inputs.ranExecuteQueryPlan) return { ok: true };

  const candidates: string[] = [];
  if (typeof envelope.tldr === "string") candidates.push(envelope.tldr);
  if (Array.isArray(envelope.findings)) {
    for (const f of envelope.findings) {
      if (typeof f?.headline === "string") candidates.push(f.headline);
      if (typeof f?.evidence === "string") candidates.push(f.evidence);
    }
  }
  // Also scan recommendations/caveats — sometimes the narrator buries the
  // not-computable admission there instead of the tldr.
  if (Array.isArray(envelope.recommendations)) {
    for (const r of envelope.recommendations) {
      if (typeof r?.action === "string") candidates.push(r.action);
      if (typeof r?.rationale === "string") candidates.push(r.rationale);
    }
  }
  if (Array.isArray(envelope.caveats)) {
    for (const c of envelope.caveats) {
      if (typeof c === "string") candidates.push(c);
    }
  }
  const sawNotComputable = candidates.some((t) => NOT_COMPUTABLE_RE.test(t));
  if (!sawNotComputable) return { ok: true };

  const description = `The user asked a literal aggregation question (${JSON.stringify(
    inputs.question.slice(0, 140)
  )}) and the dataset has the columns needed to answer it, but the draft says the answer is not computable. No execute_query_plan tool was run during this turn.`;
  const courseCorrection = `Run the aggregation. Emit a plan step now with execute_query_plan: pick the groupBy from the dimension the user named ("by X" / "across X" / "per X" when the per-target is non-temporal), set the metric column from the numeric column the user named, and use perDimension + innerOperation:"sum" when the user asked for a rate ("per day" / "daily average"). Re-narrate the envelope using the resulting rows; do not claim the answer is not computable when the dataset contains the columns the question names.`;
  return {
    ok: false,
    code: "AGGREGATION_QUESTION_NOT_ADDRESSED",
    description,
    courseCorrection,
  };
}
