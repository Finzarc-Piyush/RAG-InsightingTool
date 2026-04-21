/**
 * Wave W4 · contextAgent
 *
 * Multi-round RAG. Round 1 already runs upfront in agentLoop (the
 * `upfrontRagHitsBlock`). This module implements Round 2 (and optionally
 * Round 3): after the first parallel tool group completes, derive queries
 * from the findings on the blackboard and retrieve additional domain context.
 * Results are written to the blackboard as DomainContextEntry records.
 *
 * Calling this is non-fatal; if RAG is not enabled or the search call fails
 * the loop continues uninterrupted.
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
