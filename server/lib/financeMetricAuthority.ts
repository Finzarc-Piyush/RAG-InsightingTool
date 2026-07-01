/**
 * ============================================================================
 * financeMetricAuthority.ts — THE single decision point for metric SEMANTICS
 * ============================================================================
 *
 * WHY THIS EXISTS
 *   "What IS this metric?" used to be re-guessed independently in every chart and
 *   insight path from fragile, drifting name-regexes:
 *     • chartSpecCompiler.NON_ADDITIVE_METRIC_RX   (word-boundary; misses literal "%")
 *     • dashboardFeatureSweep.RATE_METRIC_RX        (no avg/mean, no "%")
 *     • the pivot's isRateMetric                    (a fourth, separate rate regex)
 *   None of them recognised a column literally named "GC%" (the `\b` boundary never
 *   matches "%"), so a Gross-Contribution-margin column was treated as additive and
 *   SUMMED across channels — "sum of GC% for 6 channels = 280%", which is nonsense.
 *   And NO path knew that GC% is DEFINITIONALLY NR's child (GC% = (NR−COGS)/NR), so
 *   the insight layer would happily report "GC% is impacted by Net Revenue" — an
 *   accounting identity dressed up as a discovery.
 *
 *   This module is the ONE authority every chart-building and insight-generating
 *   path delegates to. It is pure (no IO, no LLM) and is the SOLE home of:
 *     • the canonical FMCG/P&L term registry (FINANCE_TERMS) — kind, additivity,
 *       and each ratio's numerator / denominator,
 *     • metric ADDITIVITY (this file, W1) and the aggregation POLICY ladder (W2),
 *     • metric STRUCTURAL-RELATEDNESS — the identity graph (W3) that powers the
 *       correlation/causation guardrails.
 *
 * DESIGN INVARIANTS
 *   • Single matcher: alias-build AND lookup both go through `normalizeMetricTokens`,
 *     so "GC%", "GC %", "gc_pct", "Gross Contribution %" can never diverge. The "%"
 *     → "pct" rewrite is the fix the three legacy regexes all lacked.
 *   • Structured-first: when a SemanticMetric is in hand (enrichment time) its
 *     `format`/`expression` decides additivity BEFORE the name matcher — a curated
 *     `format:"percent"` or a division expression is authoritative.
 *   • Conservative catch-all: any unrecognised name carrying a rate/ratio/%/score
 *     token still resolves to non_additive, so the migration from the old regexes
 *     can never REGRESS (it is a strict superset).
 */

import type { SemanticMetric, SemanticModel } from "../shared/schema.js";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

/** What KIND of quantity a metric is. `additive` = an absolute amount or count. */
export type MetricKind =
  | "additive" // NR, NSV, GSV, COGS, GC, EBITDA, A&P, trade spend, volume, count
  | "ratio_percent" // GC%, margin%, EBITDA%, share%, mix%, growth%, adherence rate
  | "per_unit" // realization / ASP, price-per-unit, GC per kg
  | "index_score"; // index, score — non-additive, no clean numerator/denominator

export type Additivity = "additive" | "non_additive";

/**
 * Direction of "good" for a metric — drives the scorecard's direction-aware
 * tone (a rise in GC% is GOOD → green; a rise in returns% is BAD → red;
 * a metric with no natural direction gets no colour judgment).
 */
export type MetricPolarity = "higher_better" | "lower_better" | "neutral";

export interface FinanceTerm {
  /** Canonical id, e.g. "gross_contribution_pct". */
  id: string;
  kind: MetricKind;
  additivity: Additivity;
  /** Canonical ids of the numerator / denominator terms (ratio / per_unit only). */
  numerator?: string;
  denominator?: string;
  /** For additive composites (GC = NR − variable cost). Informational. */
  components?: string[];
  /** Human surface forms; tokenised through `normalizeMetricTokens` at lookup. */
  aliases: string[];
}

