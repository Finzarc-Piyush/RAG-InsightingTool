/**
 * Wave WI2-cache · per-tile insight regeneration cache.
 *
 * The WI1 `InsightSpec` schema declared `generator.kind: "llm"` as
 * the dynamic-regeneration hook for chart tiles whose insight prose
 * should refresh on filter change (master plan Workstream 7). The
 * intended UX: when the user adds a global filter or brushes via
 * WD2, each tile's insight footer offers a "✦ Re-explain this view"
 * action; clicking issues a MINI-tier LLM call with the current
 * filtered data + chart spec + domain context and replaces the
 * insight prose. Re-asking the same (tile, filter combo) within a
 * session should return instantly without burning a fresh LLM call.
 *
 * This module provides the pure data-plumbing layer:
 *
 *   1. `hashGlobalFilters(filters)` — byte-stable hash of an
 *      `ActiveChartFilters` map. Keys + categorical values + numeric
 *      bounds + date strings all sorted; the result is a short
 *      deterministic string suitable as a cache key segment.
 *
 *   2. `buildCacheKey(tileId, filterHash, regionHash?)` — composes
 *      the segments into a final cache key. Stable across re-renders
 *      for the same (tile, filter state, brush region). The third
 *      segment is omitted for non-brush call sites so WI2 footer keys
 *      stay byte-identical (Wave WI4-cache-key).
 *
 *   2b. `hashBrushRegion(region)` — byte-stable hash of a WI4
 *      `BrushRegion`, mirroring the contract of `hashGlobalFilters`.
 *      Returns `""` when no region is supplied.
 *
 *   3. `createInsightRegenCache(opts?)` — LRU + TTL cache factory.
 *      `get` returns `undefined` for stale entries; `set` evicts
 *      the least-recently-used entry when full. Pure in the sense
 *      that the cache instance owns its own state — calling code
 *      creates one per `DashboardView` mount via `useMemo`.
 *
 * No React imports. The cache instance is allocated by the consuming
 * hook (WI2-wire ships the hook); this module is testable under
 * `node --import tsx --test` with no DOM.
 */

import type { ActiveChartFilters } from "../../../lib/chartFilters";
import type { BrushRegion } from "./explainSlice";

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 min — matches Anthropic's prompt-cache TTL

/** What the cache stores per (tileId, filterHash) — opaque to this module. */
export interface InsightRegenEntry {
  /** Generated insight prose (what the InsightSpec.default slot becomes after regen). */
  text: string;
  /** Optional citations (domain pack ids) for the regenerated prose. */
  citations?: string[];
  /** ISO timestamp of when the regen completed; rendered as "Updated N min ago". */
  regeneratedAt?: string;
  /** Confidence tier the WQ1 floor assigned to the supporting evidence. */
  confidenceTier?: "low" | "medium" | "high";
}

export interface InsightRegenCacheOptions {
  /** Max entries before LRU eviction. Default 64. */
  maxEntries?: number;
  /** Time-to-live in ms; entries older than this return `undefined` from `get`. Default 5 min. */
  ttlMs?: number;
  /** Override `Date.now`; injected for deterministic tests. */
  now?: () => number;
}

export interface InsightRegenCache {
  get(key: string): InsightRegenEntry | undefined;
  set(key: string, value: InsightRegenEntry): void;
  has(key: string): boolean;
  clear(): void;
  size(): number;
  /** Drop expired entries; returns the number evicted. */
  evictExpired(): number;
}

interface InternalEntry {
  value: InsightRegenEntry;
  storedAt: number;
}

/**
 * Byte-stable hash of an `ActiveChartFilters` map. Sorts column
 * keys; sorts categorical values; serialises numeric + date filters
 * with a fixed key order. Returns a short JSON-style string suitable
 * for use as a cache key segment.
 *
 * Pure. Identical maps in different key/value orders yield identical
 * hashes (regression-pinned in tests).
 */
