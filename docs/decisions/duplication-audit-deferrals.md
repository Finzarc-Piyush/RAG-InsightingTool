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
- **mergeAggregatedResults:** chartGenerator (single-column) vs dataTransform
  (multi-column with conditional / percent_change ops) — incompatible signatures.
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
