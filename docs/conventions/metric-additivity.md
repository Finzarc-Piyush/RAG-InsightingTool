# Metric additivity — never SUM a ratio

**The gotcha:** percentages, ratios, per-unit values, growth %, share % and mix % are
**not additive**. Summing them across categories or periods is meaningless ("sum of GC%
for 6 channels"). The correct aggregation of a ratio across a group is to **recompute it
from its summed parts** (GC% by channel = `Σ GC / Σ NR`), or — when the parts aren't on the
frame — a weighted average, or a plain mean as a last resort.

**The rule:** never decide a metric's aggregation (or additivity, or layout) with a local
regex. Always delegate to [`financeMetricAuthority`](../../server/lib/financeMetricAuthority.ts):

- `isNonAdditiveMetric(name, semanticEntry?)` — the thin-view predicate (replaces the old
  `NON_ADDITIVE_METRIC_RX` / `RATE_METRIC_RX` / `isRateMetric`).
- `aggregationPolicyFor(name, { frameColumns })` → `AggPolicy` — the recompute → weighted_mean
  → mean → sum ladder. Pass the frame's columns so recompute can find the numerator/denominator.

**Why a regex won't do:** the matcher must handle the literal `%` (`normalizeMetricTokens`
rewrites `%`→`pct`), FMCG vocab (GC, contribution, realization, ASP, mix), and the
structured semantic-model `format`/`expression` signal — none of which a `\b…\b` regex covers.

**Layout corollary:** a non-additive series is always `grouped`, never `stacked` (a stacked
"% total" is nonsense). `defaultBarLayout` enforces this via the authority.

**Persisted signal:** enrichment stamps `DataSummary.columns[].additivity` so the chart math
has the durable answer even where the semantic model object isn't on the context.
