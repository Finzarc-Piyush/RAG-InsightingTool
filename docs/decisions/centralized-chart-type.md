# ADR · One authority for the line-vs-bar chart-type decision

**Status:** Accepted — 2026-06-21
**Siblings:** [`centralized-temporal-grain`](centralized-temporal-grain.md) (which GRAIN), [`centralized-query-intent`](centralized-query-intent.md) (which DEPTH), [`centralized-chart-builders`](centralized-chart-builders.md) (shared leaf builders).

## Context

A chart whose x-axis is a time axis must be a **line** (a progression); a categorical
breakdown must be a **bar** (a ranking). That decision was re-implemented inline in several
builders with **non-uniform inputs**:

- [`chartFromTable.ts`](../../server/lib/agents/runtime/chartFromTable.ts) tested
  `dateColumns.includes(x) || isTemporalFacetColumnKey(x) || periodAxis.pickedColumn` → correct.
- [`dashboardFeatureSweep.ts`](../../server/lib/agents/runtime/dashboardFeatureSweep.ts)'s
  dimension loop only guarded raw date columns (`dateCols.has(t)`) and never the temporal
  **facet** keys, so it charted `Day · Date` / `Week · Date` as **bars** (`aggregate: mean`).
- The `build_chart` tool took the LLM's `type` verbatim — a proposed temporal bar shipped.
- [`verifier.ts`](../../server/lib/agents/runtime/verifier.ts) flagged `BAR_ON_TEMPORAL_X` but,
  per the single-flow policy (invariant #6), only emits a `flow_decision` — it never rewrites.

Temporal facet columns (`<Grain> · <SourceDate>`) are materialized into `summary.columns` as
`type:"string"` (by `temporalFacetMetadataForDateColumns` in [fileParser.ts](../../server/lib/fileParser.ts)) and are absent from
`summary.dateColumns`. So any builder that classified columns by `dateColumns`/`numericColumns`
treated them as categories. Net symptom: `Compliance Visit (avg) by Day · Date` rendered as a
**bar**, while the same facet through `chartFromTable` rendered as a **line** — the L-019
anti-pattern (a single authority needs uniform inputs; here there wasn't even one authority).

## Decision

Introduce one leaf authority [`server/lib/chartTypeAuthority.ts`](../../server/lib/chartTypeAuthority.ts):
`isTemporalChartX(x, { dateColumns, periodAxisPicked? })` and `resolveChartType(x, …)`. Every
builder consults it with the SAME temporal inputs:

- `chartFromTable` resolves type through it (behaviour preserved).
- the feature sweep treats a temporal-facet dim as a **line** (never a bar), skips top-N/Other
  bucketing (meaningless on a time axis), and aggregates **metric-aware** (rate→`mean`,
  count→`sum`); `tryBuildChart` decouples `aggregate` from `type`.
- the `build_chart` tool **coerces** a temporal-x bar to a line at construction (in-policy
  argument normalization, like its existing `grain` remap — NOT a flow override).
- the verifier's guard uses the same predicate and stays a **visibility** backstop only.

Module placement is deliberately a thin leaf (imports only `isTemporalFacetColumnKey`) so the
boolean predicate never drags the grain machinery into lightweight consumers.

## Consequences

- Temporal columns render as lines on every path — chat auto-promotion, the deterministic
  dashboard/breadth sweep, and LLM-proposed `build_chart`.
- The fix lives at **construction** (sweep + build_chart); the verifier stays flag-only, so the
  single-flow policy (invariant #6) is untouched.
- Chart *breadth* is unchanged — only the type (and, for temporal facets, the aggregate) changes.
- Adding a new chart builder: call `resolveChartType` / `isTemporalChartX`; do not re-derive
  "is x temporal" inline. See lesson L-026.
