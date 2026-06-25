/**
 * ============================================================================
 * followUpDeepening.ts — THE authority for "are the suggested follow-ups a
 * genuinely DEEPER dive, or do they just re-ask what a chart already shows?"
 * ============================================================================
 * WHAT THIS FILE DOES
 *   A suggested follow-up like "How do compliance visits vary by cluster?" is
 *   useless when the dashboard already has a "Compliance Visit by Cluster"
 *   chart — the user can SEE the answer. This module owns two pure decisions:
 *
 *     - isAnsweredByExistingCharts / filterAnsweredFollowUps
 *         Drop follow-ups that merely restate a breakdown already on a chart.
 *     - generateDeeperFollowUps
 *         Synthesise genuinely deeper questions FROM the chart inventory —
 *         interactions (X within each Y), drivers ("what explains…"), outliers,
 *         and cross-metric relationships — i.e. the questions a univariate
 *         breakdown chart can NOT answer.
 *
 *     - deepenFollowUps  = filter the stored list + top up with generated ones,
 *         deduped and capped. This is what the dashboard renders, so EXISTING
 *         dashboards (whose stored prompts were frozen before this fix) still
 *         show good follow-ups, computed live from their own charts.
 *
 * WHY IT MATTERS
 *   The narrator generated `ctas` blind to the charts it produced, so the
 *   "Suggested follow-ups" panel re-asked what the dashboard already answered.
 *   Centralising the chart-awareness here (mirroring the codebase's "ONE
 *   authority" pattern — cf. temporalGrainAuthority, dashboardLayout) lets the
 *   SERVER clean `ctas` at generation time AND the CLIENT deepen them at render
 *   time from the identical logic.
 *
 * PURITY
 *   No DOM, no I/O, no Date/Math.random. A structural `ChartLike` type only —
 *   deliberately NO schema import — so this bundles cleanly into the client
 *   (mirrored via client/src/shared/followUpDeepening.ts) and runs on the
 *   server (tsx). Unit-testable on both.
 */

/** The minimal chart shape this module reads. `ChartSpec` satisfies it
 *  structurally; kept local so the module has zero schema dependency and stays
 *  client-bundle-safe. */
export interface ChartLike {
  x?: string | null;
  y?: string | null;
  seriesColumn?: string | null;
  type?: string | null;
  title?: string | null;
}

export interface DeepenOptions {
  /** Max follow-ups to return (schema caps the stored field at 3). */
  limit?: number;
}

const DEFAULT_LIMIT = 3;

// Aggregation suffixes the query engine appends to a measure via an UNDERSCORE
// delimiter ("Sales_sum", "Compliance Visit_avg"). The leading `_` is required:
// many real metric names END in one of these words ("Win Rate", "Market Share",
// "Order Count"), and a space-or-underscore class would wrongly strip that last
// word (→ "Win"/"Market"/"Order"). The engine always emits "col_op", so an
// underscore is the only legitimate delimiter to strip.
const AGG_SUFFIX =
  /_(sum|avg|average|mean|count|cnt|min|max|total|median|share|pct|percent|percentage|ratio|rate)$/i;

// Trailing dimension nouns dropped for readability ("Cluster Name" → "Cluster").
const DIM_TRAILER = /\s+(name|id|code|key)$/i;

// A standalone "or" makes a suggested question ambiguous ("…by cluster or
// state?") — the app can't resolve the choice, so the question is never
// surfaced. Mirrors suggestedQuestionGuard.hasDisjunctiveOr (the server-side
// single authority); kept INLINE here to preserve this module's zero-import,
// client-bundleable design (the client re-exports this very file). It catches
// legacy stored prompts (frozen before the rule existed) at render time, plus
// the rare generated question whose column label contains "or".
const DISJUNCTIVE_OR = /\bor\b/i;

