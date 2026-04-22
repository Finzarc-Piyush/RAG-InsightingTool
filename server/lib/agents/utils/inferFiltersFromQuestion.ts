import type { DataSummary } from "../../../shared/schema.js";
import { findUniqueValueColumnMatch } from "../../dimensionFilterRepair.js";

export interface InferredFilter {
  column: string;
  op: "in";
  values: string[];
  match: "exact" | "case_insensitive";
  matchedTokens: string[];
}

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
    });
  }

  return out;
}
