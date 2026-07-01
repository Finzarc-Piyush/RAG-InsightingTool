# Centralized per-column semantic-type authority (`classifyColumnSemantics`)

**Status:** Accepted · Wave W-SEM

## Context

A brand-manager uploaded a wide Channel-P&L Excel and the **Data Summary** panel
was confidently wrong on almost every column, because column *type* was decided by
naive value-shape heuristics ([`fileParser.ts` `createDataSummary`](../../server/lib/fileParser.ts))
and the panel ([`richColumnProfile.ts` `buildRichDataSummary`](../../server/lib/richColumnProfile.ts))
then computed mean/sum for **every** numeric-typed column, ignoring the semantic
signals that already existed on `dataSummary.columns[]` (`additivity`,
`temporalDisplayGrain`). Symptoms:

- `Year` (stored as the int `26` = FY2026) → "Numeric", averaged.
- `fy_month_number` (all `1`) → "Numeric", summed.
- `Month` (a single date) → grain "Daily / weekly" (single-point `inferTemporalGrainFromDates` → `dayOrWeek`).
- margins / `Primary Scheme` → summed → nonsense **>100%** totals.
- `month`, `UGST`, `GST Refund` (100% blank) → surfaced as normal categoricals.
- `Volume (KL)` / `MRP Value` → absurd-looking mean/sum. (An audit against the
  source blob confirmed the VALUES are correct — the numbers are real right-skew
  from mixing Brand×Channel line items, not an ingest bug.)

The user's directive: *"give this to an LLM to figure what column is what type —
use the column NAME and the VALUES inside it."*

## Decision

One authoritative per-column classification, `semantics`, on
`dataSummary.columns[]`:

```
semanticType: temporal_date|year|month|quarter | ordinal | identifier
            | categorical_dimension | measure_additive|ratio_percent|per_unit
            | currency_amount | boolean_flag | empty
aggregation:  sum | avg | none        // sum only for additive/currency
displayKind:  numeric|date|categorical|boolean|ordinal|empty
temporalGrain?, source, confidence?
```

- **Producer (single authority):** [`columnSemantics.ts` `classifyColumnSemantics`](../../server/lib/columnSemantics.ts)
  (deterministic floor, `SEMANTIC_TYPE_POLICY` maps `semanticType → {aggregation,
  displayKind}`), stamped at parse in `createDataSummary`, then refined in
  [`uploadQueue.ts`](../../server/utils/uploadQueue.ts) once additivity + indicators
  are known and OVERLAID by the dataset-profile LLM's new `perColumn` output
  (`overlayLlmSemantics` — refines but never DEMOTES a hard signal:
  empty/currency/ratio/boolean win). Reuses `LLM_PURPOSE.DATASET_PROFILE` — **no
  new LLM purpose**, so zero `llmCallPurpose` / `llmRoutingRegression` / `llmStub`
  drift. Deterministic floor + best-effort LLM keeps startup non-blocking.
- **Consumers:** the Data Summary panel (`buildRichDataSummary` routes on
  `displayKind`, aggregation-aware `buildNumericProfile` nulls illegal
  sum/mean, `buildEmptyProfile`, `empty` tally); the semantic model
  ([`inferModel.ts`](../../server/lib/semantic/inferModel.ts) — int-encoded
  temporals + ordinals become DIMENSIONS not metrics, ratios AVG'd); the chart
  math (durable `additivity` back-filled from semantics in `uploadQueue`, so a
  ratio the finance catalog missed by name is still never SUMMED by
  `resolveAggregation`); the Data Summary display grain via
  [`displayGrainForColumn`](../../server/lib/temporalGrain.ts) (name/type first,
  single-point → `null`, never `dayOrWeek`).
- **Backward compatible:** `semantics` is optional; sessions without it fall back
  to the exact prior numeric/date-membership routing. Dataset-profile cache
  schema bumped 1→2 so old cached profiles recompute once.

## Why the chart-axis authority is NOT changed

[`temporalGrainAuthority.resolveTrendGrain`](../../server/lib/temporalGrainAuthority.ts)
(invariant #11) is deliberately span/materialized-facet driven and metadata-free.
The semantic grain reaches the analysis through the semantic model's temporal
dimensions and the Data Summary display helper — a name-based override inside the
axis authority would contradict its stated design. Invariant #11 is preserved.

## Consequences

- Simple + correct: `Year`/`Month`/`Quarter`/`fy_month_number` present as
  time/ordinal (no mean/sum), ratios never summed, empties grouped, real measures
  keep honest (skew-aware) stats.
- Latent numeric-parse bugs fixed defensively via shared `parseNumericCell`:
  accounting `(1.5)` → -1.5 (was +1.5); full-column sum/min/max computed BEFORE
  the endpoint's row down-sample (was silently scaled on >300k-row datasets).
- New surface to maintain: the `semanticType` enum + policy table. Adding a type =
  one enum entry + one `SEMANTIC_TYPE_POLICY` row + a classifier branch.

See also: [`docs/decisions/centralized-temporal-grain.md`](centralized-temporal-grain.md),
[`docs/decisions/centralized-query-intent.md`](centralized-query-intent.md),
[`docs/conventions/metric-additivity.md`](../conventions/metric-additivity.md).
