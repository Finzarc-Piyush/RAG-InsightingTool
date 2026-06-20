# Incremental data refresh ("Update data")

> Behind `INCREMENTAL_REFRESH_ENABLED` (server) + `VITE_INCREMENTAL_REFRESH_ENABLED` (client), both default OFF.
> Shipped as Waves WR0–WR8 (2026-06-19) + v1.1 WR9–WR13 (2026-06-20). Plan: `/Users/tida/.claude/plans/an-extremely-new-functionality-pure-graham.md`.

## What it is

Bring new data into an **existing** chat/dashboard and faithfully regenerate everything — charts, dashboard tiles, insights, recommendations, summary — on the new data. The user picks one of two operations:

- **Replace** — the new file is the complete latest dataset; it supersedes the current data.
- **Append** — the new rows are added to the current rows; the whole analysis is recomputed on the **full combined** dataset (e.g. Jan + Feb), with key-based dedup (NEW wins, so an accidental re-upload doesn't double-count).

For **Snowflake**-sourced sessions, a one-click "Fetch latest" re-queries the same table (= Replace).

"Faithful" regeneration = the same questions/charts/dashboard the user already built, re-run and re-narrated **live** on the new numbers. A fresh planner pass that could surface NEW questions is a v1.1 follow-up.

## The keystone — reuse the automation replay engine

This is ~70% a re-target of the existing **automation capture→replay** system. The replay loop already re-runs a recipe of saved plan steps against new data and re-runs the narrator live.

- [`buildRecipeFromChat`](../../server/lib/automations/buildRecipeFromChat.ts) — captures the chat's Q&A + plan steps + dashboard drafts + transforms into a recipe (no persistence needed).
- [`replayRecipe`](../../server/lib/automations/replayLoop.service.ts) (extracted from `replayAutomation` in WR1) — the shared deterministic core. Takes an in-memory `RecipeSource` + `mode`:
  - `append-messages` → automation replay onto a new session (unchanged).
  - `overwrite` → in-place refresh: snapshot prior messages/charts into `messageVersions`, truncate to the welcome prefix, then re-run each turn. `rebindDashboardDraftCharts` rebinds dashboard charts to fresh data by axis-aware `chartIdentityKey` (WR5 — fixes the L-010 same-title collision).

## Server flow ([refreshSession.service.ts](../../server/lib/refresh/refreshSession.service.ts))

1. **Lease** — `acquireTurnLease` (exclusive; 409 if a live turn/refresh is running — a refresh swaps the dataset under the agent).
2. **Capture recipe from the PRE-ingest chat** (April schema) so column drift maps April→new correctly.
3. **Ingest** — Replace: [`ingestReplaceFromRows`](../../server/lib/refresh/ingestNewVersion.ts) (`prepareRefreshRows` runs the saved `datasetProfile` upload pipeline → `saveModifiedData` swaps the blob, bumps version, schedules RAG reindex). Append: [`ingestAppendFromRows`](../../server/lib/refresh/unionAppend.ts) (`loadLatestData` ⊕ new, `inferBusinessKey` dedup) then the same save.
4. **Replay** — `replayRecipe(overwrite)` against the swapped data.
5. **Dashboard** — [`reversionDashboardForRefresh`](../../server/lib/refresh/reversionDashboard.ts) overwrites the existing dashboard IN PLACE (same id) from the regenerated draft, stamping `dataRefreshSource`.
6. **Failure** — roll the whole session (data blob + summary + messages + charts) back to its pre-refresh state; `refreshState: failed`.

## Endpoints ([refreshController.ts](../../server/controllers/refreshController.ts) / [routes/refresh.ts](../../server/routes/refresh.ts))

- `POST /api/sessions/:id/refresh/preflight` — multipart; returns the diff (rows/cols before→after), the column-mapping dry-run, the inferred append key, and a recipe summary. No mutation.
- `POST /api/sessions/:id/refresh` — multipart; SSE. Commits a file refresh. `discover=true` adds the WR11 fresh-planner pass.
- `POST /api/sessions/:id/refresh/snowflake` — JSON; SSE. One-click Snowflake re-query.
- `GET /api/sessions/:id/refresh/history` · `POST …/rollback` — WR10 version badge + undo.
- `GET /api/sessions/:id/refresh/compare` — WR12 prior-vs-current per-chart deltas.
- `PUT /api/sessions/:id/refresh/schedule` · `POST /api/cron/refresh` — WR13 schedule + the `CRON_SECRET`-secured Vercel-cron entry.

SSE reuses the automation events (`automation_started/progress/halted/complete`) + a final `refresh_complete`, so the existing `AutomationReplayBanner` renders them.

## v1.1 (WR9–WR13)

- **WR9 Parquet sibling** ([ingestNewVersion.ts](../../server/lib/refresh/ingestNewVersion.ts) `maybeWriteRefreshParquet`) — flagged by `USE_PARQUET_READ_PATH`; keeps the durable Parquet aligned after a swap.
- **WR10 rollback** ([rollbackRefresh.service.ts](../../server/lib/refresh/rollbackRefresh.service.ts)) — the newest `messageVersions` snapshot carries prior data + messages + (WR12) prior dashboard charts; rollback restores all three and pops it.
- **WR11 discovery** ([discoverNewInsights.ts](../../server/lib/refresh/discoverNewInsights.ts)) — opt-in full-planner pass appending net-new turns on the combined data.
- **WR12 compare** ([compareVersions.ts](../../server/lib/refresh/compareVersions.ts)) — per-chart total + %Δ, matched by `chartIdentityKey`.
- **WR13 schedule** ([scheduledRefresh.service.ts](../../server/lib/refresh/scheduledRefresh.service.ts) + `findDueScheduledRefreshes`) — hourly cron re-queries due Snowflake sessions.

## Client ([refresh.ts](../../client/src/lib/api/refresh.ts) + [RefreshDataModal.tsx](../../client/src/pages/Dashboard/Components/RefreshDataModal.tsx))

"Update data" split-button in `DashboardHeader` → `RefreshDataModal`: pick file → preflight diff + Replace/Append cards → reuses **`AutomationRemapDialog`** verbatim for column drift → inline SSE progress → in-place reload (same dashboard id, refetch shows it updated). Snowflake source skips the file pick.

## Persisted state

- `ChatDocument.snowflakeSource` — `{database, schema, tableName, …}` pointer (connection stays env-based; no secret-at-rest). Stamped at the Snowflake understanding-ready checkpoint in [uploadQueue.ts](../../server/utils/uploadQueue.ts).
- `ChatDocument.refreshState` — `running | complete | failed` (+ version transition). `running` gates concurrent refreshes/turns.
- `ChatDocument.messageVersions` — capped snapshots of prior conversations for rollback coherence.
- `ChatDocument.dataVersions[].label` — human "as of …" label per data version.
- `dashboardSchema.{dataRefreshSource, supersedes/supersededByDashboardId}` — on the STRICT write schema (L-021).

## Invariants honored

- All contended chat writes via `mutateChatDocument` (#9). ESM `.js` imports (#2). Tool/skill registries untouched. The single-flow policy is unaffected (refresh is its own gated path, not a planner override).
