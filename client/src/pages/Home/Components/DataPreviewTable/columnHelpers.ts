// Pure column-classification helpers extracted verbatim from DataPreviewTable.tsx
// (god-file decomposition, behaviour-preserving code motion). These are pure
// functions: their output depends only on their arguments — no component
// closure/state — so they are trivially safe to relocate.
import { isTemporalFacetFieldId } from '@/lib/temporalFacetDisplay';
import { parseNumericCell } from '@/lib/formatAnalysisNumber';
import { parseDateLike } from '@/lib/parseDateLike';

export function inferNumericColumns(
  rows: Record<string, any>[],
  columnKeys: string[]
): string[] {
  const sample = rows.slice(0, 500);
  const out: string[] = [];
  for (const col of columnKeys) {
    if (isTemporalFacetFieldId(col)) continue;
    let n = 0;
    let numeric = 0;
    for (const row of sample) {
      const v = row[col];
      if (v === null || v === undefined || v === '') continue;
      n++;
      const parsed = parseNumericCell(v);
      if (parsed !== null) numeric++;
    }
    if (n >= 2 && numeric / n >= 0.75) out.push(col);
  }
  return out;
}

export function isIdLikeColumn(field: string): boolean {
  const f = field.trim().toLowerCase();
  return (
    f === 'id' ||
    f.endsWith('_id') ||
    f.endsWith(' id') ||
    f.includes(' id ') ||
    f.includes('row id') ||
    f.includes('order id') ||
    f.includes('customer id') ||
    f.includes('product id')
  );
}

/** Columns that parse as dates in preview rows (created/derived dims not in schema dateColumns). */
export function inferDateLikeColumns(
  rows: Record<string, any>[],
  columnKeys: string[],
  numericSet: Set<string>
): string[] {
  const sample = rows.slice(0, 500);
  const out: string[] = [];
  for (const col of columnKeys) {
    if (numericSet.has(col)) continue;
    if (isIdLikeColumn(col)) continue;
    if (isTemporalFacetFieldId(col)) {
      out.push(col);
      continue;
    }
    let n = 0;
    let ok = 0;
    for (const row of sample) {
      const v = row[col];
      if (v === null || v === undefined || v === '') continue;
      n++;
      if (parseDateLike(v) !== null) ok++;
    }
    if (n >= 3 && ok / n >= 0.7) out.push(col);
  }
  return out;
}
