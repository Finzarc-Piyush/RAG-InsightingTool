/**
 * Deterministic, manager-readable scope facts derived from a `DataSummary`.
 *
 * These power the welcome-card "What's in this data" / "What you can analyze"
 * sections when the LLM seed (`seedSessionAnalysisContextLLM`) hasn't landed
 * yet — non-blocking startup contract: the heuristic-only render must always
 * have substance.
 *
 * Pure fn, no I/O. Stays generic across datasets (Superstore-style transactional,
 * MMM panel data, wide-format Nielsen, etc.) — never hard-codes business nouns.
 */
import type { DataSummary } from "../shared/schema.js";

export interface DeterministicScopeFacts {
  highlights: string[];
  analyzeThemes: string[];
}

const PRIMARY_METRIC_HINTS = [
  "sales", "revenue", "amount", "total", "value", "gmv",
  "spend", "cost", "price", "profit", "units",
];

export function buildDeterministicScopeFacts(summary: DataSummary): DeterministicScopeFacts {
  return {
    highlights: buildHighlights(summary),
    analyzeThemes: buildAnalyzeThemes(summary),
  };
}

function buildHighlights(summary: DataSummary): string[] {
  const out: string[] = [];

  const span = computeTimeSpan(summary);
  if (span) out.push(span);

  const scopes = computeScopeDimensions(summary, 3);
  for (const s of scopes) out.push(s);

  // Always-safe magnitude bullet — total record count, framed in business
  // language. Avoids the wrong-number trap of trying to sum sampleValues.
  if (summary.rowCount > 0) {
    out.push(`${formatRowCount(summary.rowCount)} records in scope`);
  }

  return out;
}

function buildAnalyzeThemes(summary: DataSummary): string[] {
  const themes: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    const key = s.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      themes.push(s);
    }
  };

  const primaryMetric = pickPrimaryMetricLabel(summary);
  const metricLabel = primaryMetric ?? "key metrics";
  const dims = pickAnalyzableDimensions(summary, 3);
  const hasDate = summary.dateColumns.length > 0;

  if (hasDate && summary.numericColumns.length > 0) {
    push(`Track ${metricLabel} over time`);
  }

  for (const dim of dims) {
    if (themes.length >= 4) break;
    if (summary.numericColumns.length > 0) {
      push(`Compare ${metricLabel} across ${friendlyDimensionLabel(dim)}`);
    } else if (hasDate) {
      push(`Activity patterns by ${friendlyDimensionLabel(dim)}`);
    }
  }

  if (themes.length < 4 && summary.numericColumns.length >= 2) {
    const [a, b] = summary.numericColumns;
    push(`Explore the relationship between ${a} and ${b}`);
  }

  if (themes.length === 0) {
    push("Profile what the dataset contains");
  }

  return themes.slice(0, 4);
}

// ── time span ────────────────────────────────────────────────────────────────

function computeTimeSpan(summary: DataSummary): string | null {
  if (summary.dateColumns.length === 0) return null;
  // Prefer the first date column with parseable samples.
  for (const name of summary.dateColumns) {
    const col = summary.columns.find((c) => c.name === name);
    if (!col) continue;
    const dates = (col.sampleValues ?? [])
      .map((v) => parseSampleDate(v))
      .filter((d): d is Date => d !== null);
    if (dates.length < 2) continue;
    let min = dates[0];
    let max = dates[0];
    for (const d of dates) {
      if (d < min) min = d;
      if (d > max) max = d;
    }
    return formatSpan(min, max);
  }
  return null;
}

function parseSampleDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  if (typeof v === "number") {
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  if (Number.isFinite(t)) return new Date(t);
  // Fallback for D/M/YY style ("1/4/15"): parsed by Date.parse already on most
  // engines. Anything more exotic stays unparsed and we just skip the bullet.
  return null;
}

