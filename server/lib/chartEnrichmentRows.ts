import { processChartData } from "./chartGenerator.js";

/**
 * Picks row source for final chart enrichment (avoids full rawData for aggregated agent charts).
 */
export function resolveChartDataRowsForEnrichment(
  c: any,
  rawData: Record<string, any>[],
  dateColumns: string[] | undefined,
  analyticalFallbackRows?: Record<string, unknown>[]
): any[] {
  const hasEmbeddedData = c.data && Array.isArray(c.data) && c.data.length > 0;
  const analyticalOnly = Boolean((c as any)._useAnalyticalDataOnly);
  if (hasEmbeddedData) {
    return c.data;
  }
  if (analyticalOnly) {
    if (analyticalFallbackRows?.length) {
      return processChartData(
        analyticalFallbackRows as Record<string, any>[],
        c,
        dateColumns
      );
    }
    return [];
  }
  return processChartData(rawData, c, dateColumns);
}
