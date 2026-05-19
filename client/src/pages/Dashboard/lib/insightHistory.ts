/**
 * Wave WI6 · per-tile insight history store (MRU navigator).
 *
 * The WI2 trilogy + WI3 + WI4 family + WI5 closed the per-tile insight
 * regen surface on the dimensions of cache (WI2-cache), endpoint
 * (WI2-server), hook (WI2-wire), citations (WI3), brush-region
 * sub-slicing (WI4), and value-driven CTAs (WI5). WI6 adds the LAST
 * Workstream 7 piece: navigation between the prior filter combos a
 * user has explored for a given tile.
 *
 * Why this module sits next to `insightRegenCache.ts` not inside it:
 * the cache is keyed for read performance — `(tileId, filterHash[,
 * regionHash])` → entry, LRU + TTL — whereas history is keyed for UX
 * navigation — `tileId` → ordered list of `(filterHash, filters,
 * entry, recordedAt)` slots, MRU-bubble + cap. Different concerns,
 * different shapes; co-located in `lib/` so both are found together.
 *
 * Storage model:
 *   - One `Map<tileId, InsightHistoryEntry[]>`. Each tile's array is
 *     newest-first (index 0 = most recent).
 *   - `record(tileId, filters, entry)` resolves the filterHash via
 *     `hashGlobalFilters` (same helper the cache uses, so the hash
 *     contract stays consistent). If the tile's array already has a
 *     slot with that hash, the slot's `entry` + `recordedAt` are
 *     updated AND the slot is bubbled to index 0 (MRU). Otherwise a
 *     new slot is unshifted; the array is then trimmed to
 *     `MAX_HISTORY_PER_TILE`.
 *   - No TTL on history — bound is the entry-count cap × tile-count,
 *     well under any leak threshold. The cache's 5-min TTL still
 *     governs prose freshness; when the user navigates back to a TTL-
 *     expired combo, `useInsightRegen`'s auto-fire path kicks in
 *     transparently and a fresh `record` lands on the same slot.
 *
 * The module is React-free and synchronous, testable under
 * `node --import tsx --test` with no DOM. Behavioural tests live in
 * the sibling `insightHistory.test.ts` (real import + runtime
 * assertions, mirroring the WI5 `tileRecommendations.test.ts` shape).
 */

import type { ActiveChartFilters } from "../../../lib/chartFilters";
import { hashGlobalFilters, type InsightRegenEntry } from "./insightRegenCache";

/** Cap on per-tile history slots. Matches the brief's "last 3 insights". */
export const MAX_HISTORY_PER_TILE = 3;

export interface InsightHistoryEntry {
  /**
   * Stable de-dup key for the slot. Output of `hashGlobalFilters` on the
   * filter map at record time. Also load-bearing as the React `key` when
   * rendering the dropdown menu — two slots in the same tile's history
   * can never collide on this string.
   */
  filterHash: string;
  /**
   * Full filter map at regen time. Needed both for restoring the
   * dashboard's filters when the user clicks the history entry AND for
   * rendering a short human-readable label in the dropdown UI.
   */
  filters: ActiveChartFilters;
  /** The regenerated insight entry as it landed in the cache. */
  entry: InsightRegenEntry;
  /** ms timestamp when this slot was last touched (sort key for MRU). */
  recordedAt: number;
}

export interface InsightHistoryStoreOptions {
  /** Per-tile slot cap. Default `MAX_HISTORY_PER_TILE` (3). */
  maxPerTile?: number;
  /** Override `Date.now`; injected for deterministic tests. */
  now?: () => number;
}

export interface InsightHistoryStore {
  /**
   * Record a regen for a tile. MRU semantics: if a slot with the same
   * filterHash already exists, it's updated in place (entry replaced,
   * recordedAt refreshed) AND moved to index 0. Otherwise a new slot is
   * unshifted; the array is then trimmed to the per-tile cap.
   */
  record(
    tileId: string,
    filters: ActiveChartFilters,
    entry: InsightRegenEntry,
  ): void;
  /**
   * Read the tile's history list, newest first. Returns a defensive copy
   * so callers can't mutate the store by mutating the returned array.
   */
  get(tileId: string): InsightHistoryEntry[];
  /**
   * Clear history for a single tile, or for all tiles when `tileId` is
   * omitted. No-op for unknown `tileId`.
   */
  clear(tileId?: string): void;
}

/**
 * Factory: build a fresh insight history store. Callers should hold one
 * instance per `DashboardView` mount (via
 * `useMemo(() => createInsightHistoryStore(), [])`) so navigation history
 * lives for the dashboard session and dies with it — same lifecycle as
 * the regen cache.
 */
export function createInsightHistoryStore(
  opts: InsightHistoryStoreOptions = {},
): InsightHistoryStore {
  const maxPerTile = opts.maxPerTile ?? MAX_HISTORY_PER_TILE;
  const now = opts.now ?? (() => Date.now());
  const store = new Map<string, InsightHistoryEntry[]>();

  return {
    record(tileId, filters, entry) {
      const filterHash = hashGlobalFilters(filters);
      const list = store.get(tileId) ?? [];
      const existingIdx = list.findIndex((e) => e.filterHash === filterHash);
      const slot: InsightHistoryEntry = {
        filterHash,
        filters,
        entry,
        recordedAt: now(),
      };
      let next: InsightHistoryEntry[];
      if (existingIdx >= 0) {
        next = [slot, ...list.slice(0, existingIdx), ...list.slice(existingIdx + 1)];
      } else {
        next = [slot, ...list];
      }
      if (next.length > maxPerTile) {
        next = next.slice(0, maxPerTile);
      }
      store.set(tileId, next);
    },
    get(tileId) {
      const list = store.get(tileId);
      if (!list) return [];
      return list.slice();
    },
    clear(tileId) {
      if (tileId === undefined) {
        store.clear();
      } else {
        store.delete(tileId);
      }
    },
  };
}
