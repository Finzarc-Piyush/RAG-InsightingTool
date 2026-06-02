/**
 * ============================================================================
 * priorTurnState.ts — gives the current turn typed access to the last answer
 * ============================================================================
 * WHAT THIS FILE DOES
 *   In a chat, each user question is a "turn". When the user asks a follow-up,
 *   the agent benefits from knowing what the PREVIOUS answer concluded — its
 *   findings and hypotheses. Every finalised assistant message stores this as
 *   `agentInternals` (a saved snapshot of the agent's internal state). This file
 *   finds the most recent finalised assistant message, reads that snapshot, and
 *   wraps it in a `PriorTurnHandle` — a small object with typed read accessors
 *   (`findings(...)`, `hypotheses()`) so the planner/reflector/narrator can query
 *   structured prior state directly instead of parsing a blob of recall text.
 *
 * WHY IT MATTERS
 *   It lets a follow-up turn build on the last turn instead of starting cold —
 *   e.g. "chain hypotheses, don't re-run settled questions". When no prior
 *   snapshot exists (first turn, or older messages saved before this feature),
 *   it returns null and the system falls back to a plain-text memory-recall path.
 *
 * KEY PIECES
 *   - buildPriorTurnHandle — walks chat history backward, returns a handle from
 *     the latest finalised assistant message (skips streaming-preview rows).
 *   - formatPriorTurnHandleForPrompt — renders the handle as a labelled
 *     "PRIOR_TURN_STATE" prompt block (empty string when nothing to show).
 *
 * HOW IT CONNECTS
 *   Types come from investigationState.js (StructuredFinding, HypothesisNode,
 *   PriorTurnHandle) and shared/schema.js (AgentInternals, Message). The prompt
 *   block produced here is injected into planner/reflector/narrator prompts.
 */
import type {
  StructuredFinding,
  HypothesisNode,
  PriorTurnHandle,
} from "./investigationState.js";
import type { AgentInternals, Message } from "../../../shared/schema.js";

/**
 * Build a `PriorTurnHandle` from the most recent assistant message that
 * carries `agentInternals`. Walks `chatHistory` from the end so an
 * intermediate streaming-preview row without saved state doesn't shadow the
 * prior finalised turn.
 */
export function buildPriorTurnHandle(
  chatHistory: ReadonlyArray<Message>
): PriorTurnHandle | null {
  for (let i = chatHistory.length - 1; i >= 0; i--) {
    const m = chatHistory[i];
    if (m?.role !== "assistant") continue;
    if (m.isIntermediate) continue;
    if (!m.agentInternals) continue;
    return makeHandle(m, m.agentInternals);
  }
  return null;
}

function makeHandle(m: Message, internals: AgentInternals): PriorTurnHandle {
  return {
    question: extractQuestion(m),
    timestamp: m.timestamp,
    agentInternals: internals,
    findings(filter) {
      const raw = internals.blackboardSnapshot?.findings ?? [];
      // Project legacy snapshot shape → StructuredFinding interface.
      return raw
        .filter((f) => {
          if (filter?.tag) {
            const tag = filter.tag.toLowerCase();
            const haystack = `${f.label} ${f.detail}`.toLowerCase();
            if (!haystack.includes(tag)) return false;
          }
          if (filter?.relatedColumn) {
            if (!f.relatedColumns?.includes(filter.relatedColumn)) return false;
          }
          return true;
        })
        .map<StructuredFinding>((f) => ({
          id: f.id,
          claim: f.detail || f.label,
          significance: f.significance,
          confidence: (f.confidence ?? "medium") as "low" | "medium" | "high",
          sources: [],
          evidence: { queries: [], rowRefs: [], stats: [] },
          relatedColumns: f.relatedColumns ?? [],
          createdAt: 0,
        }));
    },
    hypotheses() {
      const raw = internals.blackboardSnapshot?.hypotheses ?? [];
      return raw.map<HypothesisNode>((h) => ({
        id: h.id,
        text: h.text,
        status: h.status,
        evidence: h.evidenceFindingIds ?? [],
        testedBy: [],
        parentId: h.parentId,
        alternatives: h.alternatives,
        createdAt: 0,
      }));
    },
  };
}

function extractQuestion(m: Message): string {
  // Best-effort: use the first 200 chars of content as a placeholder. The
  // user's actual question lives on the preceding user message; the agent
  // loop carries `ctx.question` directly so this field is informational.
  return (m.content ?? "").slice(0, 200);
}

/**
 * Render the priorTurnState as a labelled prompt block for the planner /
 * reflector / narrator. Empty string when no handle / no findings.
 */
export function formatPriorTurnHandleForPrompt(
  handle: PriorTurnHandle | null
): string {
  if (!handle) return "";
  const findings = handle.findings();
  const hyps = handle.hypotheses();
  if (findings.length === 0 && hyps.length === 0) return "";
  const lines: string[] = ["### PRIOR_TURN_STATE (typed structured state from the most recent finalised assistant turn — use as the implicit baseline)"];
  if (hyps.length > 0) {
    lines.push("Hypotheses:");
    for (const h of hyps.slice(0, 8)) {
      lines.push(`  ${h.id} (${h.status}): ${h.text.slice(0, 200)}`);
    }
  }
  if (findings.length > 0) {
    lines.push("Findings:");
    for (const f of findings.slice(0, 12)) {
      lines.push(`  ${f.id} [${f.significance}] ${f.claim.slice(0, 240)}`);
    }
  }
  return lines.join("\n").slice(0, 4_000);
}
