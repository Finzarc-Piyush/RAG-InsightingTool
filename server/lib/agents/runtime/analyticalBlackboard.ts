/**
 * Wave W2 · analyticalBlackboard
 *
 * Shared structured evidence store for all agents in a turn / investigation tree.
 * Pure functions only — no I/O, no LLM calls.
 */

export type HypothesisStatus = "open" | "confirmed" | "refuted" | "partial";

export interface Hypothesis {
  id: string;
  text: string;
  /** Which column/dimension this hypothesis concerns, if any. */
  targetColumn?: string;
  status: HypothesisStatus;
  evidenceRefs: string[]; // callIds or finding ids
}

export interface Finding {
  id: string;
  /** Source tool call id (callId) or synthetic id for injected context. */
  sourceRef: string;
  /** Short human-readable label for the finding. */
  label: string;
  /** Full detail — cited numbers, dimensions, context. */
  detail: string;
  /** How surprising / important this is (used to gate spawning). */
  significance: "routine" | "notable" | "anomalous";
  /** Hypothesis ids this finding supports, refutes, or is unrelated to. */
  hypothesisRefs: string[];
  /** Related column names (for context agent round-2 query construction). */
  relatedColumns: string[];
  confirmedAt: number;
}

export interface OpenQuestion {
  id: string;
  question: string;
  /** Why this needs investigation. */
  spawnReason: string;
  priority: "high" | "medium" | "low";
  /** Finding id that triggered this question, if any. */
  triggeredByFindingId?: string;
  /** Node id this question was spawned into, once actioned. */
  actionedByNodeId?: string;
}

export interface DomainContextEntry {
  id: string;
  content: string;
  source: "rag_round1" | "rag_round2" | "injected";
}

export interface AnalyticalBlackboard {
  hypotheses: Hypothesis[];
  findings: Finding[];
  openQuestions: OpenQuestion[];
  domainContext: DomainContextEntry[];
  /** Monotonic counter used for generating ids. */
  _seq: number;
}

// ─── Creation ──────────────────────────────────────────────────────────────

export function createBlackboard(): AnalyticalBlackboard {
  return {
    hypotheses: [],
    findings: [],
    openQuestions: [],
    domainContext: [],
    _seq: 0,
  };
}

// ─── Hypotheses ────────────────────────────────────────────────────────────

export function addHypothesis(
  bb: AnalyticalBlackboard,
  text: string,
  opts: { targetColumn?: string } = {}
): Hypothesis {
  const h: Hypothesis = {
    id: `h${++bb._seq}`,
    text,
    targetColumn: opts.targetColumn,
    status: "open",
    evidenceRefs: [],
  };
  bb.hypotheses.push(h);
  return h;
}

export function resolveHypothesis(
  bb: AnalyticalBlackboard,
  hypothesisId: string,
  status: Exclude<HypothesisStatus, "open">,
  evidenceRef: string
): boolean {
  const h = bb.hypotheses.find((x) => x.id === hypothesisId);
  if (!h) return false;
  h.status = status;
  if (!h.evidenceRefs.includes(evidenceRef)) h.evidenceRefs.push(evidenceRef);
  return true;
}

// ─── Findings ──────────────────────────────────────────────────────────────

export function addFinding(
  bb: AnalyticalBlackboard,
  opts: {
    sourceRef: string;
    label: string;
    detail: string;
    significance?: Finding["significance"];
    hypothesisRefs?: string[];
    relatedColumns?: string[];
  }
): Finding {
  const f: Finding = {
    id: `f${++bb._seq}`,
    sourceRef: opts.sourceRef,
    label: opts.label,
    detail: opts.detail,
    significance: opts.significance ?? "routine",
    hypothesisRefs: opts.hypothesisRefs ?? [],
    relatedColumns: opts.relatedColumns ?? [],
    confirmedAt: Date.now(),
  };
  bb.findings.push(f);
  return f;
}

// ─── Open questions ─────────────────────────────────────────────────────────

export function addOpenQuestion(
  bb: AnalyticalBlackboard,
  question: string,
  spawnReason: string,
  opts: {
    priority?: OpenQuestion["priority"];
    triggeredByFindingId?: string;
  } = {}
): OpenQuestion {
  const q: OpenQuestion = {
    id: `q${++bb._seq}`,
    question,
    spawnReason,
    priority: opts.priority ?? "medium",
    triggeredByFindingId: opts.triggeredByFindingId,
  };
  bb.openQuestions.push(q);
  return q;
}

