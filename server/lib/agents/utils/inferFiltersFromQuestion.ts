import type { DataSummary } from "../../../shared/schema.js";
import { findUniqueValueColumnMatch } from "../../dimensionFilterRepair.js";

export interface InferredFilter {
  column: string;
  op: "in" | "not_in";
  values: string[];
  match: "exact" | "case_insensitive";
  matchedTokens: string[];
  /** RD3 · "positive" = user wants these values IN, "negative" = user wants OUT. */
  intent?: "positive" | "negative";
}

// RD3 · exclusion-verb scan. The clause following each verb (up to a sentence
// boundary or NEG_CAPTURE_CHAR_CAP chars) is run through the same n-gram
// resolver; uniquely-matched values become `not_in` filters. Mirrors the
// verb set used by RD2 in planArgRepairs.ts but operates on the raw question
// text (no rollup-name proximity gate — any captured value qualifies).
//
// Wave W-UD4 · these constants are exported so the persistent-directive
// extractor (`extractUserDirectives.ts`) can reuse the same vocabulary
// without drift.
export const EXCLUDE_VERB_RE_G =
  /\b(omit|exclud(?:e|es|ed|ing)|without|except|leav(?:e|ing)\s+out|drop(?:s|ped|ping)?|remov(?:e|es|ed|ing)|skip(?:s|ped|ping)?|ignor(?:e|es|ed|ing)|aside\s+from|apart\s+from|other\s+than|don'?t\s+include|do\s+not\s+include|not\s+including|minus)\b/gi;
export const NEG_CAPTURE_CHAR_CAP = 80;
export const NEG_SENTENCE_BOUNDARIES_RE = /[.!?;]/;

const QUESTION_STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "of", "in", "for", "and", "or", "but", "nor",
  "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "doing", "done",
  "by", "on", "at", "with", "from", "over", "across", "to", "as", "into", "onto", "upon",
  "my", "our", "their", "its", "this", "that", "these", "those",
  "which", "what", "where", "when", "who", "whom", "whose", "why", "how",
  "most", "least", "top", "bottom", "best", "worst", "high", "higher", "highest",
  "low", "lower", "lowest", "big", "bigger", "biggest", "small", "smaller", "smallest",
  "grow", "grew", "growing", "growth", "grown",
  "decline", "declining", "declined", "increase", "increased", "increasing",
  "decrease", "decreased", "decreasing",
  "rise", "rising", "rose", "risen", "fell", "fall", "falling", "fallen",
  "vs", "versus", "compared", "compare", "than", "against",
  "show", "shows", "showing", "tell", "tells", "telling", "give", "gives", "list", "lists",
  "find", "finds", "finding", "report", "reports", "see", "sees",
  "have", "has", "had", "having",
  "more", "less", "all", "any", "some", "each", "every", "none",
  "terms", "total", "overall", "between", "among", "within", "without",
  "me", "us", "you", "he", "she", "it", "they", "them",
  "if", "then", "so", "such", "whether",
  "not", "no",
]);

