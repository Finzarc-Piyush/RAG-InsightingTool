/**
 * ============================================================================
 * buildAgentInternals.ts — pack a turn's debug state into a saveable snapshot
 * ============================================================================
 * WHAT THIS FILE DOES
 *   While the agent answers a question it accumulates a lot of internal state:
 *   working-memory entries, the reflector's "what should I do next" verdicts,
 *   the verifier's "is this answer good" verdicts, the full blackboard
 *   (hypotheses, findings, open questions, domain context), and the inputs and
 *   outputs of every tool call. This file boils all of that down into one
 *   compact `AgentInternals` object that gets stored alongside the chat
 *   message. Critically, it TRIMS each part to a fixed size — keeping the most
 *   recent N entries (FIFO) and capping long text fields — so the saved record
 *   never gets too big.
 *
 * WHY IT MATTERS
 *   This snapshot is what lets you debug, replay, or post-mortem a turn after
 *   the fact, and it feeds the next turn's "what happened last time" handle.
 *   The trimming is essential: chat documents live in Cosmos DB, which has a
 *   2 MB per-document hard limit, so a richly instrumented turn must be capped
 *   (budget defaults to roughly 80 KB/turn) or saving the message would fail.
 *
 * KEY PIECES
 *   - buildAgentInternals — main builder: in-memory turn state in, trimmed
 *       AgentInternals snapshot out (with a computed budgetBytes for telemetry).
 *   - buildBlackboardSnapshot — trims the blackboard portion specifically.
 *   - toolIORecordFromCall — converts one tool-call record (with its full
 *       result) into the stored ToolIORecord shape.
 *   - FIELD_CAPS / fifo / trimEnd — the size caps and the trim helpers.
 *
 * HOW IT CONNECTS
 *   Called by the agent loop at turn end to produce the `agentInternals` field
 *   on the saved Message. Types come from shared/schema, types.js, and
 *   analyticalBlackboard.js.
 */
import type { AgentInternals } from "../../../shared/schema.js";
import type { AgentTrace, WorkingMemoryEntry, ToolCallRecord } from "./types.js";
import type {
  AnalyticalBlackboard,
  Hypothesis,
  Finding,
  OpenQuestion,
  DomainContextEntry,
} from "./analyticalBlackboard.js";

export interface ReflectorVerdictRecord {
  stepIndex: number;
  action: "continue" | "finish" | "replan" | "clarify" | "investigate_gap";
  rationale: string;
  suggestedQuestions?: string[];
  gapFill?: { hypothesisId?: string; tool: string; rationale?: string };
}

export interface VerifierVerdictRecord {
  /** -1 marks the final-stage verifier; ≥0 is a per-step round. */
  stepIndex: number;
  verdict: string;
  rationale: string;
  evidence?: string;
}

export interface ToolIORecord {
  stepId: string;
  tool: string;
  ok: boolean;
  argsJson: string;
  resultSummary: string;
  resultPayload?: string;
  analyticalMeta?: {
    inputRowCount?: number;
    outputRowCount?: number;
    appliedAggregation?: boolean;
  };
  durationMs?: number;
}

interface BuildArgs {
  workingMemory: ReadonlyArray<WorkingMemoryEntry>;
  reflectorVerdicts: ReadonlyArray<ReflectorVerdictRecord>;
  verifierVerdicts: ReadonlyArray<VerifierVerdictRecord>;
  blackboard?: AnalyticalBlackboard;
  toolIO: ReadonlyArray<ToolIORecord>;
}

const FIELD_CAPS = {
  workingMemory: 60,
  reflectorVerdicts: 40,
  verifierVerdicts: 40,
  toolIO: 60,
  hypotheses: 40,
  findings: 60,
  openQuestions: 20,
  domainContext: 20,
  // These per-field char caps are generous on purpose: the trace is the
  // surface we read when debugging or replaying, so richer slices are worth
  // the bytes (the overall AGENT_TRACE_MAX_BYTES budget gives the headroom).
  workingMemorySummaryPreviewChars: 1200,
  reflectorRationaleChars: 3000,
  verifierRationaleChars: 3000,
  verifierEvidenceChars: 6000,
  toolArgsJsonChars: 6000,
  toolResultSummaryChars: 3000,
  toolResultPayloadChars: 12000,
  hypothesisTextChars: 900,
  findingDetailChars: 3000,
  domainContextTextChars: 3000,
} as const;

