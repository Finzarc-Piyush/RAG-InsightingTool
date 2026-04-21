# Agent runtime

## Purpose

The engine every chat turn routes through when `AGENTIC_LOOP_ENABLED=true`.
Plans a sequence of tool calls, executes them with reflection between
steps, verifies the final answer, and streams SSE events to the client
workbench. When agentic is off, the legacy handler orchestrator takes
over — see "Legacy layer" below; the two layers have different
capabilities.

## Key files

**Runtime loop**

- `server/lib/agents/runtime/agentLoop.service.ts` — `runAgentTurn` (the
  entry point).
- `server/lib/agents/runtime/planner.ts` — produces a `PlanStep[]` from
  the brief + skills manifest + tool manifest.
- `server/lib/agents/runtime/reflector.ts` — between-step critique.
- `server/lib/agents/runtime/verifier.ts` — final verdict on the
  synthesised answer.
- `server/lib/agents/runtime/types.ts` — `AgentState`, `AgentTrace`,
  `VerdictType`, `PlanStep`, `AgentLoopResult`.
- `server/lib/agents/runtime/schemas.ts` — zod schemas for planner
  output, verifier output, critic rounds.
- `server/lib/agents/runtime/workingMemory.ts` — per-turn memory slots.
- `server/lib/agents/runtime/context.ts` — assembles
  `AgentExecutionContext` (session, summary, working memory, etc.).

**Tools + skills**

- `server/lib/agents/runtime/toolRegistry.ts` — the `ToolRegistry`
  class and `ToolExecutor` / `ToolResult` types. See
  [`tool-registry.md`](./tool-registry.md).
- `server/lib/agents/runtime/tools/registerTools.ts` — one-shot boot
  registration of all tools.
- `server/lib/agents/runtime/skills/**` — Phase-1 analytical skills.
  See [`skills.md`](./skills.md).

**Configuration / guards**

- `server/lib/agents/runtime/assertAgenticRag.ts` —
  `assertAgenticRagConfiguration()` and
  `assertDashboardAutogenConfiguration()`. Called inside `createApp()`;
  misconfig fails boot.

**Legacy layer**

- `server/lib/agents/orchestrator.ts` — `AgentOrchestrator.processQuery`.
- `server/lib/agents/index.ts` — dispatcher registering 7 handlers
  (Conversational, DataOps, MLModel, Statistical, Comparison,
  Correlation, General). Order matters.
- `server/lib/agents/handlers/**` — individual handlers.

## Data contracts

- **`AgentTrace`** (`types.ts:205-225`) — the blob that ends up on the
  assistant message in Cosmos and is rendered by the client workbench.
  Already mirrored on both `schema.ts` files as
  `agentTrace: z.record(z.unknown()).optional()`.
- **`VerdictType`** (`types.ts:242-248`) — the verifier's possible
  outcomes: `"pass" | "revise_narrative" | "retry_tool" | "replan" |
  "ask_user" | "abort_partial"`. The zod enum in `schemas.ts:36-43`
  holds the same six values; the `VERIFIER_VERDICT` constant re-export
  (added in Wave F3) keeps `agentLoop.service.ts` literal-free.
- **`PlanStep`** (`types.ts`) — each plan entry carries `id`, `tool`,
  `args`, and optional `dependsOn`.

## Runtime flow

1. `services/chat/chatStream.service.ts` classifies the mode, assembles
   `AgentExecutionContext`, and calls `runAgentTurn`.
2. `runPlanner` returns a `PlanStep[]` or a rejection string. Arguments
   are repaired through `planArgRepairs.ts` and column names through
   `plannerColumnResolve.ts` before execution.
3. Each plan step resolves a tool via `ToolRegistry.execute(name, args,
   ctx)`. The registry safe-parses args against the tool's zod schema
   and writes a `tool_done` / `tool_error` log line with timing.
4. The reflector critiques after each step; `workingMemory` accumulates
   facts that later steps can reference.
5. When the plan finishes, the synthesiser produces the final answer.
6. The verifier reads the synthesised answer against the plan trace and
   returns a `VerifierResult { verdict, issues, course_correction }`.
7. On `verdict=revise_narrative`, the synthesiser runs again with the
   issues appended. Other verdicts (retry_tool, replan, etc.) hand back
   to the planner or surface a user-visible note.
8. The final `AgentLoopResult` is emitted as SSE events (through
   `services/chat/agentWorkbench.util.ts`) and persisted onto the
   assistant message in Cosmos.

## Verdict vocabulary

Six terminal verdicts. Use the `VERIFIER_VERDICT.*` constants (exported
from `schemas.ts`) rather than string literals:

| Verdict | Meaning | Loop action |
|---|---|---|
| `pass` | Answer is grounded and complete | Emit as-is |
| `revise_narrative` | Narrative drifts from evidence | Re-synthesise with issues |
| `retry_tool` | A specific tool run was flawed | Re-run that step |
| `replan` | The plan itself is wrong | Back to planner |
| `ask_user` | Ambiguous intent | Emit clarification prompt |
| `abort_partial` | Budget exhausted / unrecoverable | Emit partial answer + trace |

## Extension points

- **New tool**: define in `runtime/tools/<name>Tool.ts`, register inside
  `registerTools.ts`. See [`tool-registry.md`](./tool-registry.md).
- **New skill**: drop a module in `runtime/skills/`, call
  `registerSkill()` at module top-level, add an `import "./yourSkill.js"`
  line to `skills/index.ts`. See [`skills.md`](./skills.md).
- **New verdict branch**: update `VerdictType` union in `types.ts`, the
  zod enum in `schemas.ts:36-43`, the `VERIFIER_VERDICT` constant, and
  the dispatch in `agentLoop.service.ts`. TypeScript will surface every
  missing branch.

## Known pitfalls

- **Legacy layer can't serve Phase-1 skills.** The handlers in
  `server/lib/agents/handlers/**` were frozen before
  `varianceDecomposer`, `driverDiscovery`, `insightExplorer`,
  `timeWindowDiff`, or dashboard autogen existed. Disabling
  `AGENTIC_LOOP_ENABLED` as a hotfix silently downgrades — questions
  that expect a skill fall through to `generalDataAnalysisAgent`. The
  banner on `server/lib/agents/index.ts` spells out the rule. Use
  `AGENT_TOOL_TIMEOUT_MS` or `AGENTIC_MAX_STEPS` instead.
- **Skill selection is priority-ordered (Wave F1).** Prior to F1 it was
  first-match-wins on load order, which let `varianceDecomposer` shadow
  `timeWindowDiff`. See [`skills.md`](./skills.md).
- **Tool / skill registry duplicate re-registration is fatal (Wave
  F2).** Boot-time registration is called exactly once per process; a
  duplicate name throws loudly. See [`tool-registry.md`](./tool-registry.md).

## Recent changes

- **Wave F3** — verdict string literals replaced with the exported
  `VERIFIER_VERDICT` constant from `runtime/schemas.ts`. One source of
  truth for the enum tuple; typos in `agentLoop.service.ts` or
  `verifier.ts` are now compile errors, not silently-missed retry
  branches.
- Initial seed of this doc — captures the runtime as of the
  `claude/add-claude-documentation-PaA9h` branch.
