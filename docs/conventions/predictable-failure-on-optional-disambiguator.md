# Convention: Predictable-failure on optional disambiguator

> Introduced as a soft pattern in Wave WD3-server-sheetId-resolution (2026-05-21), promoted to a codified convention in Wave WI4-client-sheetId-resolution (2026-05-22) on the second instance. See `docs/WAVES.md` for the original contexts.

## Rule

When an endpoint, resolver, or pure-fn accepts an **optional** disambiguating field (`sheetId?`, `versionId?`, `tenantId?`, `branchId?`, …), the handling is bimodal:

- **`undefined` (caller did not request scoping)** → fall through to the legacy unscoped path. Backwards-compat for callers that pre-date the disambiguator.
- **Provided but doesn't match any known entity** → return null / 404 / `not_found` error. **Do NOT** silently fall back to the unscoped path.

The fallback is reserved *strictly* for the explicit `undefined` case (the "no scoping requested" signal). Any provided-but-invalid identifier is treated as a hard miss.

## Why

A disambiguating identifier that doesn't match anything in the system represents a **real bug somewhere upstream** — a stale share-link from a deleted entity, a hand-crafted URL with a typo, a client that's still sending a value the server has since pruned, a race between two clients where one's writing the key the other's reading. Silent fallback to the unscoped path obscures the bug:

- The user / caller doesn't see a clear "this thing doesn't exist anymore" — they see an unrelated entity's data and don't realise anything is wrong.
- The error class never surfaces in telemetry, so we don't know how often this is happening or how to fix the upstream cause.
- The fix moves further and further away from the bug as the silent-fallback codepath accretes downstream consumers that don't know they're operating on the wrong entity.

A clear null / 404 surfaces the failure at the boundary where it happens. The caller gets a predictable error, can decide what to do (retry? show "not found"? re-resolve?), and the telemetry/log pipeline catches the frequency.

Alternatives considered and rejected:

- **Silent fallback to the unscoped path** — the "be helpful" intent is appealing but bites every time the disambiguator becomes load-bearing for correctness (e.g. resolving the wrong chart, fetching the wrong tenant's data, applying the wrong version).
- **Fall back AND log a warning** — only useful if someone watches the warning logs; the silent-fallback failure mode persists for any caller that doesn't.
- **Coerce the invalid identifier to a sentinel ("default-for-bad-input")** — same failure mode as silent fallback, just dressed up.
- **Return an error to the caller AND fall back internally** — confusing semantics ("I both failed and succeeded"); breaks the bimodal contract.

Predictable-failure is the smallest cost to express: one line of `return null` (or `throw new NotFoundError`) at the scoped-lookup miss point.

## How to apply

When adding an optional disambiguating field to an existing endpoint / resolver / pure-fn:

1. **Preserve the legacy path verbatim** for the `undefined` branch. Backwards-compat is the whole reason the field is optional.
2. **Add the scoped-lookup branch** for the `field !== undefined` case. The branch does the scoped lookup and **returns null / throws / 404s** when the scoped entity is missing — it does NOT call into the legacy path on miss.
3. **Pin the predictable-failure invariant with a source-inspection test.** The shape is "the scoped branch returns null on miss" as a negative pin against a future edit that adds a fallback inside the scoped branch. Example regex shape: `/sheetId !== undefined[\s\S]*?return null;/` matched against the resolver source.
4. **Document the contract inline** with a JSDoc / comment block at the call site explaining the bimodal handling: "undefined → legacy walk; provided-but-stale → null/404, NOT fallback".
5. **Cross-reference symmetric resolvers.** If another resolver / endpoint applies the same disambiguator (e.g. server + client paths both scope on `sheetId`), the JSDoc on each should mention the symmetry — a future reader sees both ends of the contract.

For controllers / route handlers: map the resolver's null return to a 404 (or domain-appropriate `not_found` error). For pure-fn resolvers consumed by other resolvers: return null and let the consumer decide whether to upgrade to a thrown error.

## Related

- [Wave WD3-server-sheetId-resolution entry](../WAVES.md) — first instance. Server-side `findChartByTileId(dashboard, tileId, sheetId?)` returns null on stale sheetId rather than falling back to the legacy walk-across-sheets. Pinned by an explicit source-inspection test (`scoped-branch-returns-null-not-fallback`) in [`server/tests/dashboardDrillThroughWD3SheetIdResolution.test.ts`](../../server/tests/dashboardDrillThroughWD3SheetIdResolution.test.ts).
- [Wave WI4-client-sheetId-resolution entry](../WAVES.md) — second instance + codification. Client-side ExplainSlicePanel resolver IIFE returns null via optional-chain (`sheets.find(...)?.charts[idx] ?? null`) on stale sheetId rather than falling back to `activeSheet.charts[idx]`. Pinned by an explicit source-inspection test (`returns null on stale sheetId`) in [`client/src/pages/Dashboard/lib/wi4SheetIdResolution.test.ts`](../../client/src/pages/Dashboard/lib/wi4SheetIdResolution.test.ts).
- Files: [`server/services/dashboardDrillThrough.service.ts`](../../server/services/dashboardDrillThrough.service.ts), [`client/src/pages/Dashboard/Components/DashboardView.tsx`](../../client/src/pages/Dashboard/Components/DashboardView.tsx).
- Adjacent: [`docs/conventions/click-time-context-capture-on-event-detail.md`](click-time-context-capture-on-event-detail.md) — the click-time-capture pattern that makes optional disambiguators viable in the first place (the listener is the source of the disambiguator on event-driven paths).
