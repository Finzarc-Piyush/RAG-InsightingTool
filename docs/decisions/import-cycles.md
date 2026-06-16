# Server import cycles: dynamic-import cycle-breakers are accepted; type-only edges are eliminated

**Status:** Accepted · 2026-06-16 (expert-audit finding ARCH-3 remediation)

## Context

Audit finding **ARCH-3** (MEDIUM, architectural smell): the server tree carries
circular module dependencies that are *masked* by dynamic `await import(...)`
cycle-breakers (~144 `await import(` sites; the headline offender is
`models/chat.model.ts`, a data model, dynamically importing behavior modules to
avoid a static `import` cycle).

A Tarjan SCC scan of `server/**` (508 TS files; `import type` edges and dynamic
`import(...)` edges *excluded*, since both are erased / deferred at runtime)
finds the cyclic structure below.

**Two kinds of cycle exist here and must be treated differently:**

1. **Genuine runtime behavior cycles.** Module A calls a *function* exported by
   module B, and B (transitively) calls a function in A. A static `import` would
   create an ES-module initialization-order hazard, so one direction is a
   call-time `await import(...)`. This is a *correct, working* pattern — the
   dynamic import defers B's evaluation until first call, by which time A is
   fully initialized. Inverting these (moving behavior out of `chat.model`,
   passing functions as params, an event bus) would be a risky runtime
   refactor of the contended read-modify-write seam (`mutateChatDocument`,
   invariant #9) for a purely cosmetic graph win.

2. **Type-masquerading-as-value cycles.** Module A does a *value* `import` of a
   symbol from B but only uses it as a **type** (a parameter / field
   annotation). TypeScript would erase that import at emit, but a plain
   `import { X }` still reads as a runtime edge to readers, linters, and SCC
   tools — and `chat.model` is a heavy, side-effectful module (Cosmos caches,
   `setInterval`, schema parsing) you do *not* want pulled into a cycle by
   accident. These are **free to fix**: convert to `import type` (or an inline
   `type` specifier) and the runtime edge vanishes with zero behavior change.

## Decision

**Accept the genuine dynamic-import cycle-breakers as an intentional pattern.**
Do not invert them. When you add one, leave a one-line comment saying it breaks
a cycle, and (if it touches `chat.model`) keep it OUTSIDE any held
`withSessionWriteLock` (invariant #9 — the lock is non-reentrant).

**Eliminate every type-masquerading-as-value edge** by making the import
`import type`. The shared interface (`ChatDocument`) stays declared in
`chat.model.ts` and is re-exported as before; consumers that need it *only as a
type* take it type-only, so they drop out of the cycle without the type having
to move to a separate leaf file.

### Edges reduced to `import type` (runtime edge removed)

| File | Symbol | Before | After |
|---|---|---|---|
| `utils/dataLoader.ts` | `ChatDocument` | `import { ChatDocument }` | `import type { ChatDocument }` |
| `services/chat/chatResponse.service.ts` | `ChatDocument` | `import { ChatDocument }` | `import type { ChatDocument }` |
| `models/sharedAnalysis.model.ts` | `ChatDocument` | value import mixed with `getChatBySessionIdEfficient` / `mutateChatDocument` | inline `type ChatDocument` (the two functions stay value imports — this file has a genuine behavior edge anyway) |

Converting `dataLoader`'s `ChatDocument` to `import type` is the load-bearing
change: it severed the *only* runtime edge tying `utils/dataLoader.ts`,
`lib/ensureSessionDuckdbMaterialized.ts`, and `lib/duckdbPlanExecutor.ts` to the
`chat.model` cycle. (Those last two already imported `ChatDocument` as
`import type`; they were dragged in solely through `dataLoader`.) Result: the
`chat.model` SCC shrank from **7 files → 4 files**.

### Cycles that REMAIN deliberately dynamic (genuine behavior — left as-is)

| SCC (after) | The dynamic cycle-breaker | Why it stays |
|---|---|---|
| `chat.model` ⇄ `memoryLifecycleBuilders` ⇄ `rag/indexSession` ⇄ `sessionAnalysisContext` (4 files) | `chat.model` → `await import("memoryLifecycleBuilders")` / `await import("sessionAnalysisContext")`; `sessionAnalysisContext` → `await import("chat.model")` | `rag/indexSession` statically needs `getChatBySessionIdEfficient` + `mutateChatDocument` (the RMW seam); `memoryLifecycleBuilders` statically needs `scheduleIndexMemoryEntries`. The remaining direction is genuine behavior called at runtime inside the model's write paths. Inverting risks the RMW seam. |
| `agentLoop.service` → `investigationOrchestrator` → `spawnedFollowUpPass` (3 files) | `agentLoop.service` → `await import("spawnedFollowUpPass")` (`runSpawnedFollowUpPass`) | `spawnedFollowUpPass` statically needs `runSubInvestigation`; `investigationOrchestrator` statically needs `runAgentTurn`. Single-flow follow-up pass is invoked once, late in the loop — a clean call-time import. |
| `dashboard.model` ⇄ `sharedDashboard.model` (2 files) | `dashboard.model` → `await import("sharedDashboard.model")` (`listSharedDashboardsForUser`, 12 call sites); `sharedDashboard.model` → `await import("dashboard.model")` (`updateDashboard`) | Two sibling persistence models that legitimately reference each other's reads/writes. |
| `envFlags` ⇄ `featureFlags` (2 files) | *None — this one is a static cycle, not dynamic* | Both `import` values from each other, but the cross-reference is **lazy** (read inside the `isBusinessActionsEnabled()` accessor body, never at module top-level), so the ES-module cycle resolves cleanly. Documented inline in `envFlags.ts`. Left intentionally. |

## Consequences

- **`chat.model` import cycle: 7 files → 4.** Total files entangled in cyclic
  SCCs across the server: **14 → 11**. The 4 cyclic SCCs themselves remain (the
  remaining members are joined by genuine runtime behavior or a benign lazy
  static cycle).
- **`await import(` count unchanged at 144** — by design. The fix removed *type*
  edges; it did not touch any genuine behavior cycle-breaker, so the chat write
  path is byte-for-byte unchanged at runtime.
- **No runtime inversion, no behavior moved out of `chat.model`.** The contended
  `mutateChatDocument` RMW seam (invariant #9) is untouched.
- Future rule: when a module imports a symbol from `chat.model` (or any heavy
  model) **only to annotate types**, use `import type`. Reserve `await import`
  for genuine call-time behavior that would otherwise form a static cycle.

## How to re-measure

There is no `madge`/`dpdm` dependency in the repo. A throwaway Tarjan scan
reproduces the counts: build a graph over `server/**/*.ts`, treat `import type`
and (separately) dynamic `import(...)` as non-edges, and run SCC detection. The
`--static-only` variant (dynamic imports counted as edges) reveals the *masked*
cycles documented in the table above.
