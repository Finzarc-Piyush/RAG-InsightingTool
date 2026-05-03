/**
 * RL3-followup · per-suffix concurrency limiter for client-side POSTs that
 * burst-fire from multiple chart bubbles simultaneously.
 *
 * Why this is needed even with the per-session mutex on the server:
 * - The server mutex serialises *execution* (downstream LLM cost). It does
 *   not reduce request *arrival* count, so the express-rate-limit middleware
 *   still counts every parallel arrival.
 * - Without this limiter, 14 chart bubbles render → 14 debounced effects fire
 *   ~simultaneously → 14 POSTs hit the rate limiter within the same window.
 * - With this limiter, requests queue at the client; only N=3 are inflight at
 *   any moment. The total wall time is unchanged (each POST still completes
 *   in turn) but the rate-limit window is no longer blown.
 */

const DEFAULT_CONCURRENCY = 3;

interface PerSuffixLimiterState {
  inflight: number;
  waiters: Array<() => void>;
  max: number;
}

const limiters = new Map<string, PerSuffixLimiterState>();

function getOrCreate(suffix: string, concurrency: number): PerSuffixLimiterState {
  let s = limiters.get(suffix);
  if (!s) {
    s = { inflight: 0, waiters: [], max: concurrency };
    limiters.set(suffix, s);
  }
  return s;
}

export async function withInflightLimit<T>(
  suffix: string,
  fn: () => Promise<T>,
  concurrency: number = DEFAULT_CONCURRENCY
): Promise<T> {
  const state = getOrCreate(suffix, concurrency);
  if (state.inflight >= state.max) {
    await new Promise<void>((resolve) => state.waiters.push(resolve));
  }
  state.inflight += 1;
  try {
    return await fn();
  } finally {
    state.inflight -= 1;
    const next = state.waiters.shift();
    if (next) next();
  }
}

export const __test__ = {
  reset(): void {
    limiters.clear();
  },
  state(suffix: string): { inflight: number; queued: number; max: number } | undefined {
    const s = limiters.get(suffix);
    if (!s) return undefined;
    return { inflight: s.inflight, queued: s.waiters.length, max: s.max };
  },
};
