import type { DataSummary } from "../../shared/schema.js";
import { isRagEnabled, getRagTopK } from "./config.js";
import { embedQuery } from "./embeddings.js";
import { vectorSearchSession } from "./aiSearchStore.js";
import type { RagHit } from "./ragHit.js";
import { suggestedColumnsFromHits, formatHitsForPrompt } from "./retrieveHelpers.js";

export type { RagHit } from "./ragHit.js";
export { suggestedColumnsFromHits, formatHitsForPrompt } from "./retrieveHelpers.js";

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
}> {
  if (!isRagEnabled()) {
    return { hits: [], suggestedColumns: [] };
  }
  try {
    const qv = await embedQuery(params.question);
    const hits = await vectorSearchSession({
      sessionId: params.sessionId,
      queryVector: qv,
      topK: getRagTopK(),
      dataVersion: params.dataVersion,
    });
    return {
      hits,
      suggestedColumns: suggestedColumnsFromHits(hits, params.summary),
    };
  } catch (e) {
    console.error("⚠️ RAG retrieve failed:", e);
    const msg = e instanceof Error ? e.message : String(e);
    return { hits: [], suggestedColumns: [], retrievalError: msg };
  }
}
