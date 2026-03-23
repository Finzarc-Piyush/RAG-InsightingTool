/**
 * RAG feature flags and Azure AI Search configuration (from env).
 *
 * Required for runtime retrieval + indexing when RAG_ENABLED=true:
 *   AZURE_SEARCH_ENDPOINT   — e.g. https://myservice.search.windows.net
 *   AZURE_SEARCH_ADMIN_KEY  — admin key (index + query)
 *   AZURE_SEARCH_INDEX_NAME — must match index created via npm run create-rag-index
 *
 * Optional:
 *   RAG_ENABLED             — "true" | "false" (default off unless true + credentials)
 *   AZURE_OPENAI_EMBEDDING_DIMENSIONS — must match embedding model + Search index vector size
 *   RAG_TOP_K               — vector hits per query (1–25, default 8)
 *
 * Embeddings use AZURE_OPENAI_EMBEDDING_* / shared OpenAI client (see lib/openai.ts).
 */

export function hasAzureSearchCredentials(): boolean {
  return (
    Boolean(process.env.AZURE_SEARCH_ENDPOINT?.trim()) &&
    Boolean(process.env.AZURE_SEARCH_ADMIN_KEY?.trim()) &&
    Boolean(process.env.AZURE_SEARCH_INDEX_NAME?.trim())
  );
}

/** Runtime retrieval + indexing when true. */
export function isRagEnabled(): boolean {
  if (process.env.RAG_ENABLED === "false") {
    return false;
  }
  return process.env.RAG_ENABLED === "true" && hasAzureSearchCredentials();
}

/** For admin script: create index without RAG_ENABLED. */
export function requireAzureSearchCredentials(): {
  endpoint: string;
  adminKey: string;
  indexName: string;
} {
  if (!hasAzureSearchCredentials()) {
    throw new Error(
      "Set AZURE_SEARCH_ENDPOINT, AZURE_SEARCH_ADMIN_KEY, AZURE_SEARCH_INDEX_NAME"
    );
  }
  return {
    endpoint: process.env.AZURE_SEARCH_ENDPOINT!.replace(/\/$/, ""),
    adminKey: process.env.AZURE_SEARCH_ADMIN_KEY!,
    indexName: process.env.AZURE_SEARCH_INDEX_NAME!,
  };
}

export function getEmbeddingDimensions(): number {
  const n = parseInt(process.env.AZURE_OPENAI_EMBEDDING_DIMENSIONS || "1536", 10);
  return Number.isFinite(n) && n > 0 ? n : 1536;
}

export function getRagTopK(): number {
  const n = parseInt(process.env.RAG_TOP_K || "8", 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 25) : 8;
}

export function getSearchConfig(): {
  endpoint: string;
  adminKey: string;
  indexName: string;
} | null {
  if (!isRagEnabled()) {
    return null;
  }
  return requireAzureSearchCredentials();
}
