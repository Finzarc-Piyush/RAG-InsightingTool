# Project state — Marico RAG Insighting Tool

> Auto-updated by `/wave-commit`. Read this **first** in every new chat (or run `/orient`).
> Last sync: 2026-05-16 (Wave WW1 — planner wiring of selectTool + externalClaimDetector + WQ1 directive).

## HEAD

- **Latest wave:** Wave WW1 · planner wiring of selectTool + externalClaimDetector + WQ1 directive (2026-05-16)
- **Branch:** `claude/wide-format-classifier`
- **Last commit:** `1336f309` — "Wave WW1 · planner wiring of selectTool + externalClaimDetector + WQ1 directive" (2026-05-16)
- **Working tree:** doc updates staged for paired WW1 commit.

## Live feature streams

- **Wire-up · WW1** · planner-side wiring of WT6 + WQ2 + WQ1 SHIPPED today. New pure helper [`plannerHintsBlock.ts`](../server/lib/agents/runtime/plannerHintsBlock.ts) (`inferAnalystIntent`, `buildDatasetHints`, `buildPlannerHintsBlock`, `PLANNER_CONFIDENCE_DIRECTIVE`); [`planner.ts`](../server/lib/agents/runtime/planner.ts) builds the block per turn and concatenates it directly under the user-question line BEFORE the RAG / memory / hypothesis blocks. WT6's TOOL_ROUTER_HINT + WQ2's EXTERNAL_CLAIM_MARKERS now reach the LLM; WQ1's confidence-tier directive sits in the static system prompt. AgentLog `planner_hints_block_emitted` carries intent / topTool / topConfidence / hasExternalClaim. 19 tests. Next wire-up candidate: narrator-side WQ1 (consume the per-finding tier + hedge phrase in [`narratorAgent.ts`](../server/lib/agents/runtime/narratorAgent.ts)).
- **Workstream 9 — quality 2.0** · WQ1 + WQ2 helpers SHIPPED; WW1 wired them into the planner (WQ2 EXTERNAL_CLAIM_MARKERS block + WQ1 confidence-tier system directive). Next: WQ3 — citation hover-cards in narrator prose. Or WQ7 — significance score by default on breakdown_ranking + segment_compare tools. Or narrator-side WQ1 wiring (consume the per-finding tier + hedge phrase in narratorAgent).
- **Workstream 5 — tool library expansion** · WT6 selectTool wired by WW1 — TOOL_ROUTER_HINT block surfaces in the planner user prompt with intent + ranked tools per turn. Workstream now spans 6 of 6 routing/question-shape pieces (WT8 hierarchical-drill, WT2 cohort, WT3 RFM, WT7 elasticity, WT4 market-basket, WT6 router). Remaining tools require Python (WT1 causal / WT5 what-if / WT9 MTA Markov). Next: WT5 — `run_what_if` (Python scipy Monte Carlo).
- **Workstream 7 — insight engine 2.0** · WI1 schema foundation shipped — `chart.insight: InsightSpec` with `default + generator + confidenceTier + citations + regeneratedAt`. Coexists with legacy `keyInsight` string. Next: WI2 — wire `generator.kind === "llm"` to a MINI-tier regen call cached by `(tileId, filterHash)` so insights refresh on filter change. WI2–WI6 deliver dynamic regen → citation hover-cards → explain-this-slice → per-tile recommendations → insight history.
- **Workstream 1 — semantic & metrics layer** · W56 types + W57 inference + W58 compiler all shipped. The agent can now: (a) auto-populate a SemanticModel at upload (W57), (b) translate a `{metric, breakdownBy, filters}` query into a `QueryPlanBody` (W58). The model is ready for the planner to use; the planner just doesn't know about it yet. Next: W59 — rewrite the planner prompt to surface the metric catalog (`server/lib/agents/runtime/planner.ts` + a new `server/lib/semantic/prompt.ts` for byte-stable manifest rendering). W59–W64 deliver planner prompt rewrite → `execute_metric_query` tool → admin UI → drift gate → result cache.
- **Workstream 4 — dashboard 2.0** · WD1 ships: `+ Add filter` popover on the dashboard global filter bar (categorical + numeric + date pickers). [DashboardGlobalFilterBar.tsx](../client/src/pages/Dashboard/Components/DashboardGlobalFilterBar.tsx) renders even when `global` is empty IFF availableFilters is non-empty. Next: WD2 — cross-filter brushing (click a chart segment → add to global filter). WD2–WD10 deliver brushing → drill-through → dynamic insights → fork-from-dashboard → mobile → linked-sheet filters → saved views → tile comments → scheduled refresh per the [1000x master plan](/Users/tida/.claude/plans/go-through-the-entire-partitioned-yao.md) Workstream 4 wave map.
- **Workstream 3 — investigation mode** · W74 ships: budget exhaustion observability. New pure detector [`investigationBudget.ts`](../server/lib/agents/runtime/investigationBudget.ts) names which cap (llm_calls / wall_time / max_nodes) tripped when the BFS loop terminates short of convergence. [`investigationOrchestrator.ts`](../server/lib/agents/runtime/investigationOrchestrator.ts) emits a `flow_decision` SSE row (`layer: "investigation-budget"`, `chosen: "halt"`) + agentLog `budget_exhausted` when the detector fires. No behaviour change — pure observability. Next: W75 — workbench UI for parallel sub-investigations (per-sub-question lanes in [`ThinkingPanel.tsx`](../client/src/pages/Home/Components/ThinkingPanel.tsx)). Or W76 — Hypothesis Tree visualizer.
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

- **WW1** (2026-05-16) · planner wiring of WT6 + WQ2 + WQ1: new pure helper `plannerHintsBlock.ts` (intent inference + dataset hints + combined block render). planner.ts builds the block per turn, concatenates BEFORE RAG / memory / hypotheses; static PLANNER_CONFIDENCE_DIRECTIVE in system prompt nudges toward tools that emit n / p / R² / CI width. agentLog `planner_hints_block_emitted` for observability. 19 tests.
- **WT6** (2026-05-16) · `selectTool` planner router helper: 15-value AnalystIntent enum mapped to ordered ToolRecommendation[] with rationale + confidence. DatasetHints disambiguate. renderToolRouterPromptBlock for system-message paste. Helper-only. 26 tests.
- **WT4** (2026-05-16) · `run_market_basket` tool: 1-LHS apriori association rules from transaction baskets. Emits both directions a→b and b→a with support / confidence / lift / count. Set semantics on (tx, item) pairs. Pure-Node. 19 tests.
- **WQ2** (2026-05-16) · `externalClaimDetector` helper: pure regex-based scanner for competitor / market_size / industry_benchmark / external_event / demographic_shift markers. Emits verbatim excerpts + suggestedAction: "add web_search step". Helper-only this wave. 29 tests.
- **W74** (2026-05-16) · Investigation budget exhaustion observability: new pure `evaluateBudgetExhaustion` returns the specific cap that tripped (llm_calls / wall_time / max_nodes). Orchestrator emits `flow_decision` SSE row when the loop halts on budget. 14 tests.

For full prose entries: read `docs/WAVES.md`. For older entries: `docs/archive/`.
