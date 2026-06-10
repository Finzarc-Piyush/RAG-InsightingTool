/**
 * Wave S5 · guard predicate for live content auto-fit.
 *
 * Decides whether a tile's grid height may be patched from a freshly MEASURED
 * content height (via useTileAutoFit). Two invariants protect the user and the
 * grid from misbehaving:
 *   1. RESPECT MANUAL RESIZES — once a user drags a tile's resize handle, its
 *      id is recorded; auto-fit must never stomp that height again.
 *   2. IDEMPOTENT — never patch when the proposed rows already equal the
 *      current height, otherwise setLayouts → re-measure → setLayouts forms a
 *      persist loop.
 *
 * Pure; the only testable piece of the live auto-fit feature (the hook is DOM
 * glue, the layout patching is wiring).
 */
export function shouldAutoFit(
  tileId: string,
  proposedRows: number,
  currentH: number,
  userResizedIds: ReadonlySet<string>,
): boolean {
  if (userResizedIds.has(tileId)) return false;
  if (!Number.isFinite(proposedRows) || proposedRows < 1) return false;
  if (proposedRows === currentH) return false;
  return true;
}
