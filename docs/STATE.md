# Project state — Marico RAG Insighting Tool

> Auto-updated by `/wave-commit`. Read this **first** in every new chat (or run `/orient`).
> Last sync: 2026-05-16 (Wave W56 — semantic-layer type foundation).

## HEAD

- **Latest wave:** Wave W56 · Semantic & metrics layer — type foundation (2026-05-16)
- **Branch:** `claude/wide-format-classifier`
- **Last commit:** `549b6610` — "Wave W56 · semantic & metrics layer — type foundation" (2026-05-16)
- **Working tree:** clean after W56 + doc-update commits.

## Live feature streams

- **Workstream 1 — semantic & metrics layer** · W56 type foundation shipped (zod schemas for Metric / Dimension / Hierarchy / Model in [server/shared/schema.ts](../server/shared/schema.ts), 15 tests passing). Next: W57 `inferModel` from `DataSummary + datasetProfile + dimensionHierarchies`. Per the [1000x master plan](/Users/tida/.claude/plans/go-through-the-entire-partitioned-yao.md), W56–W64 deliver the metric catalog → compiler → planner prompt rewrite → `execute_metric_query` tool → admin UI → result cache.
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

- **W57** — `server/lib/semantic/inferModel.ts`: auto-build initial `SemanticModel` from `DataSummary` + `datasetProfile` + wide-format proposal + `dimensionHierarchies`. Persist on `ChatDocument.semanticModel` at upload completion. See the [1000x master plan](/Users/tida/.claude/plans/go-through-the-entire-partitioned-yao.md) Workstream 1 wave map.

## Last 5 waves (one line each — newest first)

- **W56** (2026-05-16) · Semantic & metrics layer — type foundation: `semanticMetricSchema` / `semanticDimensionSchema` / `semanticHierarchySchema` / `semanticModelSchema` in [server/shared/schema.ts](../server/shared/schema.ts). 15 tests. Foundation for W57–W64.
- **Phase D** (2026-05-16) · Multi-part question detector + `flow_decision` observability. D3 actual decomposition deferred.
- **Phase F** (2026-05-16) · Forecasting + anomaly detection + statistical significance tools (3 env-gated).
- **W3** (2026-05-16) · Composite-ranking expression support in `run_breakdown_ranking`.
- **W2** (2026-05-16) · `detectRollingWindowIntent` deterministic detector for rolling / cumulative phrasings.

For full prose entries: read `docs/WAVES.md`. For older entries: `docs/archive/`.