export interface MetricClassification {
  kind: MetricKind;
  additivity: Additivity;
  /** The resolved registry term, when the name matched one. */
  term?: FinanceTerm;
}

// ────────────────────────────────────────────────────────────────────────────
// Canonical matching — the ONE normalizer (alias-build === lookup)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Normalise a metric/column name to a token list. The `%`→`pct` and `&`→`and`
 * rewrites are the whole point — the legacy `\b…\b` regexes never matched "%"/"&",
 * so "GC%" and "A&P" slipped through. Separators collapse to spaces.
 */
export function normalizeMetricTokens(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/%/g, " pct ")
    .replace(/[_\-/.]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Tokens that, standing alone, mark a name non-additive even with no term hit. */
const NON_ADDITIVE_TOKENS = new Set([
  "pct",
  "percent",
  "percentage",
  "ratio",
  "share",
  "score",
  "index",
  "rate",
  "margin",
  "avg",
  "average",
  "mean",
  "per",
  "adherence",
  "compliance",
]);

// ────────────────────────────────────────────────────────────────────────────
// FINANCE_TERMS — the canonical FMCG / P&L registry (single source of truth)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Generic FMCG / P&L conventions (no company-specific spec). Order does not
 * matter; lookup is "longest matching alias wins", so specific ratio aliases
 * ("gross contribution pct") beat their additive parent ("gross contribution").
 */
export const FINANCE_TERMS: readonly FinanceTerm[] = Object.freeze([
  // ── Absolute amounts — ADDITIVE ──────────────────────────────────────────
  {
    id: "net_revenue",
    kind: "additive",
    additivity: "additive",
    aliases: ["nr", "net revenue", "net sales", "net sales value", "nsv", "nsr", "net revenue value"],
  },
  {
    id: "gross_sales",
    kind: "additive",
    additivity: "additive",
    aliases: ["gsv", "gross sales", "gross sales value"],
  },
  {
    id: "trade_spend",
    kind: "additive",
    additivity: "additive",
    aliases: ["trade spend", "trade scheme", "trade scheme cost", "trade discount", "scheme cost", "trade promotion"],
  },
  { id: "returns", kind: "additive", additivity: "additive", aliases: ["returns", "sales returns"] },
  {
    id: "cogs",
    kind: "additive",
    additivity: "additive",
    aliases: ["cogs", "cost of goods sold", "cost of goods", "cos", "cost of sales"],
  },
  { id: "raw_material", kind: "additive", additivity: "additive", aliases: ["raw material", "rm", "raw material cost"] },
  { id: "packaging_material", kind: "additive", additivity: "additive", aliases: ["packaging material", "pm", "packaging cost"] },
  { id: "conversion_cost", kind: "additive", additivity: "additive", aliases: ["conversion cost", "manufacturing cost"] },
  {
    id: "ap_spend",
    kind: "additive",
    additivity: "additive",
    aliases: ["a and p", "ap spend", "ad spend", "adspend", "advertising and promotion", "advertising promotion", "marketing spend"],
  },
  {
    id: "overheads",
    kind: "additive",
    additivity: "additive",
    aliases: ["overheads", "overhead", "sg and a", "sga", "fixed cost", "fixed costs", "opex", "operating expense"],
  },
  {
    id: "gross_profit",
    kind: "additive",
    additivity: "additive",
    components: ["net_revenue", "cogs"],
    aliases: ["gross profit", "gp", "gross margin value", "gross margin amount", "gross margin inr", "gross margin rs"],
  },
  {
    id: "gross_contribution",
    kind: "additive",
    additivity: "additive",
    components: ["net_revenue", "cogs"],
    aliases: ["gross contribution", "gc", "contribution", "contribution margin", "cm"],
  },
  {
    id: "ebitda",
    kind: "additive",
    additivity: "additive",
    components: ["gross_contribution", "ap_spend", "overheads"],
    aliases: ["ebitda", "operating profit"],
  },
  { id: "ebit", kind: "additive", additivity: "additive", aliases: ["ebit"] },
  { id: "pbt", kind: "additive", additivity: "additive", aliases: ["pbt", "profit before tax"] },
  { id: "pat", kind: "additive", additivity: "additive", aliases: ["pat", "profit after tax", "net profit"] },
  {
    id: "volume",
    kind: "additive",
    additivity: "additive",
    aliases: ["volume", "units", "cases", "tonnes", "mt", "quantity", "qty", "volume sales"],
  },
  { id: "row_count", kind: "additive", additivity: "additive", aliases: ["row count", "record count", "records"] },

  // ── Ratio / percentage — NON-ADDITIVE ────────────────────────────────────
  {
    id: "gross_contribution_pct",
    kind: "ratio_percent",
    additivity: "non_additive",
    numerator: "gross_contribution",
    denominator: "net_revenue",
    aliases: ["gc pct", "gross contribution pct", "gross contribution margin", "contribution pct", "contribution margin pct", "gc margin"],
  },
  {
    id: "gross_margin_pct",
    kind: "ratio_percent",
    additivity: "non_additive",
    numerator: "gross_profit",
    denominator: "net_revenue",
    aliases: ["gross margin", "gross margin pct", "gm", "gm pct", "margin pct", "margin"],
  },
  {
    id: "ebitda_pct",
    kind: "ratio_percent",
    additivity: "non_additive",
    numerator: "ebitda",
    denominator: "net_revenue",
    aliases: ["ebitda pct", "ebitda margin"],
  },
  {
    id: "trade_spend_pct",
    kind: "ratio_percent",
    additivity: "non_additive",
    numerator: "trade_spend",
    denominator: "gross_sales",
    aliases: ["trade spend pct", "trade pct", "scheme pct"],
  },
  {
    id: "ap_pct",
    kind: "ratio_percent",
    additivity: "non_additive",
    numerator: "ap_spend",
    denominator: "net_revenue",
    aliases: ["a and p pct", "ap pct", "a and p intensity", "ap intensity", "advertising intensity"],
  },
  { id: "value_share_pct", kind: "ratio_percent", additivity: "non_additive", aliases: ["value share", "value market share"] },
  { id: "volume_share_pct", kind: "ratio_percent", additivity: "non_additive", aliases: ["volume share", "volume market share"] },
  { id: "market_share_pct", kind: "ratio_percent", additivity: "non_additive", aliases: ["market share", "share pct"] },
  {
    id: "mix_pct",
    kind: "ratio_percent",
    additivity: "non_additive",
    aliases: ["mix", "mix pct", "channel mix", "product mix", "contribution mix"],
  },
  {
    id: "growth_pct",
    kind: "ratio_percent",
    additivity: "non_additive",
    aliases: ["growth", "growth pct", "yoy", "yoy growth", "value growth", "volume growth", "mom", "mom growth"],
  },
  {
    id: "adherence_rate",
    kind: "ratio_percent",
    additivity: "non_additive",
    aliases: ["adherence", "adherence rate", "pjp adherence", "compliance", "compliance rate"],
  },
  { id: "numeric_distribution", kind: "ratio_percent", additivity: "non_additive", aliases: ["nd", "numeric distribution"] },
  { id: "weighted_distribution", kind: "ratio_percent", additivity: "non_additive", aliases: ["wd", "weighted distribution"] },

  // ── Per-unit — NON-ADDITIVE ───────────────────────────────────────────────
  {
    id: "realization",
    kind: "per_unit",
    additivity: "non_additive",
    numerator: "net_revenue",
    denominator: "volume",
    aliases: ["realization", "realisation", "asp", "average selling price", "price per unit", "net realization", "nr per unit"],
  },
  {
    id: "gc_per_unit",
    kind: "per_unit",
    additivity: "non_additive",
    numerator: "gross_contribution",
    denominator: "volume",
    aliases: ["gc per unit", "gc per kg", "contribution per unit"],
  },

  // ── Index / score — NON-ADDITIVE ──────────────────────────────────────────
  { id: "index", kind: "index_score", additivity: "non_additive", aliases: ["index"] },
  { id: "score", kind: "index_score", additivity: "non_additive", aliases: ["score"] },
]);

/** Pre-tokenised aliases so lookup never re-derives them (alias-build === lookup). */
const TOKENIZED_TERMS: ReadonlyArray<{ term: FinanceTerm; aliasTokens: string[][] }> = FINANCE_TERMS.map(
  (term) => ({ term, aliasTokens: term.aliases.map(normalizeMetricTokens) }),
);

/** True iff every token of `needle` appears in `haystack` (multiset-subset). */
function isTokenSubset(needle: string[], haystack: string[]): boolean {
  const pool = [...haystack];
  for (const tok of needle) {
    const i = pool.indexOf(tok);
    if (i === -1) return false;
    pool.splice(i, 1);
  }
  return true;
}

/** Resolve a metric name to its registry term — longest matching alias wins. */
export function resolveFinanceTerm(name: string): FinanceTerm | undefined {
  const tokens = normalizeMetricTokens(name);
  if (tokens.length === 0) return undefined;
  let best: FinanceTerm | undefined;
  let bestLen = 0;
  let bestChars = 0;
  for (const { term, aliasTokens } of TOKENIZED_TERMS) {
    for (const alias of aliasTokens) {
      if (alias.length === 0 || !isTokenSubset(alias, tokens)) continue;
      const chars = alias.join("").length;
      if (alias.length > bestLen || (alias.length === bestLen && chars > bestChars)) {
        best = term;
        bestLen = alias.length;
        bestChars = chars;
      }
    }
  }
  return best;
}

// ────────────────────────────────────────────────────────────────────────────
// Structured-first classification (W1)
// ────────────────────────────────────────────────────────────────────────────

type SemanticHint = Pick<SemanticMetric, "format" | "expression"> & { references?: readonly string[] };

/** A `/` outside any function-arg nesting marks a ratio (SUM(a)/NULLIF(SUM(b),0)). */
function expressionIsRatio(expression: string): boolean {
  let depth = 0;
  for (const ch of expression) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "/" && depth === 0) return true;
  }
  return false;
}