const trimEnd = (s: unknown, n: number): string => {
  if (typeof s !== "string") return "";
  return s.length <= n ? s : s.slice(0, n);
};

/**
 * Keep the LAST N entries — most recent activity is always most relevant for
 * post-mortem and for the next turn's `priorTurnState` handle.
 */
const fifo = <T>(arr: ReadonlyArray<T>, n: number): T[] =>
  arr.length <= n ? arr.slice() : arr.slice(arr.length - n);

export function buildAgentInternals(args: BuildArgs): AgentInternals {
  const wm = fifo(args.workingMemory, FIELD_CAPS.workingMemory).map((e) => ({
    callId: trimEnd(e.callId, 120),
    tool: trimEnd(e.tool, 120),
    ok: !!e.ok,
    summaryPreview: trimEnd(
      e.summaryPreview,
      FIELD_CAPS.workingMemorySummaryPreviewChars
    ),
    suggestedColumns: e.suggestedColumns?.slice(0, 40),
    slots: e.slots && Object.keys(e.slots).length ? e.slots : undefined,
  }));

  const reflectorVerdicts = fifo(
    args.reflectorVerdicts,
    FIELD_CAPS.reflectorVerdicts
  ).map((r) => ({
    stepIndex: Math.max(0, Math.floor(r.stepIndex)),
    action: r.action,
    rationale: trimEnd(r.rationale, FIELD_CAPS.reflectorRationaleChars),
    suggestedQuestions: r.suggestedQuestions?.slice(0, 8).map((q) => trimEnd(q, 400)),
    gapFill: r.gapFill
      ? {
          hypothesisId: r.gapFill.hypothesisId
            ? trimEnd(r.gapFill.hypothesisId, 120)
            : undefined,
          tool: trimEnd(r.gapFill.tool, 120),
          rationale: r.gapFill.rationale
            ? trimEnd(r.gapFill.rationale, 1000)
            : undefined,
        }
      : undefined,
  }));

  const verifierVerdicts = fifo(
    args.verifierVerdicts,
    FIELD_CAPS.verifierVerdicts
  ).map((v) => ({
    stepIndex: Math.max(-1, Math.floor(v.stepIndex)),
    verdict: trimEnd(v.verdict, 60),
    rationale: trimEnd(v.rationale, FIELD_CAPS.verifierRationaleChars),
    evidence: v.evidence
      ? trimEnd(v.evidence, FIELD_CAPS.verifierEvidenceChars)
      : undefined,
  }));

  const toolIO = fifo(args.toolIO, FIELD_CAPS.toolIO).map((t) => ({
    stepId: trimEnd(t.stepId, 120),
    tool: trimEnd(t.tool, 120),
    ok: !!t.ok,
    argsJson: trimEnd(t.argsJson, FIELD_CAPS.toolArgsJsonChars),
    resultSummary: trimEnd(t.resultSummary, FIELD_CAPS.toolResultSummaryChars),
    resultPayload: t.resultPayload
      ? trimEnd(t.resultPayload, FIELD_CAPS.toolResultPayloadChars)
      : undefined,
    analyticalMeta: t.analyticalMeta,
    durationMs:
      typeof t.durationMs === "number" && Number.isFinite(t.durationMs)
        ? Math.max(0, Math.floor(t.durationMs))
        : undefined,
  }));

  const blackboardSnapshot = args.blackboard
    ? buildBlackboardSnapshot(args.blackboard)
    : undefined;

  const internals: AgentInternals = {
    schemaVersion: 1,
    workingMemory: wm.length ? wm : undefined,
    reflectorVerdicts: reflectorVerdicts.length ? reflectorVerdicts : undefined,
    verifierVerdicts: verifierVerdicts.length ? verifierVerdicts : undefined,
    toolIO: toolIO.length ? toolIO : undefined,
    blackboardSnapshot,
  };

  // Coarse byte budget for telemetry + future housekeeping.
  internals.budgetBytes = Buffer.byteLength(JSON.stringify(internals), "utf8");

  return internals;
}

