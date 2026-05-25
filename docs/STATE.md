# Project state — Marico RAG Insighting Tool

> Auto-updated by `/wave-commit`. Read this **first** in every new chat (or run `/orient`).
> Last sync: 2026-05-25 — **Stable milestone.** All feature streams closed. All deferred items resolved or explicitly out of scope. Test suite at 100% pass rate. Ready for new observations and features.

## HEAD

- **Latest wave:** Wave WHov-area-crosshair (2026-05-25)
- **Branch:** `claude/wide-format-classifier`
- **Last commit:** `91ac98b1` (2026-05-25)
- **Working tree:** clean
- **Server tests:** 5022/5022 (100% pass)
- **Client vitest:** 420/420
- **Server typecheck:** 98 errors (baseline)
- **Client typecheck:** 53 errors (baseline)

## Feature streams — ALL CLOSED

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

## Last 5 waves (one line each — newest first)

- **WHov-area-crosshair** (2026-05-25) · Hover tooltip + vertical cross-hair on AreaRenderer. Full tooltip infrastructure + cross-hair line mirroring LineRenderer. Convention promoted. +98 LOC + 9 tests. Commit `6f62ee59`.
- **WHov-line-crosshair** (2026-05-22) · Vertical cross-hair indicator on LineRenderer at snapped nearest-x. +32 LOC + 7 tests. Commit `2fe54a95`.
- **WD2-echarts-test-realign** (2026-05-22) · Realigned 4 stale source-inspection tests to current renderer code. Zero code changes, test-only. Commit `04b707c3`.
- **WD2-line-cursor-parity** (2026-05-22) · LineRenderer cursor parity with AreaRenderer's 3-branch ternary. +17 LOC + 5 tests. Commit `0077324d`.
- **WI4-client-sheetId-resolution** (2026-05-22) · ExplainSlicePanel chartId disambiguation for multi-sheet dashboards. 2 conventions promoted. +12 tests. Commit `fd43cca1`.

For full prose entries: read `docs/WAVES.md`. For older entries: `docs/archive/`.
