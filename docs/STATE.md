# Project state — Marico RAG Insighting Tool

> Auto-updated by `/wave-commit`. Read this **first** in every new chat (or run `/orient`).
> Last sync: 2026-05-16 (Wave W73 — investigation mode wired into entry point).

## HEAD

- **Latest wave:** Wave W73 · Investigation mode wired into agent loop entry (2026-05-16)
- **Branch:** `claude/wide-format-classifier`
- **Last commit:** `d1de1647` — "Wave W73 · investigation mode wired into agent loop entry" (2026-05-16)
- **Working tree:** clean after W73 + doc-update commits.

## Live feature streams

- **Workstream 3 — investigation mode** · W73 wires `runDeepInvestigation` into [`dataAnalyzer.answerQuestion`](../server/lib/dataAnalyzer.ts) behind `DEEP_INVESTIGATION_ENABLED` (invariant #6 preserved). Multi-part questions auto-decompose when the env var is on. Next: W74 — shape-based auto-dispatch (`driver_discovery` / `variance_diagnostic` / `comparison` shapes auto-trigger even without conjunction phrasing). Per the [1000x master plan](/Users/tida/.claude/plans/go-through-the-entire-partitioned-yao.md), W73–W79 deliver dispatch → workbench UI → hypothesis tree viz → narrator merge → investigation memory → golden fixture.
- **Workstream 1 — semantic & metrics layer** · W56 type foundation + W57 inference both shipped. Upload pipeline now persists `semanticModel` on `ChatDocument` (auto-source); see [server/lib/semantic/inferModel.ts](../server/lib/semantic/inferModel.ts). Next: W58 `compiler` — translate `(metric, breakdownBy, filters, window)` into `QueryPlanBody`. W58–W64 deliver compiler → planner prompt rewrite → `execute_metric_query` tool → admin UI → drift gate → result cache.
- **Phase D — coordinator multi-part detection** · D1+D2 shipped; D3 (actual parallel sub-investigation) deferred behind `DEEP_INVESTIGATION_ENABLED`. Detector lives at [server/lib/agents/runtime/detectMultiPartQuestion.ts](../server/lib/agents/runtime/detectMultiPartQuestion.ts), observability fires in [chatStream.service.ts](../server/services/chat/chatStream.service.ts) after mode classification.
- **Phase F — predictive / inferential tooling** · F1 forecast, F2 anomaly detection, F3 significance tests all shipped, gated by `FORECAST_ENABLED` / `ANOMALY_DETECTION_ENABLED` / `SIGNIFICANCE_TESTS_ENABLED`. Pure-Node implementations under [server/lib/](../server/lib/).
- **W-series — query plan expressiveness** · W1 (window aggregations) → W2 (rolling-window detector) → W3 (composite-ranking expressions in `breakdown_ranking`) all shipped. P1 (pivot reads agent result rows) closes the load-bearing UX gap for `computedAggregations`.
- **E-series — multi-tab session sync** · E1 BroadcastChannel foundation → E2 active-filter sync → E3 messages/lifted-state sync → E4 stale-filter retry helper all shipped.
- **C-series — client safety** · C1 BAI exact-timestamp matching, C2 isMountedRef SSE guards, C3 optimistic-update rollback. Shipped.
- **B-series — context plumbing across sub-agents** · B1 (quick-lookup planner) through B7 (narrator user-block always surfaces userIntent). Shipped.
- **A-series — concurrency hardening** · A1 (filter-aware question cache) through A7 (domainContext cache atomicity via generation counter). Shipped — `withSessionWriteLock` is now the unified per-session Cosmos write mutex.
- **Routing system (this migration)** · Slim CLAUDE.md, `docs/STATE.md`, `docs/WAVES.md`, three slash skills (`/orient`, `/wave-commit`, `/load`), Stop hook for doc-freshness nudges. Setup wave in flight at time of writing.

## Known WIP / broken

- Wide-format classifier (W1–W4 of the wide-format plan) is mid-flight on this branch; remaining waves W14–W29 add the modal UX + ingest wiring + decision endpoint. Independent of W56's semantic layer but should land before W57 if the semantic compiler is to consume `_metric`/`_period` columns from melted datasets.
- [docs/architecture/schemas.md](architecture/schemas.md) still describes the pre-W5 dual-mirror schema model — out of date but non-blocking. Refresh in a future doc-hygiene wave.

## Next wave (if planned)

- **WD1** — `client/src/pages/Dashboard/Components/DashboardGlobalFilterBar.tsx`: add an interactive `+ Add filter` button that opens a `FilterPicker` popover listing all columns present in ≥ 1 tile. Selecting a column opens a type-appropriate picker (categorical / numeric / date) reusing existing [`chartFilters.ts`](../client/src/lib/chartFilters.ts) logic. On confirm, mutates `globalFilters` which already broadcasts to applicable tiles. Closes the "global slicer is display-only" gap explicitly named in the user's 1000x requirements. See the [1000x master plan](/Users/tida/.claude/plans/go-through-the-entire-partitioned-yao.md) Workstream 4 wave map.

## Last 5 waves (one line each — newest first)

- **W73** (2026-05-16) · Investigation mode wired into agent loop entry: `shouldDispatchDeepInvestigation` + `dataAnalyzer.answerQuestion` calls `runDeepInvestigation` for multi-part questions when `DEEP_INVESTIGATION_ENABLED=true`. 13 tests.
- **W57** (2026-05-16) · Semantic model inference: pure `inferModel({summary, datasetProfile?}) → SemanticModel` wired into the upload understanding-ready checkpoint. Persists `ChatDocument.semanticModel`. 15 tests.
- **W56** (2026-05-16) · Semantic & metrics layer — type foundation: `semanticMetricSchema` / `semanticDimensionSchema` / `semanticHierarchySchema` / `semanticModelSchema` in [server/shared/schema.ts](../server/shared/schema.ts). 15 tests. Foundation for W57–W64.
- **Phase D** (2026-05-16) · Multi-part question detector + `flow_decision` observability. D3 actual decomposition deferred.
- **Phase F** (2026-05-16) · Forecasting + anomaly detection + statistical significance tools (3 env-gated).

For full prose entries: read `docs/WAVES.md`. For older entries: `docs/archive/`.
