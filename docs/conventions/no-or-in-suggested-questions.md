# Convention: No "or" in a suggested question

> Introduced 2026-06-25 (user product rule). Single authority:
> [`suggestedQuestionGuard`](../../server/lib/suggestedQuestionGuard.ts).

## Rule

A question the app *suggests to the user* must never contain the standalone
conjunction **"or"** — e.g. *"What is sales distribution by cluster or state?"*.
An "or" offers the app a choice between two analyses it can't resolve, so the
question is not answerable. The disjunctive question is **dropped**, never
rewritten (auto-picking one branch would silently change the user's intent).

Scope is the WORD only: `/\bor\b/i` matches `"by cluster or state"`, `"and/or"`,
`"A OR B"` — but NOT the letters inside `for`, `store`, `factor`, `category`,
`region`, `report`, `correlation` (no word boundary there).

## How it's enforced (every generator routes through the guard)

`hasDisjunctiveOr` / `stripOrQuestions` in
[`suggestedQuestionGuard.ts`](../../server/lib/suggestedQuestionGuard.ts) is the
single authority. Every surface that mints a suggested question applies it at its
output boundary, AND the relevant LLM prompts ask the model to avoid "or"
(prompt = hint, filter = guarantee — same pattern as the random-sample firewall
in `filterSpawnedQuestions`):

- Deterministic templates — [`suggestedFollowUpsFromSummary`](../../server/lib/suggestedFollowUpsFromSummary.ts) (the old `"top categories or values"` template was the one literal offender), [`quickAnswerFollowUps`](../../server/lib/agents/runtime/quickAnswerFollowUps.ts) (via `pushIfNew`).
- LLM suggesters — [`suggestionGenerator`](../../server/lib/suggestionGenerator.ts), [`datasetProfile`](../../server/lib/datasetProfile.ts), and the seed/merge/regenerate paths in [`sessionAnalysisContext`](../../server/lib/sessionAnalysisContext.ts) (`withGuardedFollowUps`).
- Reflector "Investigating further" chips — [`filterSpawnedQuestions`](../../server/lib/agents/runtime/filterSpawnedQuestions.ts) (hard-rule drop, alongside random-sample/identifier).
- Narrator + synthesis CTAs — [`narratorAgent`](../../server/lib/agents/runtime/narratorAgent.ts), [`agentLoop/synthesis`](../../server/lib/agents/runtime/agentLoop/synthesis.ts).
- Upload/initial merge backstop — [`mergeSuggestedQuestions`](../../server/lib/suggestedQuestions.ts).
- Dashboard render authority — [`followUpDeepening`](../../server/shared/followUpDeepening.ts) drops legacy stored prompts (frozen before this rule) and generated ones at render time. This module is client-mirrored (the client re-exports it) and is deliberately zero-import, so the disjunction regex is kept INLINE there with a pointer to the canonical guard.

## Why so many sites

There is no single chokepoint: suggested-question strings are minted by ~8
generators and copied/sliced/merged across controllers. Guarding only one point
leaves the rest live (the L-020 "one rule, many enforcement points" trap). Each
generator is made self-guaranteeing at its output boundary, so no downstream copy
can re-introduce an "or" question.

## Test

[`tests/suggestedQuestionGuard.test.ts`](../../server/tests/suggestedQuestionGuard.test.ts)
covers the predicate (word-boundary true/false cases), `stripOrQuestions`, the
fixed summary template, `mergeSuggestedQuestions`, `filterSpawnedQuestions`, and
the `followUpDeepening` render path.