/**
 * Classify a metric. When a SemanticMetric hint is supplied (enrichment time),
 * its curated `format` / `expression` is authoritative BEFORE the name matcher.
 */
export function classifyMetric(name: string, semanticEntry?: SemanticHint): MetricClassification {
  if (semanticEntry) {
    const fmt = semanticEntry.format;
    if (fmt === "percent" || fmt === "ratio") {
      return { kind: "ratio_percent", additivity: "non_additive", term: resolveFinanceTerm(name) };
    }
    if (semanticEntry.expression && expressionIsRatio(semanticEntry.expression)) {
      return { kind: "ratio_percent", additivity: "non_additive", term: resolveFinanceTerm(name) };
    }
  }
  const term = resolveFinanceTerm(name);
  if (term) return { kind: term.kind, additivity: term.additivity, term };
  // Conservative catch-all — preserves the legacy regexes' behaviour (superset).
  const tokens = normalizeMetricTokens(name);
  if (tokens.some((t) => NON_ADDITIVE_TOKENS.has(t))) {
    return { kind: "ratio_percent", additivity: "non_additive" };
  }
  return { kind: "additive", additivity: "additive" };
}

// ────────────────────────────────────────────────────────────────────────────
// Metric polarity — direction of "good" (the scorecard tone layer of the authority)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Registry-term → polarity. Kept as a map (not a field scattered across ~30
 * FINANCE_TERMS entries) so the polarity layer stays a single cohesive block.
 * Terms omitted here fall through to the token heuristic, then `neutral`.
 */
