import type { TemporalFacetColumnMeta } from "@/shared/schema";

const FACET_GRAIN_LABEL: Record<string, string> = {
  date: "Day",
  week: "Week",
  month: "Month",
  quarter: "Quarter",
  half_year: "Half-year",
  year: "Year",
};

export function facetColumnHeaderLabel(meta: TemporalFacetColumnMeta): string {
  const g = FACET_GRAIN_LABEL[meta.grain] ?? meta.grain;
  return `${g} · ${meta.sourceColumn}`;
}

export function facetColumnHeaderLabelForColumn(
  columnName: string,
  temporalFacetColumns: TemporalFacetColumnMeta[] | undefined | null
): string {
  const list = temporalFacetColumns ?? [];
  const meta = list.find((m) => m.name === columnName);
  return meta ? facetColumnHeaderLabel(meta) : columnName;
}

