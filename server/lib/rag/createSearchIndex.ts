/**
 * One-time / admin: create or update Azure AI Search index for RAG.
 * Run: npx tsx server/scripts/create-rag-search-index.ts (or import from REPL).
 */
import { SearchIndexClient, AzureKeyCredential } from "@azure/search-documents";
import type { SearchIndex, SearchField } from "@azure/search-documents";
import { getEmbeddingDimensions, requireAzureSearchCredentials } from "./config.js";

function buildIndexDefinition(indexName: string, dimensions: number): SearchIndex {
  const fields: SearchField[] = [
    { name: "id", type: "Edm.String", key: true, filterable: true },
    { name: "sessionId", type: "Edm.String", filterable: true, sortable: false },
    { name: "chunkId", type: "Edm.String", filterable: true },
    { name: "chunkType", type: "Edm.String", filterable: true },
    { name: "dataVersion", type: "Edm.Int32", filterable: true },
    { name: "rowStart", type: "Edm.Int32", filterable: true },
    { name: "rowEnd", type: "Edm.Int32", filterable: true },
    {
      name: "content",
      type: "Edm.String",
      searchable: true,
      filterable: false,
    },
    {
      name: "contentVector",
      type: "Collection(Edm.Single)",
      // Required by the service: vector fields must be searchable for vector queries.
      searchable: true,
      filterable: false,
      hidden: false, // retrievable in REST; SimpleField uses inverted `hidden`
      stored: true,
      vectorSearchDimensions: dimensions,
      vectorSearchProfileName: "rag-vector-profile",
    },
  ];

  return {
    name: indexName,
    fields,
    vectorSearch: {
      algorithms: [
        {
          name: "rag-hnsw",
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
          name: "rag-vector-profile",
          algorithmConfigurationName: "rag-hnsw",
        },
      ],
    },
  };
}

export async function createOrUpdateRagSearchIndex(): Promise<void> {
  const cfg = requireAzureSearchCredentials();
  const dim = getEmbeddingDimensions();
  const client = new SearchIndexClient(cfg.endpoint, new AzureKeyCredential(cfg.adminKey));
  const def = buildIndexDefinition(cfg.indexName, dim);
  await client.createOrUpdateIndex(def);
  console.log(`✅ Azure AI Search index ready: ${cfg.indexName} (vector dim ${dim})`);
}
