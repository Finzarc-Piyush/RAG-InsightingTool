/**
 * Per-dashboard in-process serialization mutex.
 *
 * Concurrent patches against the SAME dashboard chain through a Promise so the
 * read-modify-write of the persisted document is serialised. Single-instance
 * correctness only — multi-instance scaling needs Cosmos `ifMatch` ETag (parity
 * with the W40 `persistMergeAssistantSessionContext` caveat).
 *
 * Extracted verbatim from the identical inline mutex in
 * `patchDashboardBusinessActions.ts` (DPF2) and `patchDashboardChartInsights.ts`.
 * The reference-identity cleanup in `finally` is load-bearing: only the caller
 * whose `work` is still the chain head clears the entry, so a later caller that
 * overwrote the head is never deleted out from under.
 *
 * KEYSPACE: callers pass a fully-qualified key, NOT a bare dashboardId. The two
 * original patchers each owned a SEPARATE `Map`, so a businessActions patch and a
 * chartInsights patch for the same dashboard ran INDEPENDENTLY (never serialised
 * against each other). To preserve that exact semantic with one shared map, each
 * call site namespaces its key (e.g. `businessActions:<id>`, `chartInsights:<id>`).
 */

const dashboardPatchChain = new Map<string, Promise<unknown>>();

export async function serializePerDashboard<T>(
  dashboardId: string,
  work: () => Promise<T>
): Promise<T> {
  const previous = dashboardPatchChain.get(dashboardId);
  const task = (async () => {
    if (previous) {
      try {
        await previous;
      } catch {
        // Prior caller's failure is its own concern.
      }
    }
    return work();
  })();
  dashboardPatchChain.set(dashboardId, task);
  try {
    return await task;
  } finally {
    if (dashboardPatchChain.get(dashboardId) === task) {
      dashboardPatchChain.delete(dashboardId);
    }
  }
}
