# Convention — no domain "context" framing in user-facing output

**Rule:** the product no longer **generates or renders** the two domain-framing
fields. Charts, dashboards, the chat answer card, the memory journal, and deck
exports show analysis only — no "Business context" / "Industry context" / Marico
pack framing.

## The two retired fields

| Field | Was rendered as | Status |
|---|---|---|
| `businessCommentary` (on `chartSpec`) | a "**Business context:**" block under a chart's Key Insight (chat charts, dashboard tiles, both zoom modals) | **not generated, not rendered** |
| `domainLens` (on the answer envelope) | an "**Industry context**" box in [`AnswerCard`](../../client/src/pages/Home/Components/AnswerCard.tsx) + a muted italic line in the dashboard [`AnalysisSummaryPanel`](../../client/src/pages/Dashboard/Components/AnalysisSummaryPanel.tsx) | **not generated, not rendered** |

## What changed

- **Generation off.** [`insightGenerator.generateChartInsights`](../../server/lib/insightGenerator.ts) no longer asks for / parses `businessCommentary` (the `domainBlock` that fed it is gone). The narrator/synthesizer no longer emit `domainLens` ([`sharedPrompts.ts`](../../server/lib/agents/runtime/sharedPrompts.ts) instruction removed; [`agentLoop.service.ts`](../../server/lib/agents/runtime/agentLoop.service.ts) no longer sets `env.domainLens`; the budget-optimizer `buildDomainLensFromBudgetOptimizer` fallback is no longer wired).
- **Completeness gate relaxed in lockstep.** [`checkEnvelopeCompleteness`](../../server/lib/agents/runtime/checkEnvelopeCompleteness.ts) no longer **demands** `domainLens` (it dropped its 3rd `domainContextWasSupplied` param). This MUST stay relaxed — otherwise the repair loop course-corrects forever chasing a field that is never produced. `checkDomainLensCitations` is left in place (it early-returns when `domainLens` is absent) as a defensive guard for legacy/persisted data.
- **Render off.** The shared [`ChartInsightBody`](../../client/src/components/charts/ChartInsightBody.tsx) no longer has a `businessCommentary` prop/block (kills it on every chart surface at once); the `domainLens` render sites are removed, and an invisible `domainLens` no longer counts toward "has summary content" gates.

## Invariants when touching this

- **Schema fields stay `optional` for back-compat.** `businessCommentary` (in `chartSpecSchema`) and `domainLens` (in the message + dashboard envelope schemas + `narratorOutputSchema`) remain declared so already-persisted chats/dashboards still validate and load. Do **not** re-add generation or rendering.
- **Background domain knowledge is NOT removed.** `ctx.domainContext` (the FMCG/Marico packs) still feeds analytical reasoning — `hypothesisPlanner`, `businessActionsAgent`, `runHypothesisAndBrief`, `pivotEnvelope`, dataset profiling, etc. The retirement is only of the two **user-visible framing blocks**, not the analysis engine's domain priors.
- **MMM note:** budget-optimizer answers previously surfaced model methodology via `domainLens`; that blurb is gone with this change. If MMM methodology must resurface, route it to the envelope's `methodology` field, never back into `domainLens`.

See `docs/WAVES.md` (2026-06-23) for the full change set.
