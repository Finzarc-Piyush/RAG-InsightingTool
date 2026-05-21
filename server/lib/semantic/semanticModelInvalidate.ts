/**
 * Wave W61-cache-invalidate · Observability + contract pin for every
 * semantic-model version bump.
 *
 * Today the planner's [`buildSemanticCatalogPromptBlock`](./prompt.ts)
 * is a pure function; the only thing that "invalidates" on a model
 * mutation is the next planner round re-reading
 * `chatDocument.semanticModel` from the DB. The contract is implicit:
 * every entry-level mutation (W61-save / W61-audit-revert /
 * W61-delete-server / W61-add-server, and future W61-edit-*) bumps
 * `semanticModel.version` monotonically and the next read sees the new
 * version.
 *
 * That implicit contract is silently broken if a new mutation path
 * forgets to bump version. This module makes the contract explicit:
 *
 *   1. Every model-mutating controller path MUST call
 *      `onSemanticModelVersionBumped({ sessionId, priorVersion,
 *      nextVersion })` inside its `withSessionWriteLock` AFTER the
 *      `updateChatDocument` write succeeds. Tests pin this (a missing
 *      call surfaces as the per-mutation hook-fire count not
 *      incrementing).
 *
 *   2. Each fire emits a single grep-able log token
 *      (`[semantic-model-invalidate] sessionId=… priorVersion=…
 *      nextVersion=…`) so ops can correlate model-versioning activity
 *      against downstream planner-round metrics without correlating
 *      against arbitrary controller stack traces.
 *
 *   3. Future cache-bearing code (W64 cache-key wave hint, or an
 *      in-process catalog memo) registers a callback via
 *      `registerInvalidator()`. The hook fires registered callbacks in
 *      order; an invalidator that throws is logged and skipped so a
 *      buggy listener cannot break the write path.
 *
 * The hook is intentionally fire-and-forget: synchronous, no return
 * value, swallows listener errors. The controller path is already
 * inside the per-session write lock at the call site — listeners run
 * inside that lock window so a future cache.clear() invalidator is
 * serialized with the write it's invalidating against (no read/clear
 * race window between the write completing and the invalidator
 * firing).
 */

export interface SemanticModelInvalidationEvent {
  readonly sessionId: string;
  readonly priorVersion: number;
  readonly nextVersion: number;
}

export type SemanticModelInvalidator = (
  event: SemanticModelInvalidationEvent,
) => void;

const invalidators: SemanticModelInvalidator[] = [];
let invalidationCount = 0;

export function onSemanticModelVersionBumped(
  event: SemanticModelInvalidationEvent,
): void {
  invalidationCount += 1;
  console.log(
    `[semantic-model-invalidate] sessionId=${event.sessionId} priorVersion=${event.priorVersion} nextVersion=${event.nextVersion}`,
  );
  for (const fn of invalidators) {
    try {
      fn(event);
    } catch (err) {
      console.error(
        `[semantic-model-invalidate] invalidator threw — ignoring`,
        err,
      );
    }
  }
}

export function registerInvalidator(
  fn: SemanticModelInvalidator,
): () => void {
  invalidators.push(fn);
  return () => {
    const idx = invalidators.indexOf(fn);
    if (idx >= 0) invalidators.splice(idx, 1);
  };
}

export function __getInvalidationCountForTesting(): number {
  return invalidationCount;
}

export function __resetInvalidationCountForTesting(): void {
  invalidationCount = 0;
}

export function __getRegisteredInvalidatorCountForTesting(): number {
  return invalidators.length;
}

export function __clearInvalidatorsForTesting(): void {
  invalidators.length = 0;
}
