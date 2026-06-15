# Duplication audit (2026-06) — items deliberately NOT consolidated

## Context
The Dup1–Dup7 waves consolidated the *safe* duplications found in the 2026-06
duplication audit (two passes: 27 + 10 confirmed findings). The items below were
assessed and **deliberately left** because consolidating them would change
behavior or merge things that are only superficially alike — i.e. they conflict
with "don't break anything". Don't re-flag them as fresh dedup work without an
explicit behavior-change decision.

## Decision: leave (behavior-changing)
- **C2 — dataLoader currency:** `utils/dataLoader.ts normalizeNumericColumns`
  uses a naive currency regex, not `stripCurrencyAndParse`. Swapping changes the
  reload-path coercion semantics and no test pins equivalence.
- **C3 — date re-canonicalization:** `canonicalizeDateColumnValues` runs on
  several load branches. Making it path-aware (skip already-canonical loads) is
  an optimization with re-parse-path risk; it's mostly idempotent today.
- **B11 — column-name trim:** `fileParser.normalizeColumnNames` (batch + column
  mapping + early-exit) vs `streamingFileParser`'s per-row inline `key.trim()`
  are different implementations of the same intent; merging changes the streaming
  path's behavior/per-row perf.
- **C4 — ID-column heuristics:** local `ID_NAME_RE` (richColumnProfile) and
  `looksLikeIdColumn` (datasetScopeFacts) have narrower coverage than canonical
  `columnIdHeuristics.isLikelyIdentifierColumnName`; unifying changes ID detection
  in UI hints.
- **C5 — calendar-day dedup:** `temporalGrain.uniqueSortedDates` (Date[], key
  `YYYY-M-D`), `richColumnProfile` (Set via `toLocalIsoDay`), and `fileParser`
  (Set via ISO slice) use different key formats; a shared util would have to carry
  all variants.

## Decision: leave (intentional separation — not the same thing)
- ~~**mergeAggregatedResults:** chartGenerator vs dataTransform.~~ **RESOLVED — no
  longer a duplication.** The chartGenerator single-column `mergeAggregatedResults`
  was deleted as dead code in Wave Dup2b (commit `4daa07f4`, 2026-06-13). Only
  `dataTransform.mergeAggregatedResults` (multi-column groupBy + conditional /
  percent_change ops) remains, and it has no twin. (Re-confirmed by the 2026-06-14
  multi-agent re-audit; this bullet was stale.)
- **Temporal grain pickers:** `inferTemporalGrainFromDates` (display grain, median
  inter-date gap) vs `pickTrendGrainForSpan` (SQL aggregation grain, total span) —
  different metric and output; merging would invert the display→planner dependency.
- **D-out — outlier detection:** TS `anomalyDetection` (IQR/Z-score; agent tool,
  gated by `ANOMALY_DETECTION_ENABLED`) vs Python `data_operations.identify_outliers`
  (also IsolationForest/LOF). ~20% overlap; Python is the authoritative richer path.
  Rewiring TS→Python is an architecture change, not a dedup.
- **computeGrowthTool.applyDimensionFiltersInMemory:** a Set-based multi-filter
  variant, left in place when `passesFilter` was extracted to `dimensionFilterMatch.ts`.

## Not actually duplicated (critic suspicions — checked and cleared)
- **assertDataApiAccess** and **pivotEventDedupe (TTL dedupe)** are each defined
  once in `routes/dataApi.ts` and used many times *within that one file* — single-use
  helpers, no cross-file duplication to extract.

## Consequences
The remaining duplication surface is intentional. A future "two codes doing the
same thing" sweep that re-surfaces these should consult this file first; acting on
any of them requires owning the behavior change (and, for C1-adjacent ingest items,
coordinating with the large-dataset-robustness workstream).

---

# Charting/pivot consolidation audit (2026-06-14)

A second multi-agent audit (charting · pivot · formatting · sampling · exports)
found the heavy logic already centralized (`chartGenerator.processChartData`,
`chartSpecCompiler.compileChartSpec`, `temporalGrainAuthority`,
`queryIntentAuthority`, the `server/shared/pivot/*` re-export shims). The thin
glue / copied constants / copied helpers WERE consolidated — see
[`centralized-chart-builders.md`](./centralized-chart-builders.md). Items
below were assessed and **deliberately left**.

## RESOLVED 2026-06-14 — the two actionable deferrals are now done

