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
}): Promise<{ hits: RagHit[]; suggestedColumns: string[] }> {
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
    return { hits: [], suggestedColumns: [] };
  }
}
