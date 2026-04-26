/**
 * Azure AI Search push + query helpers for the `past-analyses` index.
 *
 * The index document is a denormalized projection of the Cosmos source-of-truth
 * (`past_analyses`), with `questionVector` added from `embedQuery(normalizedQuestion)`.
 * Kept in sync via fire-and-forget `indexPastAnalysis()` from the chat-stream writer.
 *
 * Mirror of `aiSearchStore.ts` for the rag-session-chunks index — same retry
 * logic, same auth pattern, same push-based model. Keeping the two stores
 * separate (rather than unifying) avoids cross-concern coupling: the rag
 * store indexes data-chunks, this one indexes Q&A records.
 */

import { SearchClient, AzureKeyCredential } from "@azure/search-documents";
import { requireAzureSearchCredentials } from "./config.js";
import { PAST_ANALYSES_INDEX_NAME } from "./createPastAnalysesIndex.js";
import type { PastAnalysisDoc } from "../../shared/schema.js";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

async function withSearchRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const statusCode =
        (err as { statusCode?: number; status?: number })?.statusCode ??
        (err as { status?: number })?.status;
      const retryable = statusCode == null ? false : RETRYABLE_STATUS.has(statusCode);
      if (!retryable || attempt === maxAttempts) {
        throw err;
      }
      const backoff = Math.min(2000, 200 * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * backoff);
      console.warn(
        `⚠️ Azure Search ${label} attempt ${attempt} failed (status ${statusCode}); retrying in ${backoff + jitter}ms`
      );
      await new Promise((r) => setTimeout(r, backoff + jitter));
    }
  }
  throw lastErr;
}

/** Shape pushed into the `past-analyses` index (superset of PastAnalysisDoc). */
export interface PastAnalysisSearchDoc {
  id: string;
  sessionId: string;
  userId: string;
  turnId: string;
  dataVersion: number;
  question: string;
  normalizedQuestion: string;
  answer: string;
  feedback: string;
  outcome: string;
  createdAt: number;
  questionVector: number[];
}

function getClient(): SearchClient<PastAnalysisSearchDoc> {
  const cfg = requireAzureSearchCredentials();
  return new SearchClient<PastAnalysisSearchDoc>(
    cfg.endpoint,
    PAST_ANALYSES_INDEX_NAME,
    new AzureKeyCredential(cfg.adminKey)
  );
}

/** Build the search doc from a Cosmos doc + freshly-computed embedding. */
function toSearchDoc(
  doc: PastAnalysisDoc,
  questionVector: number[]
): PastAnalysisSearchDoc {
  return {
    id: doc.id,
    sessionId: doc.sessionId,
    userId: doc.userId,
    turnId: doc.turnId,
    dataVersion: doc.dataVersion,
    question: doc.question,
    normalizedQuestion: doc.normalizedQuestion,
    answer: doc.answer,
    feedback: doc.feedback,
    outcome: doc.outcome,
    createdAt: doc.createdAt,
    questionVector,
  };
}

/**
 * Embed the normalized question and push the doc to the past-analyses index.
 * Fire-and-forget from the chat-stream writer — the caller is expected to
 * swallow errors. Skipped entirely when `PAST_ANALYSES_INDEX_ENABLED=false`.
 */
export async function indexPastAnalysis(doc: PastAnalysisDoc): Promise<void> {
  if (process.env.PAST_ANALYSES_INDEX_ENABLED === "false") return;
  // Lazy-import so the cache-lookup code path doesn't pull in embeddings →
  // openai module load (which crashes in unit-test env without Azure creds).
  const { embedQuery } = await import("./embeddings.js");
  const vector = await embedQuery(doc.normalizedQuestion);
  const searchDoc = toSearchDoc(doc, vector);
  const client = getClient();
  await withSearchRetry("indexPastAnalysis", () =>
    client.mergeOrUploadDocuments([searchDoc])
  );
}

/**
 * W5.5 · Merge a feedback change onto an existing AI Search row without
 * recomputing the embedding. Cheaper than a full re-index because it skips the
 * embedding round-trip — feedback changes are frequent (any user thumbs-up /
 * down), embeddings are expensive.
 *
 * Uses Azure Search merge semantics: only the listed fields update; the rest of
 * the document (questionVector, answer, etc.) stays intact.
 */
