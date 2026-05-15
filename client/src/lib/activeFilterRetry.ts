/**
 * Wave E4 · `withActiveFilterRetry` — graceful retry wrapper for any
 * client fetch that depends on the session's active filter version.
 *
 * Scenario this exists for: with multi-tab open (Wave E1–E3), Tab B can
 * issue a pivot / chart / drillthrough query AFTER Tab A applied a new
 * active filter but BEFORE the `active_filter` broadcast event lands
 * in Tab B (broadcast is async, the query was already in flight or
 * fired in the same microtask). If the server starts returning a
 * structured 400 with `code: "active_filter_version_mismatch"` (a
 * future server-side feature when conflict detection is needed — today
 * the server uses the current filter; nothing rejects on version), the
 * client can call this wrapper to:
 *   1. Detect the mismatch from the error.
 *   2. Refetch the active filter to sync this tab.
 *   3. Retry the original query ONCE.
 *   4. Surface a toast so the user knows the data was refreshed mid-action.
 *
 * The helper is opt-in — call sites wrap their fetch closure in it.
 * Today nothing wires this; the helper exists so the pattern is ready
 * the moment the server contract lands. Unit tests pin the retry
 * behaviour independent of the server change.
 */

import { sessionsApi, type ActiveFilterResponse } from "./api/sessions";

export interface WithActiveFilterRetryDeps {
  /** Called after a successful refetch so the host can update its state. */
  onFilterRefetched?: (filter: ActiveFilterResponse) => void;
  /** Called when a retry was triggered (host can toast the user). */
  onRetryTriggered?: () => void;
}

/**
 * Recognises errors that indicate the server saw a stale filter version.
 * The shape supported today:
 *   - Error.message contains "active_filter_version_mismatch"
 *   - Or `(err as any).code === "active_filter_version_mismatch"`
 *   - Or `(err as any).statusCode === 409` with a body matching the code
 *
 * Conservative on purpose — we'd rather miss a retry than burn one on
 * an unrelated 400. The contract is internal: when the server emits the
 * mismatch code, it MUST use the literal string above (no localisation,
 * no rewording).
 */
export function isStaleActiveFilterError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && code === "active_filter_version_mismatch") {
    return true;
  }
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "";
  if (message.includes("active_filter_version_mismatch")) {
    return true;
  }
  return false;
}

/**
 * Wrap `fn` so a stale-filter error refetches the active filter, then
 * retries `fn` exactly once. Returns the eventual result, or rethrows
 * the original error if the retry also fails (or if the original error
 * wasn't a stale-filter error).
 */
export async function withActiveFilterRetry<T>(
  sessionId: string,
  fn: () => Promise<T>,
  deps: WithActiveFilterRetryDeps = {}
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isStaleActiveFilterError(err)) {
      throw err;
    }
    // Refetch the current filter so the host's lifted state is fresh.
    // Best-effort — if THIS call fails we still rethrow the original.
    try {
      const out = (await sessionsApi.getActiveFilter(
        sessionId
      )) as ActiveFilterResponse;
      deps.onFilterRefetched?.(out);
    } catch {
      throw err;
    }
    deps.onRetryTriggered?.();
    // Retry exactly once. Any error on the second pass propagates.
    return await fn();
  }
}
