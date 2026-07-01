/**
 * columnSemantics.ts — the DETERMINISTIC floor for per-column semantic typing.
 *
 * Answers "what IS this column, really?" from its NAME + its VALUES, producing
 * the authoritative `ColumnSemantics` that the Data Summary panel, the temporal
 * grain display, the semantic model, and the aggregation guard all read. It is
 * the non-blocking-startup fallback: it runs with no I/O at upload and always
 * returns a sane classification even when the dataset-profile LLM times out. The
 * LLM (`datasetProfile.perColumn`) later OVERLAYS this — refining, never
 * demoting a hard signal (a currency-tagged column stays a measure regardless).
 *
 * Why this exists: the legacy pipeline classified only numeric/date/string by
 * value shape, then computed mean/sum for EVERY numeric column — so a "Year"
 * stored as 26 got averaged, "fy_month_number" got summed, and a margin % was
 * summed to a nonsense >100%. Semantic type stops all of that at the source.
 */

import type {
  AggregationPolicy,
  ColumnSemantics,
  DisplayKind,
  SemanticType,
  TemporalDisplayGrain,
} from "../shared/schema.js";
import {
  isIdentifierLikeNumericColumn,
  isLikelyIdentifierColumnName,
} from "./columnIdHeuristics.js";
import { displayGrainForColumn } from "./temporalGrain.js";

/**
 * The single mapping table `semanticType → {aggregation, displayKind}`. The LLM
 * only ever emits a `semanticType`; this fills the rest so the policy lives in
 * exactly one place.
 */
export const SEMANTIC_TYPE_POLICY: Record<
  SemanticType,
  { aggregation: AggregationPolicy; displayKind: DisplayKind }
> = {
  temporal_date: { aggregation: "none", displayKind: "date" },
  temporal_year: { aggregation: "none", displayKind: "date" },
  temporal_month: { aggregation: "none", displayKind: "date" },
  temporal_quarter: { aggregation: "none", displayKind: "date" },
  ordinal: { aggregation: "none", displayKind: "ordinal" },
  identifier: { aggregation: "none", displayKind: "categorical" },
  categorical_dimension: { aggregation: "none", displayKind: "categorical" },
  measure_additive: { aggregation: "sum", displayKind: "numeric" },
  measure_ratio_percent: { aggregation: "avg", displayKind: "numeric" },
  measure_per_unit: { aggregation: "avg", displayKind: "numeric" },
  currency_amount: { aggregation: "sum", displayKind: "numeric" },
  boolean_flag: { aggregation: "none", displayKind: "boolean" },
  empty: { aggregation: "none", displayKind: "empty" },
};

/** Semantic types the LLM must NOT override — a hard structural/parse signal. */
const HARD_SIGNAL_TYPES = new Set<SemanticType>([
  "empty",
  "currency_amount",
  "measure_ratio_percent",
  "boolean_flag",
]);

/** A "Year" / "Yr" column (values like 2026 or the fiscal short 26). */
const YEAR_NAME_RE = /(^| )(year|yr)( |$)/;
/** A month-ORDINAL name ("fy_month_number", "month no", "month index"). */
const MONTH_NUMBER_NAME_RE =
  /(^| )(fy )?month( )?(number|no|num|index|idx)( |$)/;
/** A calendar "Month" / period name (excluding the month-number case). */
const MONTH_NAME_RE = /(^| )(month|mth|mon|period)( |$)/;
/** A "Quarter" / "Qtr" / "Q1".."Q4" name. */
const QUARTER_NAME_RE = /(^| )(quarter|qtr|q[1-4])( |$)/;
/** A generic ordinal / rank / rating / sequence name. */
const ORDINAL_NAME_RE =
  /(^| )(number|no|num|rank|rating|score|level|order|seq|sequence|position|priority|grade|tier|bucket|bin|stage|phase)( |$)/;
/** A ratio / percent / rate name — never summable. */
const RATIO_NAME_RE =
  /(^| )(margin|share|rate|ratio|growth|mix|pct|percent|percentage|contribution|penetration|achievement|adherence|utili[sz]ation|scheme)( |$)|%/;
/** Values that look like a quarter/half label: Q1, Q3 25, H1. */
const QUARTER_VALUE_RE = /^\s*(q[1-4]|h[12])\b/i;

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  return false;
}

function finalize(
  semanticType: SemanticType,
  opts?: {
    source?: ColumnSemantics["source"];
    temporalGrain?: TemporalDisplayGrain | null;
    confidence?: number;
  },
): ColumnSemantics {
  const policy = SEMANTIC_TYPE_POLICY[semanticType];
  const out: ColumnSemantics = {
    semanticType,
    aggregation: policy.aggregation,
    displayKind: policy.displayKind,
    source: opts?.source ?? "deterministic",
  };
  if (opts?.temporalGrain) out.temporalGrain = opts.temporalGrain;
  if (opts?.confidence !== undefined) out.confidence = opts.confidence;
  return out;
}

