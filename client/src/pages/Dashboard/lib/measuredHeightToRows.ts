/**
 * Wave S4 · convert a measured natural content height (px) to react-grid-layout
 * rows. A stack of N rows occupies `N*rowHeight + (N-1)*marginY` px, so the
 * inverse is `ceil((px + marginY) / (rowHeight + marginY))`. Used by the
 * auto-fit hook so text/table/pivot tiles can shrink/grow to what actually
 * renders (the seed-time estimate in contentDrivenHeight is only approximate).
 *
 * Pure — the only piece of the auto-fit feature that needs a unit test (the
 * hook itself is thin DOM glue). Guards against non-finite / non-positive
 * input by returning the 1-row minimum.
 */
export function measuredHeightToRows(
  px: number,
  rowHeight: number,
  gridMargin: [number, number],
): number {
  const marginY = gridMargin[1];
  if (!Number.isFinite(px) || px <= 0) return 1;
  const denom = rowHeight + marginY;
  if (denom <= 0) return 1;
  return Math.max(1, Math.ceil((px + marginY) / denom));
}
