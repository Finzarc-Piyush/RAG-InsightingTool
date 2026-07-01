# Project state — Marico RAG Insighting Tool

> Read this for **durable context** — feature streams, prior milestones, the deferred backlog.
> For **live state** (branch, HEAD, current wave, dirty tree, recent commits) run `/orient`
> (`npm --prefix server run orient`): it is generated fresh from the tree each session and
> cannot drift. This file no longer hand-tracks HEAD — that block is what fell 62 commits
> behind on the wrong branch in June 2026, which is why the orient pack now owns it.

## HEAD

Run `/orient` for live branch / HEAD / current wave / dirty-tree / recent-commits, plus the
invariant-firewall verdict. Generated from the tree by
[`server/scripts/generate-bootstrap.ts`](../server/scripts/generate-bootstrap.ts), so it is
always current. The old hand-maintained HEAD block was removed because it drifted.

## Feature streams

- **Incremental data refresh ("Update data"):** v1 + v1.1 SHIPPED behind `INCREMENTAL_REFRESH_ENABLED` (server) + `VITE_INCREMENTAL_REFRESH_ENABLED` (client), both default OFF. Attach an updated file (or "Fetch latest" from Snowflake) to an existing chat/dashboard → the whole analysis regenerates on the new data. **Replace** (new supersedes) or **Append** (old + new → full combined). Built as Waves WR0–WR8 by re-targeting the automation capture→replay engine (`replayRecipe` extracted from `replayAutomation`); dashboard updates in place. **v1.1 (WR9–WR13) shipped:** flagged Parquet sibling-write; user-initiated rollback + "Data: as of …" version badge; opt-in fresh-planner discovery pass; April-vs-May compare; scheduled Snowflake auto-refresh (Vercel cron, `CRON_SECRET`). Plan `/Users/tida/.claude/plans/an-extremely-new-functionality-pure-graham.md`. Architecture: [`docs/architecture/incremental-refresh.md`](architecture/incremental-refresh.md). **Deploy gates:** `CRON_SECRET` for scheduling; `USE_PARQUET_READ_PATH` only with the Phase-1 read path. Full `npm test` (live Cosmos/Snowflake/Azure) must run in CI.
- **Large-dataset robustness (10M rows · multi-tenant · stay-on-serverless):** OPEN. Roadmap `/Users/tida/.claude/plans/goofy-wandering-quasar.md`. Root cause: a stateful "load all rows into a JS array" model on stateless Vercel serverless. **Shipped + verified** on branch `claude/large-dataset-robustness`: **WG0** Phase 0 guardrails (Snowflake truncation warning, Excel OOM guard, sampling transparency, env caps, telemetry); **WG1** Phase 1 Parquet/DuckDB-over-blob keystone (flag `USE_PARQUET_READ_PATH`, default OFF — production unchanged); **WG1.1** adversarial-review fixes; **WG2.0** wired the Parquet writer hook into ingest (flag-gated) — the keystone read+write loop is now functionally complete behind the flag. **Deep plans authored, remaining waves not yet implemented:** Phase 2 native CSV/Excel/Snowflake streaming ingest (needs facet re-plumbing / parity fixtures / a live Snowflake connection), Phase 3 streaming serve (preview pagination + streamed exports), Phase 4 multi-tenant concurrency (Cosmos ETag + durable jobs), Phase 5 scale validation. **Gated externally:** Phase 1 prod-enable needs the one-time Vercel SAS-read spike (`server/scripts/spikeParquetReadPath.ts`) — the dual-branch fallback means it works either way.