function formatSpan(min: Date, max: Date): string {
  const days = Math.max(0, (max.getTime() - min.getTime()) / 86_400_000);
  const years = days / 365.25;
  const months = days / 30.44;
  const minLabel = formatYearMonth(min);
  const maxLabel = formatYearMonth(max);
  if (minLabel === maxLabel) return `Single period: ${minLabel}`;
  if (years >= 1.5) {
    const yrs = Math.round(years);
    return `${yrs} years (${min.getUTCFullYear()} → ${max.getUTCFullYear()})`;
  }
  if (months >= 2) {
    const m = Math.round(months);
    return `${m} months (${minLabel} → ${maxLabel})`;
  }
  return `${minLabel} → ${maxLabel}`;
}

function formatYearMonth(d: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// ── scope dimensions (categorical columns with topValues) ────────────────────

function computeScopeDimensions(summary: DataSummary, max: number): string[] {
  const out: string[] = [];
  const numericSet = new Set(summary.numericColumns);
  const dateSet = new Set(summary.dateColumns);
  for (const col of summary.columns) {
    if (out.length >= max) break;
    if (numericSet.has(col.name) || dateSet.has(col.name)) continue;
    const tv = col.topValues;
    if (!tv || tv.length < 2 || tv.length > 30) continue;
    if (looksLikeIdColumn(col.name)) continue;
    const label = friendlyDimensionLabel(col.name, tv.length);
    out.push(`${tv.length} ${label}`);
  }
  return out;
}

function looksLikeIdColumn(name: string): boolean {
  const n = name.toLowerCase();
  return /\b(id|code|key|uuid|guid|sku|number|num|#)\b/.test(n) || /_id$|id$/.test(n);
}

function friendlyDimensionLabel(name: string, count?: number): string {
  // Lowercase + replace underscores/dashes with spaces.
  const cleaned = name.replace(/[_-]+/g, " ").trim().toLowerCase();
  // Drop trailing "name" suffix that's noise to a manager (e.g. "customer name" → "customers").
  const stripped = cleaned.replace(/\s+name$/, "");
  if (count == null || count !== 1) return pluralize(stripped);
  return stripped;
}

// Normalise to a singular base before re-pluralising, so already-plural
// column headers like "Facts" / "Markets" / "Products" don't round-trip
// to "factses" / "marketses" / "productses".
function singularize(word: string): string {
  if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;          // categories → category
  if (/sses$/.test(word)) return word.slice(0, -2);                // classes → class
  if (/(xes|zes|ches|shes)$/.test(word)) return word.slice(0, -2); // boxes → box, bushes → bush
  if (/[^s]s$/.test(word)) return word.slice(0, -1);               // markets → market, facts → fact
  return word;
}

function pluralize(word: string): string {
  if (!word) return word;
  const base = singularize(word);
  if (/(s|x|z|ch|sh)$/.test(base)) return `${base}es`;
  if (/[^aeiou]y$/.test(base)) return `${base.slice(0, -1)}ies`;
  return `${base}s`;
}

// ── primary metric heuristic ─────────────────────────────────────────────────

function pickPrimaryMetricLabel(summary: DataSummary): string | null {
  if (summary.numericColumns.length === 0) return null;
  for (const hint of PRIMARY_METRIC_HINTS) {
    const match = summary.numericColumns.find((n) => n.toLowerCase().includes(hint));
    if (match) return match;
  }
  // No semantic match — only use the lone metric when it's unambiguous.
  if (summary.numericColumns.length === 1) return summary.numericColumns[0];
  return null;
}

function pickAnalyzableDimensions(summary: DataSummary, max: number): string[] {
  const numericSet = new Set(summary.numericColumns);
  const dateSet = new Set(summary.dateColumns);
  const out: string[] = [];
  for (const col of summary.columns) {
    if (out.length >= max) break;
    if (numericSet.has(col.name) || dateSet.has(col.name)) continue;
    if (looksLikeIdColumn(col.name)) continue;
    const tv = col.topValues;
    // Prefer columns with topValues (low cardinality), but accept any non-id
    // string column as a fallback when the dataset has no topValues populated.
    if (tv && (tv.length < 2 || tv.length > 30)) continue;
    out.push(col.name);
  }
  return out;
}

// ── row-count formatter ──────────────────────────────────────────────────────

function formatRowCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString();
}