function normalizeWords(question: string): string[] {
  return question
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

function nameWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

function isNumericToken(token: string): boolean {
  return /^\d+(?:\.\d+)?$/.test(token);
}

function detectTier(
  token: string,
  canonical: string
): "exact" | "case_insensitive" | "contains" {
  if (canonical === token) return "exact";
  if (canonical.toLowerCase() === token.toLowerCase()) return "case_insensitive";
  return "contains";
}

/**
 * Deterministic pre-planner pass: tokenize the user question, generate 1–3-word
 * candidates, and resolve each to a unique (column, canonical value) using the
 * existing categorical hints on `summary`. Returns filters ready to be dropped
 * into `execute_query_plan.dimensionFilters` verbatim. Abstains on ambiguity.
 */
export function inferFiltersFromQuestion(
  question: string,
  summary: DataSummary | null | undefined,
  opts?: {
    maxFilters?: number;
    maxValuesPerFilter?: number;
    maxNgramLength?: number;
  }
): InferredFilter[] {
  const maxFilters = opts?.maxFilters ?? 4;
  const maxValues = opts?.maxValuesPerFilter ?? 10;
  const maxN = opts?.maxNgramLength ?? 3;

  if (!question || !summary?.columns?.length) return [];

  const words = normalizeWords(question);
  if (!words.length) return [];

  const columnNameLower = new Set<string>();
  const columnWordLower = new Set<string>();
  for (const c of summary.columns) {
    columnNameLower.add(c.name.toLowerCase());
    for (const w of nameWords(c.name)) columnWordLower.add(w);
  }

  const candidates = new Set<string>();
  for (let n = 1; n <= maxN; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const window = words.slice(i, i + n);
      const first = window[0]!;
      const last = window[window.length - 1]!;
      if (QUESTION_STOP_WORDS.has(first)) continue;
      if (QUESTION_STOP_WORDS.has(last)) continue;
      if (isNumericToken(first) || isNumericToken(last)) continue;
      if (n === 1) {
        if (first.length < 2) continue;
        if (columnWordLower.has(first)) continue;
      } else {
        const phrase = window.join(" ");
        if (columnNameLower.has(phrase)) continue;
        const allColumnWords = window.every((w) => columnWordLower.has(w));
        if (allColumnWords) continue;
      }
      candidates.add(window.join(" "));
    }
  }

  type Bucket = {
    values: string[];
    tokens: string[];
    tiers: Set<"exact" | "case_insensitive" | "contains">;
  };
  const byColumn = new Map<string, Bucket>();

  for (const candidate of candidates) {
    const hit = findUniqueValueColumnMatch(summary, candidate);
    if (!hit) continue;

    const tier = detectTier(candidate, hit.canonical);
    const bucket = byColumn.get(hit.column) ?? {
      values: [],
      tokens: [],
      tiers: new Set<"exact" | "case_insensitive" | "contains">(),
    };
    if (
      !bucket.values.includes(hit.canonical) &&
      bucket.values.length < maxValues
    ) {
      bucket.values.push(hit.canonical);
    }
    if (!bucket.tokens.includes(candidate)) {
      bucket.tokens.push(candidate);
    }
    bucket.tiers.add(tier);
    byColumn.set(hit.column, bucket);
  }

  const out: InferredFilter[] = [];
  for (const [column, bucket] of byColumn.entries()) {
    if (out.length >= maxFilters) break;
    if (bucket.values.length === 0) continue;
    const matchMode: "exact" | "case_insensitive" = bucket.tiers.has("exact")
      ? "exact"
      : "case_insensitive";
    out.push({
      column,
      op: "in",
      values: bucket.values,
      match: matchMode,
      matchedTokens: bucket.tokens,
      intent: "positive",
    });
  }

  // RD3 · negative-filter pre-scan. Disabled via AGENT_INFER_NEGATIVE_FILTERS=false.
  if (process.env.AGENT_INFER_NEGATIVE_FILTERS !== "false") {
    const negative = inferNegativeFiltersFromExclusionVerbs(
      question,
      summary,
      { maxFilters, maxValues, maxN }
    );
    if (negative.length) {
      // Strip any value the user said to exclude from the positive filters on
      // the same column — "compare A vs B without B" should not emit both
      // `in: [A,B]` and `not_in: [B]`.
      const excludedByCol = new Map<string, Set<string>>();
      for (const f of negative) {
        const set = excludedByCol.get(f.column) ?? new Set<string>();
        for (const v of f.values) set.add(v.toLowerCase());
        excludedByCol.set(f.column, set);
      }
      for (const f of out) {
        const ex = excludedByCol.get(f.column);
        if (!ex) continue;
        f.values = f.values.filter((v) => !ex.has(v.toLowerCase()));
      }
      // Drop emptied positive filters; emit non-empty negatives.
      const remaining = out.filter((f) => f.values.length > 0);
      remaining.push(...negative);
      return remaining.slice(0, maxFilters);
    }
  }

  return out;
}

