/**
 * W-SBGRID · pure layout core for the Executive-Summary free-form card grid.
 *
 * Flattens the band's six card groups (+ attentionAreas) into one ordered list
 * of grid cards with STABLE ids, and builds a per-breakpoint react-grid-layout
 * that (a) keeps every saved position and (b) auto-places any card the user
 * hasn't arranged yet (new / legacy) below the saved block, so a fresh
 * dashboard still gets a sensible default arrangement. Kept pure → it's the
 * testable seam; the `DashboardSummaryGrid` component stays thin.
 */
import type { Layout, Layouts } from "react-grid-layout";
import type { AttentionAreaSpec, DashboardAnswerEnvelope } from "@/shared/schema";
import {
  SUMMARY_GROUP_ORDER,
  summaryGroupItems,
  type SummaryGroupKey,
} from "./summaryBandEdit";
import { GRID_COLS } from "../Components/dashboardGridConstants";

export interface SummaryTileSize {
  w: number;
  h: number;
  minW: number;
  minH: number;
}

/** Default size per card type, in 12-col grid units (users resize freely). */
export const SUMMARY_TILE_CONFIG: Record<SummaryGroupKey, SummaryTileSize> = {
  magnitudes: { w: 2, h: 3, minW: 2, minH: 2 },
  attentionAreas: { w: 3, h: 3, minW: 2, minH: 2 },
  findings: { w: 3, h: 4, minW: 2, minH: 3 },
  likelyDrivers: { w: 3, h: 4, minW: 2, minH: 3 },
  implications: { w: 3, h: 4, minW: 2, minH: 3 },
  recommendations: { w: 4, h: 3, minW: 2, minH: 2 },
};

export interface SummaryCard {
  /** Stable react-grid-layout key. */
  gridId: string;
  group: SummaryGroupKey;
  /** Index within the group's RAW (uncapped) array — the edit/delete target. */
  index: number;
  item: Record<string, unknown>;
}

/** Stable grid key: the card's own id, or an index fallback for legacy cards. */
export function summaryCardGridId(
  group: SummaryGroupKey,
  item: Record<string, unknown>,
  index: number,
): string {
  const id = item.id;
  return typeof id === "string" && id ? id : `${group}-${index}`;
}

/** The full, ordered list of band cards across all six groups. */
export function flattenSummaryCards(
  envelope: DashboardAnswerEnvelope | undefined,
  attentionAreas: AttentionAreaSpec[] | undefined,
): SummaryCard[] {
  const cards: SummaryCard[] = [];
  for (const group of SUMMARY_GROUP_ORDER) {
    const items = summaryGroupItems(group, envelope, attentionAreas);
    items.forEach((item, index) => {
      cards.push({ gridId: summaryCardGridId(group, item, index), group, index, item });
    });
  }
  return cards;
}

/** Pack the cards that have no saved position, starting below `startY`. */
function packMissing(
  missing: SummaryCard[],
  cols: number,
  startY: number,
): Layout[] {
  const colHeights = Array<number>(cols).fill(startY);
  return missing.map((c) => {
    const cfg = SUMMARY_TILE_CONFIG[c.group];
    const w = Math.min(cfg.w, cols);
    const h = cfg.h;
    // Leftmost x whose w-column run is shortest (classic shelf packing).
    let bestX = 0;
    let bestY = Infinity;
    for (let x = 0; x + w <= cols; x++) {
      let y = 0;
      for (let k = x; k < x + w; k++) y = Math.max(y, colHeights[k]);
      if (y < bestY) {
        bestY = y;
        bestX = x;
      }
    }
    if (!Number.isFinite(bestY)) bestY = startY;
    for (let k = bestX; k < bestX + w; k++) colHeights[k] = bestY + h;
    return {
      i: c.gridId,
      x: bestX,
      y: bestY,
      w,
      h,
      minW: cfg.minW,
      minH: cfg.minH,
    };
  });
}

/** One breakpoint's layout: saved positions for known cards + packed defaults. */
function buildBreakpointLayout(
  cards: SummaryCard[],
  cols: number,
  saved: Layout[] | undefined,
): Layout[] {
  const savedById = new Map((saved ?? []).map((l) => [l.i, l]));
  const result: Layout[] = [];
  let maxY = 0;
  const missing: SummaryCard[] = [];

  for (const c of cards) {
    const s = savedById.get(c.gridId);
    const cfg = SUMMARY_TILE_CONFIG[c.group];
    if (s) {
      // Clamp a saved card into this breakpoint's column count + re-assert mins.
      const w = Math.max(cfg.minW, Math.min(s.w, cols));
      const x = Math.min(s.x, Math.max(0, cols - w));
      result.push({ ...s, x, w, minW: cfg.minW, minH: cfg.minH });
      maxY = Math.max(maxY, s.y + s.h);
    } else {
      missing.push(c);
    }
  }

  result.push(...packMissing(missing, cols, maxY));
  return result;
}

/** Build the full `Layouts` (all breakpoints) for the current card set. */
export function buildSummaryLayouts(
  cards: SummaryCard[],
  saved: Layouts | null | undefined,
): Layouts {
  const out: Layouts = {};
  for (const bp of Object.keys(GRID_COLS) as Array<keyof typeof GRID_COLS>) {
    out[bp] = buildBreakpointLayout(cards, GRID_COLS[bp], saved?.[bp]);
  }
  return out;
}
