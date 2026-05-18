/**
 * Wave WI2-wire · React hook that closes the WI2 trilogy.
 *
 *   - WI2-cache (`insightRegenCache.ts`) provides the per-tile LRU+TTL
 *     cache keyed by `(tileId, hashGlobalFilters(filters))`.
 *   - WI2-server (`POST /api/insight/regen`) populates the cache on
 *     miss. The response shape matches `InsightRegenEntry` verbatim
 *     so the merge is `cache.set(key, response)` with no transformation.
 *   - WI2-wire (this hook + the TileInsightFooter button) gives the
 *     consuming component a stable interface to read / regenerate
 *     per-tile insights as global filters change.
 *
 * The hook deliberately takes the dynamic regen context (spec /
 * filteredData / domainContext / datasetContextHint) at CALL time on
 * `regenerate(...)` rather than at hook-instantiation time. Reason:
 * the dynamic context changes with every filter change and every
 * spec edit; threading it through `useEffect` deps would either
 * (a) over-fire the network on every render, or (b) require fragile
 * deep-equality memoisation in the caller. Caller passes what it
 * has when it has it; the hook keys the cache off the stable
 * (tileId, filterHash) pair.
 *
 * No automatic prefetch on filter change — clicking the "✦ Re-explain
 * this view" button is the only trigger. The cache itself answers
 * `cache.get(key)` synchronously so the previously regenerated entry
 * shows up immediately when the user re-toggles between filter combos
 * they've already explored.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type { ActiveChartFilters } from "../../../lib/chartFilters";
import {
  buildCacheKey,
  createInsightRegenCache,
  hashGlobalFilters,
  type InsightRegenCache,
  type InsightRegenEntry,
} from "../lib/insightRegenCache";

/** Mirror of the server's `insightChartSpecLiteSchema` shape. */
export interface InsightChartSpecLite {
  type: string;
  title?: string;
  x: string;
  y: string;
  seriesColumn?: string;
  aggregate?: string;
}

/** Row shape the server endpoint accepts (string / number / boolean / null cell values). */
export type InsightRegenRow = Record<string, string | number | boolean | null>;

export interface InsightRegenArgs {
  tileId: string;
  filters: ActiveChartFilters;
  /**
   * Optional shared cache. When omitted the hook builds a per-instance
   * cache via `useMemo` — fine for one tile / one DashboardView, but
   * a shared cache scoped to the DashboardView mount lets the user's
   * "explore A, explore B, go back to A" pattern hit warm cache.
   */
  cache?: InsightRegenCache;
}

export interface InsightRegenState {
  /** Cached entry for the current (tileId, filterHash) — synchronous. */
  entry: InsightRegenEntry | undefined;
  /** True while a regenerate() call is in-flight. */
  loading: boolean;
  /** Last error message, or null. Cleared at the start of every regenerate(). */
  error: string | null;
  /**
   * Trigger a regeneration. Reads from cache first; on miss POSTs to
   * `/api/insight/regen` with the supplied dynamic context. The
   * response is merged into the cache so future cache.get() returns
   * it. Returns the entry (cached or fresh) on success.
   */
  regenerate: (
    spec: InsightChartSpecLite,
    filteredData: InsightRegenRow[],
    options?: {
      domainContext?: string;
      datasetContextHint?: string;
      /** Force network call even if a cache hit exists. Default false. */
      bypassCache?: boolean;
    },
  ) => Promise<InsightRegenEntry | null>;
  /** Cache key currently in scope — exposed for telemetry / tests. */
  cacheKey: string;
}

export function useInsightRegen(args: InsightRegenArgs): InsightRegenState {
  const { tileId, filters } = args;
  // Per-hook-instance cache when no shared cache is injected. The
  // `useMemo([])` guarantees one cache per mount; remounts (which
  // shouldn't happen during normal use) get a fresh cache.
  const fallbackCache = useMemo(() => createInsightRegenCache(), []);
  const cache = args.cache ?? fallbackCache;

  // Filter hash recomputes on filter identity change; the cache key
  // composes it with tileId.
  const cacheKey = useMemo(
    () => buildCacheKey(tileId, hashGlobalFilters(filters)),
    [tileId, filters],
  );

  // Reading the entry synchronously on every render is intentional —
  // a re-toggle between explored filter combos paints the cached
  // entry instantly without spinning the network.
  const entry = cache.get(cacheKey);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guard against stale resolves clobbering newer state — every
  // regenerate() bumps the sequence; only the latest resolution
  // commits its loading=false / error.
  const seqRef = useRef(0);

  const regenerate = useCallback<InsightRegenState["regenerate"]>(
    async (spec, filteredData, options) => {
      const bypass = options?.bypassCache ?? false;
      if (!bypass) {
        const cached = cache.get(cacheKey);
        if (cached) return cached;
      }
      const seq = ++seqRef.current;
      setLoading(true);
      setError(null);
      try {
        const body = {
          tileId,
          spec,
          filteredData,
          ...(options?.domainContext ? { domainContext: options.domainContext } : {}),
          ...(options?.datasetContextHint
            ? { datasetContextHint: options.datasetContextHint }
            : {}),
        };
        const res = await fetch("/api/insight/regen", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const reason = await safeReadError(res);
          if (seq === seqRef.current) {
            setError(reason);
            setLoading(false);
          }
          return null;
        }
        const parsed = (await res.json()) as InsightRegenEntry;
        // Response shape matches InsightRegenEntry verbatim — merge
        // straight into the cache with no transformation.
        cache.set(cacheKey, parsed);
        if (seq === seqRef.current) {
          setLoading(false);
        }
        return parsed;
      } catch (err) {
        if (seq === seqRef.current) {
          setError(err instanceof Error ? err.message : "Regen failed");
          setLoading(false);
        }
        return null;
      }
    },
    [cache, cacheKey, tileId],
  );

  return { entry, loading, error, regenerate, cacheKey };
}

async function safeReadError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === "string") return body.error;
  } catch {
    // not JSON — fall through to status text
  }
  return `Regen failed (${res.status})`;
}
