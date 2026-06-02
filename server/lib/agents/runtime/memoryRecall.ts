/**
 * ============================================================================
 * memoryRecall.ts — pull relevant past findings into the planner prompt
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Builds a "MEMORY_RECALL" text block listing prior analytical findings from
 *   this session that are semantically relevant to the current question. It
 *   does a vector search ("semantic search" = find by meaning, not exact words)
 *   over a per-session search index and returns only the top-k matches.
 *
 * WHY IT MATTERS
 *   Lets the planner chain on earlier work — avoid re-running settled questions,
 *   pick up open threads — while keeping the prompt small. Session memory itself
 *   can grow without bound, but only the few relevant entries ever hit the prompt.
 *
 * KEY PIECES
 *   - formatMemoryRecallForPlanner(args) — async; returns the markdown block, or
 *     "" when RAG is off, nothing matches, or search fails (so callers can just
 *     concatenate, no conditionals needed).
 *
 * HOW IT CONNECTS
 *   Searches via rag/retrieve.js (searchMemoryEntries); gated by rag/config.js
 *   (isRagEnabled). Caller injects the block near the top of the planner's user
 *   prompt, below RAG hits and prior-turn observations.
 */
import { searchMemoryEntries } from "../../rag/retrieve.js";
import { isRagEnabled } from "../../rag/config.js";

const DEFAULT_TOP_K = 12;
const BLOCK_HARD_CAP = 10_000; // chars — keeps the planner prompt deterministic.

/**
 * Build the "MEMORY_RECALL" markdown block for the planner. Returns "" when
 * disabled, when no entries match, or when search fails — callers can just
 * concatenate without conditional logic.
 */
export async function formatMemoryRecallForPlanner(args: {
  sessionId: string;
  question: string;
  /**
   * Optional staleness floor. Defaults to undefined (return entries
   * from all dataVersions) since old findings are usually informational
   * context — the agent should weigh relevance, not the index. Callers can
   * tighten when there's a reason (e.g. drastic transform).
   */
  minDataVersion?: number;
  topK?: number;
}): Promise<string> {
  if (!isRagEnabled()) return "";
  const q = (args.question || "").trim();
  if (!q || !args.sessionId) return "";

  const result = await searchMemoryEntries({
    sessionId: args.sessionId,
    query: q,
    topK: args.topK ?? DEFAULT_TOP_K,
    minDataVersion: args.minDataVersion,
  });
  if (result.retrievalError) {
    // Best-effort — never fail the planner because Memory recall failed.
    return "";
  }
  if (result.hits.length === 0) return "";

  const lines: string[] = [
    "MEMORY_RECALL (semantically relevant prior entries from this analysis; chain hypotheses, do not re-run settled questions, pick up open threads — figures still come from this turn's tool output):",
  ];
  for (const h of result.hits) {
    // Each entry's content is `[type] title\nsummary`, see
    // `memoryEntryEmbeddingText()` in indexSession.ts. Render as a single bullet
    // and clip aggressively so 12 entries × ~800 chars stays under 10 KB.
    const collapsed = (h.content || "").replace(/\s+/g, " ").trim();
    if (!collapsed) continue;
    const clipped =
      collapsed.length > 800 ? `${collapsed.slice(0, 799)}…` : collapsed;
    lines.push(`  • ${clipped}`);
  }
  if (lines.length <= 1) return "";

  let block = lines.join("\n");
  if (block.length > BLOCK_HARD_CAP) {
    block = `${block.slice(0, BLOCK_HARD_CAP - 1)}…`;
  }
  return block;
}
