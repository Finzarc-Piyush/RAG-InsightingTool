/**
 * RL2 · in-process counting semaphore for outbound Anthropic /v1/messages
 * calls. Backstops the case where a dashboard turn fans out the planner +
 * 14 build_chart steps + feature sweep + narrator + chart-key-insights, all
 * issuing parallel `callAnthropic` POSTs and overwhelming the per-key rate
 * limit.
 *
 * Combined with the per-call Retry-After backoff in `anthropicProvider.ts`
 * (RL1) and the per-session mutex around the chart-key-insight endpoint, this
 * caps instantaneous outbound pressure without literal `setTimeout` pacing.
 *
 * In-process only (boring-first per CLAUDE.md). Multi-instance scaling would
 * need a Redis-backed limiter; not on the roadmap.
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
