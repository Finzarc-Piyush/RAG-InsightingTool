# Centralized metric-semantics authority (`financeMetricAuthority`)

**Status:** Accepted · Waves W1–W12 (finance-aware insighting)

## Context

Finance/P&L datasets surface metrics of two fundamentally different kinds — **absolute
amounts** (Net Revenue, COGS, Gross Contribution, volume — additive) and **ratios /
percentages / per-unit** values (GC%, margin %, EBITDA %, realization, growth %, mix % —
NON-additive). The codebase had no notion of this distinction. Every chart and insight
path re-guessed it from its own fragile name-regex:

- `chartSpecCompiler.NON_ADDITIVE_METRIC_RX`, `dashboardFeatureSweep.RATE_METRIC_RX`, and
  the pivot's `isRateMetric` — three drifting `\b…\b` regexes that **never matched the
  literal `%`** (the word boundary can't), so a column literally named `GC%` was treated
  as additive and **SUMMED across channels** ("sum of GC% for 6 channels = 280%").
- No path knew that GC% is *defined* as `(NR − COGS)/NR`, so the insight layer reported
  "GC% is impacted by Net Revenue" — an accounting identity dressed up as a discovery.

## Decision

One pure authority — [`financeMetricAuthority`](../../server/lib/financeMetricAuthority.ts)
— is the SOLE source of metric semantics. It owns the canonical FMCG/P&L term registry
(`FINANCE_TERMS`: kind, additivity, each ratio's numerator/denominator) and the waterfall
identities (`FINANCE_IDENTITIES`), and exposes two coherent views:

- **Additivity (charting):** `normalizeMetricTokens` (the `%`→`pct` / `&`→`and` rewrite the
  three regexes lacked), `classifyMetric`, `isNonAdditiveMetric`, and `aggregationPolicyFor`
  → an `AggPolicy` on the ladder **recompute (Σnum/Σden) → weighted_mean → mean** for
  non-additive metrics; `sum` only for additive ones. A ratio is NEVER summed.
- **Relatedness (causation):** `buildIdentityGraph` (finance-ontology layer that fires on
  raw uploads, plus a semantic-model expression layer) and `areStructurallyRelated(a,b)` —
  a pure lookup that flags a definitional link (numerator/denominator/component/part-of-total/
  product-factor). Plus `gradeFromEvidenceKind` so a claim's causation grade is read from the
  EVIDENCE behind it, not its prose.

Decision order in `classifyMetric`: **structured hint (semantic-model `format`/`expression`)
→ registry term → conservative catch-all token → additive default.** The catch-all keeps
the migration a strict superset of the old regexes (no regression).

Every chart builder, the correlation tool, the narrator verifier, and the prompt builder
delegate here — none carries a private rate regex or re-derives identities. Machine-verified
by invariant **I13** in [`invariants.spec.ts`](../../server/scripts/invariants.spec.ts).

## Consequences

- "Sum of GC%" is structurally impossible: a non-additive metric resolves to recompute /
  weighted-mean / mean, never sum, at the one place the aggregation math runs.
- Definitional relationships (GC%↔NR) are filtered from correlation, blocked in the verifier,
  and named in the prompt — three seams that can't diverge because they read one graph.
- A decomposition between structurally-related metrics (RM-cost → GC%) stays **exempt** from
  the identity block (it is a real, quantified attribution) — guarded by the `grade !==
  "decomposition"` condition. This is the key anti-over-suppression invariant.
- Generic FMCG/P&L conventions are encoded (no company-specific spec); robust alias matching
  resolves "GC%", "GC %", "gc_pct", "Gross Contribution %" to one canonical term.
