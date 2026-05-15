# Project state — Marico RAG Insighting Tool

> Auto-updated by `/wave-commit`. Read this **first** in every new chat (or run `/orient`).
> Last sync: 2026-05-15 (during the routing-system migration).

## HEAD

- **Latest wave:** Wave D · Coordinator multi-part detection + `flow_decision` observability (2026-05-16)
- **Branch:** `claude/wide-format-classifier`
- **Last commit:** `593edf2e` — "Update CLAUDE.md for comprehensive guidance and workflow rules…" (2026-05-15)
- **Working tree:** has uncommitted modifications across `client/` and `server/` (pre-migration baseline; see `git status`)

## Live feature streams

- **Phase D — coordinator multi-part detection** · D1+D2 shipped; D3 (actual parallel sub-investigation) deferred behind `DEEP_INVESTIGATION_ENABLED`. Detector lives at [server/lib/agents/runtime/detectMultiPartQuestion.ts](../server/lib/agents/runtime/detectMultiPartQuestion.ts), observability fires in [chatStream.service.ts](../server/services/chat/chatStream.service.ts) after mode classification.
- **Phase F — predictive / inferential tooling** · F1 forecast, F2 anomaly detection, F3 significance tests all shipped, gated by `FORECAST_ENABLED` / `ANOMALY_DETECTION_ENABLED` / `SIGNIFICANCE_TESTS_ENABLED`. Pure-Node implementations under [server/lib/](../server/lib/).
- **W-series — query plan expressiveness** · W1 (window aggregations) → W2 (rolling-window detector) → W3 (composite-ranking expressions in `breakdown_ranking`) all shipped. P1 (pivot reads agent result rows) closes the load-bearing UX gap for `computedAggregations`.
- **E-series — multi-tab session sync** · E1 BroadcastChannel foundation → E2 active-filter sync → E3 messages/lifted-state sync → E4 stale-filter retry helper all shipped.
- **C-series — client safety** · C1 BAI exact-timestamp matching, C2 isMountedRef SSE guards, C3 optimistic-update rollback. Shipped.
- **B-series — context plumbing across sub-agents** · B1 (quick-lookup planner) through B7 (narrator user-block always surfaces userIntent). Shipped.
- **A-series — concurrency hardening** · A1 (filter-aware question cache) through A7 (domainContext cache atomicity via generation counter). Shipped — `withSessionWriteLock` is now the unified per-session Cosmos write mutex.
- **Routing system (this migration)** · Slim CLAUDE.md, `docs/STATE.md`, `docs/WAVES.md`, three slash skills (`/orient`, `/wave-commit`, `/load`), Stop hook for doc-freshness nudges. Setup wave in flight at time of writing.

## Known WIP / broken

- (Pre-migration working tree has many modified files in `client/` and `server/` — these belong to the active stream of work and are NOT part of this routing-system migration. Do not stage or revert them.)

## Next wave (if planned)

- Verify the new flow end-to-end on a fresh chat: `/orient` returns < 10 s, `/load <subsystem>` works, `/wave-commit` writes a clean WAVES entry. See `/Users/tida/.claude/plans/this-has-become-a-joyful-bunny.md` for the plan and verification checklist.

## Last 5 waves (one line each — newest first)

- **Phase D** (2026-05-16) · Multi-part question detector + `flow_decision` observability. D3 actual decomposition deferred.
- **Phase F** (2026-05-16) · Forecasting + anomaly detection + statistical significance tools (3 env-gated).
- **W3** (2026-05-16) · Composite-ranking expression support in `run_breakdown_ranking`.
- **W2** (2026-05-16) · `detectRollingWindowIntent` deterministic detector for rolling / cumulative phrasings.
- **W1** (2026-05-16) · `windowAggregations` on `QueryPlanBody` — rolling avg, cumulative sum, rank-within-group, lag/lead.

For full prose entries: read `docs/WAVES.md`. For older entries: `docs/archive/`.
