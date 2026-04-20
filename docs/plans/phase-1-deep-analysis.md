# Phase 1 — Deep analysis as one-stop answer

**Status:** plan. **Owner:** TBD. **Feature flag:** `DEEP_ANALYSIS_SKILLS_ENABLED` (default off until rollout).

## Context

Today when a user asks "what impacts my sales the most?" or "why did east-region
tech sales fall between Mar-22 and Apr-25?", the planner picks 1–2 analytical
tools, runs them, then synthesises a narrative. The answer is usually correct
but rarely best-in-class: no hypothesis grid, no parallel evidence, no
completeness check, no confidence bounds. Phase 1 closes that gap so a single
chat turn produces an analyst-grade answer.

## Lessons applied from how Claude Max / Claude Code solves deep analysis

1. **Decompose → hypothesise → gather in parallel → score → synthesise.**
   Deep analysis isn't a single tool call; it's a *plan of investigation*.
2. **Skills are named competencies** (see `/skills/*` in Claude Code). A
   "variance-decomposer" skill knows how to ask and answer one question type;
   the planner *picks* the skill instead of rebuilding the steps every time.
3. **Sub-agents run in isolation, return a compact report.** Each sub-agent
   receives a focused prompt, writes its findings, and hands back 1–2 KB of
   structured facts — no context pollution.
4. **Intermediate artifacts are first-class.** The hypothesis table, the
   evidence matrix, and the ranked drivers all show in the thinking panel so
   users trust the answer.
5. **The answer carries caveats.** Magnitudes, confidence bounds, sample
   sizes, and "what we couldn't check" are part of the final message, not an
   afterthought.

## Sub-problems

- **P1.1 — Question decomposition.** Convert NL question into a typed
  `AnalysisIntent` (metric, segment, time window, outcome, question-shape).
- **P1.2 — Skills catalog.** Define 4 named skills the planner can pick:
  `driver_discovery`, `variance_decomposer`, `time_window_diff`,
  `insight_explorer`. Each is a composite that chains existing tools.
- **P1.3 — Hypothesis generator.** For diagnostic questions, produce 3–6
  ranked hypotheses *before* running analytical tools.
- **P1.4 — Parallel evidence gathering.** Run hypothesis tests in parallel
  (bounded by `DIAGNOSTIC_MAX_PARALLEL`, already exists).
- **P1.5 — Evidence scoring + ranking.** Rank hypotheses by a cheap score
  (effect size × sample size × confidence).
- **P1.6 — Completeness verifier.** Extend `verifier.ts` to check that the
  answer addresses the question's decomposed slots.
- **P1.7 — Rich answer envelope.** Add `magnitudes`, `confidence`,
  `hypothesesTable`, `unexplained` to the synthesis output.
- **P1.8 — Thinking panel: intermediate artifacts.** Stream the hypothesis
  table + evidence matrix as SSE events the client renders.

## Solution design (incremental, flag-gated)

### Layer 0 — foundations already landed
- `run_segment_driver_analysis` (gated by `DIAGNOSTIC_COMPOSITE_TOOL_ENABLED`)
- `analysisSpecRouter.ts` diagnostic-mode detection
- `InterAgentMessage` trace + `AGENT_INTER_AGENT_MESSAGES` flag
- Planner sees upfront RAG hits (PR A.1) + column-mismatch suggestions (PR A.4)

### Layer 1 — Question decomposition (P1.1)

New module `server/lib/agents/runtime/analysisIntent.ts` exporting
`parseAnalysisIntent(question, summary): AnalysisIntent`:

```ts
type AnalysisIntent = {
  shape: 'driver_discovery' | 'variance_diagnostic' | 'trend' | 'comparison' | 'exploration';
  outcomeMetric?: string;              // e.g. "Sales"
  segmentFilters?: DimensionFilter[];  // e.g. [{ column: "Region", op: "eq", values: ["East"] }]
  timeWindow?: { from: string; to: string };
  timeGrain?: 'day' | 'week' | 'month' | 'quarter' | 'year';
  candidateDriverDimensions?: string[];
  rawQuestion: string;
};
```

