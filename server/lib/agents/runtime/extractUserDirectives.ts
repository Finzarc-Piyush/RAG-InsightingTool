/**
 * ============================================================================
 * extractUserDirectives.ts — detect standing "always do X" rules in a chat
 * message and turn them into persistent directives
 * ============================================================================
 * WHAT THIS FILE DOES
 *   A user might say "from now on always exclude the South region" or "for this
 *   dataset, only show premium SKUs". Those are not one-off filters — they are
 *   STANDING rules that should apply to every future answer. This module scans a
 *   message sentence-by-sentence for a persistence cue ("always", "from now on",
 *   "by default", "for this dataset", etc.) sitting next to an exclude/include
 *   clause, resolves which column + values it refers to (reusing the one-turn
 *   filter parser), and emits a `DirectiveDraft` ready to be saved.
 *
 * WHY IT MATTERS
 *   It is how the tool "remembers" user preferences across turns. It is strictly
 *   ADDITIVE: messages WITHOUT a persistence cue stay one-turn filters handled
 *   by `inferFiltersFromQuestion.ts`, so existing behaviour is unchanged. It
 *   also detects contradictions — if a new rule reverses an existing active one
 *   (same column, opposing include/exclude, overlapping values) it lists the old
 *   directive's id in `supersedes` so the caller can retire it in the same write.
 *
 * KEY PIECES
 *   - extractUserDirectives — main: message in, ExtractedDirective[] out (empty when no standing rule)
 *   - detectSupersedeIds — find prior active directives the new one contradicts/repeats
 *   - PERSISTENCE_QUALIFIER_RE / INCLUSION_VERB_RE — the cue vocabularies
 *
 * HOW IT CONNECTS
 *   Reuses exclusion-clause regexes + `inferFiltersFromQuestion` from
 *   `../utils/inferFiltersFromQuestion.js`. Returns `DirectiveDraft`s (see
 *   `datasetDirectives.model.ts`) — it does NOT perform the database write
 *   itself; that stays in the model layer's `appendDirective`.
 */
import type { DataSummary, UserDirective } from "../../../shared/schema.js";
import type { DirectiveDraft } from "../../../models/datasetDirectives.model.js";
import {
  EXCLUDE_VERB_RE_G,
  NEG_CAPTURE_CHAR_CAP,
  NEG_SENTENCE_BOUNDARIES_RE,
  NEG_POLARITY_FLIPPER_RE,
  inferFiltersFromQuestion,
} from "../utils/inferFiltersFromQuestion.js";
import { classifyQueryIntent } from "./queryIntentAuthority.js";

/**
 * Persistence-intent vocabulary. A user message whose exclusion clause sits
 * inside the same sentence as one of these phrasings is interpreted as a
 * directive (persist across turns) rather than a one-shot filter.
 *
 * Exported (W-UD-gate) because the directive-persistence seam also uses it as a
 * deterministic gate over the LLM extractor — see `isQuestionShapedWithoutMarker`.
 */
export const PERSISTENCE_QUALIFIER_RE =
  /\b(always|from\s+now\s+on|going\s+forward|for\s+the\s+rest\s+(?:of\s+(?:this|the)\s+(?:session|chat|dataset))?|for\s+this\s+dataset|for\s+all\s+(?:future\s+)?(?:questions|answers|charts)|permanently|by\s+default|every\s+time|whenever|in\s+general|throughout|hereafter)\b/i;

/** Inclusion-direction qualifier — flips an exclusion intent to include-only. */
const INCLUSION_VERB_RE =
  /\b(only\s+(?:show|include|use)|just\s+show|restrict\s+to|limit\s+to|stick\s+to|focus\s+on(?:ly)?)\b/i;

export interface ExtractedDirective {
  draft: DirectiveDraft;
  /** Verbatim sentence span that triggered the extraction (for telemetry). */
  triggerSpan: string;
}

export interface ExtractUserDirectivesInput {
  message: string;
  summary: DataSummary;
  /** Currently-active directives on the dataset — used for supersede detection. */
  existingDirectives?: UserDirective[];
  sourceSessionId?: string;
  sourceTurnId?: string;
}