export function markQuestionActioned(
  bb: AnalyticalBlackboard,
  questionId: string,
  nodeId: string
): boolean {
  const q = bb.openQuestions.find((x) => x.id === questionId);
  if (!q) return false;
  q.actionedByNodeId = nodeId;
  return true;
}

// ─── Domain context ─────────────────────────────────────────────────────────

export function addDomainContext(
  bb: AnalyticalBlackboard,
  content: string,
  source: DomainContextEntry["source"]
): DomainContextEntry {
  const e: DomainContextEntry = {
    id: `dc${++bb._seq}`,
    content,
    source,
  };
  bb.domainContext.push(e);
  return e;
}

// ─── Convergence heuristic ──────────────────────────────────────────────────

/**
 * Simple convergence check: all hypotheses resolved AND no high-priority
 * open questions remain unactioned AND at least one finding exists.
 */
export function isConverged(bb: AnalyticalBlackboard): boolean {
  if (bb.findings.length === 0) return false;
  const openHypotheses = bb.hypotheses.filter((h) => h.status === "open");
  if (openHypotheses.length > 0) return false;
  const pendingHighPriority = bb.openQuestions.filter(
    (q) => q.priority === "high" && !q.actionedByNodeId
  );
  return pendingHighPriority.length === 0;
}

// ─── Formatting ─────────────────────────────────────────────────────────────

const MAX_FINDING_DETAIL = 600;
const MAX_CONTEXT_CHARS = 400;

/** Compact block fed to the planner / reflector. */
export function formatForPlanner(bb: AnalyticalBlackboard): string {
  if (
    bb.hypotheses.length === 0 &&
    bb.findings.length === 0 &&
    bb.openQuestions.length === 0
  ) {
    return "";
  }
  const parts: string[] = [];

  if (bb.hypotheses.length > 0) {
    parts.push("INVESTIGATION_HYPOTHESES:");
    for (const h of bb.hypotheses) {
      const refs = h.evidenceRefs.length ? ` refs=[${h.evidenceRefs.join(",")}]` : "";
      parts.push(`  [${h.id}] ${h.status.toUpperCase()} — ${h.text}${refs}`);
    }
  }

  if (bb.findings.length > 0) {
    parts.push("FINDINGS:");
    for (const f of bb.findings) {
      const detail = f.detail.replace(/\s+/g, " ").slice(0, MAX_FINDING_DETAIL);
      parts.push(`  [${f.id}|${f.significance}] ${f.label}: ${detail}`);
    }
  }

  if (bb.openQuestions.length > 0) {
    const pending = bb.openQuestions.filter((q) => !q.actionedByNodeId);
    if (pending.length > 0) {
      parts.push("OPEN_QUESTIONS:");
      for (const q of pending) {
        parts.push(`  [${q.id}|${q.priority}] ${q.question} (reason: ${q.spawnReason})`);
      }
    }
  }

  return parts.join("\n");
}

/** Richer block fed to the narrator for synthesis. */
export function formatForNarrator(bb: AnalyticalBlackboard): string {
  const parts: string[] = [];

  if (bb.domainContext.length > 0) {
    parts.push("DOMAIN_CONTEXT:");
    for (const dc of bb.domainContext) {
      parts.push(`  [${dc.source}] ${dc.content.slice(0, MAX_CONTEXT_CHARS)}`);
    }
  }

  if (bb.hypotheses.length > 0) {
    parts.push("HYPOTHESIS_OUTCOMES:");
    for (const h of bb.hypotheses) {
      const evidence =
        h.evidenceRefs.length > 0 ? ` Evidence: ${h.evidenceRefs.join(", ")}` : "";
      parts.push(`  [${h.id}] ${h.status.toUpperCase()} — ${h.text}.${evidence}`);
    }
  }

  if (bb.findings.length > 0) {
    parts.push("FINDINGS (most significant first):");
    const sorted = [...bb.findings].sort((a, b) => {
      const rank = { anomalous: 0, notable: 1, routine: 2 };
      return rank[a.significance] - rank[b.significance];
    });
    for (const f of sorted) {
      parts.push(`  [${f.id}] ${f.label}`);
      parts.push(`    ${f.detail.replace(/\s+/g, " ")}`);
    }
  }

  return parts.join("\n");
}