const POLARITY_BY_TERM_ID: Readonly<Record<string, MetricPolarity>> = Object.freeze({
  // Amounts / ratios where UP is good.
  net_revenue: "higher_better",
  gross_sales: "higher_better",
  gross_profit: "higher_better",
  gross_contribution: "higher_better",
  ebitda: "higher_better",
  ebit: "higher_better",
  pbt: "higher_better",
  pat: "higher_better",
  volume: "higher_better",
  gross_contribution_pct: "higher_better",
  gross_margin_pct: "higher_better",
  ebitda_pct: "higher_better",
  value_share_pct: "higher_better",
  volume_share_pct: "higher_better",
  market_share_pct: "higher_better",
  growth_pct: "higher_better",
  adherence_rate: "higher_better",
  numeric_distribution: "higher_better",
  weighted_distribution: "higher_better",
  realization: "higher_better",
  gc_per_unit: "higher_better",
  // Costs / leakage where UP is bad.
  returns: "lower_better",
  cogs: "lower_better",
  trade_spend: "lower_better",
  trade_spend_pct: "lower_better",
  raw_material: "lower_better",
  packaging_material: "lower_better",
  conversion_cost: "lower_better",
  overheads: "lower_better",
  // Investment ratios / mix / index → deliberately NEUTRAL (no colour judgment):
  //   ap_spend, ap_pct, mix_pct, index, score, row_count.
});

