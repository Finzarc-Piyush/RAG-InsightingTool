# ADR — Segregated, hedged causation (the "Why this might be happening" lane)

**Status:** Accepted · 2026-06-18 · Waves W-CW1…W-DX2

## Context

Users found the chat answer "useless": for a plain breakdown it restated the same fact ~6×
across stacked surfaces, and — more importantly — it only ever **described** the numbers
("Pclass 1 survived at 63%"), never **explained** them ("…likely because first-class cabins
sat nearer the lifeboats, and 'women-and-children-first' boarding favored them").

The tool was *designed* not to explain: the answer-envelope contract said *"Never speculate
about causes the data does not show"* and the verifier flagged `UNSUPPORTED_CAUSAL_CLAIM`.
That guard exists for a real reason — for an FMCG operator, a fabricated business cause
("metro share fell because a competitor launched") is dangerous. So the causal "why" the user
wanted and the anti-hallucination guard the product needs were in direct tension.

Two further facts shaped the decision:
- The system **already** brainstorms causal mechanisms (`hypothesisPlanner`, incl. world-knowledge
  ones like lifeboat access) — they were just parked as untested "OPEN" clutter.
- The per-chart insight generator **already** ships a world-knowledge "likely reason" inside
  `keyInsight` (ungated, only loosely hedged). The chat narrator was the outlier that forbade it.

## Decision

Causation is **segregated, not banned**. The *measured layer* (body, findings, implications,
magnitudes, methodology) stays strictly factual — it states WHAT the numbers show, never WHY.
The "why" lives in ONE quarantined, clearly-labeled, always-hedged field: `likelyDrivers[]`
(`{explanation, basis: "data"|"domain"|"general", confidence, testable?}`), rendered as a
distinct "Why this might be happening" section with a standing disclaimer and per-item basis
chips. World knowledge (`basis="general"`) is permitted **there and nowhere else**.

The feature is purely **additive and quarantined** — the measured-surface anti-hallucination
rails are never weakened.

### Safety rails (what an A+ reviewer checks first)

- **Separation + labeling** — own field, own section, mandatory disclaimer; a reader can tell a
  hedged guess from a measured fact at a glance.
- **Mandatory hedge** — deterministic `verifierCausalCheck` rejects any explanation lacking a
  `CAUSAL_HEDGE_TERMS` token; the contract mandates it.
- **No number in a mechanism** — deterministic check + contract + verifier `FABRICATED_MECHANISM_NUMBER`.
- **No false data-grounding** — `basis="data"` must name a real dataset column (else demoted to `general`).
- **No confidence inflation** — basis↔confidence coupling clamped **structurally at schema parse**
  (`transform` normalizes confidence DOWN: data→high, domain→medium, general→low). Unbypassable.
- **Ordering rail** — the deterministic gate (W-SR2) shipped BEFORE the contract opened the
  permission (W-CP1), so there was never a window where the model could speculate ungated.
- **Unverified surfaces** — the dashboard band reads ONLY the persisted, verifier-passed envelope
  (no re-generation); the chart path keeps its hedge discipline inline.

## Consequences

- **One-time prompt-cache repricing** for the narrator/synth/verifier (the `ANSWER_ENVELOPE_CONTRACT`
  + verifier prompt are static text edits; per-call `epistemicNotes` stays in the USER block so the
  cacheable system prefix is otherwise byte-stable).
- **Five envelope declarations move in lockstep** — `narratorOutputSchema`, `finalAnswerEnvelopeSchema`,
  `messageAnswerEnvelopeSchema`, `dashboardAnswerEnvelopeSchema` (a SEPARATE `z.object`), and the
  client re-export. A forward-parity test pins them (see L-021).
- **Conciseness is depth-adaptive** — the heavy hypothesis/investigation machinery is gated to
  standard/full, but the hedged "why" is a first-class narrator output available at ALL depths, so a
  minimal lookup still gets a tight causal line without the OPEN-hypothesis clutter.
- **Heuristic detectors** (`CAUSAL_HEDGE_TERMS`, the stat-number / causal-connective regexes) are a
  content vocabulary in `sharedPrompts.ts` — NOT an intent vocabulary — so they do not touch
  `queryIntentAuthority` or trip invariant #12. The LLM verifier is a second advisory layer.
