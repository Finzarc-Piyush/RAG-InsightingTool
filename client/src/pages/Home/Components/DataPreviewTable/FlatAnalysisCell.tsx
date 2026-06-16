// Pure presentational cell-formatter for the analysis-variant flat table,
// extracted verbatim from DataPreviewTable.tsx (god-file decomposition,
// behaviour-preserving code motion). Props-only: it captures no component
// state — the lookup maps (facet metadata, date columns, resolved grains,
// numeric columns) are passed in by the parent. Output is identical to the
// former inline `renderFlatAnalysisCell` closure.
import type { ReactNode } from 'react';
import type { TemporalDisplayGrain, TemporalFacetColumnMeta } from '@/shared/schema';
import { formatDateCellForGrain } from '@/lib/temporalDisplayFormat';
import { formatTemporalFacetValue } from '@/lib/temporalFacetDisplay';
import { formatAnalysisNumber, parseNumericCell } from '@/lib/formatAnalysisNumber';

export interface FlatAnalysisCellLookups {
  facetMetaByName: Record<string, TemporalFacetColumnMeta>;
  effectiveDateColumns: string[];
  resolvedGrainsByColumn: Record<string, TemporalDisplayGrain>;
  numericColumns: string[];
}

/**
 * Renders one cell of the analysis flat table, formatting temporal facet
 * values, date cells (per resolved grain), and numeric cells, falling back to
 * a plain string otherwise. Null/undefined render as an italic "null".
 */
export function renderFlatAnalysisCell(
  col: string,
  raw: unknown,
  lookups: FlatAnalysisCellLookups
): ReactNode {
  const { facetMetaByName, effectiveDateColumns, resolvedGrainsByColumn, numericColumns } =
    lookups;
  if (raw === null || raw === undefined) {
    return <span className="text-muted-foreground italic">null</span>;
  }
  const facetMeta = facetMetaByName[col];
  if (facetMeta) {
    const formatted = formatTemporalFacetValue(raw, facetMeta.grain);
    return formatted ?? String(raw);
  }
  if (effectiveDateColumns.includes(col)) {
    const g = resolvedGrainsByColumn[col];
    const formatted = g !== undefined ? formatDateCellForGrain(raw, g) : null;
    return formatted ?? String(raw);
  }
  if (numericColumns.includes(col)) {
    const n = parseNumericCell(raw);
    return n !== null ? formatAnalysisNumber(n) : String(raw);
  }
  return String(raw);
}