/**
 * Unambiguous cost/leakage tokens → lower_better. NOTE: bare "return"/"returns"
 * is intentionally EXCLUDED (it would mislabel ROI / "rate of return"); the
 * finance-term `returns` is caught by POLARITY_BY_TERM_ID instead.
 */
const LOWER_BETTER_TOKENS = new Set([
  "cost", "costs", "cogs", "expense", "expenses", "defect", "defects",
  "complaint", "complaints", "churn", "attrition", "stockout", "stockouts",
  "oos", "wastage", "shrinkage", "rejection", "rejections", "reject",
  "overdue", "dso", "backlog", "downtime", "scrap", "rework", "loss", "losses",
]);
const HIGHER_BETTER_TOKENS = new Set([
  "revenue", "sales", "profit", "margin", "share", "growth", "adherence",
  "compliance", "distribution", "availability", "penetration", "productivity",
  "throughput", "realization", "realisation",
]);

/**
 * Resolve a metric/column name to its polarity (direction of "good").
 * Order: registry-term map → token heuristic (lower before higher, so an
 * explicit cost word dominates) → neutral.
 */
export function resolveMetricPolarity(name: string): MetricPolarity {
  if (!name || !name.trim()) return "neutral";
  const term = resolveFinanceTerm(name);
  const byId = term ? POLARITY_BY_TERM_ID[term.id] : undefined;
  if (byId) return byId;
  const tokens = normalizeMetricTokens(name);
  if (tokens.some((t) => LOWER_BETTER_TOKENS.has(t))) return "lower_better";
  if (tokens.some((t) => HIGHER_BETTER_TOKENS.has(t))) return "higher_better";
  return "neutral";
}

function expressionHintNonAdditive(hint: SemanticHint): boolean {
  if (hint.format === "percent" || hint.format === "ratio") return true;
  return !!hint.expression && expressionIsRatio(hint.expression);
}

/** Additivity of a metric by name, or by a structured `{format, expression}` hint. */
export function metricAdditivity(metric: string | SemanticHint): Additivity {
  if (typeof metric === "string") return classifyMetric(metric).additivity;
  return expressionHintNonAdditive(metric) ? "non_additive" : "additive";
}

/**
 * THE thin-view predicate the chart/sweep/pivot callers import (replacing their
 * private rate regexes). Structured hint wins; otherwise name-based.
 */
export function isNonAdditiveMetric(name: string, semanticEntry?: SemanticHint): boolean {
  return classifyMetric(name, semanticEntry).additivity === "non_additive";
}

