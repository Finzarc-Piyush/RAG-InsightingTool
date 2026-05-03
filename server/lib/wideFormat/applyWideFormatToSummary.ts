// Decorate a `DataSummary` produced from a post-melt long dataset
// with wide-format metadata + Value-column currency. Runs after
// `createDataSummary` (or `applyUploadPipelineWithProfile`) in the
// upload pipeline. See WF7.
//
// Pure helper — no I/O. Reads the per-column currency tally that
// `parseFile` populated for the original wide source columns and
// votes the dominant currency across them onto the new long `Value`
// column. Also forces the Value column to type `number` even when
// the high-cardinality identifier heuristic would otherwise mark it
// as `string` (24 unique đX,XXX,XXX,XXX cells trip Signal B).

import type { DataSummary, WideFormatTransform } from "../../shared/schema.js";
import { finaliseCurrencyForColumn } from "../fileParser.js";

export function applyWideFormatTransformToSummary(
  summary: DataSummary,
  wideFormatTransform: WideFormatTransform
): void {
  summary.wideFormatTransform = wideFormatTransform;

  // Vote dominant currency across all source columns that were
  // melted into `Value`. Each source column's currency was captured
  // at parseFile time and survives in fileParser's tally.
  const votes = new Map<
    string,
    {
      count: number;
      isoCode: string;
      symbol: string;
      position: "prefix" | "suffix";
    }
  >();
  for (const src of wideFormatTransform.meltedColumns) {
    const c = finaliseCurrencyForColumn(src);
    if (!c) continue;
    const k = `${c.symbol}|${c.position}`;
    const v = votes.get(k);
    if (v) v.count++;
    else
      votes.set(k, {
        count: 1,
        isoCode: c.isoCode,
        symbol: c.symbol,
        position: c.position,
      });
  }
  let best:
    | { count: number; isoCode: string; symbol: string; position: "prefix" | "suffix" }
    | null = null;
  for (const v of votes.values()) {
    if (!best || v.count > best.count) best = v;
  }

  const valueCol = summary.columns.find(
    (c) => c.name === wideFormatTransform.valueColumn
  );
  if (!valueCol) return;

  // Force numeric type — see header comment.
  if (valueCol.type !== "number") {
    valueCol.type = "number";
    if (!summary.numericColumns.includes(valueCol.name)) {
      summary.numericColumns.push(valueCol.name);
    }
    // Drop string-only artifacts that may have leaked in.
    delete (valueCol as Record<string, unknown>).topValues;
  }

  if (best) {
    valueCol.currency = {
      symbol: best.symbol,
      isoCode: best.isoCode,
      position: best.position,
      confidence: 1,
    };
    wideFormatTransform.detectedCurrencySymbol = best.symbol;
  }
}
