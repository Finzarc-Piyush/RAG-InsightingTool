/**
 * Wave Z1 · pure visibility predicates for the tile-header action slots.
 *
 * TileHeader has two action slots:
 *   - `actions` (edit-gated) — delete / edit buttons, only in edit mode.
 *   - `persistentActions` (always-on) — affordances every viewer needs, e.g.
 *     the per-chart Expand/Maximize button (Z2). These must render in BOTH
 *     view and edit mode so read-only viewers can still zoom a chart.
 *
 * Extracted so the gating logic is unit-testable without rendering JSX (vitest
 * runs environment: node, no testing-library).
 */
export function shouldShowEditActions(
  mode: string,
  canToggle: boolean,
  hasActions: boolean,
): boolean {
  return canToggle && mode === "edit" && hasActions;
}

export function shouldShowPersistentActions(hasPersistentActions: boolean): boolean {
  return hasPersistentActions;
}
