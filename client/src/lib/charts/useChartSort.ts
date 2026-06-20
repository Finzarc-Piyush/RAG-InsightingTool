import { useEffect, useMemo, useRef, useState } from "react";
import {
  isChartSpecV2,
  type ChartSpec,
  type ChartSpecV2,
} from "@/shared/schema";
import { applyChartSort, type ChartSortSpec } from "@/shared/chartSort";

export type { ChartSortSpec } from "@/shared/chartSort";

type AnyChartSpec = ChartSpec | ChartSpecV2;

/**
 * Whether the interactive "Sort by" control is meaningful for a spec. Scoped to
 * bar/column charts that carry their rows client-side and have >1 category to
 * order. (Temporal line/area keep their chronological order; they don't expose
 * a value-sort toggle.)
 *
 * v1: `type === "bar"` with an embedded `data` array.
 * v2 (Chart v1→v2 convergence): `mark === "bar"` with an INLINE source — the
 *     v2 renderer (PremiumChart) used to silently drop the control because the
 *     gate only knew about the v1 shape (lesson L-019: the gate was centralized
 *     but its INPUT was path-dependent). Handling both shapes here puts sort
 *     back on every bar/column chart, chat · dashboard · fullscreen.
 */
export function chartSupportsSort(
  spec: Pick<ChartSpec, "type" | "data"> | ChartSpecV2,
): boolean {
  if (isChartSpecV2(spec)) {
    return (
      spec.mark === "bar" &&
      spec.source.kind === "inline" &&
      Array.isArray(spec.source.rows) &&
      spec.source.rows.length > 1
    );
  }
  const v1 = spec as Pick<ChartSpec, "type" | "data">;
  return v1.type === "bar" && Array.isArray(v1.data) && v1.data.length > 1;
}

export interface UseChartSortResult<S extends AnyChartSpec = ChartSpec> {
  /** The active sort (user override, else the spec's baked sort). */
  sort: ChartSortSpec | undefined;
  /** Set a new sort; re-orders the spec's rows instantly, no round-trip. */
  setSort: (next: ChartSortSpec) => void;
  /** The spec with its rows re-ordered + the active sort reflected. */
  sortedSpec: S;
}

/** v2 inline source row — the cell union mirrors `chartSourceSchema`. */
type V2Row = Record<string, string | number | boolean | null>;

/** The fold transform's series columns (wide multi-series), if any. */
function foldSeriesKeys(spec: ChartSpecV2): string[] | undefined {
  const fold = spec.transform?.find((t) => t.type === "fold");
  return fold && "fields" in fold ? (fold.fields as string[]) : undefined;
}

/**
 * Order LONG-format multi-series rows (one row per category×series) by ordering
 * the CATEGORIES — aggregate each category's value, order the categories with
 * the shared authority, then flatten preserving the in-category series order
 * (Array.sort is stable). Single-series and wide rows never reach here.
 */
function sortLongFormatByCategory(
  rows: V2Row[],
  sort: ChartSortSpec,
  xCol: string,
  yCol: string,
): V2Row[] {
  const totals = new Map<string, { key: V2Row[string]; total: number }>();
  const order: string[] = [];
  for (const r of rows) {
    const k = String(r[xCol]);
    let t = totals.get(k);
    if (!t) {
      t = { key: r[xCol], total: 0 };
      totals.set(k, t);
      order.push(k);
    }
    const n = Number(r[yCol]);
    if (Number.isFinite(n)) t.total += n;
  }
  // One representative row per category, then order them with applyChartSort so
  // the value/category/temporal comparators stay identical to v1.
  const reps: V2Row[] = order.map((k) => {
    const t = totals.get(k)!;
    return { [xCol]: t.key, [yCol]: t.total };
  });
  const orderedReps = applyChartSort(reps, sort, { xCol, yCol });
  const rank = new Map(orderedReps.map((r, i) => [String(r[xCol]), i]));
  return rows
    .slice()
    .sort(
      (a, b) =>
        (rank.get(String(a[xCol])) ?? 0) - (rank.get(String(b[xCol])) ?? 0),
    );
}

/**
 * Re-order an INLINE v2 bar spec's source rows. Pure; never mutates input.
 * BarRenderer builds its band-scale domain via `distinctOrdered` (first-seen
 * row order), so reordering the rows IS what moves the axis — no scale.domain
 * surgery needed. The interactive sort is NOT stamped into `encoding.x.sort`
 * (that channel carries a Vega-Lite sort, a different shape); it stays as the
 * hook's client state.
 */
