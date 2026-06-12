# God-file decomposition — plan & progress

> Maintainability initiative (not correctness/security). Each step is a
> **behaviour-preserving** extraction verified by `npm run typecheck && npm test`.
> Do them ONE cohesive module per wave — never a big-bang split — because the
> real risks are (a) **init-order circular deps** (a module-init reference to a
> symbol that now lives in a not-yet-evaluated module) and (b) a **missed
> re-export** breaking an existing import path.

## The safe pattern (proven in Wave R30)

1. Move a cohesive, low-coupling cluster into a new sibling module.
2. In the new module, import shared types **`import type`** only where the
   source would otherwise import back into the god-file → no runtime cycle.
3. In the god-file: `import` what it still calls, and **re-export** any symbol
   that external code (or tests) imports from the god-file's path, e.g.
   `export { CosmosDocSizeError } from "./cosmosDocSizeGuard.js";`. Existing
   `from ".../chat.model.js"` imports keep working unchanged.
4. Verify: typecheck (catches broken imports/cycles), full suite (catches
   behaviour/order regressions), lint.

## Targets (largest first)

| File | LOC | Suggested cohesive extractions (each its own wave) |
|---|---:|---|
| `lib/dataOps/dataOpsOrchestrator.ts` | 5466 | per-operation handlers (removeNulls, aggregate, pivot, convertType, derivedColumn) → `dataOps/handlers/*.ts`; the response-normalisation/coercion helpers → `dataOps/normalize.ts`; the prompt/plan builders → `dataOps/planning.ts`. Orchestrator keeps only the dispatch loop. |
| `lib/agents/runtime/agentLoop.service.ts` | 4508 | the per-tool execution dispatch → `agentLoop/executeStep.ts`; SSE/event emission helpers → `agentLoop/emit.ts`; the reflector/verifier wiring → `agentLoop/flowControl.ts`; the turn-checkpoint/persistence glue → `agentLoop/checkpoint.ts`. |
| `shared/schema.ts` | 3543 | group Zod schemas by domain into `shared/schema/<domain>.ts` (chart, dashboard, pivot, message, session, semantic) and convert `schema.ts` into a barrel that `export *`s them. **CAUTION:** schemas reference each other at module-init — extract a domain only with the schemas it depends on, or keep cross-domain refs via `z.lazy()`. Highest circular-dep risk; do it last + incrementally. |
| `lib/agents/runtime/planArgRepairs.ts` | 2825 | the 23 exported repair fns are already cohesive — split by intent family (ranking, pivot/aggregation, temporal/facet, dimension-filter) into `planArgRepairs/*.ts`, re-export from a barrel. Low coupling (8 imports) → one of the cleaner targets. |
| `services/chat/chatStream.service.ts` | 2585 | the intermediate-segment flush/buffer logic → `chatStream/intermediates.ts`; the pivot-defaults derivation → `chatStream/pivotDefaults.ts`; SSE frame builders → `chatStream/frames.ts`. |
| `models/chat.model.ts` | ~2052 | **R30 done:** doc-size guard → `cosmosDocSizeGuard.ts`. Next: the in-process cache layer (sessionDocCache/sessionListCache/accessResultCache + invalidate*) → `chat.cache.ts` behind a small get/set/invalidate API; the session-list summary helpers (`SESSION_LIST_SELECT`, `finalizeSessionListSummary`) → `chat.sessionList.ts`. |

## Progress

- **R30** · `chat.model.ts` (2088→2052) → `cosmosDocSizeGuard.ts`.
- **R35** · one cohesive module extracted from each remaining god-file (all
  re-export-pattern, full suite 5686 green):
  - `planArgRepairs.ts` (2826→2416) → `planArgRepairs/ranking.ts` (ranking
    intent family, 443 LOC).
  - `dataOpsOrchestrator.ts` (5466→5238) → `dataOpsValueHelpers.ts` (4 pure
    value/column helpers).
  - `agentLoop.service.ts` (4508→4315) → `agentLoopFormatters.ts` (13 pure
    shape/extraction helpers).
  - `chatStream.service.ts` (2586→2370) → `chatStreamPivotDefaults.ts`
    (pivot-defaults derivation).
  - `shared/schema.ts` (3543→3469) → `userDirectiveSchema.ts` (the
    self-contained user-directive schema leaf group; re-exported).

Each god-file now has a proven seam + ≥1 module carved off. To keep shrinking
them, repeat the pattern one cohesive cluster per wave per the table above.