// ────────────────────────────────────────────────────────────────────────────
// Aggregation policy ladder (W2) — how to combine a metric ACROSS a dimension
// ────────────────────────────────────────────────────────────────────────────

/**
 * How a metric should be combined when grouping rows by a dimension/period.
 *   • sum            — additive amounts (NR, volume, COGS …).
 *   • weighted_mean  — a ratio re-weighted by its denominator: Σ(value·w)/Σ(w)
 *                      (GC% by channel = Σ(GC%·NR)/Σ NR). This is the PRIMARY ratio
 *                      policy: correct AND scale-preserving (a percent-points column
 *                      stays percent-points; a fraction stays a fraction).
 *   • recompute      — a ratio rebuilt from RAW parts: Σnumerator / Σdenominator.
 *                      Correct, but yields the canonical fraction (Σ GC / Σ NR = 0.30,
 *                      not 30) — use only when there is no ratio column to re-weight.
 *   • mean           — last resort for a non-additive metric with no denominator.
 * NEVER `sum` a non-additive metric — that is the "sum of GC%" nonsense.
 */
export type AggPolicy =
  | { op: "sum" }
  | { op: "mean" }
  | { op: "weighted_mean"; weightColumn: string }
  | { op: "recompute"; numerator: string; denominator: string };

/**
 * Find the actual frame column that carries a given canonical finance term —
 * e.g. canonical "net_revenue" → the column literally named "Net Revenue" / "NR".
 */
export function resolveSiblingColumn(
  canonicalId: string,
  frameColumns: readonly string[],
): string | undefined {
  for (const col of frameColumns) {
    if (resolveFinanceTerm(col)?.id === canonicalId) return col;
  }
  return undefined;
}

/**
 * THE aggregation decision. Additive ⇒ sum. Non-additive ⇒ walk the ladder:
 * recompute (both parts on the frame) → weighted_mean (denominator present) →
 * mean (last resort). Pure — callers pass the frame columns they can see.
 */
export function aggregationPolicyFor(
  metricName: string,
  opts?: {
    semanticEntry?: SemanticHint;
    frameColumns?: readonly string[];
    /** Override term-id → column resolution (defaults to `resolveSiblingColumn`). */
    columnResolver?: (canonicalId: string) => string | undefined;
  },
): AggPolicy {
  const cls = classifyMetric(metricName, opts?.semanticEntry);
  if (cls.additivity === "additive") return { op: "sum" };

  const term = cls.term ?? resolveFinanceTerm(metricName);
  const frameColumns = opts?.frameColumns ?? [];
  const resolve = opts?.columnResolver ?? ((id: string) => resolveSiblingColumn(id, frameColumns));

  // Weighted-mean by the denominator is the primary ratio policy: correct AND
  // scale-preserving (Σ(GC%·NR)/Σ NR = 30, keeping percent-points). Recompute from
  // raw parts would give the unscaled fraction (0.30), so it is NOT auto-selected.
  if (term?.denominator) {
    const denCol = resolve(term.denominator);
    if (denCol && denCol !== metricName) return { op: "weighted_mean", weightColumn: denCol };
  }
  return { op: "mean" };
}

// ────────────────────────────────────────────────────────────────────────────
// Structural relatedness (W3) — the identity graph behind the causation guards
// ────────────────────────────────────────────────────────────────────────────

/** How two metrics are STRUCTURALLY linked (a definitional, not causal, link). */
export type StructuralKind =
  | "identity" // same accounting quantity under two names
  | "numerator" // one is the numerator of the other's ratio
  | "denominator" // one is the denominator of the other's ratio (GC% / NR)
  | "component" // one is an additive component of the other (COGS in GC)
  | "part_of_total" // one is a part of the other's total (channel NR in total NR)
  | "product_factor" // one is a multiplicative factor of the other (volume × price = value)
  | "none";

