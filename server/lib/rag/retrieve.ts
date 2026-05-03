import type { DataSummary } from "../../shared/schema.js";
import { isRagEnabled, getRagTopK } from "./config.js";
import { embedQuery } from "./embeddings.js";
import { vectorSearchSession, keywordSearchSession } from "./aiSearchStore.js";
import { MEMORY_ENTRY_CHUNK_TYPE } from "./indexSession.js";
import type { RagHit } from "./ragHit.js";
import { suggestedColumnsFromHits, formatHitsForPrompt } from "./retrieveHelpers.js";

export type { RagHit } from "./ragHit.js";
export { suggestedColumnsFromHits, formatHitsForPrompt } from "./retrieveHelpers.js";

/**
 * Threshold below which vector recall is considered weak enough to warrant a
 * keyword-search augmentation pass (P-A2). Tuned conservatively — real
 * matches on this index tend to score 0.5+.
 */
const LOW_SIMILARITY_THRESHOLD = Number(
  process.env.RAG_KEYWORD_FALLBACK_MIN_SIM || 0.3
);

/** First 400 chars used as the dedup signature for hit content (P-A2). */
function hitSignature(hit: RagHit): string {
  return (hit.content || "").trim().slice(0, 400);
}

function dedupHits(hits: RagHit[]): RagHit[] {
  const seen = new Set<string>();
  const out: RagHit[] = [];
  for (const h of hits) {
    const sig = hitSignature(h);
    if (!sig || seen.has(sig)) continue;
    seen.add(sig);
    out.push(h);
  }
  return out;
}

function meanScore(hits: RagHit[]): number {
  const scored = hits.filter((h) => typeof h.score === "number");
  if (scored.length === 0) return 0;
  return scored.reduce((s, h) => s + (h.score ?? 0), 0) / scored.length;
}

export interface RetrieveDiagnostics {
  /** Mean cosine similarity across vector hits (0 when unavailable). */
  meanSimilarity: number;
  /** True when the keyword-search fallback contributed hits. */
  keywordFallbackUsed: boolean;
  /** Dedup trims (vector + keyword) before slicing to topK. */
  dedupRemoved: number;
}

export async function retrieveRagHits(params: {
  sessionId: string;
  question: string;
  summary: DataSummary;
  dataVersion?: number;
}): Promise<{
  hits: RagHit[];
  suggestedColumns: string[];
  /** Set when Search/embed API failed (distinct from zero hits). */
  retrievalError?: string;
  diagnostics?: RetrieveDiagnostics;
}> {
  if (!isRagEnabled()) {
    return { hits: [], suggestedColumns: [] };
  }
  const topK = getRagTopK();
  try {
    const qv = await embedQuery(params.question);
    const vectorHits = await vectorSearchSession({
      sessionId: params.sessionId,
      queryVector: qv,
      topK,
      dataVersion: params.dataVersion,
      // W57 · keep memory entries out of data-RAG retrieval; they are surfaced
      // separately via `searchMemoryEntries` for the planner's recall block.
      excludeChunkTypes: [MEMORY_ENTRY_CHUNK_TYPE],
    });

    const mean = meanScore(vectorHits);
    const weakRecall =
      vectorHits.length === 0 || mean < LOW_SIMILARITY_THRESHOLD;

    let keywordHits: RagHit[] = [];
    if (weakRecall) {
      try {
        keywordHits = await keywordSearchSession({
          sessionId: params.sessionId,
          query: params.question,
          topK: 2,
          dataVersion: params.dataVersion,
          excludeChunkTypes: [MEMORY_ENTRY_CHUNK_TYPE],
        });
      } catch (kwErr) {
        // Keyword augmentation is best-effort — never block the main result.
        console.warn("⚠️ RAG keyword fallback failed:", kwErr);
      }
    }

    const combined = [...vectorHits, ...keywordHits];
    const deduped = dedupHits(combined);
    const dedupRemoved = combined.length - deduped.length;
    const hits = deduped.slice(0, topK);

    return {
      hits,
      suggestedColumns: suggestedColumnsFromHits(hits, params.summary),
      diagnostics: {
        meanSimilarity: mean,
        keywordFallbackUsed: keywordHits.length > 0,
        dedupRemoved,
      },
    };
  } catch (e) {
    console.error("⚠️ RAG retrieve failed:", e);
    const msg = e instanceof Error ? e.message : String(e);
    return { hits: [], suggestedColumns: [], retrievalError: msg };
  }
}

/**
 * W57 · Semantic search restricted to Analysis Memory entries for a session.
 * Used by W60 (planner recall block) and W61 (Memory page search endpoint).
 *
 * Returns the most relevant memory entries (questions, hypotheses, findings,
 * conclusions, etc.) for a follow-up question — bypasses the FIFO 5 cap on
 * `priorInvestigations` and unlocks unbounded session memory with a bounded
 * prompt (top-k injection only).
 */
export async function searchMemoryEntries(params: {
  sessionId: string;
  query: string;
  topK?: number;
  /** Optional staleness floor: only return entries with dataVersion ≥ this. */
  minDataVersion?: number;
}): Promise<{
  hits: RagHit[];
  retrievalError?: string;
  diagnostics?: { meanSimilarity: number };
}> {
  if (!isRagEnabled()) {
    return { hits: [] };
  }
  const queryText = (params.query || "").trim();
  if (!queryText) return { hits: [] };
  const topK = params.topK ?? 12;
  try {
    const qv = await embedQuery(queryText);
    // W66 · Pass `minDataVersion` through to AI Search as an OData `ge` clause
    // (server-side staleness filter) — preserves index efficiency vs paging
    // through and discarding client-side. When `minDataVersion` is unset, we
    // fall back to all dataVersions so historical entries still appear.
    const vectorHits = await vectorSearchSession({
      sessionId: params.sessionId,
      queryVector: qv,
      topK,
      includeChunkTypes: [MEMORY_ENTRY_CHUNK_TYPE],
      minDataVersion: params.minDataVersion,
    });
    const deduped = dedupHits(vectorHits).slice(0, topK);
    return {
      hits: deduped,
      diagnostics: { meanSimilarity: meanScore(deduped) },
    };
  } catch (e) {
    console.error("⚠️ Memory recall search failed:", e);
    const msg = e instanceof Error ? e.message : String(e);
    return { hits: [], retrievalError: msg };
  }
}
