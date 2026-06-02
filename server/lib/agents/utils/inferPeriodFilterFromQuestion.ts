// Relative-period → filter translation for melted wide-format ("pure_period")
// datasets. A Nielsen topline melt produces a NON-ADDITIVE period dimension
// (Period / PeriodIso / PeriodKind) where rows like "Latest 12 Mths" (L12M)
// are pre-computed rollups that already equal the sum of the latest 4 quarters.
// The categorical `inferFiltersFromQuestion` only matches LITERAL catalog
// values, so a phrase like "latest 12 months" never resolves to PeriodIso=L12M
// and Value gets summed across every overlapping period row.
//
// This deterministic pass maps relative-period phrases to a single concrete
// filter on PeriodIso (preferred) or PeriodKind, gated on the value actually
// existing in the column catalog. Output rides the existing inferred-filters
// pipeline (context.ts → INFERRED_FILTERS_JSON → every dimensionFilter tool),
// so no tool changes are needed.

import type { DataSummary } from "../../../shared/schema.js";
import type { InferredFilter } from "./inferFiltersFromQuestion.js";
import { matchPeriod } from "../../wideFormat/periodVocabulary.js";

interface RelativePhraseRule {
  /** Tested against the lowercased question. More-specific rules come first. */
  re: RegExp;
  /** Ordered candidate PeriodIso values, most-preferred (current, non-comparative) first. */
  isoCandidates: string[];
  /** Fallback PeriodKind literals when no isoCandidate exists in the catalog. */
  kindFallback?: string[];
  /** When set, the captured group is run through matchPeriod to derive the iso
   *  (for generic "latest N months/weeks/years"). */
  deriveFromMatch?: boolean;
  label: string;
}

// NOTE order: YTD-comparative before YTD; specific 12-month before generic
// "latest N"; explicit-grain phrases before the bare "latest"/"most recent".
const RELATIVE_PHRASE_RULES: RelativePhraseRule[] = [
  {
    re: /\bytd\s+(?:last\s+year|year\s+ago|ya)\b/,
    isoCandidates: ["YTD-YA"],
    label: "ytd year ago",
  },
  {
    re: /\b(?:year[\s-]*to[\s-]*date|ytd|this\s+year\s+so\s+far)\b/,
    isoCandidates: ["YTD-TY", "YTD"],
    kindFallback: ["ytd"],
    label: "year to date",
  },
  {
    // "latest/last/trailing/rolling/past 12 (or twelve) months/mths",
    // plus the canonical shorthands TTM / L12M / MAT.
    re: /\b(?:(?:latest|last|trailing|rolling|past)\s+(?:12|twelve)\s+(?:months?|mths?))|trailing\s+twelve\s+months|\bttm\b|\bl12m\b|\bmat\b/,
    isoCandidates: ["L12M"],
    kindFallback: ["latest_n"],
    label: "latest 12 months",
  },
  {
    // Generic "latest/last/trailing/rolling N months|weeks|years|days".
    re: /\b(?:latest|last|trailing|rolling|past)\s+\d{1,3}\s+(?:months?|mths?|weeks?|wks?|years?|yrs?|days?)\b/,
    isoCandidates: [],
    kindFallback: ["latest_n"],
    deriveFromMatch: true,
    label: "latest N period",
  },
  {
    // Bare "latest" / "most recent" / "current period" — ambiguous grain.
    // Prefer the L12M rollup as the canonical "latest"; if absent, emit
    // nothing and let the deterministic guard (Layer B) pick a default.
    re: /\b(?:latest\s+period|most\s+recent|current\s+period|latest\s+available)\b/,
    isoCandidates: ["L12M"],
    label: "latest period",
  },
];

const COMPARATIVE_SUFFIX_RE = /-(?:YA|2YA|3YA)$/i;

function catalogStrings(
  summary: DataSummary,
  columnName: string | undefined
): string[] {
  if (!columnName) return [];
  const col = summary.columns.find((c) => c.name === columnName);
  if (!col) return [];
  const fromTop = (col.topValues ?? [])
    .map((t) => String(t.value).trim())
    .filter(Boolean);
  if (fromTop.length) return fromTop;
  return (col.sampleValues ?? [])
    .filter((v): v is string | number => v !== null)
    .map((v) => String(v).trim())
    .filter(Boolean);
}

/** First catalog value that case-insensitively equals `candidate`, or null. */
function catalogHit(candidate: string, catalog: string[]): string | null {
  const lc = candidate.toLowerCase();
  return catalog.find((v) => v.toLowerCase() === lc) ?? null;
}

/**
 * Translate a relative-period phrase in the question into at most ONE
 * InferredFilter on the melted period dimension. Returns [] for tidy/compound
 * datasets, when no relative phrase is present, or when the resolved period
 * value does not exist in the dataset's catalog (abstain rather than guess).
 */
export function inferPeriodFilterFromQuestion(
  question: string,
  summary: DataSummary | null | undefined
): InferredFilter[] {
  const wf = summary?.wideFormatTransform;
  if (!summary || !wf?.detected || wf.shape !== "pure_period") return [];
  if (!question?.trim()) return [];

  const q = question.toLowerCase();
  const isoCol = wf.periodIsoColumn;
  const kindCol = wf.periodKindColumn;
  const isoCatalog = catalogStrings(summary, isoCol);
  const kindCatalog = catalogStrings(summary, kindCol);
  if (!isoCatalog.length && !kindCatalog.length) return [];

  for (const rule of RELATIVE_PHRASE_RULES) {
    if (!rule.re.test(q)) continue;

    // Build the ordered iso candidate list (rule-supplied + optionally derived).
    const isoCandidates = [...rule.isoCandidates];
    if (rule.deriveFromMatch) {
      const m = rule.re.exec(q);
      const derived = m ? matchPeriod(m[0]) : null;
      // Only use the current (non-comparative) variant the phrase implies.
      if (derived?.iso && !COMPARATIVE_SUFFIX_RE.test(derived.iso)) {
        isoCandidates.unshift(derived.iso);
      }
    }

    // Prefer a PeriodIso equality to a real, non-comparative catalog value.
    for (const cand of isoCandidates) {
      const hit = catalogHit(cand, isoCatalog);
      if (hit) {
        return [
          {
            column: isoCol,
            op: "in",
            values: [hit],
            match: "case_insensitive",
            matchedTokens: [rule.label],
            intent: "positive",
          },
        ];
      }
    }

    // Fall back to a PeriodKind filter if the canonical iso is absent.
    for (const kind of rule.kindFallback ?? []) {
      const hit = catalogHit(kind, kindCatalog);
      if (hit) {
        return [
          {
            column: kindCol,
            op: "in",
            values: [hit],
            match: "case_insensitive",
            matchedTokens: [rule.label],
            intent: "positive",
          },
        ];
      }
    }

    // Matched a phrase but nothing resolvable in the catalog → abstain and let
    // the deterministic guard (Layer B) choose a default. Stop scanning so a
    // less-specific rule doesn't produce a wrong filter.
    return [];
  }

  return [];
}
