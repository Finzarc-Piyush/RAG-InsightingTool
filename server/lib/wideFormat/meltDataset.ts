// Wide → long melt — given a row collection and the classification
// from `classifyDataset`, produce a long-format equivalent that the
// rest of the pipeline (DuckDB, profile inference, RAG) can treat as
// an ordinary dataset.
//
// Output shape:
//   pure_period:  { ...idCols, Period, PeriodIso, PeriodKind, Value }
//   compound:     { ...idCols, Period, PeriodIso, PeriodKind, Metric, Value }
//
// Numeric values are coerced via `stripCurrencyAndParse` so the long
// `Value` column is `number | null`. The currency symbol that was
// peeled (if any) is captured at the dataset level so the caller can
// attach it to the column metadata at WF7 (uploadQueue wiring).

import type { DatasetClassification, WideShape } from "./classifyDataset.js";
import { stripCurrencyAndParse } from "./currencyVocabulary.js";

export interface WideFormatTransformSummary {
  detected: true;
  shape: WideShape;
  idColumns: string[];
  /** Original wide-format column headers that were melted away. */
  meltedColumns: string[];
  periodCount: number;
  /** Names of the new long-format columns. */
  periodColumn: string;
  periodIsoColumn: string;
  periodKindColumn: string;
  valueColumn: string;
  metricColumn?: string;
  /** Dominant currency symbol seen across melted values, if any. */
  detectedCurrencySymbol: string | null;
}

export interface MeltResult {
  rows: Record<string, unknown>[];
  summary: WideFormatTransformSummary;
}

const PERIOD_COL = "Period";
const PERIOD_ISO_COL = "PeriodIso";
const PERIOD_KIND_COL = "PeriodKind";
const VALUE_COL = "Value";
const METRIC_COL = "Metric";

export function meltDataset(
  rows: Record<string, unknown>[],
  classification: DatasetClassification
): MeltResult {
  if (!classification.isWide || !classification.shape) {
    throw new Error("meltDataset called on a non-wide classification");
  }

  const { idColumns, shape, tags } = classification;
  // Deterministic lookup: header → ColumnTagResult.
  const tagByHeader = new Map(tags.map((t) => [t.header, t]));

  // Period-like columns to melt = period + compound columns.
  const meltedColumns = [
    ...classification.periodColumns,
    ...classification.compoundColumns,
  ];

  const out: Record<string, unknown>[] = [];
  const symbolTally = new Map<string, number>();

  for (const row of rows) {
    // Stable id-column subrow.
    const idSubrow: Record<string, unknown> = {};
    for (const idCol of idColumns) {
      idSubrow[idCol] = row[idCol] ?? null;
    }
    for (const meltedCol of meltedColumns) {
      const tag = tagByHeader.get(meltedCol);
      if (!tag) continue;
      const periodIso = tag.period?.iso ?? null;
      const periodKind = tag.period?.kind ?? null;
      const metric = tag.metric?.canonical ?? null;
      const raw = row[meltedCol];
      const value = coerceToNumber(raw, symbolTally);

      const longRow: Record<string, unknown> = {
        ...idSubrow,
        [PERIOD_COL]: meltedCol,
        [PERIOD_ISO_COL]: periodIso,
        [PERIOD_KIND_COL]: periodKind,
        [VALUE_COL]: value,
      };
      if (shape === "compound") {
        longRow[METRIC_COL] = metric;
      }
      out.push(longRow);
    }
  }

  let detectedCurrencySymbol: string | null = null;
  if (symbolTally.size > 0) {
    let bestSym: string | null = null;
    let bestCount = 0;
    let total = 0;
    for (const c of symbolTally.values()) total += c;
    for (const [sym, c] of symbolTally.entries()) {
      if (c > bestCount) {
        bestCount = c;
        bestSym = sym;
      }
    }
    if (bestSym && bestCount / total >= 0.8) {
      detectedCurrencySymbol = bestSym;
    }
  }

  const summary: WideFormatTransformSummary = {
    detected: true,
    shape,
    idColumns,
    meltedColumns,
    periodCount: meltedColumns.length,
    periodColumn: PERIOD_COL,
    periodIsoColumn: PERIOD_ISO_COL,
    periodKindColumn: PERIOD_KIND_COL,
    valueColumn: VALUE_COL,
    metricColumn: shape === "compound" ? METRIC_COL : undefined,
    detectedCurrencySymbol,
  };
  return { rows: out, summary };
}

/** Coerce a cell to number | null, stripping currency symbol and
 * thousand separators on the way. Tally currency symbols seen so the
 * caller can attach a dominant currency to the new Value column. */
function coerceToNumber(
  raw: unknown,
  symbolTally: Map<string, number>
): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = stripCurrencyAndParse(trimmed);
  if (parsed === null) return null;
  if (parsed.symbol) {
    symbolTally.set(parsed.symbol, (symbolTally.get(parsed.symbol) ?? 0) + 1);
  }
  return parsed.num;
}
