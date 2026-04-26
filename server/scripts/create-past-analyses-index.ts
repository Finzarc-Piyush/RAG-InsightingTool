/**
 * One-time / idempotent create-or-update of the `past-analyses` Azure AI Search
 * index. Loads server/server.env via loadEnv. Requires AZURE_SEARCH_* creds
 * (RAG_ENABLED not required — this is a separate index used for the semantic
 * question cache, independent of the per-session RAG path).
 *
 * Run:
 *   npx tsx server/scripts/create-past-analyses-index.ts
 */
import "../loadEnv.ts";
import { createOrUpdatePastAnalysesIndex } from "../lib/rag/createPastAnalysesIndex.ts";

createOrUpdatePastAnalysesIndex()
  .then(() => {
    console.log("Azure AI Search past-analyses index is ready.");
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
