/**
 * W60 · Semantic Memory Recall block for the planner prompt.
 *
 * Replaces the FIFO-capped `priorInvestigations` digest with a vector-search
 * over the per-session AI Search index (W57). Every analytical event written
 * by the producer hooks (W58/W59) becomes individually retrievable; the
 * planner sees only the top-k relevant entries for the current question, so
 * the prompt stays bounded while session memory itself is unbounded.
 *
 * Pure formatter: caller decides where to inject the block (currently the
 * planner's user prompt at the top, just below RAG hits and prior turn
 * observations).
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
   * W66 · Optional staleness floor. Defaults to undefined (return entries
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
