/**
 * Wave B9 · `PriorTurnHandle` builder.
 *
 * Reads the prior assistant message's persisted `agentInternals` (Wave A1/A2)
 * and exposes typed read accessors so a follow-up turn's planner / reflector /
 * narrator can reason against structured prior state instead of the W60
 * memory-recall TEXT block.
 *
 * Falls back to `null` when no prior assistant message has `agentInternals`
 * persisted (legacy turns or first-turn sessions). The W60 memory recall path
 * stays in place as a TEXT fallback in those cases.
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