Implemented as an LLM call wrapped by `completeJson(schema)` — same pattern
as `runPlanner`. Runs once at turn start, attached to
`AgentExecutionContext.analysisIntent`.

### Layer 2 — Skills catalog (P1.2)

New `server/lib/agents/runtime/skills/` directory. Each skill is a small
file exporting:

```ts
interface AnalysisSkill {
  name: string;
  description: string;                 // for planner manifest
  appliesTo(intent: AnalysisIntent): boolean;
  plan(intent: AnalysisIntent, ctx: AgentExecutionContext): PlanStep[];
}
```

Four skills for Phase 1:

| File | Name | Shape handled |
|------|------|---------------|
| `driverDiscovery.ts` | `driver_discovery` | "What impacts X most?" |
| `varianceDecomposer.ts` | `variance_decomposer` | "Why did X fall in segment Y between A and B?" |
| `timeWindowDiff.ts` | `time_window_diff` | "What changed between period A and period B?" |
| `insightExplorer.ts` | `insight_explorer` | "Show me surprising things" |

Each skill's `plan()` returns 3–8 pre-sequenced `PlanStep`s using existing
tools (`execute_query_plan`, `run_breakdown_ranking`, `run_correlation`,
`run_two_segment_compare`, `run_segment_driver_analysis`). No new tool types.

Skills are registered into a `SkillRegistry` and the planner's prompt
receives a short manifest (name + one-liner). The planner picks a skill
*or* sticks with ad-hoc tools — both paths remain valid.

### Layer 3 — Hypothesis generator (P1.3)

New `server/lib/agents/runtime/hypothesize.ts` → `generateHypotheses(intent, summary, ragHits): Hypothesis[]`.

`Hypothesis`:

```ts
{
  id: string;                          // 'h1'..'h6'
  statement: string;                   // NL hypothesis
  testPlan: PlanStep[];                // how to test it
  priorConfidence: number;             // 0..1, LLM-estimated
}
```

Runs inside variance/driver skills before execution. Cap at 6 hypotheses.
Emit as SSE event `hypotheses_generated` so the client can render them in
the thinking panel.

### Layer 4 — Parallel evidence gathering (P1.4)

`agentLoop.service.ts` already runs steps sequentially. Add
`runPlanStepsConcurrently(steps, maxParallel)` reusing the
`diagnosticMaxParallelBranches()` budget. Only plans produced by skills
declared `parallelizable: true` opt in; ad-hoc planner plans stay
sequential (safer).

### Layer 5 — Evidence scoring (P1.5)

After each hypothesis's steps complete, compute a cheap `EvidenceScore`:

```ts
{
  hypothesisId: string;
  effectSize: number;          // e.g. delta %, correlation coefficient
  sampleSize: number;          // rows or distinct segments involved
  confidence: 'low' | 'med' | 'high';  // bucketed from effect × sample
  supported: boolean;          // passes a minimum threshold
}
```

Implemented as a pure function over tool results — no LLM call.

### Layer 6 — Completeness verifier (P1.6)

Extend `verifier.ts` to accept the `AnalysisIntent` slots and check:

- Was every `candidateDriverDimension` in `intent` actually tested?
- For variance questions, did we isolate (time effect, composition shift,
  intra-segment change)?
- Are magnitudes present in the narrative?
- Is at least one chart produced when the data supports it?

New verdict codes: `INCOMPLETE_DRIVERS`, `MISSING_DECOMPOSITION`,
`MISSING_MAGNITUDES`. Each maps to a concrete replan hint.

### Layer 7 — Rich answer envelope (P1.7)

Extend the agent answer JSON with optional fields:

```ts
{
  body: string;
  keyInsight?: string;
  hypothesesTable?: Hypothesis[];       // ranked by evidence
  magnitudes?: Array<{ label: string; value: string; confidence: string }>;
  unexplained?: string;                 // what couldn't be determined + why
  followUpPrompts?: string[];
}
```

Client renders the new fields in `MessageBubble`; missing fields render
nothing (back-compat).

