# Project state — Marico RAG Insighting Tool

> Auto-updated by `/wave-commit`. Read this **first** in every new chat (or run `/orient`).
> Last sync: 2026-05-16 (Wave W57 — semantic model inference).

## HEAD

- **Latest wave:** Wave W57 · Semantic model inference (2026-05-16)
- **Branch:** `claude/wide-format-classifier`
- **Last commit:** `ee647eb9` — "Wave W57 · semantic model inference" (2026-05-16)
- **Working tree:** clean after W57 + doc-update commits.

## Live feature streams

- **Workstream 1 — semantic & metrics layer** · W56 type foundation + W57 inference both shipped. Upload pipeline now persists `semanticModel` on `ChatDocument` (auto-source); see [server/lib/semantic/inferModel.ts](../server/lib/semantic/inferModel.ts). Next: W58 `compiler` — translate `(metric, breakdownBy, filters, window)` into `QueryPlanBody`. Per the [1000x master plan](/Users/tida/.claude/plans/go-through-the-entire-partitioned-yao.md), W58–W64 deliver compiler → planner prompt rewrite → `execute_metric_query` tool → admin UI → drift gate → result cache.
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

- **W58** — `server/lib/semantic/compiler.ts`: pure `compileMetricQuery({ metric, breakdownBy, filters, window }) → QueryPlanBody`. Reuses existing `aggregationEntrySchema` + `dimensionFilterSchema` + `windowAggregationsSchema` + `computedAggregationSchema` so the compiler output is *valid input to existing tools*, not a parallel execution path. Will replace ~70% of planner ad-hoc `execute_query_plan` calls once W59 rewrites the planner prompt. See the [1000x master plan](/Users/tida/.claude/plans/go-through-the-entire-partitioned-yao.md) Workstream 1 wave map.

## Last 5 waves (one line each — newest first)

- **W57** (2026-05-16) · Semantic model inference: pure `inferModel({summary, datasetProfile?}) → SemanticModel` wired into the upload understanding-ready checkpoint. Persists `ChatDocument.semanticModel`. 15 tests.
- **W56** (2026-05-16) · Semantic & metrics layer — type foundation: `semanticMetricSchema` / `semanticDimensionSchema` / `semanticHierarchySchema` / `semanticModelSchema` in [server/shared/schema.ts](../server/shared/schema.ts). 15 tests. Foundation for W57–W64.
- **Phase D** (2026-05-16) · Multi-part question detector + `flow_decision` observability. D3 actual decomposition deferred.
- **Phase F** (2026-05-16) · Forecasting + anomaly detection + statistical significance tools (3 env-gated).
- **W3** (2026-05-16) · Composite-ranking expression support in `run_breakdown_ranking`.

For full prose entries: read `docs/WAVES.md`. For older entries: `docs/archive/`.
