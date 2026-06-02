/**
 * ============================================================================
 * assertAgenticRag.ts — startup guards that fail fast on bad config
 * ============================================================================
 * WHAT THIS FILE DOES
 *   Two boot-time checks. The first refuses to start if the agentic loop is on
 *   but RAG is not configured (RAG = Retrieval-Augmented Generation: the search
 *   index of dataset chunks the agent reads from). The second refuses to start
 *   if dashboard autogeneration is on while the agent loop is off — that would
 *   be dead config because dashboards are only built inside the loop.
 *
 * WHY IT MATTERS
 *   "Fail fast": crashing at startup with a clear FATAL message beats running
 *   in a silently broken state where the agent has no data to retrieve, or a
 *   feature that can never fire. Honors invariant #1 (the loop needs RAG).
 *
 * KEY PIECES
 *   - assertAgenticRagConfiguration() — exits(1) if loop is on but RAG is off.
 *   - assertDashboardAutogenConfiguration() — exits(1) if autogen is on but
 *     the loop is off.
 *   - Both honor escape hatches: AGENTIC_ALLOW_NO_RAG (tests) and the feature
 *     flags themselves.
 *
 * HOW IT CONNECTS
 *   Reads flags via types.js (isAgenticLoopEnabled) and rag/config.js
 *   (isRagEnabled). Called once at app startup (e.g. from createApp).
 */
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

/**
 * When dashboard autogen is on, the agentic loop must be on.
 * buildDashboard only fires inside runAgentTurn, so enabling autogen
 * without AGENTIC_LOOP_ENABLED=true would be silently dead configuration.
 */
export function assertDashboardAutogenConfiguration(): void {
  if (process.env.DASHBOARD_AUTOGEN_ENABLED !== "true") {
    return;
  }
  if (!isAgenticLoopEnabled()) {
    console.error(
      "FATAL: DASHBOARD_AUTOGEN_ENABLED=true requires AGENTIC_LOOP_ENABLED=true (the dashboard draft is emitted from the agent loop). Either turn the agent loop on or unset DASHBOARD_AUTOGEN_ENABLED."
    );
    process.exit(1);
  }
}