export interface StructuralRelation {
  related: boolean;
  kind: StructuralKind;
  reason: string;
  canonicalA?: string;
  canonicalB?: string;
}

export interface IdentityEdge {
  kind: StructuralKind;
}

export interface IdentityGraph {
  /** canonical term id → (other canonical term id → edge). Undirected (both ways). */
  edges: Map<string, Map<string, IdentityEdge>>;
  /** lowercased detected column / metric name → canonical term id. */
  aliases: Map<string, string>;
}

/**
 * Extra waterfall identities NOT already encoded as a ratio numerator/denominator
 * or a term's `components`. Each pair is a definitional edge of the given kind.
 */
export const FINANCE_IDENTITIES: ReadonlyArray<{ a: string; b: string; kind: StructuralKind }> =
  Object.freeze([
    { a: "net_revenue", b: "gross_sales", kind: "component" },
    { a: "net_revenue", b: "trade_spend", kind: "component" },
    { a: "net_revenue", b: "returns", kind: "component" },
    { a: "cogs", b: "raw_material", kind: "component" },
    { a: "cogs", b: "packaging_material", kind: "component" },
    { a: "cogs", b: "conversion_cost", kind: "component" },
    { a: "net_revenue", b: "volume", kind: "product_factor" },
    { a: "net_revenue", b: "realization", kind: "product_factor" },
    // A margin ratio is mechanically a function of its cost too (GC% = 1 − COGS/NR),
    // so the bare correlation GC%↔COGS is definitional. (The DECOMPOSITION "COGS rose,
    // compressing GC% by X pts" is still valid — it is exempted at the verifier by
    // gradeFromEvidenceKind === "decomposition", not here.)
    { a: "gross_contribution_pct", b: "cogs", kind: "component" },
    { a: "gross_margin_pct", b: "cogs", kind: "component" },
  ]);

function addEdge(edges: Map<string, Map<string, IdentityEdge>>, a: string, b: string, kind: StructuralKind): void {
  if (a === b) return;
  for (const [from, to] of [
    [a, b],
    [b, a],
  ] as const) {
    let m = edges.get(from);
    if (!m) edges.set(from, (m = new Map()));
    if (!m.has(to)) m.set(to, { kind });
  }
}

/**
 * Build the per-dataset identity graph. Two layers, unioned:
 *   1. The finance ontology (FINANCE_TERMS numerator/denominator/components +
 *      FINANCE_IDENTITIES) — fires on RAW uploads, no curated model needed.
 *   2. The semantic model's ratio expressions, when present (high confidence).
 * `aliases` maps each DETECTED column to its canonical term so the gates can
 * resolve real column names, not just canonical ids.
 */
export function buildIdentityGraph(input: {
  columns: readonly string[];
  semanticModel?: SemanticModel | null;
}): IdentityGraph {
  const edges = new Map<string, Map<string, IdentityEdge>>();

  // Layer 1a — ratio numerator/denominator + additive components from the registry.
  for (const term of FINANCE_TERMS) {
    if (term.numerator) addEdge(edges, term.id, term.numerator, "numerator");
    if (term.denominator) addEdge(edges, term.id, term.denominator, "denominator");
    for (const c of term.components ?? []) addEdge(edges, term.id, c, "component");
  }
  // Layer 1b — extra waterfall identities.
  for (const { a, b, kind } of FINANCE_IDENTITIES) addEdge(edges, a, b, kind);

  // Layer 2 — semantic-model ratio expressions (best-effort, high confidence).
  for (const metric of input.semanticModel?.metrics ?? []) {
    if (!metric.expression || !expressionIsRatio(metric.expression)) continue;
    const self = resolveFinanceTerm(metric.name) ?? resolveFinanceTerm(metric.label);
    if (!self) continue;
    const slash = topLevelSlashIndex(metric.expression);
    const left = metric.expression.slice(0, slash);
    const right = metric.expression.slice(slash + 1);
    for (const ref of metric.references ?? []) {
      const refTerm = resolveFinanceTerm(ref);
      if (!refTerm) continue;
      if (left.includes(ref)) addEdge(edges, self.id, refTerm.id, "numerator");
      else if (right.includes(ref)) addEdge(edges, self.id, refTerm.id, "denominator");
    }
  }

  // Aliases — every detected column → canonical id (lowercased key).
  const aliases = new Map<string, string>();
  for (const col of input.columns) {
    const term = resolveFinanceTerm(col);
    if (term) aliases.set(col.toLowerCase(), term.id);
  }
  return { edges, aliases };
}

