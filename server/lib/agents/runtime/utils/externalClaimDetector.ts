/**
 * ============================================================================
 * externalClaimDetector.ts — spot when a question needs facts from outside the dataset
 * ============================================================================
 * WHAT THIS FILE DOES
 *   A tiny, pure (no side-effects, no network) helper that reads the user's
 *   question text and scans it with a catalogue of regular expressions
 *   ("regex" = pattern-matching rules over text). It looks for phrases that
 *   point at facts the uploaded spreadsheet alone can't possibly answer —
 *   e.g. competitor moves, category/market size, industry benchmarks, external
 *   events (COVID, monsoon, elections), or demographic-shift framing (Gen Z,
 *   millennials). If any of those markers appear, it reports that an "external
 *   claim" is present and suggests the planner add a web-search step.
 *
 * WHY IT MATTERS
 *   The agent normally answers strictly from the dataset. When a question
 *   leans on real-world context the data doesn't contain, an honest answer
 *   needs a web lookup. This detector is the deterministic trigger that routes
 *   such questions toward web search and flags claims for later verification.
 *   Detection is deliberately conservative: a false positive only wastes a
 *   cheap web call (~$0.001 + a few seconds), while a false negative just
 *   falls back to the safe dataset-only default. Each match keeps a short
 *   verbatim excerpt so a verifier can later check the answer addressed it.
 *
 * KEY PIECES
 *   - ExternalClaimType / ExternalClaim / ExternalClaimReport — the result shapes.
 *   - detectExternalClaims(question) — main entry: returns the report.
 *   - summarizeExternalClaims(report) — compact per-type tally + a prompt line.
 *   - PATTERNS — the brand-agnostic regex catalogue driving detection.
 *
 * HOW IT CONNECTS
 *   Called by plannerHintsBlock.ts (which planner.ts inlines as the
 *   EXTERNAL_CLAIM_MARKERS hint) and may be used by skills, the analysis-brief
 *   pipeline, or the workbench. The recommended web-search step is executed by
 *   webSearchTool.ts in the act loop.
 */

export type ExternalClaimType =
  | "competitor"
  | "market_size"
  | "industry_benchmark"
  | "external_event"
  | "demographic_shift"
  | "external_lookup";

export interface ExternalClaim {
  type: ExternalClaimType;
  /** ≤120-char verbatim excerpt around the match — for verifier replay. */
  excerpt: string;
  /** Heuristic confidence. `high` = explicit phrase; `medium` = ambiguous. */
  confidence: "high" | "medium";
  /** Regex group that matched, for telemetry / debugging. */
  matchedTerm: string;
}

export interface ExternalClaimReport {
  hasExternalClaim: boolean;
  claims: ExternalClaim[];
  /** Suggested planner action, or null when no claim detected. */
  suggestedAction: string | null;
}

interface PatternRule {
  type: ExternalClaimType;
  /** Word-boundary regex. Case-insensitive — declared without /i so we can
   *  attach the `g` flag for multi-match. The detector wraps each match
   *  with `.test()` against an i-flag clone. */
  pattern: RegExp;
  confidence: "high" | "medium";
}

/** Pattern catalogue. Keep brand-agnostic; brand-specific competitor
 *  detection belongs to the domain-context pack layer. */
