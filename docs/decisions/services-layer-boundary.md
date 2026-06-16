# Services-layer boundary — "controllers-as-services" is the accepted pattern

**Status:** Accepted · closes audit finding ARCH-6

## Context

The audit (ARCH-6) flagged the `server/services/` tier as **thin and bypassed**:
controllers reach directly into `server/lib/` far more often than they go
through a service. Measured on the tree:

- **69** `from '../lib/…'` imports across [`server/controllers/`](../../server/controllers)
- **9** `from '../services/…'` imports across the same controllers

The implied worry is a "half-used tier": a `services/` directory that *looks*
like it should be the single orchestration layer between HTTP controllers and
the `lib/` building blocks, but in practice is skipped by most controllers.
That ambiguity invites two bad reactions — (a) a churny mass-migration to force
every controller through a service, or (b) deleting `services/` entirely. Both
are wrong for this codebase.

What the tree actually shows is a **deliberate, consistent** split, not an
accident:

- **Controllers orchestrate `lib/` directly** for request handling that belongs
  to exactly one entrypoint. The controller *is* the orchestration seam for that
  route. This is the de-facto pattern across all 23 controllers and it is fine —
  Express handlers composing pure `lib/` functions is a perfectly good
  architecture; an extra pass-through service would add indirection without
  removing duplication.

- **`services/` exists exactly where orchestration is genuinely shared by more
  than one entrypoint** — i.e. the same multi-step flow is invoked from a
  controller *and* a background worker *and/or* a second controller. Today's
  tier is small and every member earns its place by that test:

  | Service | Entrypoints that consume it (non-test) | Why it's a service |
  |---|---|---|
  | [`services/chat/`](../../server/services/chat) (`chat.service.ts`, `chatStream.service.ts`, `chatResponse.service.ts`, …) | [`controllers/chatController.ts`](../../server/controllers/chatController.ts), [`controllers/automationController.ts`](../../server/controllers/automationController.ts), [`utils/uploadQueue.ts`](../../server/utils/uploadQueue.ts) | The chat answer/stream flow runs from the chat route, the automation route, **and** the post-upload background queue. Three entrypoints → shared. |
  | [`services/dataOps/`](../../server/services/dataOps) (`dataOps.service.ts`, `dataOpsStream.service.ts`) | [`controllers/dataOpsController.ts`](../../server/controllers/dataOpsController.ts) | A logical data-ops orchestration seam over the python-service; sync + stream variants kept as one cohesive module. |
  | [`services/dashboardExport/`](../../server/services/dashboardExport) + [`dashboardExport.service.ts`](../../server/services/dashboardExport.service.ts) | [`controllers/dashboardController.ts`](../../server/controllers/dashboardController.ts), [`controllers/dashboardExportController.ts`](../../server/controllers/dashboardExportController.ts) | Export (PPTX/XLSX) is invoked from the dashboard route **and** the dedicated export route. Two entrypoints → shared. |
  | [`dashboardDrillThrough.service.ts`](../../server/services/dashboardDrillThrough.service.ts) | [`controllers/dashboardDrillThroughController.ts`](../../server/controllers/dashboardDrillThroughController.ts) | Drill-through orchestration kept out of the controller because it is a cohesive multi-step flow likely to be re-used by export/replay. |

So the 69-vs-9 ratio is not evidence of a bypassed tier; it is evidence that
**most route handling is single-entrypoint** (correctly living in the
controller) and **the genuinely shared orchestration has already been
factored out** into `services/`.

## Decision

**Controllers-as-services is the accepted, de-facto pattern.** Specifically:

1. **Controllers MAY orchestrate `lib/` directly.** A controller is allowed to
   be the orchestration seam for its route — composing pure `lib/` functions,
   DuckDB executors, model RMW helpers, etc. — with no intermediate service.
   This is the default and requires no justification.

2. **The `services/` tier is retained ONLY for orchestration genuinely shared
   by more than one entrypoint.** "Entrypoint" means a distinct call site
   class: an HTTP controller, a background worker / queue (e.g.
   [`utils/uploadQueue.ts`](../../server/utils/uploadQueue.ts)), a replay/import
   path, or a second controller. If a multi-step flow is (or is about to be)
   invoked from two or more of those, it belongs in `services/`.

3. **Placement rule for new code:**
   - New **cross-entrypoint** orchestration → put it in `services/<domain>/`.
   - New **single-entrypoint** orchestration → it MAY stay in the controller.
     Do not pre-emptively wrap a one-caller flow in a service "for symmetry".
   - When a previously single-entrypoint flow gains a second caller, *then*
     promote it from the controller into `services/`.

4. **No mass migration.** We explicitly reject forcing all 23 controllers
   through pass-through services. That would add indirection without removing
   duplication and churn the entire HTTP layer for zero behavioural gain.

This removes the "half-used tier" ambiguity: the tier is not half-used, it is
**precisely scoped** to shared orchestration, and the rule for what goes where
is now explicit.

## Consequences

- **ARCH-6 is closed by decision, not refactor.** The boundary is documented;
  the 69-vs-9 ratio is the *expected* shape, not a defect.
- **Reviewers have a crisp test.** "Does this orchestration have ≥2 entrypoints?"
  decides controller-vs-service. No more case-by-case debate.
- **`services/` stays small and meaningful.** Every member is justified by an
  active second consumer, so the tier doesn't rot into a grab-bag.
- **Lib remains the shared building-block layer** for both controllers and
  services; nothing here changes how `lib/` is consumed.
- **Trade-off accepted:** a single-entrypoint controller can grow large before
  anyone extracts a service. That is bounded by the existing host-size
  convention ([`host-pre-extract-at-1500-loc.md`](../conventions/host-pre-extract-at-1500-loc.md)),
  which already drives extraction on size grounds independently of this
  boundary.

## See also

- [`docs/architecture/overview.md`](../architecture/overview.md) — "Services vs controllers boundary" note.
- [`docs/conventions/host-pre-extract-at-1500-loc.md`](../conventions/host-pre-extract-at-1500-loc.md) — size-driven extraction trigger.