export function hashGlobalFilters(filters: ActiveChartFilters): string {
  const parts: string[] = [];
  for (const column of Object.keys(filters).sort()) {
    const sel = filters[column];
    if (!sel) continue;
    if (sel.type === "categorical") {
      const values = [...sel.values].sort().join("|");
      parts.push(`${column}=c:${values}`);
    } else if (sel.type === "date") {
      const start = sel.start ?? "";
      const end = sel.end ?? "";
      parts.push(`${column}=d:${start}..${end}`);
    } else if (sel.type === "numeric") {
      const min = sel.min ?? "";
      const max = sel.max ?? "";
      parts.push(`${column}=n:${min}..${max}`);
    }
  }
  return parts.join(";");
}

/**
 * Wave WI4-cache-key · byte-stable hash of a `BrushRegion` for use
 * as the third cache-key segment. Returns `""` when no region is
 * supplied so non-brush regen call sites (the WI2 per-tile footer)
 * keep their existing two-segment keys byte-identical.
 *
 * Three region kinds get three fixed serialisations:
 *  - `numeric`     → `n:<start>..<end>`
 *  - `temporal`    → `t:<startMs>..<endMs>`
 *  - `categorical` → `c:<v1>|<v2>|…`
 *
 * Categorical value order is preserved (not sorted) because the
 * brushed band-scale slot order is itself a signal — a brush over
 * `[Mar, Apr]` and one over `[Apr, Mar]` would imply different
 * sub-domain orderings, and the canonical x-axis order is fixed
 * upstream by `distinctOrdered(data, enc.x.accessor)` so identical
 * brushes always yield identical value arrays.
 *
 * Pure. Identical regions yield identical hashes (regression-pinned
 * in tests). Mirrors the byte-stability contract of `hashGlobalFilters`.
 */
export function hashBrushRegion(region: BrushRegion | undefined): string {
  if (!region) return "";
  switch (region.kind) {
    case "numeric":
      return `n:${region.start}..${region.end}`;
    case "temporal":
      return `t:${region.startMs}..${region.endMs}`;
    case "categorical":
      return `c:${region.values.join("|")}`;
  }
}

/**
 * Compose `(tileId, filterHash, regionHash?)` into the final cache
 * key. The delimiter `::` is unambiguous because the hash helpers
 * (`hashGlobalFilters`, `hashBrushRegion`) use `=` / `;` / `:` /
 * `..` / `|` as their internal separators.
 *
 * Backwards-compat: when `regionHash` is undefined or empty, the
 * third segment is omitted entirely so non-brush call sites keep
 * their existing two-segment keys byte-identical (the WI2 footer
 * built a long history of cached entries against the two-arg shape
 * and we don't want to invalidate them on this widening).
 */
export function buildCacheKey(
  tileId: string,
  filterHash: string,
  regionHash?: string,
): string {
  if (!regionHash) return `${tileId}::${filterHash}`;
  return `${tileId}::${filterHash}::${regionHash}`;
}

/**
 * Factory: build a fresh insight regen cache with LRU eviction +
 * TTL semantics. Callers should hold one instance per
 * `DashboardView` mount (via `useMemo(() => createInsightRegenCache(), [])`)
 * so the cache lives for the dashboard session and dies with it.
 *
 * Iteration order of the underlying `Map` is insertion order; the
 * cache reinserts on `get` to refresh LRU recency, and pops
 * `keys().next().value` for eviction.
 */
export function createInsightRegenCache(
  opts: InsightRegenCacheOptions = {},
): InsightRegenCache {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  const store = new Map<string, InternalEntry>();

  function isExpired(entry: InternalEntry): boolean {
    return now() - entry.storedAt > ttlMs;
  }

  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (isExpired(entry)) {
        store.delete(key);
        return undefined;
      }
      // Refresh LRU recency by re-inserting at the tail.
      store.delete(key);
      store.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      if (store.has(key)) {
        store.delete(key);
      } else if (store.size >= maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest !== undefined) store.delete(oldest);
      }
      store.set(key, { value, storedAt: now() });
    },
    has(key) {
      const entry = store.get(key);
      if (!entry) return false;
      if (isExpired(entry)) {
        store.delete(key);
        return false;
      }
      return true;
    },
    clear() {
      store.clear();
    },
    size() {
      return store.size;
    },
    evictExpired() {
      let evicted = 0;
      for (const [k, entry] of store) {
        if (isExpired(entry)) {
          store.delete(k);
          evicted += 1;
        }
      }
      return evicted;
    },
  };
}
