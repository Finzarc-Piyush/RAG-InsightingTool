/**
 * Wave AD5 · in-process LRU+TTL cache for metrics aggregator queries.
 *
 * Marico-tenant scale doesn't justify a Redis tier; per-request caching
 * across the 60s window is enough to absorb a hot-reload / refresh storm
 * on the admin dashboard while keeping every series live within a minute.
 *
 * Single-instance correctness only — multi-region deploys would need
 * external cache. Documented as a "boring first" choice in the plan.
 */

const TTL_MS = 60 * 1000;
const MAX_ENTRIES = 200;

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();

export function metricsCacheGet<T>(key: string): T | undefined {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.value as T;
}

export function metricsCacheSet<T>(key: string, value: T): void {
  if (store.size >= MAX_ENTRIES) {
    // FIFO eviction — Map preserves insertion order so the first key is the oldest.
    const oldest = store.keys().next().value;
    if (oldest != null) store.delete(oldest);
  }
  store.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

/** Test helper · clear the cache between cases. */
export function __resetMetricsCacheForTesting(): void {
  store.clear();
}

/**
 * Wrap an async function with cache-aside semantics. If the key is hot,
 * returns the cached value; otherwise invokes the loader and caches the
 * result. Errors are NOT cached — the loader is retried on next call.
 */
export async function withMetricsCache<T>(
  key: string,
  loader: () => Promise<T>
): Promise<T> {
  const hit = metricsCacheGet<T>(key);
  if (hit !== undefined) return hit;
  const value = await loader();
  metricsCacheSet(key, value);
  return value;
}
