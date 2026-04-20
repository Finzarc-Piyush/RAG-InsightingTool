import { SearchClient, AzureKeyCredential } from "@azure/search-documents";
import type { VectorizedQuery } from "@azure/search-documents";
import { getSearchConfig, getRagTopK } from "./config.js";
import type { RagHit } from "./ragHit.js";

export type { RagHit } from "./ragHit.js";

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
  await client.mergeOrUploadDocuments(docs);
}

/**
 * List all document ids for a session (paginated) then delete in batches.
 */
export async function deleteRagDocumentsBySessionId(sessionId: string): Promise<void> {
  const { client } = getClient();
  const ids: string[] = [];
  const filter = `sessionId eq '${sessionId.replace(/'/g, "''")}'`;
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

export async function vectorSearchSession(params: {
  sessionId: string;
  queryVector: number[];
  topK?: number;
  dataVersion?: number;
}): Promise<RagHit[]> {
  const { client } = getClient();
  const topK = params.topK ?? getRagTopK();
  let filter = `sessionId eq '${params.sessionId.replace(/'/g, "''")}'`;
  if (params.dataVersion != null) {
    filter += ` and dataVersion eq ${params.dataVersion}`;
  }

  const vectorQuery: VectorizedQuery<RagSearchDocument> = {
    kind: "vector",
    vector: params.queryVector,
    kNearestNeighborsCount: topK,
    fields: ["contentVector"] as any,
  };

  const results = await client.search<RagSearchDocument>("*", {
    filter,
    vectorSearchOptions: {
      queries: [vectorQuery],
    },
    select: ["chunkId", "chunkType", "content"] as any,
    top: topK,
  });

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