const PATTERNS: PatternRule[] = [
  // Competitor — explicit phrasing.
  { type: "competitor", pattern: /\bcompetitor['s]?\b|\bcompetitors\b/gi, confidence: "high" },
  { type: "competitor", pattern: /\brival(?:s|ry)?\b/gi, confidence: "high" },
  { type: "competitor", pattern: /\bcompeting\s+(?:brand|product|company)/gi, confidence: "high" },
  { type: "competitor", pattern: /\bvs\.?\s+(?:other|the)\b/gi, confidence: "medium" },

  // Market size / growth — category-level claims.
  { type: "market_size", pattern: /\bmarket\s+(?:size|growth|grow|grew|growing|value|share|expanded|shrinking)\b/gi, confidence: "high" },
  { type: "market_size", pattern: /\bcategory\s+(?:size|growth|grow|grew|growing|value|share)\b/gi, confidence: "high" },
  { type: "market_size", pattern: /\bindustry\s+(?:size|growth|grow|grew|growing|value)\b/gi, confidence: "high" },
  { type: "market_size", pattern: /\btotal\s+addressable\s+market\b|\bTAM\b/gi, confidence: "high" },
  // "haircare market" / "fmcg market" / etc — bare category reference to a market.
  { type: "market_size", pattern: /\b(?:haircare|hair\s+care|skincare|skin\s+care|fmcg|consumer|grocery|hair\s+oil|shampoo|cooking\s+oil|edible\s+oil|beverage|cosmetics?|personal\s+care|category|industry)\s+market\b/gi, confidence: "medium" },

  // Industry benchmark.
  { type: "industry_benchmark", pattern: /\bindustry\s+(?:average|standard|benchmark|norm)\b/gi, confidence: "high" },
  { type: "industry_benchmark", pattern: /\bbenchmark(?:ed|ing)?\b/gi, confidence: "medium" },
  { type: "industry_benchmark", pattern: /\bpeer\s+(?:average|comparison|group)\b/gi, confidence: "high" },

  // External event — macroeconomic / cultural / weather.
  { type: "external_event", pattern: /\blockdown(?:s)?\b/gi, confidence: "high" },
  { type: "external_event", pattern: /\bpandemic\b|\bcovid(?:-?19)?\b/gi, confidence: "high" },
  { type: "external_event", pattern: /\brecession\b|\binflation\b/gi, confidence: "high" },
  { type: "external_event", pattern: /\belection(?:s)?\b/gi, confidence: "medium" },
  { type: "external_event", pattern: /\bmonsoon(?:s)?\b/gi, confidence: "high" },
  { type: "external_event", pattern: /\b(?:diwali|festive\s+season|holi|navratri|eid|christmas)\b/gi, confidence: "medium" },

  // Explicit external-lookup requests — the user directly asks to consult
  // outside sources. High precision (these phrasings almost never refer to the
  // uploaded data), so a web_search step is clearly wanted. Kept narrow to
  // avoid firing on internal verbs ("show me", "filter").
  { type: "external_lookup", pattern: /\bsearch\s+(?:the\s+|for\s+)?(?:news|web|online|internet|google)\b/gi, confidence: "high" },
  { type: "external_lookup", pattern: /\b(?:look|search)\s+(?:it\s+|that\s+|this\s+)?up\b/gi, confidence: "medium" },
  { type: "external_lookup", pattern: /\blook\s+(?:online|it\s+up)\b/gi, confidence: "high" },
  { type: "external_lookup", pattern: /\b(?:latest|recent|breaking)\s+news\b/gi, confidence: "high" },
  { type: "external_lookup", pattern: /\bin\s+the\s+news\b/gi, confidence: "high" },
  { type: "external_lookup", pattern: /\bnews\s+(?:about|on|around|during|for|regarding)\b/gi, confidence: "high" },
  { type: "external_lookup", pattern: /\bgoogle\s+(?:it|for|the)\b/gi, confidence: "high" },
  { type: "external_lookup", pattern: /\bresearch\s+(?:the|on|about|how|what|why|whether)\b/gi, confidence: "medium" },

  // Demographic shift framing.
  { type: "demographic_shift", pattern: /\b(?:gen\s*z|gen-?z|generation\s*z)\b/gi, confidence: "high" },
  { type: "demographic_shift", pattern: /\bmillennial(?:s)?\b/gi, confidence: "high" },
  { type: "demographic_shift", pattern: /\bdemographic\s+(?:shift|change|trend)\b/gi, confidence: "high" },
  { type: "demographic_shift", pattern: /\burbani[sz]ation\b|\burban\s+india\b/gi, confidence: "medium" },
  { type: "demographic_shift", pattern: /\btier[-\s]?[12]\s+(?:city|cities|town|towns|market)/gi, confidence: "medium" },
];

const SUGGESTED_ACTION_TEMPLATE =
  "Question references external claim(s) that the uploaded dataset alone cannot answer — add a `web_search` step to ground them.";

/** Pure detector. Pass the user question text; receive a report. */
export function detectExternalClaims(question: string): ExternalClaimReport {
  if (!question || question.trim().length === 0) {
    return { hasExternalClaim: false, claims: [], suggestedAction: null };
  }
  const claims: ExternalClaim[] = [];
  const seenTerms = new Set<string>();
  for (const rule of PATTERNS) {
    // Reset lastIndex because we share the same regex across calls.
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(question)) !== null) {
      const matchedTerm = m[0];
      const dedupeKey = `${rule.type}:${matchedTerm.toLowerCase()}`;
      if (seenTerms.has(dedupeKey)) continue;
      seenTerms.add(dedupeKey);
      claims.push({
        type: rule.type,
        excerpt: makeExcerpt(question, m.index, matchedTerm.length),
        confidence: rule.confidence,
        matchedTerm,
      });
      // Safety: prevent infinite loop on zero-width matches.
      if (m.index === rule.pattern.lastIndex) rule.pattern.lastIndex += 1;
    }
  }
  return {
    hasExternalClaim: claims.length > 0,
    claims,
    suggestedAction: claims.length > 0 ? SUGGESTED_ACTION_TEMPLATE : null,
  };
}

/** Group claims by type for a compact summary. */
export function summarizeExternalClaims(report: ExternalClaimReport): {
  total: number;
  byType: Record<ExternalClaimType, number>;
  promptLine: string;
} {
  const byType: Record<ExternalClaimType, number> = {
    competitor: 0,
    market_size: 0,
    industry_benchmark: 0,
    external_event: 0,
    demographic_shift: 0,
    external_lookup: 0,
  };
  for (const c of report.claims) byType[c.type] += 1;
  const total = report.claims.length;
  const present = (Object.entries(byType) as Array<[ExternalClaimType, number]>)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${type}=${count}`);
  const promptLine =
    total === 0
      ? "No external-claim markers detected."
      : `${total} external-claim marker(s) — ${present.join(", ")}. Consider a web_search step.`;
  return { total, byType, promptLine };
}

function makeExcerpt(text: string, matchIndex: number, matchLen: number): string {
  const radius = 40;
  const start = Math.max(0, matchIndex - radius);
  const end = Math.min(text.length, matchIndex + matchLen + radius);
  let excerpt = text.slice(start, end).trim();
  if (start > 0) excerpt = "…" + excerpt;
  if (end < text.length) excerpt = excerpt + "…";
  return excerpt.slice(0, 120);
}
