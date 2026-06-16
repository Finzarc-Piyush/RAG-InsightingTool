/**
 * PERF-10 · Per-turn shared DuckDB handle.
 *
 * Before this module, every analytical tool that hit DuckDB did its own
 * `new ColumnarStorageService({ sessionId }) → initialize() → …queries… →
 * close()` round-trip. Within a single turn the agent can run several such
 * tools back to back (e.g. `run_analytical_query` → `compute_growth` →
 * `detect_seasonality`), each re-opening and re-closing the SAME on-disk
 * `<sessionId>.duckdb` file for the SAME session. That open/close churn is pure
 * overhead — the file, the materialized `data` table and the `data_filtered`
 * view all persist on disk across handles, so nothing about a fresh handle is
 * required for correctness.
 *
 * This helper memoises ONE initialized `ColumnarStorageService` per
 * `AgentExecutionContext` (i.e. per turn) keyed by `ctx.sessionId`. The first
 * read tool that asks for a handle constructs + `initialize()`s it; every later
 * tool in the same turn reuses it. The agent loop closes it exactly once at
 * turn end via `closeTurnColumnarStorage`.
 *
 * Scope / safety:
 *   • Per-turn AND per-session. The cache lives on the turn's ctx object, never
 *     a process-global map, so two concurrent turns (different ctx) never share
 *     a handle. Mismatched sessionId (should never happen — a turn is bound to
 *     one session) bypasses the cache and returns a throwaway handle the caller
 *     owns, preserving isolation.
 *   • Read-only adopters only. The `add_computed_columns` materialize path keeps
 *     its own short-lived handle (it mutates `data` via DROP/RENAME DDL and runs
 *     rarely) so we don't entangle a mutation's lifecycle with the shared read
 *     handle.
 *   • DuckDB allows many `conn = db.connect()` from one `Database`, which is
 *     exactly how `ColumnarStorageService` already issues each query, so reuse
 *     does not change query results or concurrency semantics.
 */
import {
  ColumnarStorageService,
  type ColumnarStorageOptions,
} from "../../columnarStorage.js";
import type { AgentExecutionContext } from "./types.js";

/** Internal cache shape stashed on the ctx. */
interface TurnColumnarStorageCache {
  sessionId: string;
  /** Memoised initialize() promise — awaited by every adopter. */
  ready: Promise<ColumnarStorageService>;
}

/**
 * The slice of `AgentExecutionContext` these helpers touch. Narrowing the
 * parameter (rather than taking the whole context) keeps the seam testable with
 * a tiny object and documents that nothing else on the turn is read or written.
 */
export type TurnColumnarStorageCtx = Pick<
  AgentExecutionContext,
  "sessionId" | "_turnColumnarStorage"
>;

/**
 * Returns a per-turn shared, already-`initialize()`d `ColumnarStorageService`
 * for `ctx.sessionId`. Constructs + initializes once; subsequent calls in the
 * same turn await the same instance. Callers MUST NOT call `.close()` on the
 * returned handle — the turn owner closes it via `closeTurnColumnarStorage`.
 *
 * If the requested `sessionId` (rare/defensive) does not match the turn's
 * session, returns a fresh throwaway handle the caller is responsible for
 * closing — isolation over reuse.
 */
export async function getTurnColumnarStorage(
  ctx: TurnColumnarStorageCtx,
  options?: Pick<ColumnarStorageOptions, "tempDir">
): Promise<{ storage: ColumnarStorageService; shared: boolean }> {
  const sessionId = ctx.sessionId;

  // Defensive: a custom tempDir or a session mismatch means "don't share".
  if (options?.tempDir) {
    const storage = new ColumnarStorageService({ sessionId, tempDir: options.tempDir });
    await storage.initialize();
    return { storage, shared: false };
  }

  const cache = ctx._turnColumnarStorage;
  if (cache && cache.sessionId === sessionId) {
    return { storage: await cache.ready, shared: true };
  }

  // First adopter this turn (or session changed — shouldn't happen): build +
  // initialize once, cache the in-flight promise so concurrent adopters share it.
  const ready = (async () => {
    const storage = new ColumnarStorageService({ sessionId });
    await storage.initialize();
    return storage;
  })();
  ctx._turnColumnarStorage = { sessionId, ready };
  return { storage: await ready, shared: true };
}

/**
 * Closes the per-turn shared handle if one was opened. Idempotent — safe to call
 * even when no tool ever asked for a handle. Called by the agent loop at turn
 * end (success, abort, or error). Best-effort: a close failure is swallowed so
 * it never masks the turn's real result.
 */
export async function closeTurnColumnarStorage(
  ctx: TurnColumnarStorageCtx
): Promise<void> {
  const cache = ctx._turnColumnarStorage;
  if (!cache) return;
  ctx._turnColumnarStorage = undefined;
  try {
    const storage = await cache.ready;
    await storage.close();
  } catch {
    /* best-effort: never let handle teardown break the turn */
  }
}

export type { TurnColumnarStorageCache };
