/**
 * One-time (or idempotent) create/update of the Azure AI Search index used for RAG.
 * Loads server/server.env via loadEnv. Requires AZURE_SEARCH_* (RAG_ENABLED not required).
 */
import "../loadEnv.ts";
import { createOrUpdateRagSearchIndex } from "../lib/rag/createSearchIndex.ts";

createOrUpdateRagSearchIndex()
  .then(() => {
    console.log("Azure AI Search RAG index is ready.");
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
