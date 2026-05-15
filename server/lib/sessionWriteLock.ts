/**
 * Wave A2 · `withSessionWriteLock` — single per-session promise chain that
 * serialises every read-modify-write of the Cosmos chat document.
 *
 * **Why this exists.** Pre-A2 the codebase had THREE independent
 * `Map<sessionId, Promise<unknown>>` chains, each only serialising its own
 * call site:
 *
 *   - `sessionPersistChain` in `sessionAnalysisContext.ts` — covered
 *     `persistMergeAssistantSessionContext` (turn-end), `persistMidTurnAssistantSessionContext`,
 *     `extractAndPersistUserHierarchies` (chat-flow), `updateSessionDimensionHierarchies`
 *     (EU1 PUT), and `updateSessionSchemaAnnotations` (SU-UX1 PUT).
 *   - `sessionPatchChain` in `patchAssistantBusinessActions.ts` —
 *     covered the post-verifier BAI patch.
 *   - `activeFilterLocks` in `controllers/activeFilterController.ts` —
 *     covered FA1 PUT/DELETE.
 *
 * All three chains called `getChatBySessionIdForUser → mutate doc →
 * updateChatDocument(doc)` against the SAME Cosmos document. They did not
 * coordinate with each other, so a turn whose `businessActionsPromise`
 * outlived the response event opened a race window: turn A's BAI patch
 * could RMW concurrently with turn B's assistant merge, with last-writer-
 * wins on the doc-level upsert. The result was occasional corruption of
 * `messages[]` (BAI patch reads stale messages, target message moves
 * because turn B already appended new ones, BAI patch upserts the stale
 * messages back).
 *
 * The fix is the simplest possible: ONE map per process, every Cosmos-
 * facing RMW on a session goes through it. Because Node is single-
 * threaded, "in-process serialisation" is sufficient correctness for
 * single-instance deployment (see CLAUDE.md "Conventions that bite").
 * Multi-instance deployment would still need Cosmos `ifMatch` ETag —
 * explicitly out of scope and recorded as a future concern.
 *
 * **What this DOESN'T cover.** `materializeLocks` in
 * `ensureSessionDuckdbMaterialized.ts` is a different concern (DuckDB
 * table create/replace, not Cosmos). It stays separate by design — those
 * paths don't read or write the Cosmos doc.
 *
 * **Failure semantics.** A prior caller's failure is its own concern; the
 * next chained call awaits the prior's promise inside its own `try/catch`
 * so failures don't poison the chain. The exception still propagates back
 * to the failed caller.
 */

const sessionWriteChain = new Map<string, Promise<unknown>>();

/**
 * Acquire the per-session write lock and run `fn` once the prior chained
 * write has settled (success or failure). Returns whatever `fn` returns.
 *
 * Usage:
 *
 *   return withSessionWriteLock(sessionId, async () => {
 *     const doc = await getChatBySessionIdForUser(sessionId, username);
 *     if (!doc) return null;
 *     doc.someField = newValue;
 *     await updateChatDocument(doc);
 *     return result;
 *   });
 *
 * The map entry is removed on completion iff the entry is still pointing
 * at this caller's promise — a chained next-caller may have already
 * replaced it, in which case removal is the next caller's responsibility.
 */
export async function withSessionWriteLock<T>(
  sessionId: string,
  fn: () => Promise<T>
): Promise<T> {
  const previous = sessionWriteChain.get(sessionId);
  const work = (async () => {
    if (previous) {
      try {
        await previous;
      } catch {
        // Prior caller's failure is its own concern.
      }
    }
    return fn();
  })();
  sessionWriteChain.set(sessionId, work);
  try {
    return await work;
  } finally {
    if (sessionWriteChain.get(sessionId) === work) {
      sessionWriteChain.delete(sessionId);
    }
  }
}

/**
 * Test-only escape hatch. Lets unit tests assert the chain is empty after
 * an expected sequence completes. Production code must not call this.
 */
export function __sessionWriteChainSizeForTesting(): number {
  return sessionWriteChain.size;
}

/**
 * Test-only escape hatch. Drops every in-flight lock so a test that
 * deliberately stalls a write can move on without leaking state into the
 * next test. Does NOT cancel the underlying promises — those resolve as
 * normal but no longer block downstream callers.
 */
export function __resetSessionWriteChainForTesting(): void {
  sessionWriteChain.clear();
}
