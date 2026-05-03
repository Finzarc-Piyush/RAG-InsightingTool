import { SearchClient, AzureKeyCredential } from "@azure/search-documents";
import type { VectorizedQuery } from "@azure/search-documents";
import { getSearchConfig, getRagTopK } from "./config.js";
import type { RagHit } from "./ragHit.js";

export type { RagHit } from "./ragHit.js";

// P-023: Azure Search 429 / 5xx retry with exponential backoff + jitter.
// Reads are always safe to retry; writes (upsert / delete) are idempotent by id
// so retry is also safe. Max 3 attempts, capped delay.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

async function withSearchRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const statusCode = (err as { statusCode?: number; status?: number })?.statusCode
        ?? (err as { status?: number })?.status;
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

export interface RagSearchDocument {
  id: string;
  sessionId: string;
  chunkId: string;
  chunkType: string;
  dataVersion: number;
  rowStart?: number;
  rowEnd?: number;
  content: string;
  contentVector: number[];
}

function getClient(): { client: SearchClient<RagSearchDocument>; indexName: string } {
  const cfg = getSearchConfig();
  if (!cfg) {
    throw new Error("RAG search not configured");
  }
  const client = new SearchClient<RagSearchDocument>(
    cfg.endpoint,
    cfg.indexName,
    new AzureKeyCredential(cfg.adminKey)
  );
  return { client, indexName: cfg.indexName };
}

export async function upsertRagDocuments(docs: RagSearchDocument[]): Promise<void> {
  if (docs.length === 0) {
    return;
  }
  const { client } = getClient();
  await withSearchRetry("upsertRagDocuments", () => client.mergeOrUploadDocuments(docs));
}

/**
 * List all document ids for a session (paginated) then delete in batches.
 */
/**
 * W64 · Build the OData filter used by `deleteRagDocumentsBySessionId`.
 * Exported for unit tests so the `memory_entry` exclusion default is locked
 * in (regressing it would silently delete memory entries on every data-RAG
 * reindex).
 */
export function buildSessionDeleteFilter(
  sessionId: string,
  excludeChunkTypes: string[] = ["memory_entry"]
): string {
  const excludes = excludeChunkTypes
    .map((t) => ` and chunkType ne '${t.replace(/'/g, "''")}'`)
    .join("");
  return `sessionId eq '${sessionId.replace(/'/g, "''")}'${excludes}`;
}

export async function deleteRagDocumentsBySessionId(
  sessionId: string,
  // W64 · Memory entries (chunkType="memory_entry") live in the same per-session
  // index but represent durable, append-only events. They must survive a data-RAG
  // reindex (which fires on every saveModifiedData via scheduleIndexSessionRag).
  // Default excludes them; pass `[]` to wipe the entire session including memory.
  excludeChunkTypes: string[] = ["memory_entry"]
): Promise<void> {
  const { client } = getClient();
  const ids: string[] = [];
  const filter = buildSessionDeleteFilter(sessionId, excludeChunkTypes);
  const pageSize = 1000;
  let skip = 0;
  for (;;) {
    const page = await client.search("*", {
      filter,
      select: ["id"] as const,
      top: pageSize,
      skip,
    });
    let n = 0;
    for await (const r of page.results) {
      n++;
      const id = (r.document as { id?: string }).id;
      if (id) {
        ids.push(id);
      }
    }
    if (n < pageSize) {
      break;
    }
    skip += pageSize;
  }
  const batch = 500;
  const failures: Array<{ id: string; error: string }> = [];
  for (let i = 0; i < ids.length; i += batch) {
    const slice = ids.slice(i, i + batch).map((id) => ({ id }));
    const result = await client.deleteDocuments(slice);
    // Azure SDK returns per-document results; collect any that did not succeed
    // so the caller can see orphan chunks rather than assuming success (P-022).
    for (const r of result.results ?? []) {
      if (!r.succeeded) {
        failures.push({ id: r.key, error: r.errorMessage ?? "unknown error" });
      }
    }
  }
  if (failures.length > 0) {
    const sample = failures
      .slice(0, 3)
      .map((f) => `${f.id}: ${f.error}`)
      .join("; ");
    throw new Error(
      `RAG delete left ${failures.length} orphan chunk(s) for session ${sessionId}. Sample: ${sample}`
    );
  }
}

