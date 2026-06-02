import { isTemporalFacetFieldId } from "@/lib/temporalFacetDisplay";

/**
 * Filter-panel column kind.
 * "period" = a derived temporal facet ("Quarter · Period") or the canonical
 * PeriodIso column: discrete period buckets that filter like a category but must
 * be ordered chronologically and labelled as periods (not raw text or a calendar
 * date-range picker).
 */
export type FilterColumnKind = "text" | "numeric" | "date" | "period";

export function classifyFilterColumn(
  name: string,
  numericColumns: string[],
  dateColumns: string[],
  temporalColumns: string[] = []
): FilterColumnKind {
  // Period facets / PeriodIso first: temporal but filtered as ordered categories.
  if (isTemporalFacetFieldId(name) || temporalColumns.includes(name)) return "period";
  if (dateColumns.includes(name)) return "date";
  if (numericColumns.includes(name)) return "numeric";
  return "text";
}