export interface ClassifyColumnInput {
  name: string;
  /** name ∈ dataSummary.numericColumns (upload-time numeric classification). */
  isNumericMember: boolean;
  /** name ∈ dataSummary.dateColumns. */
  isDateMember: boolean;
  /** From financeMetricAuthority (available in uploadQueue merge, not at first parse). */
  additivity?: "additive" | "non_additive";
  additivityKind?: "additive" | "ratio_percent" | "per_unit" | "index_score";
  /** Column carried a currency symbol at parse time → real measure. */
  hasCurrency?: boolean;
  /** Column has a boolean/indicator classification. */
  isBooleanIndicator?: boolean;
  /** RAW sample values (may include blanks) for shape signals. */
  sampleValues?: unknown[];
  /** Parsed dates when known (date columns), for the grain fallback. */
  dates?: Date[];
}

/**
 * Deterministic per-column classification. Pure; no I/O. Precedence is designed
 * so a strong signal (empty, currency, explicit temporal name) wins before the
 * weaker value-shape heuristics.
 */
export function classifyColumnSemantics(
  input: ClassifyColumnInput,
): ColumnSemantics {
  const { name } = input;
  const nn = (input.sampleValues ?? []).filter((v) => !isBlank(v));
  const n = normalizeName(name);
  const grain = (st: SemanticType) =>
    displayGrainForColumn(name, st, input.dates);

  // 1. EMPTY — no non-blank values at all. Hard signal.
  if (input.sampleValues !== undefined && nn.length === 0) {
    return finalize("empty");
  }

  // 2. Hard measure signals (only meaningful once additivity/currency known).
  if (input.additivityKind === "ratio_percent") {
    return finalize("measure_ratio_percent");
  }
  if (input.additivityKind === "per_unit" || input.additivityKind === "index_score") {
    return finalize("measure_per_unit");
  }
  if (input.hasCurrency) return finalize("currency_amount");

  // 3. Temporal / ordinal by NAME (works for int- and label-encoded columns
  //    that never parse as dates — Year=26, fy_month_number=1, Quarter="Q1").
  if (YEAR_NAME_RE.test(n) || n === "fy") {
    return finalize("temporal_year", { temporalGrain: grain("temporal_year") });
  }
  if (MONTH_NUMBER_NAME_RE.test(n)) {
    return finalize("ordinal"); // a month index (1..12) — never averaged
  }
  if (QUARTER_NAME_RE.test(n)) {
    return finalize("temporal_quarter", {
      temporalGrain: grain("temporal_quarter"),
    });
  }
  if (MONTH_NAME_RE.test(n)) {
    return finalize("temporal_month", { temporalGrain: grain("temporal_month") });
  }

  // 4. Date-typed columns not caught by name → generic temporal_date.
  if (input.isDateMember) {
    return finalize("temporal_date", {
      temporalGrain: displayGrainForColumn(name, "temporal_date", input.dates),
    });
  }

  // 5. Numeric members that are NOT measures.
  if (input.isNumericMember) {
    const allInt = nn.length > 0 && nn.every((v) => /^-?\d+$/.test(String(v).trim()));
    const distinct = new Set(nn.map((v) => String(v).trim())).size;

    // Ratio by name / value (financeMetricAuthority may not have fired yet).
    if (RATIO_NAME_RE.test(n) || nn.some((v) => typeof v === "string" && v.includes("%"))) {
      return finalize("measure_ratio_percent");
    }
    // Numeric surrogate key / code.
    if (isIdentifierLikeNumericColumn(name, nn)) {
      return finalize("identifier");
    }
    // Low-cardinality integer WITH a rank/level/number-ish name → ordinal.
    if (allInt && distinct <= 24 && ORDINAL_NAME_RE.test(n)) {
      return finalize("ordinal");
    }
    // Everything else numeric is a real additive measure (keeps mean + sum).
    return finalize("measure_additive");
  }

  // 6. String members (categorical / boolean / label-encoded temporal).
  if (input.isBooleanIndicator) return finalize("boolean_flag");
  if (QUARTER_NAME_RE.test(n) || nn.some((v) => QUARTER_VALUE_RE.test(String(v)))) {
    return finalize("temporal_quarter", {
      temporalGrain: grain("temporal_quarter"),
    });
  }
  const distinctStr = new Set(nn.map((v) => String(v))).size;
  if (isLikelyIdentifierColumnName(name) || (nn.length > 1 && distinctStr === nn.length)) {
    return finalize("identifier");
  }
  return finalize("categorical_dimension");
}

/**
 * Overlay an LLM-provided semantic type onto a deterministic base. The LLM
 * refines but never DEMOTES a hard signal: if the deterministic base is a hard
 * type (empty/currency/ratio/boolean) it wins. Otherwise the LLM type is
 * adopted (with its policy + optional grain), marked `source:"llm"`.
 */
export function overlayLlmSemantics(
  base: ColumnSemantics,
  llm: { semanticType: SemanticType; temporalGrain?: TemporalDisplayGrain } | undefined,
  columnName: string,
): ColumnSemantics {
  if (!llm) return base;
  if (HARD_SIGNAL_TYPES.has(base.semanticType)) return base;
  if (llm.semanticType === base.semanticType && !llm.temporalGrain) return base;
  const policy = SEMANTIC_TYPE_POLICY[llm.semanticType];
  const grain =
    llm.temporalGrain ??
    (policy.displayKind === "date"
      ? displayGrainForColumn(columnName, llm.semanticType) ?? undefined
      : undefined);
  const out: ColumnSemantics = {
    semanticType: llm.semanticType,
    aggregation: policy.aggregation,
    displayKind: policy.displayKind,
    source: "llm",
  };
  if (grain) out.temporalGrain = grain;
  return out;
}