function topLevelSlashIndex(expression: string): number {
  let depth = 0;
  for (let i = 0; i < expression.length; i++) {
    const ch = expression[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "/" && depth === 0) return i;
  }
  return -1;
}

function canonicalIdFor(name: string, graph: IdentityGraph): string | undefined {
  return graph.aliases.get(name.toLowerCase()) ?? resolveFinanceTerm(name)?.id;
}

const KIND_PHRASE: Record<Exclude<StructuralKind, "none">, string> = {
  identity: "they are the same accounting quantity under two names",
  numerator: "one is the numerator of the other's ratio",
  denominator: "one is the denominator of the other's ratio",
  component: "one is an additive component of the other",
  part_of_total: "one is a part of the other's total",
  product_factor: "one is a multiplicative factor of the other",
};

/**
 * Are two metrics DEFINITIONALLY (structurally) related? A pure lookup against a
 * prebuilt graph — symmetric in `related`. When true, any "X is driven by / is
 * impacted by Y" claim between them is a tautology, not an insight.
 */
export function areStructurallyRelated(
  metricA: string,
  metricB: string,
  graph: IdentityGraph,
): StructuralRelation {
  const a = canonicalIdFor(metricA, graph);
  const b = canonicalIdFor(metricB, graph);
  if (!a || !b || a === b) {
    return { related: false, kind: "none", reason: "", canonicalA: a, canonicalB: b };
  }
  const edge = graph.edges.get(a)?.get(b);
  if (!edge) return { related: false, kind: "none", reason: "", canonicalA: a, canonicalB: b };
  return {
    related: true,
    kind: edge.kind,
    reason: `"${metricA}" and "${metricB}" are definitionally linked — ${KIND_PHRASE[edge.kind as Exclude<StructuralKind, "none">]}.`,
    canonicalA: a,
    canonicalB: b,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Causation grade (W3/W11) — derived from the EVIDENCE that produced a claim
// ────────────────────────────────────────────────────────────────────────────

/**
 * A claim's causation grade is decided by the KIND of evidence behind it, not by
 * its prose. Only the first four are causation-grade (surfaceable as a driver /
 * action); `association_only` is a bare correlation — shown, but hard-labelled,
 * never as a cause. A decomposition between structurally-related metrics (RM-cost
 * → GC%) is a REAL quantified attribution and stays exempt from the identity block.
 */
export type CausationGrade =
  | "decomposition"
  | "temporal_leadlag"
  | "controlled_comparison"
  | "domain_mechanism"
  | "association_only";

export function gradeFromEvidenceKind(evidenceKind: string | undefined | null): CausationGrade {
  const k = (evidenceKind ?? "").toLowerCase();
  if (/(decompos|variance|attribut|waterfall|bridge)/.test(k)) return "decomposition";
  if (/(growth|trend|lead.?lag|temporal|over.time|momentum)/.test(k)) return "temporal_leadlag";
  if (/(segment|controlled|hold.?out|like.for.like|benchmark)/.test(k)) return "controlled_comparison";
  if (/(domain|pack|mechanism|known)/.test(k)) return "domain_mechanism";
  return "association_only";
}

/** Is a causation grade strong enough to surface as a driver/action (not association)? */
export function isCausationGrade(grade: CausationGrade): boolean {
  return grade !== "association_only";
}
