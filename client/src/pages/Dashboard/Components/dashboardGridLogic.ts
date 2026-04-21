import type { Layout, Layouts } from 'react-grid-layout';

/**
 * Pure helpers for dashboard grid layout mutations. Kept outside the
 * component so they can be unit-tested and reasoned about without React.
 *
 * Design goals:
 *  - Dropping a dragged tile on top of another should SWAP their slots
 *    (Notion / Tableau semantics), not cascade other tiles downward.
 *  - When tiles are reordered or removed, existing tiles keep their
 *    positions; only genuinely new tiles get a bottom-fill slot.
 *
 * Used by `DashboardTiles.tsx` to replace the prior greedy re-place
 * behavior that caused the "cards keep pushing way too far down" UX.
 */

export interface GridSize {
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}

export interface OverlapResult {
  /** Tile id that the dragged item most meaningfully overlaps (≥50% of dragged area). */
  swapTargetId?: string;
  /** True when multiple tiles overlap the dragged item — caller should revert. */
  ambiguous: boolean;
}

function overlapArea(a: Layout, b: Layout): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return x * y;
}

/** Find overlaps between the dragged item and every other tile. */
export function findOverlapsForTile(
  layout: readonly Layout[],
  draggedId: string,
  minOverlapRatio = 0.5
): OverlapResult {
  const dragged = layout.find((l) => l.i === draggedId);
  if (!dragged) return { ambiguous: false };
  const draggedArea = Math.max(1, dragged.w * dragged.h);
  const overlaps: Array<{ id: string; area: number }> = [];
  for (const item of layout) {
    if (item.i === draggedId) continue;
    const area = overlapArea(dragged, item);
    if (area > 0 && area / draggedArea >= minOverlapRatio) {
      overlaps.push({ id: item.i, area });
    }
  }
  if (overlaps.length === 0) return { ambiguous: false };
  if (overlaps.length > 1) return { ambiguous: true };
  return { swapTargetId: overlaps[0].id, ambiguous: false };
}

/**
 * Resolve a drag-drop for a single breakpoint. Given the layout before the
 * drag, the layout after (as the library reports it, potentially with
 * cascade pushes), and the dragged tile id:
 *
 *  - If exactly one tile was ≥50% overlapped by the drop, swap that tile's
 *    position with the dragged tile's original position.
 *  - If the overlap is ambiguous (multiple targets), revert the drag.
 *  - Otherwise, restore every non-dragged tile to its pre-drag position
 *    (cancelling any cascade pushes) and keep the dragged tile's new spot.
 *
 * The return value is a new layout array — input arrays are never mutated.
 */
export function resolveDropBySwap(
  layoutBefore: readonly Layout[],
  layoutAfter: readonly Layout[],
  draggedId: string
): Layout[] {
  const byIdBefore = new Map(layoutBefore.map((l) => [l.i, l]));
  const byIdAfter = new Map(layoutAfter.map((l) => [l.i, l]));

  const draggedBefore = byIdBefore.get(draggedId);
  const draggedAfter = byIdAfter.get(draggedId);

  // If we can't find the dragged tile, accept whatever the library returned.
  if (!draggedBefore || !draggedAfter) {
    return layoutAfter.map((l) => ({ ...l }));
  }

  const overlap = findOverlapsForTile(layoutAfter, draggedId);

  // Ambiguous drop → revert the whole gesture.
  if (overlap.ambiguous) {
    return layoutBefore.map((l) => ({ ...l }));
  }

  // Build the restored layout: every non-dragged tile goes back to its
  // pre-drag position, cancelling cascade pushes.
  const restored: Layout[] = layoutAfter.map((after) => {
    if (after.i === draggedId) return { ...after };
    const before = byIdBefore.get(after.i);
    return before ? { ...before } : { ...after };
  });

  // If we overlapped a single target, swap it with the dragged tile's
  // pre-drag slot so both remain visible.
  if (overlap.swapTargetId) {
    return restored.map((item) => {
      if (item.i === overlap.swapTargetId) {
        return {
          ...item,
          x: draggedBefore.x,
          y: draggedBefore.y,
          w: draggedBefore.w,
          h: draggedBefore.h,
        };
      }
      return item;
    });
  }

  // Clean drop onto empty space — restored layout already keeps others in
  // place and keeps dragged tile at its new spot.
  return restored;
}

/** Apply `resolveDropBySwap` across every breakpoint present in `after`. */
export function resolveLayoutsDropBySwap(
  before: Layouts,
  after: Layouts,
  draggedId: string
): Layouts {
  const out: Layouts = {};
  for (const key of Object.keys(after) as Array<keyof Layouts>) {
    const beforeArr = before[key] ?? [];
    const afterArr = after[key] ?? [];
    out[key] = resolveDropBySwap(beforeArr, afterArr, draggedId);
  }
  return out;
}

/**
 * Greedy bottom-fill for a tile that has no prior position. Walks the
 * column range looking for the lowest y where a {w x h} block fits
 * without overlap, given the positions we've already committed.
 */
function findFirstFreeSlot(
  committed: readonly Layout[],
  w: number,
  h: number,
  cols: number
): { x: number; y: number } {
  const width = Math.min(Math.max(1, w), cols);
  let bestX = 0;
  let bestY = Number.MAX_SAFE_INTEGER;
  for (let x = 0; x <= cols - width; x++) {
    const candidate = { i: '__probe', x, y: 0, w: width, h };
    let maxOverlapBottom = 0;
    for (const item of committed) {
      if (overlapArea(candidate, item) > 0) {
        maxOverlapBottom = Math.max(maxOverlapBottom, item.y + item.h);
      }
    }
    if (maxOverlapBottom < bestY) {
      bestY = maxOverlapBottom;
      bestX = x;
    }
  }
  return { x: bestX, y: bestY === Number.MAX_SAFE_INTEGER ? 0 : bestY };
}

/**
 * Stable layout placement.
 *
 * Existing tiles that already have a valid layout entry keep their slot
 * exactly. Tiles without a prior position — and only those tiles — get a
 * fresh bottom-fill slot. This prevents the cascade-push behaviour of the
 * previous `placeTilesForCols` helper.
 */
export function stablePlaceTiles(
  tileIds: readonly string[],
  tileConfig: Record<string, GridSize>,
  cols: number,
  previous: readonly Layout[] = []
): Layout[] {
  if (cols <= 0) return [];
  const known = new Map(previous.map((l) => [l.i, l]));
  const output: Layout[] = [];
  const committed: Layout[] = [];

  for (const id of tileIds) {
    const config = tileConfig[id];
    if (!config) continue;
    const prior = known.get(id);
    const width = Math.min(config.w, cols);
    const minW = Math.min(config.minW ?? config.w, cols);
    if (prior) {
      const clamped: Layout = {
        ...prior,
        w: Math.min(Math.max(prior.w, minW), cols),
        minW,
        minH: config.minH ?? prior.minH,
      };
      output.push(clamped);
      committed.push(clamped);
      continue;
    }
    const slot = findFirstFreeSlot(committed, width, config.h, cols);
    const fresh: Layout = {
      i: id,
      x: slot.x,
      y: slot.y,
      w: width,
      h: config.h,
      minW,
      minH: config.minH,
    };
    output.push(fresh);
    committed.push(fresh);
  }
  return output;
}
