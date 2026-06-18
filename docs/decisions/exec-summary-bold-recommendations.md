# Executive-summary recommendations are bold business decisions (not analytical-only)

_Wave IUX4 · 2026-06-18_

## Context

The `ANSWER_ENVELOPE_CONTRACT` VOICE rules ([`sharedPrompts.ts`](../../server/lib/agents/runtime/sharedPrompts.ts))
historically constrained `recommendations[]` to **analytical** next-steps — "split by an
existing dimension, compare two cohorts the data has, look at the metric over time" — and
explicitly forbade executive / strategic moves, on the theory that the reader is "an
analyst running a report, not a CEO" and the LLM might hallucinate moves it cannot support.
The genuine business "what to do" lived in a separate, gated `businessActions[]` lane buried
in the dashboard drawer.

A user reviewing the dashboard executive summary reported the recommendations "don't feel
like meaningful insights … decoration rather than help" — because an analyst's to-do list
("compare metro vs non-metro") is not decision help for a manager. Asked to choose, the user
explicitly picked **bold manager decisions** over sharper-but-still-analytical recommendations.

## Decision

`recommendations[]` are now **genuine business decisions** a manager can act on or escalate
(where to focus or de-prioritise, where to shift spend/attention, what to protect, fix, or
push, what to escalate with urgency), with **two hard integrity rails preserved**:

1. **Grounding** — every move MUST be anchored to a specific finding and its number (the
   `rationale`). No number, no recommendation.
2. **Data-bounded** — never invent the *mechanism* behind a move (a pricing / channel /
   distribution / competition / demographic lever) unless those columns exist in the data.
   When the lever is inferred rather than measured, hedge it ("likely") and keep the action
   on the controllable **response**, not the unproven cause.

Vague placeholders ("investigate further", "monitor", "optimise") without a named dimension /
metric / cohort / threshold are banned. A new optional `expectedImpact` field (max 240, mirrors
`businessActionItem.expectedImpact`) states what success looks like in business terms.

`businessActions[]` remains a complementary lane for *additional* longer-horizon / cross-cutting
plays not already captured as a recommendation — its dedup instruction was updated accordingly
(emit only what the recommendations don't already cover, else return `{ items: [] }`).

## Consequences

- The exec-summary band and drawer now lead with decision-useful content; recommendations
  render with their grounding number + expected impact (the "decision chain on the band").
- More LLM latitude → a small risk of over-reach. Mitigated by the integrity rails in the
  prompt. The natural **follow-up** if over-reach is observed in practice: a deterministic
  specificity / grounding verifier check (advisory-first, then gating) — deliberately NOT
  added at launch to avoid revise-loop latency on a quality that the prompt now strongly
  constrains.
- The pivot-table insight envelope ([`pivotEnvelope.ts`](../../server/lib/insightGenerator/pivotEnvelope.ts))
  keeps its own analytical-only contract — it is a distinct surface (insight above a
  user-built pivot), intentionally left narrow. Revisit only on a specific ask.
- Back-compat: `expectedImpact` is optional on all schemas, so historical persisted envelopes
  (chat messages + dashboards) validate and render unchanged.