/**
 * W57 · Build the optional chunkType include/exclude clause. Memory entries
 * use `chunkType = "memory_entry"`; data RAG callers pass
 * `excludeChunkTypes: ["memory_entry"]` to keep their retrieval clean, while
 * the memory recall block (W60) passes `includeChunkTypes: ["memory_entry"]`.
 */
function buildChunkTypeClause(opts: {
  includeChunkTypes?: string[];
  excludeChunkTypes?: string[];
}): string {
  const parts: string[] = [];
  if (opts.includeChunkTypes && opts.includeChunkTypes.length > 0) {
    const list = opts.includeChunkTypes
      .map((t) => `chunkType eq '${t.replace(/'/g, "''")}'`)
      .join(" or ");
    parts.push(`(${list})`);
  }
  if (opts.excludeChunkTypes && opts.excludeChunkTypes.length > 0) {
    for (const t of opts.excludeChunkTypes) {
      parts.push(`chunkType ne '${t.replace(/'/g, "''")}'`);
    }
  }
  return parts.length === 0 ? "" : ` and ${parts.join(" and ")}`;
}

export async function vectorSearchSession(params: {
  sessionId: string;
  queryVector: number[];
  topK?: number;
  dataVersion?: number;
  /** W66 · Lower bound on dataVersion (inclusive) — hits older than this are excluded. */
  minDataVersion?: number;
  includeChunkTypes?: string[];
  excludeChunkTypes?: string[];
}): Promise<RagHit[]> {
  const { client } = getClient();
  const topK = params.topK ?? getRagTopK();
  let filter = `sessionId eq '${params.sessionId.replace(/'/g, "''")}'`;
  if (params.dataVersion != null) {
    filter += ` and dataVersion eq ${params.dataVersion}`;
  } else if (params.minDataVersion != null) {
    filter += ` and dataVersion ge ${params.minDataVersion}`;
  }
  filter += buildChunkTypeClause(params);

  const vectorQuery: VectorizedQuery<RagSearchDocument> = {
    kind: "vector",
    vector: params.queryVector,
    kNearestNeighborsCount: topK,
    fields: ["contentVector"] as any,
  };

  const results = await withSearchRetry("vectorSearchSession", () =>
    client.search<RagSearchDocument>("*", {
      filter,
      vectorSearchOptions: {
        queries: [vectorQuery],
      },
      select: ["chunkId", "chunkType", "content"] as any,
      top: topK,
    })
  );

  const hits: RagHit[] = [];
  for await (const r of results.results) {
    hits.push({
      chunkId: r.document.chunkId,
      chunkType: r.document.chunkType,
      content: r.document.content,
      score: r.score,
    });
  }
  return hits;
}

/**
 * P-A2: Keyword (BM25) search companion to vectorSearchSession. Used as a
 * fallback when vector recall is low (e.g. user wording diverges from
 * indexed phrasing) so synonyms / verbatim column names still surface.
 */
export async function keywordSearchSession(params: {
  sessionId: string;
  query: string;
  topK?: number;
  dataVersion?: number;
  includeChunkTypes?: string[];
  excludeChunkTypes?: string[];
}): Promise<RagHit[]> {
  const queryText = (params.query || "").trim();
  if (!queryText) return [];
  const { client } = getClient();
  const topK = params.topK ?? getRagTopK();
  let filter = `sessionId eq '${params.sessionId.replace(/'/g, "''")}'`;
  if (params.dataVersion != null) {
    filter += ` and dataVersion eq ${params.dataVersion}`;
  }
  filter += buildChunkTypeClause(params);
  const results = await withSearchRetry("keywordSearchSession", () =>
    client.search<RagSearchDocument>(queryText, {
      filter,
      searchFields: ["content"] as any,
      select: ["chunkId", "chunkType", "content"] as any,
      top: topK,
    })
  );
  const hits: RagHit[] = [];
  for await (const r of results.results) {
    hits.push({
      chunkId: r.document.chunkId,
      chunkType: r.document.chunkType,
      content: r.document.content,
      score: r.score,
    });
  }
  return hits;
}