// A question that already carries one of these signals is a DEEPER ask (why /
// driver / interaction / outlier / correlation / trend). It is never treated as
// "already answered by a flat breakdown chart" — this keeps the filter
// conservative (it only drops pure restatements, never a genuine deep-dive).
const DEEPER_SIGNAL =
  /\b(why|driv\w*|explain\w*|reason|root[-\s]?cause|underl\w*|caus\w*|contribut\w*|within each|for each|inside each|outlier\w*|stand[-\s]?out|anomal\w*|correlat\w*|relationship|associat\w*|relate[ds]?\b|drill|deeper|gap between|differ(?:ence)? between|compared?\s+(?:to|with|against)|versus|\bvs\b|trend\w*|over time|forecast|predict|what[-\s]?if|scenario|seasonal\w*)\b/i;

// A "per <entity>" used mid-question denotes a derived RATIO ("revenue PER
// store"), distinct from a trailing "per <dim>" breakdown connector ("visits
// per cluster"). When such a "per" PRECEDES a further breakdown ("…per store
// vary by month"), the question asks about a ratio a raw breakdown chart never
// shows — so it is a genuine deeper dive, never "already answered".
const RATIO_INTERIOR =
  /\bper\s+[a-z0-9][\w-]*\s+.*\b(?:by|across|per|vary|varies|differ|differs)\b/i;

// Does the question read like a breakdown at all (a grouping verb/preposition)?
const BREAKDOWN_SIGNAL =
  /\b(?:vary(?:ing)?|varies|differ(?:s|ing)?|break(?:s|ing)?\s*down|broken\s*down|distribut\w*|split|grouped|segment\w*|across|by|per)\b/i;
// The dimension is whatever follows the LAST grouping connector. The leading
// `.*` is greedy so it binds to the rightmost `by/across/per` (closest to the
// dimension), not the first verb — "…vary by HQ Name" → "HQ Name", not "by HQ…".
const BREAKDOWN_CONNECTOR =
  /^.*\b(?:by|across|per)\s+(?:the\s+)?([a-z0-9][\w \-/&]*?)$/i;

// Heuristic: does a dimension label denote a time axis (→ a trend, not a peer
// breakdown)? Used to prefer categorical dimensions when forming interactions.
const TEMPORAL_DIM =
  /\b(date|datetime|day|days|daily|week|weekly|month|monthly|quarter|quarterly|year|yearly|annual|time|period|fy|mtd|ytd|qtd)\b/i;

/** Naive singularizer so "clusters" matches "cluster". Per token, drop a
 *  trailing "s" on words longer than 3 chars (leaves "ss", "asm", "ios"). */
function depluralize(token: string): string {
  return token.length > 3 && token.endsWith("s") && !token.endsWith("ss")
    ? token.slice(0, -1)
    : token;
}

/** Lowercase alphanumeric token form of a label, with agg/dimension noise
 *  removed and tokens singularized. Used for equality/containment matching on
 *  BOTH sides (so the transform is internally consistent), never for display. */
export function normalizeLabel(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = String(raw).trim();
  s = s.replace(AGG_SUFFIX, "");
  s = s.replace(DIM_TRAILER, "");
  return s
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map(depluralize)
    .join(" ");
}