- **visualPlanner deterministic fallback now *calls* `buildChartFromAnalyticalTable`.**
  The fallback in [visualPlanner.ts](../../server/lib/agents/runtime/visualPlanner.ts)
  no longer re-implements the column-split → x-pick → type → compile flow. It was
  extracted into an exported `buildDeterministicFallbackChart(ctx, existingCharts)`
  that delegates the whole build to [chartFromTable.ts](../../server/lib/agents/runtime/chartFromTable.ts)
  `buildChartFromAnalyticalTable` and then re-applies the ctx-aware
  `validateChartProposal` guard. `{charts, note}` packaging is preserved; a built
  fallback chart now deep-equals `buildChartFromAnalyticalTable`'s output for the same
  table (pinned by an equivalence test — that IS the no-drift guarantee). The
  rate-frame y-pick and multi-series Y-domain corrections relative to pre-centralization
  code are owned by the companion [`centralized-chart-builders.md`](./centralized-chart-builders.md)
  wave (the shared `chartMeasurePick` + `chartSpecFinish` leaves), not by this
  delegation. Three deliberate,
  documented behavior deltas: (1) a 1-row scalar frame now returns `null` (delegated
  scalar guard); (2) a no-usable-dim frame returns `null` → caller falls through to
  the LLM (was an early `return {charts:[]}`; the in-code comment already said it
  SHOULD fall through, and minimal-depth asks are still short-circuited by the
  `depthBudget` gate that runs after the fallback); (3) a compile/parse throw is now
  caught → `null` (was an uncaught throw). Golden-replay coverage:
  `visualPlannerDeterministicFallback.test.ts` (battery + fallback≡promotion
  equivalence) and the rewritten `visualPlannerPeriodResolverParity.test.ts`
  (delegation tripwire). See [`centralized-chart-builders.md`](./centralized-chart-builders.md).

- **`analyticalChartSpec.mergeDeterministicAnalyticalCharts` deleted as dead code.**
  Confirmed fully dead: no live importer anywhere in the repo (the file's own comment
  claiming `dataAnalyzer.ts` imported it was stale). The only references were itself
  and a source-text pin in `chartInsightsSynthesisContextB3.test.ts`. The whole file
  `analyticalChartSpec.ts` (in `server/lib/`) was removed; its sole forward-compat
  `synthesisContext` pin was dropped while the FOUR live-caller pins
  (chatStream/chat.service/sessionController/correlationAnalyzer) stay. The misnamed
  `analyticalChartSpec.test.ts` (it always tested `analyticalChartBuilders`) was
  renamed to `analyticalChartBuilders.test.ts`.

## Not consolidated (verified distinct — do not re-flag)
Re-verified 2026-06-14 by a second multi-agent re-audit; each below stays separate.
- Three client K/M/B formatters (`format.ts:formatKMB` field-aware (with a T tier)
  vs `chartFilterHelpers.formatAxisLabelFieldBlind` vs
  `chartNumberFormat.formatChartTooltipValue`) — genuinely different precision /
  tier / input contracts (e.g. `45.678` → `45.7` vs `45.68`; `0.001` → `0.0` vs
  `0.0001`). Not one formatter.
- DuckDB SQL aggregation vs `dataTransform` in-memory aggregation — a SHARED contract
  (same operations + output aliases via `outputAliasForAgg`) with two deliberately
  different *implementations*: one compiles to SQL strings (`SUM(TRY_CAST(...))`) for
  DuckDB, the other runs a JS reduce/loop over loaded arrays. The evaluation bodies
  are not shareable; only the op-list/alias naming is, and that already is. A
  re-audit agent suggested a "shared evaluator" — rejected: the SQL-string builder and
  the JS evaluator have nothing executable in common.
- Reservoir sampling (Algorithm-R) in `streamingFileParser` (counts ALL rows) vs
  `streamingCorrelationAnalyzer` (counts only post-validation valid pairs) — a generic
  ~5-line algorithm with *different counter universes*; a shared helper would have to
  thread that distinction and risks off-by-one. Not worth extracting.
- v1 `ChartRenderer` heatmap `colorAt` (inline HSL, hue 210) vs
  `palette.sequentialColor` — legacy renderer mid-migration; different ramps.
- `routes/dataApi.ts` `assertDataApiAccess` / `pivotEventDedupe` — defined once, used
  many times *within that one file*; no cross-file duplication to extract (a re-audit
  agent's "merge with `loadChatForDataSession`" is a different refactor, not a dedup).

## Identical-but-deliberately-mirrored (accurate reason, see below)
- **Client/server `parseNumericCell`.** `pivotQueryService.parseNumericCell` (server,
  private) and `formatAnalysisNumber.parseNumericCell` (client, exported) are
  **byte-for-byte identical** — same currency set `$€£¥₹`, same `( )`-negative
  handling, same `parseFloat`/finite checks. The earlier note that they "split by
  char-set policy" was inaccurate: there is NO policy difference. They are a DELIBERATE
  cross-runtime mirror (keep client and server cell-parsing bit-identical). Because the
  parser is pure, it is a clean candidate for one `shared/` module both sides import
  (zero behavior risk) — but that is a client+server change outside the charting
  surface and is left to its own small wave, not folded into a charting dedup.
