# Centralized query-intent authority (`classifyQueryIntent`)

**Status:** Accepted · Wave QI1

## Context

Two user-facing problems shared one root cause.

1. **Over-answering.** A simple question ("what is the average X per Y?", "which
   region has the most sales?") still returned a "plethora" — extra charts, an
   unsolicited dashboard offer, recommendations, "investigate further" chips, and
   long implications/methodology sections. The live routing order is
   `tryDirectAnswer` → `tryQuickAnswer` → full loop
   ([agentLoop.service.ts](../../server/lib/agents/runtime/agentLoop.service.ts)).
   Both fast paths are conservative regex gates that bail on any analytical
   phrasing; once they bail, the **heavy loop was the unconditional default** and
   every enrichment stage (`proposeAndBuildExtraCharts`, the dashboard "offer",
   the feature sweep, the spawned-followup fan-out) fired with **no reference to
   how simple the question was**. The only complexity signal —
   `isDirectFactualQuestion` — was applied late, at two sites, and gated only two
   text fields; it was even bypassed by a parallel `followUpPrompts = envCtas`
   assignment in the shared scope and by the verifier-revise branch.

2. **Inconsistent verdicts from duplication.** The predicate "is this analytical
   vs a plain lookup?" was hand-coded with **divergent** word lists in at least
   eight places — `quickAnswerDetector` (`ANALYTICAL_DENYLIST_REGEX`),
   `isDirectFactualQuestion` (`NON_FACTUAL_CUES`), `analysisSpecRouter`
   (`DIAGNOSTIC_RE`), `decompositionGate`, `detectMultiPartQuestion`,
   `errorRecovery`, and dead copies. The same sentence came out "simple" to one
   gate and "analytical" to another (e.g. *"what is the growth in revenue"* was
   flagged by `NON_FACTUAL_CUES` but **not** by `ANALYTICAL_DENYLIST_REGEX` — the
   fall/drop/growth asymmetry). No `QueryComplexityAuthority` existed, unlike the
   precedent set for chart grain by [`temporalGrainAuthority`](centralized-temporal-grain.md)
   (invariant #11).

## Decision

One pure authority —
[`queryIntentAuthority.classifyQueryIntent`](../../server/lib/agents/runtime/queryIntentAuthority.ts)
— classifies a question **once** into an intent class
(`conversational`/`metadata`/`lookup`/`descriptive`/`diagnostic`/`strategic`) plus
a **`depthBudget`** (`minimal`/`standard`/`full`). It owns the canonical
vocabularies: `ANALYTICAL_CORE_RE`, `DIRECT_FACTUAL_EXTRA_RE`,
`DIAGNOSTIC_INTENT_RE`, `STRATEGIC_INTENT_RE`, `TREND_INTENT_RE`,
`LOOKUP_SHAPE_RE`, `FACTUAL_LEADER_RES`, `MULTI_PART_RE`.

- **Legacy gates become thin views.** `isDirectFactualQuestion(q)` ≡
  `classifyQueryIntent(q).isDirectFactual`; `detectQuickLookup(q)` ≡
  `classifyQueryIntent(q).isLookupShape`. They carry **no private denylist** —
  one vocabulary governs every gate, so they can never disagree again.
- **The one intentional divergence is centralized.** The lookup fast path keys off
  `ANALYTICAL_CORE_RE` only (a "list all plans" lookup is still a lookup); the
  direct-factual gate adds `DIRECT_FACTUAL_EXTRA_RE` (softer strategy/outcome
  language like *improve / strategy / fall / drop*). This was the accidental
  delta between the two old denylists; it is now one documented union, not drift.
- **`depthBudget` is computed once and consumed everywhere.** The full loop sets
  `ctx.depthBudget` right after the fast paths bail. A **`minimal`** ask (plain
  lookup / direct factual) then:
  - skips the visual-planner's LLM-proposed EXTRA charts (the deterministic
    single-chart fallback that visualizes the answer frame is kept);
  - never triggers the unsolicited dashboard "offer";
  - never runs the breadth feature sweep or the spawned-followup fan-out;
  - drops recommendations / next-steps / follow-up chips on **all** writer
    branches (narrator, synthesizer-fallback, verifier-revise) and on the
    quick-answer path.
  `standard` and `full` are **today's behavior unchanged** — only clearly-simple
  questions are trimmed, so analytical questions never under-answer.

Decision order is conservative: **diagnostic/strategic → full**, then
**direct-factual OR lookup-shape → minimal**, else **standard**. Ambiguous shapes
stay `standard` (neither stripped nor force-expanded).

Enforced by invariant **I12** ([invariants.spec.ts](../../server/scripts/invariants.spec.ts)):
`queryIntentAuthority` must export `classifyQueryIntent` + `ANALYTICAL_CORE_RE`,
the two legacy gates must reference `classifyQueryIntent`, and the old private
denylists (`NON_FACTUAL_CUES`, `ANALYTICAL_DENYLIST_REGEX`) must not reappear — so
a future hand-rolled classifier turns the build red.

## Consequences

- A simple question is answered with what was asked (the number/table + at most
  one chart that visualizes it) — no auto-padded charts, dashboard, recs, or chips.
- The same question now gets ONE intent verdict across the fast path, the
  suppression gate, and the depth gate — the "different verdict per gate"
  inconsistency is gone.
- Behavior change is **bounded to `minimal`-depth questions**; `standard`/`full`
  turns are byte-for-byte the prior pipeline, so diagnostic/strategic answers keep
  their full decision-grade envelope and breadth machinery.
- `classifyQueryIntent` is pure (no env / IO), so it is unit-tested
  unconditionally ([queryIntentAuthority.test.ts](../../server/tests/queryIntentAuthority.test.ts))
  and the legacy gates' existing test contracts still pass verbatim.
- `analysisSpecRouter` is also collapsed: its broad diagnostic-MODE detector now
  lives in the authority as `DIAGNOSTIC_MODE_RE` (kept SEPARATE from the narrow
  depth-budget `DIAGNOSTIC_INTENT_RE` — "performance in / success in" gate pivots,
  not full-depth answers). The orphaned `complexQueryDetector` (zero callers) was
  deleted. Still deliberately separate: `detectMultiPartQuestion` (a richer
  SPLITTER), and the dormant `decompositionGate` / `coordinatorAgent` (unwired by
  the single-flow policy, invariant #6) — folding the dormant ones in is a
  follow-up guarded by the same I12 firewall.

## Refinement (2026-06-22) — a minimal/quick answer keeps ONE chart + ONE pivot of the answer data

"Minimal depth = answer what was asked" does **not** mean "no visualization." The
principle this decision encodes is *no auto-padding with tangential analysis* —
speculative EXTRA charts, an unsolicited dashboard offer, recommendations,
next-step chips, the breadth sweep, and the spawned-followup fan-out. A single
chart + a single pivot **of the same answer data** are the answer in another
form, not padding, so they are kept:

- The full-loop `minimal` path always kept the deterministic single-chart
  fallback (see the `minimal` bullet above) plus the derived pivot.
- The **quick-answer fast path** ([`quickAnswerPath.ts`](../../server/lib/agents/runtime/quickAnswerPath.ts))
  returns *before* `ctx.depthBudget` is even computed, so it inherited none of
  that — it shipped a table only. It now attaches one chart of all performers
  (sorted by the measure; for a single-winner answer it re-executes a leaderboard
  frame) via the pure [`quickAnswerChart.ts`](../../server/lib/agents/runtime/quickAnswerChart.ts)
  seam, flag `QUICK_ANSWER_CHART_ENABLED` (default ON). The pivot was already
  present downstream (`derivePivotDefaultsFromExecution` re-queries base). This is
  **parity** between the two paths, not a relaxation of I12: the suppression of
  extra charts / recs / offers / fan-out is unchanged. Lesson L-029.