### Layer 8 — Intermediate artifacts in the thinking panel (P1.8)

New SSE events emitted during deep analysis:

- `intent_parsed` — the `AnalysisIntent` JSON.
- `hypotheses_generated` — the hypothesis list.
- `evidence_scored` — the ranked `EvidenceScore` array.
- `skill_execution` — skill name + sub-step count.

Client adds new `AgentWorkbenchEntry` kinds (`intent`, `hypotheses`,
`evidence`) that render compact JSON tables in the thinking panel.

## File-level changes (first cut)

New files:
- `server/lib/agents/runtime/analysisIntent.ts`
- `server/lib/agents/runtime/hypothesize.ts`
- `server/lib/agents/runtime/evidenceScore.ts`
- `server/lib/agents/runtime/skills/index.ts` (registry)
- `server/lib/agents/runtime/skills/driverDiscovery.ts`
- `server/lib/agents/runtime/skills/varianceDecomposer.ts`
- `server/lib/agents/runtime/skills/timeWindowDiff.ts`
- `server/lib/agents/runtime/skills/insightExplorer.ts`
- `server/tests/skills/*.test.ts` — one per skill (negative + happy paths)

Modified:
- `server/lib/agents/runtime/agentLoop.service.ts` — intent parse at turn
  start; skill dispatch; parallel step runner; SSE emits.
- `server/lib/agents/runtime/planner.ts` — skills manifest in system prompt.
- `server/lib/agents/runtime/verifier.ts` — completeness checks.
- `server/lib/agents/runtime/types.ts` — `AnalysisIntent`, extended
  `AgentConfig` (`maxParallelSkillSteps`), extended `WorkingMemoryEntry`.
- `client/src/shared/schema.ts` + `server/shared/schema.ts` — extended
  message envelope (stays optional to satisfy the drift gate).
- `client/src/pages/Home/Components/MessageBubble.tsx` — render new fields.
- `client/src/pages/Home/Components/ThinkingPanel/` — render new workbench
  entry kinds.

## Execution order

1. **PR 1.A** — Add `AnalysisIntent` parser + SSE `intent_parsed` event (no
   behavior change; observational).
2. **PR 1.B** — Add skills infrastructure (registry + empty manifest in
   planner prompt). Ship with `DEEP_ANALYSIS_SKILLS_ENABLED=false`.
3. **PR 1.C** — Implement `variance_decomposer` skill first (highest-value
   question shape). Gate by skill name in the flag.
4. **PR 1.D** — Add `driver_discovery` skill + hypothesis generator +
   evidence scorer.
5. **PR 1.E** — Parallel step runner (opt-in per skill).
6. **PR 1.F** — Completeness verifier additions.
7. **PR 1.G** — Rich answer envelope + client rendering.
8. **PR 1.H** — `time_window_diff` + `insight_explorer` skills.

Each PR small enough to review in one sitting. Turn on the flag per-skill
as coverage lands.

## Verification

- **Unit tests**: each skill has golden plan outputs for 3–5 question
  shapes.
- **Integration smoke**: a fixture dataset + three deep-analysis prompts
  run end-to-end, snapshot the SSE event sequence, assert the envelope has
  magnitudes and a ranked hypotheses table.
- **Manual dogfood**: one analyst runs the four prompts from the product
  brief on a real dataset, compares answers vs the current pipeline on the
  same branch with the flag off.
- **Budgets**: add trace assertions that `AGENT_MAX_LLM_CALLS` and
  `AGENT_MAX_TOOL_CALLS` stay within current limits when a skill expands
  into ~6 sub-steps.

## Open questions

- Should skills be per-dataset-type (timeseries vs cross-section)? Probably
  yes later; start with question-shape only.
- Do we need stat tests (t-test, chi-square) for confidence bounds, or is
  rule-of-thumb bucketing enough for v1? Start with bucketing; add tests
  in Phase 1.5 if users ask.
- Parallel execution budget: do we double `AGENT_MAX_TOOL_CALLS` when a
  skill opts in, or count each branch against the same cap? Start with
  the same cap; monitor truncation rate.