/** Split a message into sentence-shaped segments for qualifier-locality checks. */
function splitSentences(message: string): string[] {
  return message
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Does this sentence carry a persistence qualifier? */
function isPersistentSentence(sentence: string): boolean {
  return PERSISTENCE_QUALIFIER_RE.test(sentence);
}

/** Does this sentence carry an inclusion qualifier? */
function isInclusionSentence(sentence: string): boolean {
  return INCLUSION_VERB_RE.test(sentence);
}

/**
 * W-UD-gate · deterministic guard for the LLM directive extractor.
 *
 * The LLM pass (extractUserDirectivesLlm) is *told* to never mint a directive
 * from a one-off question lacking a persistence marker, but a MINI-tier model
 * occasionally disobeys and saves a plain analytical question ("avg clock in
 * time by cluster") as a standing rule — which then silently biases future
 * analysis (lesson L-022: ship the deterministic gate BEFORE the prompt opens
 * the permission). This predicate is that gate.
 *
 * Returns true when the message reads as an analytical / lookup / factual
 * QUESTION (per the query-intent authority, invariant #12) AND carries NO
 * explicit persistence marker. Such messages are asks-to-answer, not
 * rules-to-remember, so any LLM-mined directive from them is dropped. Genuine
 * marker-less rule statements ("stop featuring Hair Oil") are imperative /
 * declarative — none of the question signals fire — so they still pass through.
 * Marker-bearing messages ("from now on always exclude Central") also pass
 * (and are caught by the strict deterministic extractor regardless).
 */
export function isQuestionShapedWithoutMarker(message: string): boolean {
  const m = message?.trim() ?? "";
  if (!m) return false;
  if (PERSISTENCE_QUALIFIER_RE.test(m)) return false;
  const intent = classifyQueryIntent(m);
  return (
    intent.isLookupShape ||
    intent.isDirectFactual ||
    intent.signals.analytical ||
    intent.signals.diagnostic ||
    intent.signals.strategic ||
    intent.signals.trend
  );
}

/** Returns true when a sentence has an exclusion verb whose captured clause
 *  is NOT polarity-flipped. Mirrors the gating in `inferFiltersFromQuestion`. */
function hasExclusionIntent(sentence: string): boolean {
  EXCLUDE_VERB_RE_G.lastIndex = 0;
  for (const m of sentence.matchAll(EXCLUDE_VERB_RE_G)) {
    const verbEnd = (m.index ?? 0) + m[0].length;
    let region = sentence.slice(verbEnd, verbEnd + NEG_CAPTURE_CHAR_CAP);
    const boundary = region.search(NEG_SENTENCE_BOUNDARIES_RE);
    if (boundary >= 0) region = region.slice(0, boundary);
    region = region.trim();
    if (!region) continue;
    if (NEG_POLARITY_FLIPPER_RE.test(region)) continue;
    return true;
  }
  return false;
}

/** Detect whether `draft` contradicts an existing active directive. Returns
 *  the ids of all overlapping prior directives that should be superseded. */
function detectSupersedeIds(
  draft: DirectiveDraft,
  existing: UserDirective[]
): string[] {
  if (!draft.structured?.column || !draft.structured?.op) return [];
  const ids: string[] = [];
  for (const prior of existing) {
    if (prior.status !== "active") continue;
    if (!prior.structured?.column || !prior.structured?.op) continue;
    if (prior.structured.column !== draft.structured.column) continue;
    // Opposing-op pair: exclude (not_in) ↔ include-only (in).
    const isOpposing =
      (prior.structured.op === "not_in" && draft.structured.op === "in") ||
      (prior.structured.op === "in" && draft.structured.op === "not_in");
    if (!isOpposing) {
      // Same op but DIFFERENT values is co-existence (no supersede).
      // Same op AND identical values is a tautological repeat — supersede the
      // older one to keep the audit chain clean.
      if (prior.structured.op !== draft.structured.op) continue;
      const a = new Set(prior.structured.values ?? []);
      const b = new Set(draft.structured.values ?? []);
      if (a.size !== b.size) continue;
      let identical = true;
      for (const v of a) if (!b.has(v)) { identical = false; break; }
      if (identical) ids.push(prior.id);
      continue;
    }
    // Opposing ops + any overlap in values → the prior intent is reversed.
    const priorVals = new Set(prior.structured.values ?? []);
    const newVals = draft.structured.values ?? [];
    if (newVals.some((v) => priorVals.has(v))) ids.push(prior.id);
  }
  return ids;
}

/**
 * Extract persistent user directives from the current message.
 *
 * Returns an empty array when the message contains no qualifier-bearing
 * exclusion or inclusion clause. Each returned `ExtractedDirective` is a
 * draft ready to pass to `appendDirective`, with `supersedes` populated
 * when the message contradicts an existing active directive on the same
 * column.
 */
export function extractUserDirectives(
  input: ExtractUserDirectivesInput
): ExtractedDirective[] {
  const { message, summary, existingDirectives = [] } = input;
  if (!message || message.trim().length === 0) return [];

  const sentences = splitSentences(message);
  // Whole-message inferred filters: parses both positive and negative
  // (not_in) candidates against categorical topValues.
  const inferred = inferFiltersFromQuestion(message, summary);

  const out: ExtractedDirective[] = [];

  for (const sentence of sentences) {
    const persistent = isPersistentSentence(sentence);
    if (!persistent) continue;

    const hasExcl = hasExclusionIntent(sentence);
    const hasIncl = isInclusionSentence(sentence);
    if (!hasExcl && !hasIncl) continue;

    // Polarity-flipped EXCLUSION sentences ("exclude everything except for X")
    // are semantically ambiguous in a persistent context. The deterministic
    // pass bails — the LLM extractor handles these. Only applies when an
    // exclusion verb is the primary intent; inclusion-only sentences carry
    // "only"/"just" as part of the verb itself and don't need this gate.
    if (hasExcl && !hasIncl && NEG_POLARITY_FLIPPER_RE.test(sentence)) continue;

    // Match inferred filters that resolve against values mentioned in this
    // sentence. The filter values must appear inside the sentence span (case-
    // insensitive substring match) — this avoids attributing a global filter
    // to a sentence that didn't name it.
    const lowerSent = sentence.toLowerCase();
    for (const f of inferred) {
      const valuesInSentence = f.values.filter((v) =>
        lowerSent.includes(v.toLowerCase())
      );
      if (valuesInSentence.length === 0) continue;

      const kind = hasIncl && f.op === "in" ? "include-only" : (f.op === "in" ? "include-only" : "exclude");
      const op = f.op;
      const draft: DirectiveDraft = {
        scope: "dataset",
        kind,
        text: sentence,
        structured: {
          column: f.column,
          op,
          values: valuesInSentence,
        },
        source: "chat-message",
        sourceSessionId: input.sourceSessionId,
        sourceTurnId: input.sourceTurnId,
        supersedes: undefined,
      };
      const supersedeIds = detectSupersedeIds(draft, existingDirectives);
      if (supersedeIds.length > 0) draft.supersedes = supersedeIds;
      out.push({ draft, triggerSpan: sentence });
    }
  }

  return dedupe(out);
}

/** Collapse duplicates emitted because the same sentence matched multiple
 *  inferred-filter buckets that targeted the same (column, op, values). */
function dedupe(items: ExtractedDirective[]): ExtractedDirective[] {
  const seen = new Set<string>();
  const out: ExtractedDirective[] = [];
  for (const it of items) {
    const key = `${it.draft.structured?.column}|${it.draft.structured?.op}|${(
      it.draft.structured?.values ?? []
    )
      .slice()
      .sort()
      .join(",")}|${it.triggerSpan}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __PERSISTENCE_QUALIFIER_RE = PERSISTENCE_QUALIFIER_RE;
export const __INCLUSION_VERB_RE = INCLUSION_VERB_RE;
export { detectSupersedeIds as __detectSupersedeIdsForTesting };
