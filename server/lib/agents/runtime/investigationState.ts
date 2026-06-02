/**
 * ============================================================================
 * investigationState.ts — the data shapes that hold everything the agent
 *                        learns while answering one question
 * ============================================================================
 * WHAT THIS FILE DOES
 *   This file is pure TypeScript type definitions (plus two tiny helpers). It
 *   describes the "investigation state": one big object that records, in a
 *   structured and lossless way, everything the agent discovers while working a
 *   question — the hypotheses it's testing, the findings it confirms, the raw
 *   results of every tool call ("observations"), facts it's holding in working
 *   memory, RAG/web context it pulled in, contradictions it spotted, and its
 *   verification trail. "Lossless" means the full tool result is kept (the whole
 *   table, charts, numbers), not just a one-line summary — the summary is only
 *   for showing the model, while the full result stays available for code.
 *
 * WHY IT MATTERS
 *   An older design was "prompt-centric": rich tool results were flattened into
 *   a single prose line, findings lost their structure, and tools couldn't read
 *   what earlier steps had found. These types are the foundation for a
 *   "state-centric" alternative where steps cite each other by id, every finding
 *   carries typed evidence and a confidence level, and hypotheses form a tree
 *   with parents, children, and alternative explanations. Many other runtime
 *   files build, read, and project from this state.
 *
 * KEY PIECES
 *   - InvestigationState — the top-level object tying everything together.
 *   - createInvestigationState(question) — make a fresh, empty state.
 *   - StructuredFinding — a single typed claim with evidence + confidence.
 *   - HypothesisNode / HypothesisTree — tree of hypotheses and their status.
 *   - StructuredObservation — one tool call's full result + a compact summary.
 *   - Fact / ScratchpadEntry — working memory and a cross-step typed scratchpad.
 *   - MagnitudeClaim / MagnitudeAudit — the numeric core of a claim and its
 *     re-checked verification record.
 *   - RagHit / Contradiction / VerificationLog / CausalNode — context, detected
 *     inconsistencies, the verification trail, and a causal-chain shape.
 *   - PriorTurnHandle — read-only access to a previous turn's structured state.
 *   - nextId(prefix) — generate a short unique id (e.g. "finding-…").
 *
 * HOW IT CONNECTS
 *   Imports `AgentInternals` and the verdict-record types from sibling files
 *   (../../../shared/schema.js, ./buildAgentInternals.js). The legacy
 *   `AnalyticalBlackboard` (analyticalBlackboard.ts) is a *projection* of this
 *   state, so older code keeps working unchanged on top of these richer shapes.
 *
 * DESIGN INVARIANTS
 *   - Lossless: full `ToolResult.payload` (table, charts, numericPayload) is
 *     preserved on `StructuredObservation`. Prompt rendering reads
 *     `resultSummary`; programmatic access reads `result`.
 *   - Structured: every finding has typed evidence + confidence + sources;
 *     every magnitude carries a verifying query + (later) confidence interval.
 *   - Cross-step references: tools cite each other by `stepId` (symbolic),
 *     not by re-shipping payloads.
 *   - Tree-structured hypotheses: parent/child + alternatives so multi-
 *     hypothesis investigations track branches explicitly.
 *   - Back-compat: legacy `AnalyticalBlackboard` is a *projection* of this
 *     state (analyticalBlackboard.ts keeps working unchanged at the data layer).
 */

// ─── Identifiers ───────────────────────────────────────────────────────────

export type StepId = string;
export type FindingId = string;
export type HypothesisId = string;
export type SubQuestionId = string;
export type ObservationId = string;

// ─── References (symbolic, lightweight) ────────────────────────────────────

export interface QueryRef {
  stepId: StepId;
  /** SQL or query plan JSON that produced the cited rows / numbers. */
  query: string;
  /** Tool that ran it. */
  tool: string;
}

export interface RowRef {
  /** Filter spec describing the row set; resolved on demand via DataAccess. */
  filter?: Record<string, unknown>;
  /** Row count this RowRef stands for. */
  count: number;
  /** Optional small sample of representative rows for prompt rendering. */
  sample?: Record<string, unknown>[];
  /** Step that produced these rows. */
  producedByStepId?: StepId;
}

export interface StatRef {
  /** Stat kind: mean, sum, p50, p95, correlation, etc. */
  kind: string;
  /** Column the stat is for. */
  column?: string;
  /** Numeric value of the stat. */
  value: number;
  /** Optional lower / upper bound. */
  ci?: [number, number];
  /** Filter scope this stat was computed under. */
  filter?: Record<string, unknown>;
}

