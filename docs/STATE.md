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

- **Large-dataset robustness (10M rows · multi-tenant · stay-on-serverless):** OPEN. Roadmap `/Users/tida/.claude/plans/goofy-wandering-quasar.md`. Root cause: a stateful "load all rows into a JS array" model on stateless Vercel serverless. **Shipped + verified** on branch `claude/large-dataset-robustness`: **WG0** Phase 0 guardrails (Snowflake truncation warning, Excel OOM guard, sampling transparency, env caps, telemetry); **WG1** Phase 1 Parquet/DuckDB-over-blob keystone (flag `USE_PARQUET_READ_PATH`, default OFF — production unchanged); **WG1.1** adversarial-review fixes; **WG2.0** wired the Parquet writer hook into ingest (flag-gated) — the keystone read+write loop is now functionally complete behind the flag. **Deep plans authored, remaining waves not yet implemented:** Phase 2 native CSV/Excel/Snowflake streaming ingest (needs facet re-plumbing / parity fixtures / a live Snowflake connection), Phase 3 streaming serve (preview pagination + streamed exports), Phase 4 multi-tenant concurrency (Cosmos ETag + durable jobs), Phase 5 scale validation. **Gated externally:** Phase 1 prod-enable needs the one-time Vercel SAS-read spike (`server/scripts/spikeParquetReadPath.ts`) — the dual-branch fallback means it works either way.

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
