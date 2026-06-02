/**
 * ============================================================================
 * toolRuntime.ts — the "handle" a tool uses to read state and record results
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Each tool the agent can call (run a query, compute a correlation, etc.)
 *   used to receive just its arguments and a context object. This file upgrades
 *   that to a richer "ToolRuntime" handle that lets a tool BOTH look back at
 *   what already happened this turn AND record what it found. Reads include:
 *   "what findings exist so far?", "has this tool already run?", "what did the
 *   last query return?", "what's in the scratchpad?". Writes include: emit a
 *   finding, emit a follow-up sub-question, spawn or resolve a hypothesis, set
 *   a scratchpad value. (A "finding" is a concrete result with evidence; a
 *   "hypothesis" is a guess being tested; the "blackboard" is the shared store
 *   of all this for a turn.)
 *
 * WHY IT MATTERS
 *   It turns tools from dumb functions into "first-class reasoners" that can be
 *   smart — e.g. skip a correlation a previous step already computed, or build
 *   on an earlier finding. Crucially, all writes are funneled through the
 *   existing blackboard accessors so the older summary view
 *   (AnalyticalBlackboard) the narrator/reflector prompts read stays perfectly
 *   in sync. Tools that ignore the runtime keep working unchanged.
 *
 * KEY PIECES
 *   - ToolRuntime (interface) — the composite read+write handle plus `args`,
 *       `ctx`, `stepId`, `tool`.
 *   - createToolRuntime — builds a runtime for one step from the live arrays
 *       and the loop's emit hooks.
 *   - projectStructuredFindingToLegacy — adapter that mirrors a new structured
 *       finding into the legacy blackboard shape.
 *
 * HOW IT CONNECTS
 *   Instantiated per-step inside agentLoop.service.ts, which passes in the live
 *   in-memory arrays (observations, findings, working facts, scratchpad,
 *   hypotheses) and the onEmit* hooks that fan writes out to the blackboard.
 *   Types come from investigationState.js and analyticalBlackboard.js.
 */
import type { AgentExecutionContext } from "./types.js";
import type {
  AnalyticalBlackboard,
  Finding as LegacyFinding,
} from "./analyticalBlackboard.js";
import type {
  StructuredFinding,
  StructuredObservation,
  Fact,
  HypothesisNode,
  ScratchpadEntry,
  SubQuestion,
  StepId,
  FindingId,
  HypothesisId,
} from "./investigationState.js";
import { addFinding } from "./analyticalBlackboard.js";

/** Filters on `findings()` accessor. */
export interface FindingFilter {
  /** Restrict to findings linked to a hypothesis. */
  hypothesisId?: HypothesisId;
  /** Restrict to findings touching this column. */
  relatedColumn?: string;
  /** Tool that produced the finding (matches `sources[]`). */
  tool?: string;
  /** Minimum significance threshold. */
  minSignificance?: "anomalous" | "notable" | "routine";
}

/** Filters on `priorToolResults()` accessor. */
export interface ToolResultFilter {
  /** Restrict to a specific tool name. */
  tool?: string;
  /** Only the most recent N results. */
  last?: number;
}

/**
 * Read-only handle into the in-memory turn state. Tools may consult it
 * without mutating; mutations happen via the `emit*` helpers.
 */
export interface ToolRuntimeReads {
  /** Findings emitted earlier in this turn. */
  findings(filter?: FindingFilter): readonly StructuredFinding[];
  /** Hypothesis nodes (tree form). */
  hypotheses(): readonly HypothesisNode[];
  /** Past tool I/O (full ToolResult preserved). */
  priorToolResults(filter?: ToolResultFilter): readonly StructuredObservation[];
  /** Most-recent value of a working-memory slot key, if set. */
  workingFact(field: string): Fact | undefined;
  /** Scratchpad lookup by key. */
  scratchpadGet(key: string): unknown;
  /** Has the given tool already run successfully this turn? */
  hasRun(toolName: string): boolean;
  /** Last successful result for the given tool, if any. */
  lastResultFor(toolName: string): StructuredObservation | undefined;
}

/**
 * Mutation surface. All `emit*` helpers go through the legacy blackboard
 * shim so existing reflector / narrator prompts keep working unchanged.
 */
export interface ToolRuntimeWrites {
  /**
   * Emit a structured finding. Returns the new finding id. Wired through
   * `analyticalBlackboard.addFinding` for projection compat.
   */
  emitFinding(f: Omit<StructuredFinding, "id" | "createdAt">): FindingId;
  /** Emit a sub-question for the orchestrator. */
  emitSubQuestion(q: Omit<SubQuestion, "id" | "createdAt">): string;
  /** Add a hypothesis to the tree. */
  spawnHypothesis(h: Omit<HypothesisNode, "id" | "createdAt" | "evidence" | "testedBy">): HypothesisId;
  /** Mark a hypothesis status. */
  resolveHypothesis(id: HypothesisId, status: HypothesisNode["status"], evidenceFindingId?: FindingId): void;
  /** Push to the scratchpad. */
  scratchpadSet(entry: Omit<ScratchpadEntry, "createdAt">): void;
}

/**
 * Composite runtime handed to a tool. The original `(args, ctx)` are still
 * present as `args` and `ctx` so legacy tools keep compiling.
 */
export interface ToolRuntime extends ToolRuntimeReads, ToolRuntimeWrites {
  args: Record<string, unknown>;
  ctx: AgentExecutionContext;
  /** Stable id for the current step in this plan. */
  stepId: StepId;
  /** Tool name being executed. */
  tool: string;
}

