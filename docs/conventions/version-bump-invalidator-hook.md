# Convention: Version-bump invalidator hook (semantic model mutations)

> Introduced in Wave W61-cache-invalidate (2026-05-21). See `docs/WAVES.md` for the original context.

## Rule

Every code path that mutates `chatDocument.semanticModel` and bumps `semanticModel.version` MUST call `onSemanticModelVersionBumped({ sessionId, priorVersion, nextVersion })` from [`server/lib/semantic/semanticModelInvalidate.ts`](../../server/lib/semantic/semanticModelInvalidate.ts) inside the `withSessionWriteLock` write-window AFTER the `updateChatDocument` (or equivalent `_updater`) call succeeds — and only on the success path. Error paths (404, 4xx validation, 5xx persist failures) must NOT fire the hook.

## Why

Today the planner's [`buildSemanticCatalogPromptBlock`](../../server/lib/semantic/prompt.ts) is a pure function with no internal cache — every planner round re-reads `chatDocument.semanticModel` from the DB, so the version bump alone is sufficient to serve fresh prompts. That "implicit contract" is silently broken if a new mutation path forgets to bump `version`:

1. A future cache-bearing wave (W64 cache-key, in-process catalog memos) keyed on `(sessionId, semanticModel.version)` would silently serve stale entries against the missing bump.
2. Observability around "when did this session's model last change" is lost — `console.log` lines are scattered across four controllers with no single grep-token.

This convention closes both gaps at once:

- **Contract pin.** Every mutation calls the same hook; tests assert each path fires it exactly once on success and not on any error path. A future contributor adding a fifth mutation path (W61-edit-column, W61-edit-references, W61-hierarchy-edit, …) gets a tests failure if they forget the hook — the W61-cache-invalidate integration test file's "every mutation path" coverage is the canary.
- **Observability surface.** A single grep-able log token (`[semantic-model-invalidate] sessionId=… priorVersion=… nextVersion=…`) correlates every model-version change across the four controllers. Ops can grep for the prefix and see every model edit on a session without correlating against handler stack traces.
- **Registry for future cache invalidators.** `registerInvalidator(fn)` returns an unsubscribe fn so future code can wire a real cache.clear() callback into the same hook fire-window — no need to chase down every controller again. The registry semantics are: listeners fire in registration order; a listener that throws is logged and skipped (subsequent listeners still fire; the caller sees normal return). This keeps the write path resilient against a buggy cache invalidator.

## How to apply

When writing a new handler that bumps `semanticModel.version`:

1. **Capture `priorVersion` + `nextVersion` near the version-bump.** The pattern across the four W61 mutation paths is `const nextVersion = (doc.semanticModel.version ?? 0) + 1;` — `priorVersion` is just `nextVersion - 1`. There's no need to introduce a separate local; passing `priorVersion: nextVersion - 1` to the hook is the canonical form.

2. **Call the hook AFTER `_updater(doc)` resolves successfully**, still inside the `withSessionWriteLock` callback. Position the call between the persist and the `return { kind: "ok", ... }` line:

   ```ts
   doc.semanticModel = nextModel;
   doc.lastUpdatedAt = savedAt;
   const saved = await _updater(doc);
   onSemanticModelVersionBumped({
     sessionId,
     priorVersion: nextVersion - 1,
     nextVersion,
   });
   return { kind: "ok", model: saved.semanticModel ?? nextModel, ... };
   ```

   This ordering matters: if `_updater` throws (Cosmos outage, document-too-large, optimistic-concurrency conflict), the catch block emits the 5xx response and the hook MUST NOT have fired — otherwise a downstream cache invalidates against a write that never landed.

3. **Inside the lock, not outside.** Future invalidators (W64 in-process cache.clear() callbacks) will rely on serialization with the write they invalidate against. Firing the hook outside the lock would open a read/clear race window between the write completing and the invalidator running. Listeners are fire-and-forget; the hook signature is `(event) => void` not `(event) => Promise<void>`, so long-running invalidators are not supported by design (keep them cheap — log + counter + sync cache.clear() is the budget).

4. **Add a controller integration test** in `tests/adminSemanticModelInvalidateW61CacheInvalidate.test.ts` (or a sibling file if the new handler lives in a different controller). The test pattern is `registerInvalidator((e) => events.push(e))` + drive the handler + assert `events.length === 1` on success and `=== 0` on every error path including the 5xx-on-persist-throw case.

5. **Wave entry must mention the hook call.** The wave's `What landed` section should explicitly note the hook call site; the wave's `Tests` section should mention the integration test coverage. This is a load-bearing affordance that reviewers (and future-Claude) need to verify the contract is preserved.

## Related

- [Wave W61-cache-invalidate entry](../WAVES.md)
- [Convention: One injectable per Cosmos container](injectable-per-cosmos-container.md)
- Files:
  - [`server/lib/semantic/semanticModelInvalidate.ts`](../../server/lib/semantic/semanticModelInvalidate.ts) — the hook module + invalidator registry.
  - [`server/controllers/adminSemanticModelController.ts`](../../server/controllers/adminSemanticModelController.ts) — the four call sites (`patchSemanticModel`, `revertSemanticModel`, `deleteSemanticModelEntry`, `addSemanticModelEntry`).
  - [`server/tests/semanticModelInvalidateW61CacheInvalidate.test.ts`](../../server/tests/semanticModelInvalidateW61CacheInvalidate.test.ts) — module-level contract tests.
  - [`server/tests/adminSemanticModelInvalidateW61CacheInvalidate.test.ts`](../../server/tests/adminSemanticModelInvalidateW61CacheInvalidate.test.ts) — controller-level "every mutation path fires the hook" tests.