export interface FindingCitation {
  /** Reference to a finding by id. */
  findingId: FindingId;
  /** Optional clarifying note about how this citation supports/contradicts. */
  note?: string;
}

// ─── Magnitudes (the numeric core of every claim) ──────────────────────────

export type Direction = "up" | "down" | "flat";

export interface MagnitudeClaim {
  value: number;
  unit: string;
  direction?: Direction;
  /** 95% confidence interval when computed. */
  ci?: [number, number];
  /** Optional column / metric label for prompt rendering. */
  metric?: string;
  /** Filter scope under which this magnitude holds. */
  filter?: Record<string, unknown>;
}

export interface MagnitudeAudit {
  /** Finding the audited magnitude lives on. */
  findingId: FindingId;
  /** What the tool reported. */
  expected: number;
  /** What re-running the verification query against raw data found. */
  actual: number | null;
  /** Percent difference between expected and actual. null when unverifiable. */
  deltaPct: number | null;
  status: "ok" | "drift" | "unverifiable";
  /** ISO timestamp of the audit. */
  auditedAt: number;
  /** Note: which query was run for verification. */
  verificationQuery?: string;
}

// ─── Structured findings (replace LLM-prose Finding) ───────────────────────

export type FindingConfidence = "low" | "medium" | "high";
export type FindingSignificance = "anomalous" | "notable" | "routine";

export interface StructuredFinding {
  id: FindingId;
  /** Human-readable claim sentence. */
  claim: string;
  /** Hypothesis this finding tests (when applicable). */
  hypothesisId?: HypothesisId;
  /** Significance gates spawning of follow-up sub-questions. */
  significance: FindingSignificance;
  confidence: FindingConfidence;
  /** Tools / agents whose work supports this finding. */
  sources: StepId[];
  evidence: {
    queries: QueryRef[];
    rowRefs: RowRef[];
    stats: StatRef[];
  };
  /** Optional numeric magnitude (the "−12% drop" core of the claim). */
  magnitude?: MagnitudeClaim;
  /** Findings this contradicts (cross-checked by the contradiction watcher). */
  contradicts?: FindingCitation[];
  /** Findings this supports. */
  supports?: FindingCitation[];
  /** Related column names (for context-agent Round-2 query construction). */
  relatedColumns?: string[];
  createdAt: number;
}

// ─── Hypothesis tree (replaces flat Hypothesis array) ──────────────────────

export type HypothesisStatusV2 =
  | "open"
  | "confirmed"
  | "refuted"
  | "partial"
  | "inconclusive";

export interface HypothesisNode {
  id: HypothesisId;
  /** null/undefined for root-level hypotheses. */
  parentId?: HypothesisId;
  /** Sibling hypotheses that propose alternative explanations. */
  alternatives?: HypothesisId[];
  text: string;
  /** Column / dimension this hypothesis concerns. */
  targetColumn?: string;
  status: HypothesisStatusV2;
  /** Findings (by id) that bear on this hypothesis. */
  evidence: FindingId[];
  /** Tool calls (by step id) that tested it. */
  testedBy: StepId[];
  /** Step / observation that originally triggered the hypothesis. */
  spawnedFrom?: StepId;
  confidence?: FindingConfidence;
  createdAt: number;
}

export interface HypothesisTree {
  /** Top-level hypotheses. */
  rootIds: HypothesisId[];
  /** All nodes by id. */
  byId: Record<HypothesisId, HypothesisNode>;
}

// ─── Open questions / sub-questions ────────────────────────────────────────

export interface SubQuestion {
  id: SubQuestionId;
  question: string;
  spawnReason: string;
  priority: "high" | "medium" | "low";
  /** Finding that triggered this question. */
  triggeredByFindingId?: FindingId;
  /** Suggested columns for whoever investigates it. */
  suggestedColumns?: string[];
  /** Set when the orchestrator picked it up. */
  arcId?: string;
  createdAt: number;
}

// ─── Structured observations (lossless replacement for text observations[]) ─

export interface StructuredObservation {
  id: ObservationId;
  stepId: StepId;
  tool: string;
  args: Record<string, unknown>;
  /** Full ToolResult — table, charts, numericPayload, all preserved. */
  result: unknown;
  /** Compact summary for prompt rendering. */
  resultSummary: string;
  metrics: {
    inputRowCount?: number;
    outputRowCount?: number;
    appliedAggregation?: boolean;
    durationMs?: number;
    cacheHit?: boolean;
  };
  /** Findings emitted as a side effect of this step. */
  findingIds: FindingId[];
  createdAt: number;
}

// ─── Working facts (upgraded working memory; typed slots) ──────────────────

