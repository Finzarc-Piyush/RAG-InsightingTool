# Skills (Phase-1 analytical competencies)

## Purpose

Skills are **composites** over the existing tool catalog. They expand
into a sequence of `PlanStep[]` the agent loop would otherwise need the
planner to assemble ad-hoc. A skill lets the planner say "this turn
looks like a variance decomposition — package the right evidence" in one
step instead of a fragile three-tool improvisation.

No skill invents new tool types. Every expanded step calls a tool
already registered with `ToolRegistry`.

## Key files

- `server/lib/agents/runtime/skills/index.ts` — the registry,
  `registerSkill`, `selectSkill`, `expandSkill`,
  `formatSkillsManifestForPlanner`, and the auto-import block that
  registers every built-in skill at module load.
- `server/lib/agents/runtime/skills/types.ts` — the `AnalysisSkill`
  interface (`name`, `description`, `handles`, `priority`, `appliesTo`,
  `plan`), the `SkillInvocation` shape, and the env-flag helpers
  (`isDeepAnalysisSkillsEnabled`, `skillAllowlist`).
- Built-in skills (one file each):
  - `varianceDecomposer.ts` — "why did X fall between A and B"
  - `driverDiscovery.ts` — "what drives X"
  - `insightExplorer.ts` — open-ended narrative on a dataset slice
  - `timeWindowDiff.ts` — explicit "period A vs period B" comparisons
  - `parallelResolve.ts` — parallel-step resolver (infrastructure, not a
    user-facing skill)

## Data contracts

- **`AnalysisSkill.handles`** — a list of intent tags (e.g. `"variance_diagnostic"`)
  used for manifest rendering and allowlist filtering. Not a predicate
  — the real predicate is `appliesTo`.
- **`AnalysisSkill.appliesTo(brief, ctx)`** — must be deterministic and
  cheap. Checks the brief's `questionShape`, `outcomeMetricColumn`,
  `comparisonPeriods`, `filters`, and the execution context's column
  metadata.
- **`AnalysisSkill.plan(brief, ctx)`** returns a `SkillInvocation` with
  a stable `id`, a `label`, the concrete `PlanStep[]`, and a
  `rationale` string.
- **`AnalysisSkill.priority`** (optional, default `0`) — higher values
  win in `selectSkill`. Narrow skills (require specific brief fields)
  should carry a higher priority so they shadow the broader ones when
  their preconditions are met.

## Selection rules

`selectSkill(brief, ctx)` (in `skills/index.ts`) walks every registered
skill, filters by the allowlist (if any), keeps the ones whose
`appliesTo()` returns true, and picks the **highest-priority** winner.
Ties break on registry insertion order (load order in `skills/index.ts`).

**Before Wave F1**, selection was first-match-wins in load order —
narrow skills like `timeWindowDiff` that require a strictly-larger brief
(e.g. `comparisonPeriods` present) never ran in prod because a broader
skill (`varianceDecomposer`) was imported first. Wave F1 introduced the
`priority` field and the sort; the regression test is in
`server/tests/skillSelectionPriority.test.ts`.

Canonical priorities (see source for the authoritative value):

| Skill | Priority | Why |
|---|---:|---|
| `time_window_diff` | 10 | Requires explicit `comparisonPeriods`; narrow |
| `variance_decomposer` | 0 | Broader — catches generic `variance_diagnostic` turns |
| `driver_discovery` | 0 | Independent question shape |
| `insight_explorer` | 0 | Independent question shape |

## Environment flags

- `DEEP_ANALYSIS_SKILLS_ENABLED` — when off, `selectSkill` returns
  `null` and the manifest is empty. Planner falls back to ad-hoc plans.
- `DEEP_ANALYSIS_SKILLS_ALLOWLIST` — comma-separated skill names; when
  set, only those skills are eligible. Useful for staged rollout.

## Extension points

- **Add a skill**: new file under `skills/`, call `registerSkill(skill)`
  at module scope, append the import to `skills/index.ts`. Pick a
  priority above existing broad skills if `appliesTo` is strictly
  narrower.
- **Allowlist for rollout**: set `DEEP_ANALYSIS_SKILLS_ALLOWLIST` in
  `server.env`; no code change required.

## Known pitfalls

- **Skill registration is idempotent**. Re-registering a name overwrites
  silently by design (HMR, test re-imports). The `ToolRegistry` has the
  opposite policy: throw on duplicate. Skills can get away with
  overwrite because the load set is fixed at module boot and idempotent
  on repeat.
- **`selectSkill` returns `null` when `DEEP_ANALYSIS_SKILLS_ENABLED` is
  off.** The planner treats that as "use ad-hoc plan" — there is no
  silent fallback to a broader skill.
- **Priority is the only tie-breaker for overlapping preconditions.**
  If you add a skill that could match at the same shape as an existing
  one, give it a priority explicitly — don't rely on registry order.

## Recent changes

- Initial seed of this doc.
