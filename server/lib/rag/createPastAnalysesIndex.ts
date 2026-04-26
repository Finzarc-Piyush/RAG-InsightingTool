/**
 * Azure AI Search index for past-analysis semantic retrieval (W2.4).
 *
 * Separate from `rag-session-chunks` because the contents + filtering patterns
 * differ:
 *   - Sorted/filtered by userId + sessionId + dataVersion + feedback
 *   - One document per completed turn (not per chunk)
 *   - Populated by the chat-stream writer (W2.3) via push + embedding
 *   - Consumed by the W5 semantic cache to check "have we answered this before?"
 *
 * Run once (or after a schema change):
 *   npx tsx server/scripts/create-past-analyses-index.ts
 */

import { SearchIndexClient, AzureKeyCredential } from "@azure/search-documents";
import type { SearchIndex, SearchField } from "@azure/search-documents";
import {
  getEmbeddingDimensions,
  requireAzureSearchCredentials,
} from "./config.js";

export const PAST_ANALYSES_INDEX_NAME =
  process.env.AZURE_SEARCH_PAST_ANALYSES_INDEX_NAME || "past-analyses";

function buildPastAnalysesIndexDefinition(
  indexName: string,
  dimensions: number
): SearchIndex {
  const fields: SearchField[] = [
    { name: "id", type: "Edm.String", key: true, filterable: true },
    { name: "sessionId", type: "Edm.String", filterable: true, facetable: true },
    { name: "userId", type: "Edm.String", filterable: true, facetable: true },
    { name: "turnId", type: "Edm.String", filterable: true },
    { name: "dataVersion", type: "Edm.Int32", filterable: true },
    {
      name: "question",
      type: "Edm.String",
      searchable: true,
      filterable: false,
    },
    // Used by the W5.2 exact-match shortcut before vector search fires.
    {
      name: "normalizedQuestion",
      type: "Edm.String",
      searchable: false,
      filterable: true,
    },
    {
      name: "answer",
      type: "Edm.String",
      searchable: true,
      filterable: false,
    },
    // `up` / `down` / `none`. Filter out `down` so bad answers can't serve
    // from cache (W5.5 feedback loop).
    { name: "feedback", type: "Edm.String", filterable: true, facetable: true },
    {
      name: "outcome",
      type: "Edm.String",
      filterable: true,
      facetable: true,
    },
    {
      name: "createdAt",
      type: "Edm.Int64",
      filterable: true,
      sortable: true,
    },
    {
      name: "questionVector",
      type: "Collection(Edm.Single)",
      searchable: true,
      filterable: false,
      hidden: false,
      stored: true,
      vectorSearchDimensions: dimensions,
      vectorSearchProfileName: "pa-vector-profile",
    },
  ];

  return {
    name: indexName,
    fields,
    vectorSearch: {
      algorithms: [
        {
          name: "pa-hnsw",
          kind: "hnsw",
          parameters: {
            m: 4,
            efConstruction: 400,
            efSearch: 500,
            metric: "cosine",
          },
        },
      ],
      profiles: [
        {
          name: "pa-vector-profile",
          algorithmConfigurationName: "pa-hnsw",
        },
      ],
    },
  };
}

export async function createOrUpdatePastAnalysesIndex(): Promise<void> {
  const cfg = requireAzureSearchCredentials();
  const dim = getEmbeddingDimensions();
  const client = new SearchIndexClient(
    cfg.endpoint,
    new AzureKeyCredential(cfg.adminKey)
  );
  const def = buildPastAnalysesIndexDefinition(PAST_ANALYSES_INDEX_NAME, dim);
  await client.createOrUpdateIndex(def);
  console.log(
    `✅ Azure AI Search index ready: ${PAST_ANALYSES_INDEX_NAME} (vector dim ${dim})`
  );
}