// RD3 · "ignore the rest, just X" / "except for X" inverts the polarity of the
// exclusion verb — the captured clause names what to KEEP, not what to omit.
// Exported for W-UD4 reuse in the directive extractor.
export const NEG_POLARITY_FLIPPER_RE =
  /\b(?:just|only|the\s+rest|everything\s+else|all\s+else|all\s+but|except\s+for)\b/i;

function inferNegativeFiltersFromExclusionVerbs(
  question: string,
  summary: DataSummary,
  opts: { maxFilters: number; maxValues: number; maxN: number }
): InferredFilter[] {
  EXCLUDE_VERB_RE_G.lastIndex = 0;
  const regions: string[] = [];
  for (const m of question.matchAll(EXCLUDE_VERB_RE_G)) {
    const verbEnd = (m.index ?? 0) + m[0].length;
    // Capture up to NEG_CAPTURE_CHAR_CAP chars or until a sentence boundary.
    let region = question.slice(verbEnd, verbEnd + NEG_CAPTURE_CHAR_CAP);
    const boundary = region.search(NEG_SENTENCE_BOUNDARIES_RE);
    if (boundary >= 0) region = region.slice(0, boundary);
    region = region.trim();
    if (!region) continue;
    // Polarity check — skip if the clause names what to KEEP, not what to omit.
    if (NEG_POLARITY_FLIPPER_RE.test(region)) continue;
    regions.push(region);
  }
  if (regions.length === 0) return [];

  const columnNameLower = new Set<string>();
  const columnWordLower = new Set<string>();
  for (const c of summary.columns ?? []) {
    columnNameLower.add(c.name.toLowerCase());
    for (const w of nameWords(c.name)) columnWordLower.add(w);
  }

  // Aggregate negative candidates across all regions.
  type NegBucket = {
    values: string[];
    tokens: string[];
    tiers: Set<"exact" | "case_insensitive" | "contains">;
  };
  const byColumn = new Map<string, NegBucket>();

  for (const region of regions) {
    const words = normalizeWords(region);
    if (!words.length) continue;
    const candidates = new Set<string>();
    for (let n = 1; n <= opts.maxN; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        const window = words.slice(i, i + n);
        const first = window[0]!;
        const last = window[window.length - 1]!;
        if (QUESTION_STOP_WORDS.has(first)) continue;
        if (QUESTION_STOP_WORDS.has(last)) continue;
        if (isNumericToken(first) || isNumericToken(last)) continue;
        if (n === 1) {
          if (first.length < 2) continue;
          if (columnWordLower.has(first)) continue;
        } else {
          const phrase = window.join(" ");
          if (columnNameLower.has(phrase)) continue;
          const allColumnWords = window.every((w) => columnWordLower.has(w));
          if (allColumnWords) continue;
        }
        candidates.add(window.join(" "));
      }
    }
    for (const candidate of candidates) {
      const hit = findUniqueValueColumnMatch(summary, candidate);
      if (!hit) continue;
      const tier = detectTier(candidate, hit.canonical);
      const bucket = byColumn.get(hit.column) ?? {
        values: [],
        tokens: [],
        tiers: new Set<"exact" | "case_insensitive" | "contains">(),
      };
      if (
        !bucket.values.includes(hit.canonical) &&
        bucket.values.length < opts.maxValues
      ) {
        bucket.values.push(hit.canonical);
      }
      if (!bucket.tokens.includes(candidate)) bucket.tokens.push(candidate);
      bucket.tiers.add(tier);
      byColumn.set(hit.column, bucket);
    }
  }

  const out: InferredFilter[] = [];
  for (const [column, bucket] of byColumn.entries()) {
    if (out.length >= opts.maxFilters) break;
    if (bucket.values.length === 0) continue;
    const matchMode: "exact" | "case_insensitive" = bucket.tiers.has("exact")
      ? "exact"
      : "case_insensitive";
    out.push({
      column,
      op: "not_in",
      values: bucket.values,
      match: matchMode,
      matchedTokens: bucket.tokens,
      intent: "negative",
    });
  }
  return out;
}
