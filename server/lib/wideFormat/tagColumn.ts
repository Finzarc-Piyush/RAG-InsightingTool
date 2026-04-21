// Per-header tagger — composes W1 (periodVocabulary), W2
// (metricVocabulary), and W3 (tokenize + n-grams) into a single
// verdict per column header: `id | period | metric | compound |
// ambiguous`.
//
// The whole-dataset classifier (W5) consumes a list of these tags
// and decides whether the dataset is wide, long, or ambiguous.

import { matchPeriod, type PeriodMatch } from "./periodVocabulary.js";
import { matchMetric, type MetricMatch } from "./metricVocabulary.js";
import { tokenize, ngrams } from "./tokenize.js";

export type ColumnTag = "id" | "period" | "metric" | "compound" | "ambiguous";

export interface ColumnTagResult {
  header: string;
  tag: ColumnTag;
  period?: PeriodMatch;
  metric?: MetricMatch;
  confidence: number;
  evidence: string[];
}

/**
 * Scan every n-gram (3, 2, 1) of the header and return the
 * highest-confidence period / metric match found. Ties break toward
 * larger n-grams (already first in iteration order via `ngrams`'s
 * default).
 */
function bestMatches(header: string): {
  period: PeriodMatch | null;
  metric: MetricMatch | null;
  periodNgram: string | null;
  metricNgram: string | null;
} {
  const toks = tokenize(header);
  // Also include the raw (untokenized) header so that matchers with
  // punctuation-friendly regexes ("Jan-2024", "MAT Dec-24") can hit
  // before tokenization discards separators.
  const candidates = [header.trim(), ...ngrams(toks)];

  let bestPeriod: PeriodMatch | null = null;
  let bestPeriodNgram: string | null = null;
  let bestMetric: MetricMatch | null = null;
  let bestMetricNgram: string | null = null;

  for (const cand of candidates) {
    if (!bestPeriod || (bestPeriod.confidence < 0.9)) {
      const p = matchPeriod(cand);
      if (p && (!bestPeriod || p.confidence > bestPeriod.confidence)) {
        bestPeriod = p;
        bestPeriodNgram = cand;
      }
    }
    if (!bestMetric || bestMetric.confidence < 0.9) {
      const m = matchMetric(cand);
      if (m && (!bestMetric || m.confidence > bestMetric.confidence)) {
        bestMetric = m;
        bestMetricNgram = cand;
      }
    }
  }

  return {
    period: bestPeriod,
    metric: bestMetric,
    periodNgram: bestPeriodNgram,
    metricNgram: bestMetricNgram,
  };
}

const ID_LIKE_PATTERN = /^[a-z][a-z0-9 _./&-]*$/i;

/**
 * Heuristic for "looks like an identifier column" — short text, no
 * standalone digits runs that aren't attached to a recognized token,
 * no recognized period / metric. Caller has already ruled out both
 * period + metric matches.
 */
function looksLikeId(header: string): boolean {
  const trimmed = header.trim();
  if (!trimmed) return false;
  // Reject if the header contains a clear year-like run (e.g. "Col 2024")
  // that's not part of a match — that's suspicious for an ID.
  if (/\b(19|20)\d{2}\b/.test(trimmed)) return false;
  if (!ID_LIKE_PATTERN.test(trimmed)) return false;
  // Short + mostly letters → id-ish.
  const letters = trimmed.replace(/[^a-z]/gi, "").length;
  return trimmed.length <= 60 && letters >= 2;
}

/**
 * Tag a single header.
 */
export function tagColumn(header: string): ColumnTagResult {
  const safe = typeof header === "string" ? header : "";
  const { period, metric, periodNgram, metricNgram } = bestMatches(safe);

  const evidence: string[] = [];

  if (period && metric) {
    if (periodNgram) evidence.push(`period "${periodNgram}" → ${period.iso}`);
    if (metricNgram) evidence.push(`metric "${metricNgram}" → ${metric.canonical}`);
    return {
      header: safe,
      tag: "compound",
      period,
      metric,
      confidence: (period.confidence + metric.confidence) / 2,
      evidence,
    };
  }
  if (period) {
    if (periodNgram) evidence.push(`period "${periodNgram}" → ${period.iso}`);
    return {
      header: safe,
      tag: "period",
      period,
      confidence: period.confidence,
      evidence,
    };
  }
  if (metric) {
    if (metricNgram) evidence.push(`metric "${metricNgram}" → ${metric.canonical}`);
    return {
      header: safe,
      tag: "metric",
      metric,
      confidence: metric.confidence,
      evidence,
    };
  }
  if (looksLikeId(safe)) {
    evidence.push("id-like: short text, no period/metric/year tokens");
    return { header: safe, tag: "id", confidence: 0.7, evidence };
  }
  evidence.push("no period, metric, or id signal");
  return { header: safe, tag: "ambiguous", confidence: 0.2, evidence };
}

/**
 * Tag every header in a list. Order preserved.
 */
export function tagColumns(headers: string[]): ColumnTagResult[] {
  return headers.map((h) => tagColumn(h));
}
