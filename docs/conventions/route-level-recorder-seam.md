# Convention: Route-level recorder seam

> Introduced as a soft pattern in Wave WD3-telemetry (2026-05-21), promoted to a codified convention in Wave WI4-telemetry (2026-05-21) on the second instance. See `docs/WAVES.md` for the original contexts.

## Rule

When a route handler fires a fire-and-forget call to a model writer (e.g. `recordUsageEvent`) and you need that writer to be substitutable in tests, **expose the substitution seam on the route module, not on the model module**:

1. Import the model writer once at module load.
2. Capture it in a mutable module-local: `let recorder: typeof recordUsageEvent = recordUsageEvent;`.
3. Export `__setXxxForTesting(fn)` and `__resetXxxForTesting()` setters that mutate the local.
4. All route handlers in the module dispatch through the local, never through the imported name directly.

When a single route module hosts multiple controllers that fire the SAME model writer (e.g. `telemetry.ts` hosts both `drillThroughTelemetryController` and `explainSliceTelemetryController`, both calling `recordUsageEvent`), **declare ONE seam at the module level**; both controllers route through the same mutable local; tests substitute via the shared setter and reset via the shared resetter. Do NOT declare a second seam per-controller — that fragments the test substitution surface and forces every test file to re-export-aware.

## Why

Node's ESM module bindings are immutable read-only references from the importer's perspective. Reassigning a named export from outside its declaring module fails with `TypeError: Cannot assign to read only property`. Two consequences:

- **Model-level setters are forced into the model module itself**, which couples test-substitution concerns into production model code (the model file ends up exporting `__setRecorderForTesting` alongside its real surface — visual noise, and a permission to mutate model behavior from anywhere).
- **The recorder needs to be swappable AT IMPORT TIME from each consumer**, which the immutable-binding restriction makes impossible without a layer of indirection.

The route-level seam works because the route module imports the writer once, captures it in a mutable module-local, and exposes setters that mutate the local rather than the export. Tests substitute by calling the setter from `beforeEach` and reset from `afterEach`; production code calls the (now-substituted) local; no ESM rules are violated.

This pattern is the **mirror image** of the W61 admin-controller setter pattern (introduced in W61-add-server) where setters live on controller exports rather than route exports — controllers were tested as standalone functions, not through the route layer. The choice between controller-level and route-level depends on where the test harness invokes the unit:

- **Controller-level seam** (W61): controllers exported as named functions, tests invoke them with `fakeReq` / `fakeRes`; seam lives on the controller's defining module.
- **Route-level seam** (this convention): route module hosts BOTH the registration AND the controllers; tests still invoke controllers as functions with `fakeReq` / `fakeRes`, but the seam lives on the route module because the controllers are not separately-exported across module boundaries (they're internal to the route module's docstring scope).

Use route-level when the route module is small (one or two endpoints, with controllers that are too small to merit a separate `controllers/` module). Use controller-level when the surface is large enough that controllers warrant their own module.

## How to apply

When adding a new fire-and-forget observability endpoint:

1. Check if a sibling endpoint already lives in the route module (e.g. `server/routes/telemetry.ts` already hosts `/telemetry/drill-through`). If yes, **reuse the existing seam** — don't declare a second one. Both controllers should route through `recorder(...)`.
2. If this is the first endpoint in the module, declare the seam at the top of the file:
   ```ts
   type UsageEventRecorder = typeof recordUsageEvent;
   let recorder: UsageEventRecorder = recordUsageEvent;
   export function __setUsageEventRecorderForTesting(fn: UsageEventRecorder) {
     recorder = fn;
   }
   export function __resetUsageEventRecorderForTesting() {
     recorder = recordUsageEvent;
   }
   ```
3. Dispatch through `recorder(...)`, NOT through `recordUsageEvent(...)` directly, even if it looks redundant when there's only one handler.
4. In tests, `beforeEach(() => __setXxxForTesting(myMock))` + `afterEach(() => __resetXxxForTesting())`.

## Related

- [Wave WD3-telemetry entry](../WAVES.md) — first instance (`drillThroughTelemetryController` + recorder seam).
- [Wave WI4-telemetry entry](../WAVES.md) — second instance + codification (`explainSliceTelemetryController` shares the SAME seam).
- Files: [`server/routes/telemetry.ts`](../../server/routes/telemetry.ts).
- Adjacent precedent: W61 admin-controller setters (controller-level rather than route-level).
- Test files exercising the seam: [`dashboardDrillThroughTelemetryWD3Telemetry.test.ts`](../../server/tests/dashboardDrillThroughTelemetryWD3Telemetry.test.ts), [`dashboardExplainSliceTelemetryWI4Telemetry.test.ts`](../../server/tests/dashboardExplainSliceTelemetryWI4Telemetry.test.ts).
