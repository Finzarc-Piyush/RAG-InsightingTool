import { isLikelyIdentifierColumnName } from "./columnIdHeuristics.js";
import type { DataSummary } from "../shared/schema.js";

/**
 * Deterministic follow-up questions from persisted column metadata (no LLM).
 * Used when upload-time LLM seeding is disabled or when flush finds no stored follow-ups.
 */
export function suggestedFollowUpsFromDataSummary(
  summary: DataSummary,
  options?: { fileLabel?: string }
): string[] {
  if (!summary?.columns?.length || summary.rowCount < 1) {
    return [];
  }

  const numericSet = new Set(summary.numericColumns);
  const dateSet = new Set(summary.dateColumns);
  const numeric = summary.numericColumns.filter((c) =>
    summary.columns.some((col) => col.name === c)
  );
  const dates = summary.dateColumns.filter((c) =>
    summary.columns.some((col) => col.name === c)
  );
  const otherCols = summary.columns
    .map((c) => c.name)
    .filter((n) => !numericSet.has(n) && !dateSet.has(n) && !isLikelyIdentifierColumnName(n));

  const out: string[] = [];
  const fileHint = options?.fileLabel?.trim();

  for (const col of numeric.slice(0, 3)) {
    out.push(`What are the main statistics and outliers for ${col}?`);
  }
  if (dates.length > 0 && numeric.length > 0) {
    out.push(
      `How does ${numeric[0]} change over ${dates[0]}?`
    );
  }
  for (const col of otherCols.slice(0, 4)) {
    out.push(`What are the top categories or values for ${col}?`);
  }
  if (numeric.length >= 2) {
    out.push(
      `What is the relationship between ${numeric[0]} and ${numeric[1]}?`
    );
  }
  out.push(
    `Summarize patterns across all ${summary.columnCount} columns (${summary.rowCount.toLocaleString()} rows).`
  );
  if (fileHint) {
    out.push(`What are the key insights in ${fileHint}?`);
  }

  return [...new Set(out)].slice(0, 12);
}
