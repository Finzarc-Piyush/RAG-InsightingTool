import type { ChartSpec } from "../shared/schema.js";

/**
 * When `processChartData` mutates its spec argument (e.g. sets `seriesKeys` on a shallow copy),
 * merge those fields back onto the outward chart spec.
 */
export function seriesKeysPatchesFromProcessedSpec(
  mutated: Pick<ChartSpec, "seriesKeys" | "seriesColumn">
): Pick<ChartSpec, "seriesKeys" | "seriesColumn"> {
  const out: Pick<ChartSpec, "seriesKeys" | "seriesColumn"> = {};
  if (mutated.seriesKeys?.length) {
    out.seriesKeys = mutated.seriesKeys;
  }
  if (mutated.seriesColumn?.trim()) {
    out.seriesColumn = mutated.seriesColumn;
  }
  return out;
}

/**
 * If wide pivot/chart rows have one column per series but `seriesKeys` was dropped, infer keys
 * from the first row (all keys except X, excluding long-format triple x+series+y).
 */
export function deriveSeriesKeysFromWideDataRow(
  type: ChartSpec["type"],
  x: string,
  y: string,
  seriesColumn: string | undefined,
  firstRow: Record<string, unknown> | null | undefined
): string[] | undefined {
  if (type !== "line" && type !== "bar" && type !== "area") return undefined;
  if (!seriesColumn?.trim() || !firstRow) return undefined;
  const keys = Object.keys(firstRow).filter((k) => k !== x);
  if (keys.length === 0) return undefined;
  const sc = seriesColumn.trim();
  if (keys.length === 2 && keys.includes(sc) && keys.includes(y)) {
    return undefined;
  }
  return keys.filter((k) => k !== y);
}
