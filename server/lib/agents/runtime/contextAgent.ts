/**
 * ============================================================================
 * contextAgent.ts — second round of background-knowledge retrieval (RAG)
 * ============================================================================
 * WHAT THIS FILE DOES
 *   RAG = "retrieval-augmented generation": before/while answering, the system
 *   fetches relevant background snippets (domain knowledge, prior notes) and
 *   feeds them to the LLM. Round 1 of RAG already runs at the very start of a
 *   turn. This file is Round 2: AFTER the first batch of analytical tools has run
 *   and produced findings, it turns those findings into fresh search queries,
 *   retrieves more domain context, and writes the results back onto the
 *   "blackboard" (the shared scratchpad where the agent's findings and context
 *   live for this turn).
 *
 * WHY IT MATTERS
 *   Findings reveal what's actually interesting (e.g. an anomaly in a specific
 *   region), and Round 2 lets the system pull background that's targeted to those
 *   discoveries — context Round 1 couldn't know to ask for. It's best-effort and
 *   non-fatal: if RAG is disabled or a search fails, the agent loop continues
 *   uninterrupted (the function just returns 0).
 *
 * KEY PIECES
 *   - runContextAgentRound2 — runs Round 2; returns how many new context entries
 *     were added (0 = disabled / no hits / error).
 *   - deriveQueriesFromFindings (internal) — builds up to 3 queries, preferring
 *     anomalous over notable over routine findings, falling back to open
 *     hypotheses then the root question so it never returns empty.
 *
 * HOW IT CONNECTS
 *   Lazily imports rag/config.js (isRagEnabled) and rag/retrieve.js
 *   (retrieveRagHits, formatHitsForPrompt). Writes via addDomainContext into the
 *   AnalyticalBlackboard. Called from the main agent loop between tool groups.
 */

import { agentLog } from "./agentLogger.js";
import {
  addDomainContext,
  type AnalyticalBlackboard,
} from "./analyticalBlackboard.js";
import type { AgentExecutionContext } from "./types.js";

const MAX_ROUND2_QUERIES = 3;
const MAX_HITS_PER_QUERY = 2;
const MAX_CONTEXT_CHARS = 800;

/**
 * Derive search queries from blackboard findings. Targets anomalous/notable
 * findings first since those are most likely to benefit from domain context.
 */
function deriveQueriesFromFindings(
  bb: AnalyticalBlackboard,
  rootQuestion: string
): string[] {
  const queries: string[] = [];

  // Prefer anomalous > notable > routine
  const sorted = [...bb.findings].sort((a, b) => {
    const rank = { anomalous: 0, notable: 1, routine: 2 };
    return rank[a.significance] - rank[b.significance];
  });

  for (const f of sorted.slice(0, MAX_ROUND2_QUERIES)) {
    const cols =
      f.relatedColumns.length > 0
        ? ` focusing on ${f.relatedColumns.slice(0, 3).join(", ")}`
        : "";
    queries.push(`${f.label}${cols}`);
  }

  // If no findings yet, fall back to open hypothesis texts
  if (queries.length === 0) {
    for (const h of bb.hypotheses.filter((h) => h.status === "open").slice(0, MAX_ROUND2_QUERIES)) {
      queries.push(h.text);
    }
  }

  // Always include root question as last fallback so we never return empty
  if (queries.length === 0) {
    queries.push(rootQuestion);
  }

  return queries.slice(0, MAX_ROUND2_QUERIES);
}

/**
 * Run RAG Round 2 after the first parallel tool group completes.
 * Writes retrieved domain context into the blackboard.
 * Returns the number of new context entries added (0 = no-op / disabled).
 */
export async function runContextAgentRound2(
  ctx: AgentExecutionContext,
  blackboard: AnalyticalBlackboard,
  turnId: string
): Promise<number> {
  try {
    const { isRagEnabled } = await import("../../rag/config.js");
    if (!isRagEnabled()) return 0;

    const { retrieveRagHits, formatHitsForPrompt } = await import(
      "../../rag/retrieve.js"
    );

    const queries = deriveQueriesFromFindings(blackboard, ctx.question);
    let added = 0;

    for (const query of queries) {
      try {
        const { hits } = await retrieveRagHits({
          sessionId: ctx.sessionId,
          question: query,
          summary: ctx.summary,
          dataVersion: ctx.dataBlobVersion,
        });
        const topHits = hits.slice(0, MAX_HITS_PER_QUERY);
        if (topHits.length === 0) continue;

        const content = formatHitsForPrompt(topHits)
          .replace(/\s+/g, " ")
          .slice(0, MAX_CONTEXT_CHARS);

        addDomainContext(blackboard, content, "rag_round2");
        added++;
      } catch (hitErr) {
        agentLog("contextAgent.queryFailed", {
          turnId,
          query: query.slice(0, 80),
          error: hitErr instanceof Error ? hitErr.message : String(hitErr),
        });
      }
    }

    agentLog("contextAgent.round2.done", { turnId, added, queries: queries.length });
    return added;
  } catch (err) {
    agentLog("contextAgent.round2.failed", {
      turnId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}
