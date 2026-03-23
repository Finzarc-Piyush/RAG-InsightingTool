/**
 * RAG smoke checks: config, optional embedding call, optional retrieval for a session.
 * Usage: from server/, `npm run rag-smoke`
 * Optional: RAG_SMOKE_SESSION_ID=<sessionId> to run vector retrieval against indexed data.
 */
import "../loadEnv.js";
import { isRagEnabled, hasAzureSearchCredentials } from "../lib/rag/config.js";

async function main() {
  console.log("RAG smoke");
  console.log("- hasAzureSearchCredentials:", hasAzureSearchCredentials());
  console.log("- isRagEnabled (RAG_ENABLED=true + credentials):", isRagEnabled());

  if (!hasAzureSearchCredentials()) {
    console.log("\nSet AZURE_SEARCH_ENDPOINT, AZURE_SEARCH_ADMIN_KEY, AZURE_SEARCH_INDEX_NAME in server/server.env");
    process.exit(0);
  }

  if (!isRagEnabled()) {
    console.log("\nSet RAG_ENABLED=true to enable runtime retrieval and indexing.");
    process.exit(0);
  }

  const { embedQuery } = await import("../lib/rag/embeddings.js");
  const v = await embedQuery("smoke test query");
  console.log("- embedQuery dim:", v.length);

  const sessionId = process.env.RAG_SMOKE_SESSION_ID?.trim();
  if (!sessionId) {
    console.log(
      "\nOptional: set RAG_SMOKE_SESSION_ID to a session with ragIndex=ready to test vector search."
    );
    console.log("Manual: upload a file or save in Data Ops, then check Cosmos ragIndex and ask a question in the app.");
    process.exit(0);
  }

  const { getChatBySessionIdEfficient } = await import("../models/chat.model.js");
  const doc = await getChatBySessionIdEfficient(sessionId);
  console.log("- session ragIndex:", doc?.ragIndex ?? "(no doc)");

  const { retrieveRagHits } = await import("../lib/rag/retrieve.js");
  if (!doc?.dataSummary) {
    console.error("No dataSummary on document; cannot run retrieveRagHits.");
    process.exit(1);
  }
  const { hits, suggestedColumns } = await retrieveRagHits({
    sessionId,
    question: process.env.RAG_SMOKE_QUERY?.trim() || "summary sample",
    summary: doc.dataSummary,
    dataVersion: doc.currentDataBlob?.version,
  });
  console.log("- hits:", hits.length, "suggestedColumns:", suggestedColumns);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
