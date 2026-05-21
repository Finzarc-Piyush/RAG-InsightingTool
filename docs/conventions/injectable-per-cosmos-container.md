# Convention: One injectable per Cosmos container

> Introduced in Wave W61-references-dashboards (2026-05-21). See `docs/WAVES.md` for the original context.

## Rule

Each Cosmos container that a controller reads from gets its own `__set*ForTesting` injectable. When two read paths touch the same container, they share the existing injectable. When a new read path touches a different container, it gets a new dedicated injectable rather than overloading an existing one.

## Why

The W61 controllers (`adminSemanticModelController.ts`) originally exposed a single `_detailFetcher` injectable that wrapped `getChatBySessionIdEfficient` (the chat-documents container, partitioned by sessionId). W61-references-endpoint and W61-audit-history-api both re-used `_detailFetcher` because they read the same chat document. W61-references-dashboards is the first wave that needs to read from a DIFFERENT Cosmos container — the `dashboards` container, partitioned by username. Two options were considered:

1. **Overload `_detailFetcher`** to optionally return dashboards alongside the chat doc. Rejected because:
   - The fetcher's signature was `(sessionId) => Promise<ChatDocument | null>` — widening it to also return dashboards would force every existing call site to either consume the new fields or destructure them away.
   - The two fetches have different partition keys (sessionId vs username), different return types, and different failure modes (chat fetch returns `null` on missing; dashboard fetch returns `[]` on missing).
   - The test-fake surface would balloon — every test that stubs `_detailFetcher` would now also be implicitly stubbing the dashboard read path.

2. **Add a dedicated `_dashboardListerForUser` injectable.** Adopted. Mirrors the existing `_lister` / `_detailFetcher` / `_updater` trio's per-responsibility separation. The test-fake surface grows linearly with the number of containers, not the number of read paths.

The general rule that falls out: **the injectable boundary follows the Cosmos container boundary, not the read-path boundary.**

## How to apply

When writing a new handler that needs to read from a Cosmos container:

1. **Check whether the container is already represented by an existing injectable in the controller.** Look for `_*` slots + `__set*ForTesting` shims at the top of the file. The chat-documents container is `_detailFetcher`; the dashboards container is `_dashboardListerForUser`; the LLM-usage container is `_usageReader`; etc.

2. **If the container is already represented, re-use the existing injectable.** Don't add a parallel slot for the same container; that's just a duplicate test-fake surface.

3. **If the container is new to this controller, add a dedicated injectable:**
   - New `type` for the function shape (e.g. `type DashboardListerForUser = (username: string) => Promise<ReadonlyArray<unknown>>`).
   - New `let _slotName: Type = _defaultImplementation` slot.
   - New `__setSlotForTesting(fn: Type | null): void` shim that restores `null → _defaultImplementation`.
   - Default implementation as a `const` closure so the test shim can fall back to it cleanly.

4. **Prefer `ReadonlyArray<unknown>` at the lister boundary** when the consumer applies its own defensive guards (the W61-references-dashboards scanner is defensive against non-object dashboards; the lister doesn't need to eagerly parse).

5. **Short-circuit zero-input cases at the default lister** (e.g. empty username → return `[]` immediately, saves a Cosmos round-trip). Test surface should pin this with a `listerCalled === false` assertion.

## Related

- [Wave W61-references-dashboards entry](../WAVES.md)
- Files:
  - [`server/controllers/adminSemanticModelController.ts`](../../server/controllers/adminSemanticModelController.ts) — `_detailFetcher` (chat docs), `_lister` (admin index), `_updater` (chat doc writes), `_dashboardListerForUser` (dashboards).
  - [`server/models/dashboard.model.ts`](../../server/models/dashboard.model.ts) — `getUserDashboards` (the default backing for `_dashboardListerForUser`).