// ─── Implementation ────────────────────────────────────────────────────────

export interface CreateToolRuntimeArgs {
  ctx: AgentExecutionContext;
  args: Record<string, unknown>;
  stepId: StepId;
  tool: string;
  /** Live arrays from the agent loop (read-only references). */
  observations: ReadonlyArray<StructuredObservation>;
  findings: ReadonlyArray<StructuredFinding>;
  workingFacts: ReadonlyArray<Fact>;
  scratchpad: ScratchpadEntry[];
  hypotheses: ReadonlyArray<HypothesisNode>;
  /** Hooks the loop wires so emits fan out into the legacy blackboard. */
  onEmitFinding(finding: StructuredFinding): void;
  onEmitSubQuestion(q: SubQuestion): void;
  onSpawnHypothesis(h: HypothesisNode): void;
  onResolveHypothesis(
    id: HypothesisId,
    status: HypothesisNode["status"],
    evidenceFindingId?: FindingId
  ): void;
}

const SIGNIFICANCE_RANK: Record<string, number> = {
  routine: 0,
  notable: 1,
  anomalous: 2,
};

export function createToolRuntime(args: CreateToolRuntimeArgs): ToolRuntime {
  return {
    args: args.args,
    ctx: args.ctx,
    stepId: args.stepId,
    tool: args.tool,

    findings(filter?: FindingFilter) {
      let out: ReadonlyArray<StructuredFinding> = args.findings;
      if (filter?.hypothesisId) {
        out = out.filter((f) => f.hypothesisId === filter.hypothesisId);
      }
      if (filter?.relatedColumn) {
        out = out.filter((f) =>
          f.relatedColumns?.includes(filter.relatedColumn as string)
        );
      }
      if (filter?.tool) {
        out = out.filter((f) => f.sources.some((s) => s === filter.tool));
      }
      if (filter?.minSignificance) {
        const min = SIGNIFICANCE_RANK[filter.minSignificance];
        out = out.filter((f) => SIGNIFICANCE_RANK[f.significance] >= min);
      }
      return out;
    },

    hypotheses() {
      return args.hypotheses;
    },

    priorToolResults(filter?: ToolResultFilter) {
      let out: ReadonlyArray<StructuredObservation> = args.observations;
      if (filter?.tool) out = out.filter((o) => o.tool === filter.tool);
      if (filter?.last !== undefined && filter.last > 0)
        out = out.slice(-filter.last);
      return out;
    },

    workingFact(field: string) {
      // Walk in reverse so the most recent fact wins.
      for (let i = args.workingFacts.length - 1; i >= 0; i--) {
        const f = args.workingFacts[i];
        if (f.id === field || f.statement.includes(field)) return f;
        if (f.relatedColumns?.includes(field)) return f;
      }
      return undefined;
    },

    scratchpadGet(key: string): unknown {
      const hit = args.scratchpad.find((e) => e.key === key);
      return hit?.value;
    },

    hasRun(toolName: string): boolean {
      return args.observations.some((o) => o.tool === toolName && o.metrics.cacheHit !== true);
    },

    lastResultFor(toolName: string): StructuredObservation | undefined {
      for (let i = args.observations.length - 1; i >= 0; i--) {
        if (args.observations[i].tool === toolName) return args.observations[i];
      }
      return undefined;
    },

    // ─── Writes ────────────────────────────────────────────────────────────

    emitFinding(input) {
      const id = `f-${args.stepId}-${args.findings.length + 1}`;
      const finding: StructuredFinding = {
        ...input,
        id,
        createdAt: Date.now(),
      };
      args.onEmitFinding(finding);
      return id;
    },

    emitSubQuestion(input) {
      const id = `sq-${args.stepId}-${Date.now().toString(36)}`;
      const sq: SubQuestion = {
        ...input,
        id,
        createdAt: Date.now(),
      };
      args.onEmitSubQuestion(sq);
      return id;
    },

    spawnHypothesis(input) {
      const id = `h-${args.stepId}-${Date.now().toString(36)}`;
      const h: HypothesisNode = {
        ...input,
        id,
        createdAt: Date.now(),
        evidence: [],
        testedBy: [],
      };
      args.onSpawnHypothesis(h);
      return id;
    },

    resolveHypothesis(id, status, evidenceFindingId) {
      args.onResolveHypothesis(id, status, evidenceFindingId);
    },

    scratchpadSet(entry) {
      const existing = args.scratchpad.findIndex((e) => e.key === entry.key);
      const full: ScratchpadEntry = { ...entry, createdAt: Date.now() };
      if (existing >= 0) args.scratchpad[existing] = full;
      else args.scratchpad.push(full);
    },
  };
}

/** Legacy adapter: project a structured finding into the legacy blackboard. */
export function projectStructuredFindingToLegacy(
  bb: AnalyticalBlackboard,
  f: StructuredFinding
): LegacyFinding | null {
  return addFinding(bb, {
    sourceRef: f.sources[0] ?? f.id,
    label: f.claim.slice(0, 200),
    detail: [
      f.claim,
      f.magnitude
        ? `Magnitude: ${f.magnitude.value}${f.magnitude.unit} (${f.magnitude.direction ?? "?"})`
        : "",
      f.evidence.queries.length
        ? `Queries: ${f.evidence.queries.map((q) => q.tool).join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 1800),
    significance: f.significance,
    hypothesisRefs: f.hypothesisId ? [f.hypothesisId] : [],
    relatedColumns: f.relatedColumns ?? [],
  });
}
