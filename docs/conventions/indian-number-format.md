# Indian number format (₹ · Cr / Lac / K) is the display default

All data in this product is INR. Numbers are displayed in the **Indian numbering
system** everywhere — chat answers, Key Insights, chart axes, tooltips, magnitude
cards, dashboards, filter labels — using **Cr / Lac / K** with a **space before
the suffix**, and a **₹** prefix on currency-typed values. There is no `$`, `M`,
or `B` in user-facing output.

## Tier ladder (the gotcha: it is MIRRORED in four files, on purpose)

Server and client are separate packages, so the ladder is duplicated. When you
change one, change all four — each carries a cross-reference comment:

| File | Role |
|---|---|
| [`server/lib/formatCompactNumber.ts`](../../server/lib/formatCompactNumber.ts) | server narrative / insight magnitude authority |
| [`client/src/lib/charts/format.ts`](../../client/src/lib/charts/format.ts) | client `formatKMB` / `formatCurrency` / `formatChartValue` (chart axes, ₹ default) |
| [`client/src/lib/chartNumberFormat.ts`](../../client/src/lib/chartNumberFormat.ts) | chart tooltip values |
| [`client/src/lib/charts/chartFilterHelpers.ts`](../../client/src/lib/charts/chartFilterHelpers.ts) | field-blind filter-range labels |

Tiers: `|n| ≥ 1e7 → " Cr"`, `≥ 1e5 → " Lac"`, `≥ 1e3 → " K"`, `< 1e3 → plain`.
Magnitude decimals are adaptive — **1 dp when the scaled value ≥ 10, else 2 dp**,
trailing zeros stripped (so `1,049,389,992.94 → "104.9 Cr"`, `481,000 → "4.81 Lac"`).
Percent / duration / date / ordinal / sub-1000 branches are untouched.

## Two non-obvious coupling points

1. **The narrator's prose must round-trip through the verifier.** Once we *emit*
   "104.9 Cr" / "4.81 Lac", the hallucination guard
   [`verifyNarrativeNumbers.ts`](../../server/lib/agents/runtime/verifyNarrativeNumbers.ts)
   that parses numbers back *out* of narration must recognise the `Cr`/`Lac`
   suffixes (and the LLM prompt in `insightGenerator.ts` must instruct Indian
   format) — otherwise the auditor mis-reads the figure. Emitter and parser are a
   pair; change them together. (`magnitudeAudit.ts` needs no change — it
   recomputes from rows, never parses prose.)

2. **Bare numbers get magnitude words, currency-typed values get ₹.** Field-name
   inference (`formatChartValue`) adds ₹ for currency columns; the narrator adds ₹
   in prose; but a context-free bare number (e.g. a row count, or a raw number the
   narrator emitted) only gets the Cr/Lac/K word — never assume a bare number is
   money. `compactizeNumbersInText` (the prose compactor wired into
   [`insightText.tsx`](../../client/src/lib/insightText.tsx) so Key-Insights stop
   showing full-precision digits) maps any stray `$` to `₹`, since data is INR-only.

Row counts ([`datasetScopeFacts.ts`](../../server/lib/datasetScopeFacts.ts)) use
Cr/Lac/K words but **no ₹** (a count is not money) and stay integer-leaning.
