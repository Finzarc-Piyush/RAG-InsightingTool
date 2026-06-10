import { useEffect, useRef } from "react";
import { measuredHeightToRows } from "../lib/measuredHeightToRows";

/**
 * Wave S4 · observe a tile's natural content height and report it as a row
 * count. Thin DOM glue around ResizeObserver (precedent: ResizableTile.tsx) —
 * all conversion math lives in the pure `measuredHeightToRows` so this hook
 * needs no unit test. The element passed via `ref` should wrap the tile's
 * intrinsic content (the unconstrained inner node), NOT the grid cell, so we
 * measure what the content WANTS rather than the height the grid already gave.
 *
 * `onRows` is stored in a ref so a fresh callback identity each render doesn't
 * re-subscribe the observer. Disabled by passing `enabled = false` (e.g. for
 * chart tiles, which have no intrinsic content height).
 */
export function useTileAutoFit(
  ref: React.RefObject<HTMLElement | null>,
  rowHeight: number,
  gridMargin: [number, number],
  onRows: (rows: number) => void,
  enabled = true,
): void {
  const onRowsRef = useRef(onRows);
  onRowsRef.current = onRows;

  const marginX = gridMargin[0];
  const marginY = gridMargin[1];

  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof ResizeObserver === "undefined") return;

    let last = -1;
    const report = (heightPx: number) => {
      const rows = measuredHeightToRows(heightPx, rowHeight, [marginX, marginY]);
      if (rows !== last) {
        last = rows;
        onRowsRef.current(rows);
      }
    };

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = entry.contentRect?.height ?? el.scrollHeight;
        report(h);
      }
    });
    ro.observe(el);
    // Prime once with the current height (ResizeObserver fires async).
    report(el.scrollHeight);

    return () => ro.disconnect();
  }, [ref, rowHeight, marginX, marginY, enabled]);
}