function sortV2Spec(spec: ChartSpecV2, sort: ChartSortSpec): ChartSpecV2 {
  // Guard mirrors the v1 path: only bars reorder, so switching a sorted bar →
  // line/area can never carry value-order onto a temporal axis.
  if (spec.mark !== "bar") return spec;
  const src = spec.source;
  if (src.kind !== "inline") return spec;
  const rows = src.rows as V2Row[];
  if (!Array.isArray(rows) || rows.length === 0) return spec;
  const xCol = spec.encoding.x?.field;
  const yCol = spec.encoding.y?.field;
  if (!xCol || !yCol) return spec;

  const seriesKeys = foldSeriesKeys(spec); // wide multi-series (series as cols)
  const colorCol = spec.encoding.color?.field; // long multi-series

  let nextRows: V2Row[];
  if (seriesKeys && seriesKeys.length > 1) {
    // WIDE multi-series: structurally identical to v1 wide rows → same path.
    nextRows = applyChartSort(rows, sort, { xCol, yCol, seriesKeys });
  } else if (colorCol && colorCol !== xCol) {
    // LONG multi-series: order by aggregated category value, flatten stably.
    nextRows = sortLongFormatByCategory(rows, sort, xCol, yCol);
  } else {
    // Single series.
    nextRows = applyChartSort(rows, sort, { xCol, yCol });
  }

  return { ...spec, source: { ...src, rows: nextRows } };
}

/** The structural seed key — stable across a re-render that hands back a fresh
 *  object for the SAME chart, so an in-flight sort choice isn't wiped. */
function seedKeyFor(spec: AnyChartSpec): string {
  if (isChartSpecV2(spec)) {
    return [
      "v2",
      spec.mark,
      spec.encoding.x?.field ?? "",
      spec.encoding.y?.field ?? "",
      spec.encoding.color?.field ?? "",
    ].join("|");
  }
  const v1 = spec as ChartSpec;
  return [
    "v1",
    v1.type,
    v1.title,
    v1.x,
    v1.y,
    v1.seriesColumn ?? "",
    v1.sort?.by ?? "",
    v1.sort?.direction ?? "",
  ].join("|");
}

/**
 * The spec's baked interactive sort. v1 carries it as top-level `sort`
 * ({by, direction}). v2 has no equivalent — its `encoding.x.sort` is a
 * Vega-Lite channel sort (a different shape), so v2 starts unsorted (the
 * server's source-row order) and the user drives ordering via the control.
 */
function bakedSortOf(spec: AnyChartSpec): ChartSortSpec | undefined {
  if (isChartSpecV2(spec)) return undefined;
  return (spec as ChartSpec).sort;
}

/**
 * Owns the interactive sort for one chart (v1 OR v2). Seeded from the spec's
 * baked order. Re-ordering is pure and client-side — the rows are already
 * present — so toggling the dropdown is instant; persistence is the caller's
 * job. The displayed row set is never re-capped here (the server already
 * selected it); only its ORDER changes.
 */
export function useChartSort<S extends AnyChartSpec>(
  spec: S,
): UseChartSortResult<S> {
  const [sort, setSort] = useState<ChartSortSpec | undefined>(() =>
    bakedSortOf(spec),
  );

  // Re-seed the user override only when the chart's STRUCTURAL identity changes
  // — not on every parent re-render that hands back a fresh object.
  const seedKey = seedKeyFor(spec);
  const lastSeed = useRef(seedKey);
  useEffect(() => {
    if (lastSeed.current !== seedKey) {
      lastSeed.current = seedKey;
      setSort(bakedSortOf(spec));
    }
  }, [seedKey, spec]);

  const sortedSpec = useMemo<S>(() => {
    if (isChartSpecV2(spec)) {
      if (!sort) return spec;
      return sortV2Spec(spec, sort) as S;
    }
    const v1 = spec as ChartSpec;
    const rows = v1.data;
    if (v1.type !== "bar") return spec;
    if (!sort || !Array.isArray(rows) || rows.length === 0) return spec;
    const data = applyChartSort(
      rows as Array<Record<string, unknown>>,
      sort,
      { xCol: v1.x, yCol: v1.y, seriesKeys: v1.seriesKeys },
    ) as ChartSpec["data"];
    return { ...v1, sort, data } as S;
  }, [spec, sort]);

  return { sort, setSort, sortedSpec };
}