- **Smarter analysis program (memory build-up · real insights · per-chart deep-dive):** OPEN, leverage-ordered. Plan [`/Users/tida/.claude/plans/resilient-inventing-koala.md`](file:///Users/tida/.claude/plans/resilient-inventing-koala.md). Origin: a brand-manager user reported (a) answers don't build on prior turns ("results aren't stored/accessed completely"), (b) insights read as observations not insights and recommendations as common sense not real suggestions, (c) no obvious-read business judgment (GT vs Q-com), (d) no per-chart "investigate further". Five workstreams: **A** durable memory recall, **B** smarter conclusions (ranking + why + anti-generic recommendation guard), **C** per-chart investigate→full deep-dive, **D** smarter suggested questions, **E** web-search enabler (free providers default-on). **Shipped:** W-MEM (A1–A3) recall-side memory fixes; W-INSIGHT (B1–B4) performance-standing block + observation→insight contract + recommendation-quality guard + channel maturity priors. W-CHARTDIVE (C1–C2) per-chart "Investigate further" → full deep-dive; W-SUGG (D1–D2) domain-aware decision-relevant suggested questions; W-WEB (E1) web search default-ON (free providers) + broadened external-claim detector. **All five workstreams (A–E) shipped.** Deploy note: W-WEB flips `WEB_SEARCH_ENABLED` to default-true — set `=false` to revert.

- **Data Summary semantic typing (W-SEM):** SHIPPED. One authoritative per-column `semantics` field (`dataSummary.columns[].semantics`) — deterministic [`columnSemantics.ts`](../server/lib/columnSemantics.ts) floor + dataset-profile LLM `perColumn` overlay — drives the Data Summary panel, the semantic model, and the chart-math additivity. Fixes int-encoded temporals being averaged (`Year`=26), ordinals summed (`fy_month_number`), single-date `Month` grain, ratios summed >100%, and 100%-blank columns surfaced as categoricals. `Volume(KL)`/`MRP` "wrongness" was real skew (audited against source), not ingest. Backward-compatible (optional field; legacy fallback). Reuses `LLM_PURPOSE.DATASET_PROFILE` (no routing drift); dataset-profile cache bumped v2. ADR [`centralized-column-semantics.md`](decisions/centralized-column-semantics.md); memory `project_data_summary_semantics`.

### Prior milestone — ALL CLOSED (preserved)

- **Workstream 7 — insight engine 2.0:** CLOSED at 6/6 (WI1–WI6). Per-tile insight regen, brush explain-slice, citations, recommendations, MRU history dropdown — all shipped.
- **WD2 — dashboard cross-filter:** CLOSED. All 15 chart kinds wired (visx + echarts). Dim mechanics on all marks.
- **WD3 — drill-through:** CLOSED. Server endpoint + client side-sheet + sheetId resolution for multi-sheet dashboards. Telemetry wired.
- **WI4 — explain-this-slice:** CLOSED at 4/4 brush-capable kinds (Line, Area, Bar, Point). sheetId resolution mirrored from WD3. Telemetry wired.
- **W61 — admin semantic-model editor:** CLOSED. Full CRUD: save/revert/delete/add endpoints, source provenance + filtering (global + per-section override), audit history with one-click revert, hierarchy level editor, schema-aware column + references editing, downstream-reference warning on delete, dashboard tile reference scanning.
- **WHov — hover cross-hair indicators:** CLOSED. LineRenderer + AreaRenderer ship the vertical cross-hair at snapped nearest-x. Convention codified at [`hover-crosshair-on-brush-capable-visx-renderer.md`](conventions/hover-crosshair-on-brush-capable-visx-renderer.md). BarRenderer cross-hair assessed and deprioritized (bars are their own visual anchors; per-bar tooltip already exists).
- **WS2 — pre-classify parallelization:** CLOSED. `kickOffPreClassifyWork` fires schemaBind + parseUserQuery + loadDomainContext concurrently, shaving ~300-500ms off cold-cache chat turns.
- **WV/WQ/WW — deterministic floor:** CLOSED. Verifier confidence checks, finding evidence formatting, effect-magnitude bucketing (correlation + price-elasticity), planner + narrator hints blocks, critic verdict confidence-overclaim wiring.
- **Wide-format classifier (W1–W4):** CLOSED for current scope. Melt pipeline, shape block, column resolver guard, pivot defaults, post-melt E2E pipeline all shipped. Future modal UX + ingest wiring (W14–W29) deferred indefinitely — will reopen only with a specific product ask.

## Known WIP / broken

None. All carry-forward items resolved:
- WD2-echarts test failures: realigned in WD2-echarts-test-realign (server tests at 100% pass rate since).
- wi4WiringArea test drift from WHov-area-crosshair: realigned same session.
- schemas.md staleness: acknowledged, non-blocking. Will refresh organically when schemas next change.

## Next wave

No planned next wave. The backlog is deliberately empty. All deferred items from prior sessions are closed or explicitly out of scope:

| Item | Status |
|---|---|
| BarRenderer cross-hair | Deprioritized — bars are their own anchors |
| ComboRenderer cross-hair | Deferred — needs tooltip infra first, low urgency |
| Cosmos aggregator (WD3-WI4) | Deferred — building blocks in place, no analytics ask |
| Hover-dwell-time tracker | Deferred — no observability ask |
| WT5 Monte Carlo tool | Deferred — needs Python service work + specific product ask |
| Streaming row payload (NDJSON) | Deferred — no perf complaint |
| WS2 latency series (W65) | Deferred — chatStream decomposition prerequisite |
| chatStream.service.ts decomposition | Deferred — needs refactor-justifying signal |
| WV7 segment-driver bucket | Deferred — needs domain-specific design |
| schemas.md doc refresh | Will refresh when schemas next change |

**Start new work from user observations and feature requests, not from this backlog.**

## Recent waves

Run `/orient` (it lists the last ~10 commits) or read `docs/WAVES.md` for full prose entries
(`docs/archive/` for older). A hand-maintained "last 5" list lived here and drifted — the orient
pack derives it live from `git log`, so it is no longer duplicated in this file.
