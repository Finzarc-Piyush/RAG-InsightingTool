# Project state — Marico RAG Insighting Tool

> Auto-updated by `/wave-commit`. Read this **first** in every new chat (or run `/orient`).
> Last sync: 2026-05-16 (Wave WT8 — `run_hierarchical_drill` tool).

## HEAD

- **Latest wave:** Wave WT8 · `run_hierarchical_drill` tool (2026-05-16)
- **Branch:** `claude/wide-format-classifier`
- **Last commit:** `0fdc072c` — "Wave WT8 · run_hierarchical_drill tool" (2026-05-16)
- **Working tree:** clean after WT8 + doc-update commits.

## Live feature streams

- **Workstream 5 — tool library expansion** · WT8 ships: `run_hierarchical_drill` rolls high-cardinality dimensions into top-N + "Other" for readable breakdown charts. Pure-Node, registered in [`registerTools.ts`](../server/lib/agents/runtime/tools/registerTools.ts). Next: WT2 — `run_cohort_analysis` (pure-Node, DuckDB SQL when available, recency-frequency cohort tables). Or WT3 — `run_rfm_segmentation`. WT1–WT10 deliver causal / cohort / RFM / market-basket / what-if / MTA / elasticity / hierarchical-drill / tool-router per the [1000x master plan](/Users/tida/.claude/plans/go-through-the-entire-partitioned-yao.md).
- **Workstream 7 — insight engine 2.0** · WI1 schema foundation shipped — `chart.insight: InsightSpec` with `default + generator + confidenceTier + citations + regeneratedAt`. Coexists with legacy `keyInsight` string. Next: WI2 — wire `generator.kind === "llm"` to a MINI-tier regen call cached by `(tileId, filterHash)` so insights refresh on filter change. WI2–WI6 deliver dynamic regen → citation hover-cards → explain-this-slice → per-tile recommendations → insight history.
- **Workstream 1 — semantic & metrics layer** · W56 types + W57 inference + W58 compiler all shipped. The agent can now: (a) auto-populate a SemanticModel at upload (W57), (b) translate a `{metric, breakdownBy, filters}` query into a `QueryPlanBody` (W58). The model is ready for the planner to use; the planner just doesn't know about it yet. Next: W59 — rewrite the planner prompt to surface the metric catalog (`server/lib/agents/runtime/planner.ts` + a new `server/lib/semantic/prompt.ts` for byte-stable manifest rendering). W59–W64 deliver planner prompt rewrite → `execute_metric_query` tool → admin UI → drift gate → result cache.
- **Workstream 4 — dashboard 2.0** · WD1 ships: `+ Add filter` popover on the dashboard global filter bar (categorical + numeric + date pickers). [DashboardGlobalFilterBar.tsx](../client/src/pages/Dashboard/Components/DashboardGlobalFilterBar.tsx) renders even when `global` is empty IFF availableFilters is non-empty. Next: WD2 — cross-filter brushing (click a chart segment → add to global filter). WD2–WD10 deliver brushing → drill-through → dynamic insights → fork-from-dashboard → mobile → linked-sheet filters → saved views → tile comments → scheduled refresh per the [1000x master plan](/Users/tida/.claude/plans/go-through-the-entire-partitioned-yao.md) Workstream 4 wave map.
- **Workstream 3 — investigation mode** · W73 wires `runDeepInvestigation` into [`dataAnalyzer.answerQuestion`](../server/lib/dataAnalyzer.ts) behind `DEEP_INVESTIGATION_ENABLED` (invariant #6 preserved). Multi-part questions auto-decompose when the env var is on. Next: W74 — shape-based auto-dispatch (`driver_discovery` / `variance_diagnostic` / `comparison` shapes auto-trigger even without conjunction phrasing). W73–W79 deliver dispatch → workbench UI → hypothesis tree viz → narrator merge → investigation memory → golden fixture.
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

- **WD2** — cross-filter brushing. Each chart renderer accepts an `onElementClick` prop (already added in the recent commit `593edf2e`). Wire it: clicking a bar/point/segment dispatches a `crossFilter` event with `{column, value}` to `DashboardView`, which adds it to `globalFilters` (already in place from WD1). Visual: filtered tiles dim non-matching marks instead of removing them. New module `client/src/pages/Dashboard/lib/crossFilter.ts`. See the [1000x master plan](/Users/tida/.claude/plans/go-through-the-entire-partitioned-yao.md) Workstream 4 wave map.

## Last 5 waves (one line each — newest first)

- **WT8** (2026-05-16) · `run_hierarchical_drill` tool: rolls high-cardinality dimensions into top-N + "Other" for readable breakdowns. Pure-Node, no Python. _rank=-1 flags the rolled bucket; _share fractions sum to 1. 19 tests.
- **WI1** (2026-05-16) · InsightSpec schema: `chart.insight: InsightSpec` with `default + generator + confidenceTier + citations + regeneratedAt`. Coexists with legacy `keyInsight`. Foundation for WI2 (dynamic regen). 14 tests.
- **W58** (2026-05-16) · Semantic-layer compiler: `compileMetricQuery({model, metric, breakdownBy?, filters?, sortBy?, limit?}) → QueryPlanBody`. Simple + composite arithmetic metrics; rejects expressions that don't fit the executor's allowed-character set. 18 tests.
- **WD1** (2026-05-16) · Dashboard global filter bar is now additive: `AddFilterPopover` with categorical/numeric/date editors, `availableFilterDefinitions` pure helper, `DashboardGlobalFilterBar` renders when empty if columns are addable. 17 tests.
- **W73** (2026-05-16) · Investigation mode wired into agent loop entry: `shouldDispatchDeepInvestigation` + `dataAnalyzer.answerQuestion` calls `runDeepInvestigation` for multi-part questions when `DEEP_INVESTIGATION_ENABLED=true`. 13 tests.

For full prose entries: read `docs/WAVES.md`. For older entries: `docs/archive/`.