export type FactSource =
  | { kind: "tool"; stepId: StepId; tool: string }
  | { kind: "insight"; stepId: StepId }
  | { kind: "domain"; packId: string }
  | { kind: "rag"; round: 1 | 2; hitId: string }
  | { kind: "user_question" };

export interface Fact {
  id: string;
  /** Short text that the planner / narrator can read. */
  statement: string;
  source: FactSource;
  confidence: FindingConfidence;
  /** Optional columns the fact relates to (for filtering on read). */
  relatedColumns?: string[];
  createdAt: number;
}

// ─── Inconsistencies (cross-finding contradictions detected by the watcher) ─

export interface Contradiction {
  id: string;
  /** The pair of findings whose magnitudes / claims diverge. */
  a: FindingId;
  b: FindingId;
  reason: string;
  /** Numeric magnitude of the discrepancy when measurable. */
  deltaPct?: number;
  detectedAt: number;
}

// ─── Verifications ─────────────────────────────────────────────────────────

export interface VerificationLog {
  /** Finding being verified. */
  findingId?: FindingId;
  /** What was checked. */
  kind: "magnitude" | "claim_consistency" | "row_provenance" | "domain_pack_citation";
  /** Outcome. */
  status: "ok" | "drift" | "fail" | "unverifiable";
  /** Optional human-readable detail. */
  note?: string;
  /** Detailed audit record when applicable. */
  audit?: MagnitudeAudit;
  at: number;
}

// ─── RAG hits (typed; promptBuilder still emits text) ──────────────────────

export interface RagHit {
  id: string;
  text: string;
  score?: number;
  url?: string;
  source: "rag_round1" | "rag_round2" | "web" | "injected";
  /** Step that triggered Round-2 retrieval. */
  triggeredByStepId?: StepId;
  createdAt: number;
}

// ─── Causal chain (for diagnostic question shape) ──────────────────────────

export interface CausalNode {
  id: string;
  effect: string;
  /** Findings (by id) that establish this effect. */
  evidence: FindingId[];
  /** Children: contributing factors. */
  contributingFactors: string[];
  /** When this is the deepest node in its branch. */
  isRootCause?: boolean;
}

// ─── Cross-step typed scratchpad ───────────────────────────────────────────

export interface ScratchpadEntry {
  key: string;
  /** Free-form value; tool authors are responsible for serialisation. */
  value: unknown;
  /** Producing step. */
  producedByStepId: StepId;
  /** Optional kind tag for read-side filtering. */
  kind?: string;
  createdAt: number;
}

// ─── Cross-turn handle ─────────────────────────────────────────────────────

import type { AgentInternals } from "../../../shared/schema.js";

export interface PriorTurnHandle {
  question: string;
  timestamp: number;
  /** Read-only access to prior turn's structured state, if persisted. */
  agentInternals?: AgentInternals;
  /** Lazy resolvers — read-only views. */
  findings(filter?: { tag?: string; relatedColumn?: string }): readonly StructuredFinding[];
  hypotheses(): readonly HypothesisNode[];
}

// ─── Top-level state ───────────────────────────────────────────────────────

export interface InvestigationState {
  // Question + scope
  question: string;
  questionShape?: string;
  hypotheses: HypothesisTree;
  subQuestions: SubQuestion[];
  causalChain?: CausalNode[];

  // Knowledge (lossless)
  findings: StructuredFinding[];
  observations: StructuredObservation[];
  workingFacts: Fact[];
  scratchpad: ScratchpadEntry[];

  // Context layers
  ragHits: RagHit[];
  /** Domain pack ids currently loaded. */
  domainPacks: string[];

  // Verification trail
  verifications: VerificationLog[];
  magnitudeAudits: MagnitudeAudit[];
  contradictions: Contradiction[];

  // Cross-turn
  priorTurnState: PriorTurnHandle | null;

  // Trace / history
  reflectorVerdicts: import("./buildAgentInternals.js").ReflectorVerdictRecord[];
  verifierVerdicts: import("./buildAgentInternals.js").VerifierVerdictRecord[];
}

// ─── Constructors ──────────────────────────────────────────────────────────

export function createInvestigationState(question: string): InvestigationState {
  return {
    question,
    hypotheses: { rootIds: [], byId: {} },
    subQuestions: [],
    findings: [],
    observations: [],
    workingFacts: [],
    scratchpad: [],
    ragHits: [],
    domainPacks: [],
    verifications: [],
    magnitudeAudits: [],
    contradictions: [],
    priorTurnState: null,
    reflectorVerdicts: [],
    verifierVerdicts: [],
  };
}

// ─── Utilities ─────────────────────────────────────────────────────────────

let idCounter = 0;
export function nextId(prefix: string): string {
  idCounter = (idCounter + 1) | 0;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}
