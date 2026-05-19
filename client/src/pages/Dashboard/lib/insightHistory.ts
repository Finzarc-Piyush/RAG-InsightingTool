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
 *
 * Wave WI6-persist · cross-session persistence via sessionStorage.
 * History now survives DashboardView remounts (route changes,
 * navigation away and back) — but not tab close, matching the
 * "dashboard-session-lifecycle" framing in the original WI6 comment.
 * The version-suffixed `STORAGE_KEY_PREFIX = "marico-insight-history-v1"`
 * isolates the persisted payload from a future schema bump on
 * `InsightRegenEntry`; v2 readers simply don't find v1 keys and start
 * empty. See `insightHistoryPersistenceWI6Persist.test.ts` for the
 * full hydrate/write-through/quota-tolerance contract.
 */

import type { ActiveChartFilters } from "../../../lib/chartFilters";
import { hashGlobalFilters, type InsightRegenEntry } from "./insightRegenCache";

/** Cap on per-tile history slots. Matches the brief's "last 3 insights". */
export const MAX_HISTORY_PER_TILE = 3;

/**
 * Wave WI6-persist · prefix of the sessionStorage key.
 *
 * The trailing `-v1` is load-bearing. Any future schema bump on
 * `InsightRegenEntry` (e.g., promoting `confidenceTier` to required,
 * adding a required `correlationFingerprint`) MUST also bump this to
 * `-v2` — old payloads will then silently be missed and the store
 * starts empty, rather than rendering `undefined` everywhere.
 *
 * Callers may append a scope (typically `dashboard.id`) so two
 * dashboards on the same tab don't share storage slots. The composed
 * key shape is `${STORAGE_KEY_PREFIX}::${storageScope}` when a scope
 * is provided, else the bare prefix.
 */
export const STORAGE_KEY_PREFIX = "marico-insight-history-v1";

const SCHEMA_VERSION = 1;

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

/**
 * Wave WI6-persist · injectable storage adapter for cross-session
 * persistence. Three methods because `localStorage` / `sessionStorage`
 * expose three (`getItem` / `setItem` / `removeItem`); the adapter
 * isolates the store from the browser-only `window` reference so node
 * tests can run a deterministic in-memory fake.
 *
 * Implementations MUST be best-effort: throwing from any method is
 * caught at the call site, but a clean swallow (return `null` from
 * read, no-op on write/remove) keeps the failure path quieter.
 */
export interface InsightHistoryStorage {
  read(): string | null;
  write(data: string): void;
  remove(): void;
}

export interface InsightHistoryStoreOptions {
  /** Per-tile slot cap. Default `MAX_HISTORY_PER_TILE` (3). */
  maxPerTile?: number;
  /** Override `Date.now`; injected for deterministic tests. */
  now?: () => number;
  /**
   * Wave WI6-persist · storage adapter. Default = a sessionStorage
   * adapter when `window.sessionStorage` is available, else `null` (no
   * persistence). Pass `null` explicitly to opt out of persistence in
   * a browser context. Pass an in-memory fake in node tests.
   */
  storage?: InsightHistoryStorage | null;
  /**
   * Wave WI6-persist · scope suffix appended to `STORAGE_KEY_PREFIX`.
   * Typically a dashboard id — keeps two dashboards' histories on
   * separate keys so navigating between them doesn't surface the
   * wrong tile slots.
   */
  storageScope?: string;
}

interface PersistedPayload {
  version: number;
  tiles: Record<string, InsightHistoryEntry[]>;
}

function defaultSessionStorageAdapter(
  key: string,
): InsightHistoryStorage | null {
  if (typeof window === "undefined" || !window.sessionStorage) return null;
  return {
    read() {
      try {
        return window.sessionStorage.getItem(key);
      } catch {
        return null;
      }
    },
    write(data) {
      try {
        window.sessionStorage.setItem(key, data);
      } catch {
        /* swallow quota / blocked-storage errors */
      }
    },
    remove() {
      try {
        window.sessionStorage.removeItem(key);
      } catch {
        /* swallow */
      }
    },
  };
}

function isValidHistoryEntry(e: unknown): e is InsightHistoryEntry {
  if (typeof e !== "object" || e === null) return false;
  const slot = e as Partial<InsightHistoryEntry>;
  if (typeof slot.filterHash !== "string") return false;
  if (typeof slot.filters !== "object" || slot.filters === null) return false;
  if (typeof slot.entry !== "object" || slot.entry === null) return false;
  if (typeof (slot.entry as InsightRegenEntry).text !== "string") return false;
  if (typeof slot.recordedAt !== "number") return false;
  return true;
}

function hydrateFromStorage(
  raw: string | null,
): Map<string, InsightHistoryEntry[]> {
  if (raw == null) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as PersistedPayload).version !== SCHEMA_VERSION ||
    typeof (parsed as PersistedPayload).tiles !== "object" ||
    (parsed as PersistedPayload).tiles === null
  ) {
    return new Map();
  }
  const out = new Map<string, InsightHistoryEntry[]>();
  for (const [tileId, list] of Object.entries(
    (parsed as PersistedPayload).tiles,
  )) {
    if (!Array.isArray(list)) continue;
    const validated = list.filter(isValidHistoryEntry);
    if (validated.length > 0) out.set(tileId, validated);
  }
  return out;
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
  const storageKey = opts.storageScope
    ? `${STORAGE_KEY_PREFIX}::${opts.storageScope}`
    : STORAGE_KEY_PREFIX;
  // `opts.storage !== undefined` distinguishes "caller passed null to
  // opt out" from "caller omitted, so default to sessionStorage". A
  // simple `??` would conflate the two.
  const storage =
    opts.storage !== undefined
      ? opts.storage
      : defaultSessionStorageAdapter(storageKey);

  // Wrap the read in try/catch so a custom adapter that throws (rare,
  // but the default sessionStorage adapter could also throw if the
  // browser is in a quota-exhausted / private-mode state) yields an
  // empty store rather than crashing the DashboardView mount.
  let initialRaw: string | null = null;
  if (storage) {
    try {
      initialRaw = storage.read();
    } catch {
      initialRaw = null;
    }
  }
  const store = hydrateFromStorage(initialRaw);

  function persist(): void {
    if (!storage) return;
    const payload: PersistedPayload = {
      version: SCHEMA_VERSION,
      tiles: Object.fromEntries(store),
    };
    let serialised: string;
    try {
      serialised = JSON.stringify(payload);
    } catch {
      return; // unserialisable payload — best-effort persistence skips
    }
    try {
      storage.write(serialised);
    } catch {
      // Quota / locked-storage; swallowed so the in-memory record
      // semantics still hold even when persistence isn't available.
    }
  }

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
      persist();
    },
    get(tileId) {
      const list = store.get(tileId);
      if (!list) return [];
      return list.slice();
    },
    clear(tileId) {
      if (tileId === undefined) {
        store.clear();
        if (storage) {
          try {
            storage.remove();
          } catch {
            /* swallow — in-memory clear still holds */
          }
        }
      } else {
        store.delete(tileId);
        persist();
      }
    },
  };
}
