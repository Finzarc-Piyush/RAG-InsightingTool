/**
 * ============================================================================
 * anthropicSemaphore.ts — cap how many Anthropic calls run at once
 * ============================================================================
 * WHAT THIS FILE DOES
 *   An in-process "counting semaphore": a gate that lets only N outbound
 *   Anthropic API calls run concurrently and queues the rest until a slot frees
 *   up. (A semaphore is a classic concurrency limiter — hold a token while you
 *   run, return it when you finish.) Default ceiling is 6.
 *
 * WHY IT MATTERS
 *   A single dashboard turn can fan out into many parallel LLM calls (planner +
 *   ~14 chart steps + feature sweep + narrator + chart insights). Without a cap
 *   they all POST at once and trip the provider's per-key rate limit. This
 *   smooths instantaneous pressure without literal setTimeout pacing, working
 *   alongside the per-call Retry-After backoff in anthropicProvider.ts and the
 *   per-session mutex on the chart-key-insight endpoint.
 *
 * KEY PIECES
 *   - acquireAnthropicSlot() — await a slot; resolves with an idempotent
 *     release() function.
 *   - withAnthropicSlot(fn) — convenience: acquire, run fn, always release.
 *   - __test__ — snapshot/reset helpers (tests only).
 *
 * HOW IT CONNECTS
 *   Wrapped around callAnthropic POSTs. In-process only; multi-instance scaling
 *   would need a Redis-backed limiter (not planned). Concurrency tunable via
 *   ANTHROPIC_MAX_CONCURRENCY.
 */

const DEFAULT_MAX_CONCURRENCY = 6;

let inFlight = 0;
const waiters: Array<() => void> = [];

function readMaxConcurrency(): number {
  const raw = process.env.ANTHROPIC_MAX_CONCURRENCY;
  if (!raw) return DEFAULT_MAX_CONCURRENCY;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_CONCURRENCY;
}

/**
 * Acquire a slot. Resolves with a release function once the in-flight count is
 * below the configured ceiling. The release function is idempotent.
 */
export async function acquireAnthropicSlot(): Promise<() => void> {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    inFlight -= 1;
    const next = waiters.shift();
    if (next) next();
  };

  if (inFlight < readMaxConcurrency()) {
    inFlight += 1;
    return release;
  }

  return new Promise<() => void>((resolve) => {
    waiters.push(() => {
      inFlight += 1;
      resolve(release);
    });
  });
}

/** Convenience wrapper: acquire, run, always release. */
export async function withAnthropicSlot<T>(fn: () => Promise<T>): Promise<T> {
  const release = await acquireAnthropicSlot();
  try {
    return await fn();
  } finally {
    release();
  }
}

export const __test__ = {
  /** Snapshot for tests; do not call from production code. */
  state(): { inFlight: number; queued: number; max: number } {
    return { inFlight, queued: waiters.length, max: readMaxConcurrency() };
  },
  /** Reset state between tests. Throws if there are still waiters in flight. */
  reset(): void {
    inFlight = 0;
    waiters.length = 0;
  },
};