/** Display label for a measure: drop the aggregation suffix, keep casing. */
export function humanizeMeasure(y: string | null | undefined): string {
  if (!y) return "";
  return String(y)
    .replace(AGG_SUFFIX, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Display label for a dimension: drop a trailing Name/Id, tidy spacing. */
export function humanizeDimension(d: string | null | undefined): string {
  if (!d) return "";
  return String(d)
    .replace(/[_]+/g, " ")
    .replace(DIM_TRAILER, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A loose, punctuation-insensitive identity for de-duplicating questions. */
function questionKey(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Normalized dimension tokens that appear on ANY chart (x or seriesColumn). */
function chartedDimensionNorms(charts: ReadonlyArray<ChartLike>): Set<string> {
  const out = new Set<string>();
  for (const c of charts ?? []) {
    const x = normalizeLabel(c?.x);
    const s = normalizeLabel(c?.seriesColumn);
    if (x) out.add(x);
    if (s) out.add(s);
  }
  return out;
}

/** Extract the trailing dimension phrase a breakdown question groups by. */
function extractBreakdownTail(question: string): string | null {
  const q = question.trim().replace(/[?.]+$/, "");
  if (!BREAKDOWN_SIGNAL.test(q)) return null;
  const m = q.match(BREAKDOWN_CONNECTOR);
  return m && m[1] ? m[1].trim() : null;
}

/** Does the question's breakdown dimension (`tail`) refer to a charted
 *  dimension (`dim`)? Equality, OR the tail is a shorter form of the charted
 *  column ("attendance" ⊆ "attendance status"). We deliberately do NOT match
 *  the reverse (a tail with extra words beyond the charted dim, e.g. "region to
 *  last year" ⊇ "region") — those extra words usually mark a DIFFERENT, deeper
 *  ask (a YoY comparison, a nested slice), so flagging it would wrongly hide a
 *  useful question. Both sides are normalized (singularized), so "clusters"
 *  matches "cluster" without needing the unsafe direction. */
function dimMatches(tail: string, dim: string): boolean {
  if (!tail || !dim) return false;
  if (tail === dim) return true;
  // Whole-token subset (NOT raw substring, which collides within words — "age"
  // inside "average"): every token of the question's dimension must appear as a
  // whole token of the charted dimension. So "attendance" ⊆ {attendance,status}
  // matches, but "region to last year" ⊄ {region} does not.
  const tailTokens = tail.split(" ").filter(Boolean);
  if (!tailTokens.length) return false;
  const dimTokens = new Set(dim.split(" ").filter(Boolean));
  return tailTokens.every((t) => dimTokens.has(t));
}

/** Are two normalized measure labels token-variants of each other (one's tokens
 *  a subset of the other's)? "sale" vs "net sale" → true. Used to avoid a
 *  near-tautological cross-metric follow-up. */
function measureTokensOverlap(a: string, b: string): boolean {
  const at = a.split(" ").filter(Boolean);
  const bt = b.split(" ").filter(Boolean);
  if (!at.length || !bt.length) return false;
  const aset = new Set(at);
  const bset = new Set(bt);
  return at.every((t) => bset.has(t)) || bt.every((t) => aset.has(t));
}

/**
 * Is this follow-up already answered by an existing chart? True only when the
 * question is a plain breakdown ("how does X vary by <dim>", "X by <dim>") whose
 * dimension matches a charted dimension AND it carries no deeper-dive signal.
 * Deliberately conservative — a false positive silently hides a useful question,
 * so we only drop unambiguous restatements.
 */
export function isAnsweredByExistingCharts(
  question: string | null | undefined,
  charts: ReadonlyArray<ChartLike>,
): boolean {
  if (!question) return false;
  if (DEEPER_SIGNAL.test(question)) return false;
  if (RATIO_INTERIOR.test(question)) return false;
  const tail = extractBreakdownTail(question);
  if (!tail) return false;
  const tailNorm = normalizeLabel(tail);
  if (!tailNorm || tailNorm.length < 2) return false;
  for (const dim of chartedDimensionNorms(charts)) {
    if (dimMatches(tailNorm, dim)) return true;
  }
  return false;
}

/** Drop follow-ups already answered by an existing chart, preserving order. */
export function filterAnsweredFollowUps(
  candidates: ReadonlyArray<string> | null | undefined,
  charts: ReadonlyArray<ChartLike>,
): string[] {
  if (!candidates?.length) return [];
  return candidates
    .map((c) => (typeof c === "string" ? c.trim() : ""))
    .filter(Boolean)
    .filter((c) => !DISJUNCTIVE_OR.test(c)) // no ambiguous "or" questions
    .filter((c) => !isAnsweredByExistingCharts(c, charts));
}

interface MeasureGroup {
  measure: string; // display label
  measureNorm: string;
  /** Distinct dimensions this measure is charted against, in appearance order. */
  dims: { label: string; norm: string; temporal: boolean }[];
}

/** Group the charted (measure → dimensions) angles, deduped, in stable order. */
function measureGroups(charts: ReadonlyArray<ChartLike>): MeasureGroup[] {
  const byMeasure = new Map<string, MeasureGroup>();
  for (const c of charts ?? []) {
    const measure = humanizeMeasure(c?.y);
    if (!measure) continue;
    const measureNorm = normalizeLabel(c?.y);
    let group = byMeasure.get(measureNorm);
    if (!group) {
      group = { measure, measureNorm, dims: [] };
      byMeasure.set(measureNorm, group);
    }
    for (const src of [c?.x, c?.seriesColumn]) {
      const label = humanizeDimension(src);
      const norm = normalizeLabel(src);
      if (!label || !norm) continue;
      if (norm === measureNorm) continue; // a dim equal to the measure is noise
      if (group.dims.some((d) => d.norm === norm)) continue;
      group.dims.push({ label, norm, temporal: TEMPORAL_DIM.test(label) });
    }
  }
  return [...byMeasure.values()];
}

/**
 * Synthesise genuinely DEEPER follow-up questions from the chart inventory —
 * the questions a flat breakdown chart can't answer. Prioritised so the most
 * novel angle leads: cross-dimension interaction → cross-metric relationship →
 * driver → outlier. Returns [] when there are no usable charts.
 */
export function generateDeeperFollowUps(
  charts: ReadonlyArray<ChartLike>,
  opts: DeepenOptions = {},
): string[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const groups = measureGroups(charts);
  if (!groups.length) return [];

  // Primary measure = the one analysed against the most dimensions.
  const primary = [...groups].sort((a, b) => b.dims.length - a.dims.length)[0]!;
  const M = primary.measure;
  // Driver / outlier / interaction read naturally only over CATEGORICAL peers,
  // never a time axis ("…vary by Date" is a trend, already charted). The bare
  // time-only fallback below handles a chart set with no categorical dimension.
  const categorical = primary.dims.filter((d) => !d.temporal);
  const temporal = primary.dims.find((d) => d.temporal);
  const D1 = categorical[0]?.label;
  const D2 = categorical[1]?.label;
  // Cross-metric: a SECOND measure that isn't merely a token-variant of the
  // primary ("Net Sales" vs "Sales" → skip the near-tautological "relate to").
  const otherMeasure = groups.find(
    (g) =>
      g.measureNorm !== primary.measureNorm &&
      !measureTokensOverlap(g.measureNorm, primary.measureNorm),
  )?.measure;

  const candidates: string[] = [];
  // Interaction — two univariate charts never reveal the cross-effect.
  if (D1 && D2) candidates.push(`Within each ${D1}, how does ${M} vary by ${D2}?`);
  // Cross-metric relationship.
  if (otherMeasure) candidates.push(`How does ${M} relate to ${otherMeasure}?`);
  // Driver — a bar chart shows the gap, not what causes it.
  if (D1) candidates.push(`What explains the differences in ${M} by ${D1}?`);
  // Outlier drill-down.
  if (D1) candidates.push(`Which ${D1} values are the biggest outliers in ${M}, and why?`);
  // Only a time axis exists → ask what moves it.
  if (!D1 && temporal) {
    candidates.push(`What is driving the change in ${M} over ${temporal.label}?`);
  }

  // De-dupe (defensive) and cap. Generated questions carry deeper-dive signals,
  // so the answered-filter is a safe no-op here, but we run it for consistency.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of candidates) {
    if (isAnsweredByExistingCharts(q, charts)) continue;
    const k = questionKey(q);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(q);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The display authority: take the stored follow-ups, drop any already answered
 * by a chart, then top up with generated deeper questions — deduped and capped.
 * With no charts to reason about, the stored list is returned (trimmed/capped)
 * unchanged. This is what the dashboard renders.
 */
export function deepenFollowUps(
  stored: ReadonlyArray<string> | null | undefined,
  charts: ReadonlyArray<ChartLike>,
  opts: DeepenOptions = {},
): string[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const cleanStored = (stored ?? [])
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean)
    .filter((s) => !DISJUNCTIVE_OR.test(s)); // no ambiguous "or" questions

  if (!charts?.length) return cleanStored.slice(0, limit);

  const kept = filterAnsweredFollowUps(cleanStored, charts);
  const generated = generateDeeperFollowUps(charts, { limit });

  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of [...kept, ...generated]) {
    if (DISJUNCTIVE_OR.test(q)) continue; // no ambiguous "or" questions
    const k = questionKey(q);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(q);
    if (out.length >= limit) break;
  }
  return out;
}