export async function mergeFeedbackInPastAnalysisIndex(
  id: string,
  feedback: PastAnalysisDoc["feedback"]
): Promise<void> {
  if (process.env.PAST_ANALYSES_INDEX_ENABLED === "false") return;
  const client = getClient();
  await withSearchRetry("mergeFeedbackInPastAnalysisIndex", () =>
    client.mergeDocuments([{ id, feedback } as PastAnalysisSearchDoc])
  );
}

/**
 * Exact-match lookup on normalized question text (W5.2). Filters to the
 * current session + dataVersion + positive feedback. Returns the most recent
 * matching doc, or null.
 */
export async function findExactPastAnalysisMatch(params: {
  sessionId: string;
  dataVersion: number;
  normalizedQuestion: string;
  createdAfterEpochMs?: number;
}): Promise<PastAnalysisSearchDoc | null> {
  const client = getClient();
  const escapedNq = params.normalizedQuestion.replace(/'/g, "''");
  const escapedSid = params.sessionId.replace(/'/g, "''");
  const parts = [
    `sessionId eq '${escapedSid}'`,
    `dataVersion eq ${params.dataVersion}`,
    `normalizedQuestion eq '${escapedNq}'`,
    `outcome eq 'ok'`,
    `feedback ne 'down'`,
  ];
  if (params.createdAfterEpochMs != null) {
    parts.push(`createdAt gt ${params.createdAfterEpochMs}`);
  }
  const results = await withSearchRetry("findExactPastAnalysisMatch", () =>
    client.search("*", {
      filter: parts.join(" and "),
      orderBy: ["createdAt desc"],
      top: 1,
    })
  );
  for await (const r of results.results) {
    return r.document as PastAnalysisSearchDoc;
  }
  return null;
}

/**
 * Vector-similarity search (W5.3). Returns the top-K similar past analyses
 * scoped to the current session + dataVersion with positive feedback. Caller
 * applies a similarity threshold to decide whether to reuse the answer.
 */
export async function findSimilarPastAnalyses(params: {
  sessionId: string;
  dataVersion: number;
  queryVector: number[];
  topK?: number;
  /** Optional TTL — only rows strictly newer than this epoch-ms match. */
  createdAfterEpochMs?: number;
}): Promise<Array<{ doc: PastAnalysisSearchDoc; score: number }>> {
  const client = getClient();
  const escapedSid = params.sessionId.replace(/'/g, "''");
  const filterParts = [
    `sessionId eq '${escapedSid}'`,
    `dataVersion eq ${params.dataVersion}`,
    `outcome eq 'ok'`,
    `feedback ne 'down'`,
  ];
  if (params.createdAfterEpochMs != null) {
    filterParts.push(`createdAt gt ${params.createdAfterEpochMs}`);
  }
  const filter = filterParts.join(" and ");
  // SDK-version shim: the strict `VectorizedQuery<TModel>` constraint in the
  // current @azure/search-documents generics does not match the working
  // runtime shape. Using the runtime-correct literal via an `any` escape,
  // mirroring the existing aiSearchStore.ts (both files hit the same issue).
  const vectorQuery = {
    kind: "vector" as const,
    vector: params.queryVector,
    kNearestNeighborsCount: params.topK ?? 5,
    fields: ["questionVector"],
  };
  const results = await withSearchRetry("findSimilarPastAnalyses", () =>
    client.search("*", {
      filter,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vectorSearchOptions: { queries: [vectorQuery as any] },
      top: params.topK ?? 5,
    })
  );
  const out: Array<{ doc: PastAnalysisSearchDoc; score: number }> = [];
  for await (const r of results.results) {
    out.push({ doc: r.document as PastAnalysisSearchDoc, score: r.score ?? 0 });
  }
  return out;
}

/** Admin / cleanup: remove a past-analysis by id. Used by W5.6 sweep + W5.5 down-votes that purge. */
export async function deletePastAnalysisById(id: string): Promise<void> {
  const client = getClient();
  await withSearchRetry("deletePastAnalysis", () =>
    client.deleteDocuments("id", [id])
  );
}
