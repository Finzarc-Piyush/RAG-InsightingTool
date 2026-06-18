import { useEffect, useMemo, useRef, useState } from "react";
import type { ChartSpec } from "@/shared/schema";
import { applyChartSort, type ChartSortSpec } from "@/shared/chartSort";

export type { ChartSortSpec } from "@/shared/chartSort";

/**
 * Whether the interactive "Sort by" control is meaningful for a spec. Scoped to
 * bar/column charts that carry their rows client-side and have >1 category to
 * order. (Temporal line/area keep their chronological order; they don't expose
 * a value-sort toggle.)
 */
export function chartSupportsSort(
  spec: Pick<ChartSpec, "type" | "data">,
): boolean {
  return (
    spec.type === "bar" && Array.isArray(spec.data) && spec.data.length > 1
  );
}

export interface UseChartSortResult {
  /** The active sort (user override, else the spec's baked sort). */
  sort: ChartSortSpec | undefined;
  /** Set a new sort; re-orders `sortedSpec.data` instantly, no round-trip. */
  setSort: (next: ChartSortSpec) => void;
  /** The spec with `.data` re-ordered + `.sort` reflecting the active choice. */
  sortedSpec: ChartSpec;
}

/**
 * Owns the interactive sort for one chart. Seeded from `spec.sort` (the order
 * the server baked). Re-ordering is pure and client-side — the rows are already
 * present — so toggling the dropdown is instant; persistence is the caller's
 * job. The displayed row set is never re-capped here (the server already
 * selected it); only its ORDER changes.
 */
export function useChartSort(spec: ChartSpec): UseChartSortResult {
  const [sort, setSort] = useState<ChartSortSpec | undefined>(spec.sort);

  // Re-seed the user override when the underlying chart changes (new question,
  // new tile) — keyed on stable structural fields, NOT object identity, so a
  // streaming/parent re-render that hands back a fresh object for the SAME
  // chart doesn't wipe an in-flight choice.
  const seedKey = [
    spec.type,
    spec.title,
    spec.x,
    spec.y,
    spec.seriesColumn ?? "",
    spec.sort?.by ?? "",
    spec.sort?.direction ?? "",
  ].join("|");
  const lastSeed = useRef(seedKey);
  useEffect(() => {
    if (lastSeed.current !== seedKey) {
      lastSeed.current = seedKey;
      setSort(spec.sort);
    }
  }, [seedKey, spec.sort]);

  const sortedSpec = useMemo<ChartSpec>(() => {
    const rows = spec.data;
    // Sort applies to bar/column only (the control's scope). Guarding here means
    // toggling a sorted bar → line/area can never carry the value-order onto the
    // line's points, even for the frame before the re-seed effect clears `sort`.
    if (spec.type !== "bar") return spec;
    if (!sort || !Array.isArray(rows) || rows.length === 0) return spec;
    const data = applyChartSort(
      rows as Array<Record<string, unknown>>,
      sort,
      { xCol: spec.x, yCol: spec.y, seriesKeys: spec.seriesKeys },
    ) as ChartSpec["data"];
    return { ...spec, sort, data };
  }, [spec, sort]);

  return { sort, setSort, sortedSpec };
}
