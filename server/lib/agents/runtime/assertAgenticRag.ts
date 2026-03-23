import { isAgenticLoopEnabled } from "./types.js";
import { isRagEnabled } from "../../rag/config.js";

/**
 * When the agentic loop is enabled, RAG (Azure AI Search + embeddings) must be viable.
 * Call once at app startup (e.g. from createApp).
 *
 * Set AGENTIC_ALLOW_NO_RAG=true only in unit tests or local experiments that mock retrieval.
 */
export function assertAgenticRagConfiguration(): void {
  if (process.env.AGENTIC_ALLOW_NO_RAG === "true") {
    return;
  }
  if (!isAgenticLoopEnabled()) {
    return;
  }
  if (!isRagEnabled()) {
    console.error(
      "FATAL: AGENTIC_LOOP_ENABLED=true requires RAG. Set RAG_ENABLED=true and AZURE_SEARCH_ENDPOINT, AZURE_SEARCH_ADMIN_KEY, AZURE_SEARCH_INDEX_NAME (and matching AZURE_OPENAI_EMBEDDING_DIMENSIONS). For tests only, set AGENTIC_ALLOW_NO_RAG=true."
    );
    process.exit(1);
  }
}