function buildBlackboardSnapshot(b: AnalyticalBlackboard) {
  return {
    hypotheses: b.hypotheses?.length
      ? fifo(b.hypotheses as ReadonlyArray<Hypothesis>, FIELD_CAPS.hypotheses).map(
          (h) => ({
            id: trimEnd(h.id, 120),
            text: trimEnd(h.text, FIELD_CAPS.hypothesisTextChars),
            status: h.status,
            evidenceFindingIds: h.evidenceRefs?.slice(0, 20),
            parentId: undefined, // flat for now (no tree structure persisted)
            alternatives: undefined,
          })
        )
      : undefined,
    findings: b.findings?.length
      ? fifo(b.findings as ReadonlyArray<Finding>, FIELD_CAPS.findings).map(
          (f) => ({
            id: trimEnd(f.id, 120),
            sourceRef: trimEnd(f.sourceRef, 200),
            label: trimEnd(f.label, 400),
            detail: trimEnd(f.detail, FIELD_CAPS.findingDetailChars),
            significance: f.significance,
            relatedColumns: f.relatedColumns?.slice(0, 20),
            hypothesisId: f.hypothesisRefs?.[0],
            confidence: undefined as
              | "low"
              | "medium"
              | "high"
              | undefined, // populated once findings carry structured confidence
          })
        )
      : undefined,
    openQuestions: b.openQuestions?.length
      ? fifo(
          b.openQuestions as ReadonlyArray<OpenQuestion>,
          FIELD_CAPS.openQuestions
        ).map((q) => ({
          id: trimEnd(q.id, 120),
          text: trimEnd(q.question, 600),
          spawnedFromStepId: q.triggeredByFindingId,
          priority: q.priority,
        }))
      : undefined,
    domainContext: b.domainContext?.length
      ? fifo(
          b.domainContext as ReadonlyArray<DomainContextEntry>,
          FIELD_CAPS.domainContext
        ).map((d) => ({
          id: trimEnd(d.id, 120),
          text: trimEnd(d.content, FIELD_CAPS.domainContextTextChars),
          sourceRound: d.source,
        }))
      : undefined,
  };
}

/**
 * Convert a single ToolCallRecord (which today survives in the agent trace
 * with a 500-char-summary cap) into a ToolIORecord with the full result. The
 * caller passes the live ToolResult so we can include the full payload.
 */
export function toolIORecordFromCall(
  rec: ToolCallRecord,
  fullResult?: { summary?: string; table?: unknown; numericPayload?: string },
  args?: Record<string, unknown>,
  durationMs?: number
): ToolIORecord {
  const summary =
    fullResult?.summary != null
      ? String(fullResult.summary)
      : (rec as { resultSummary?: string }).resultSummary ?? "";
  let payload: string | undefined;
  if (fullResult) {
    const obj: Record<string, unknown> = {};
    if (fullResult.table != null) obj.table = fullResult.table;
    if (fullResult.numericPayload != null) obj.numericPayload = fullResult.numericPayload;
    if (Object.keys(obj).length > 0) {
      try {
        payload = JSON.stringify(obj);
      } catch {
        payload = undefined;
      }
    }
  }
  let argsJson: string;
  try {
    argsJson = args ? JSON.stringify(args) : "{}";
  } catch {
    argsJson = "{}";
  }
  return {
    stepId: rec.id,
    tool: rec.name,
    ok: rec.ok,
    argsJson,
    resultSummary: summary,
    resultPayload: payload,
    analyticalMeta: undefined,
    durationMs,
  };
}
