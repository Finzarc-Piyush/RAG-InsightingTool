/**
 * Cosmos model for the `llm_usage` telemetry container.
 *
 * One document per chat-completion API call (including retries). Populated by
 * the `llmUsageSink` which subscribes to the global usage emitter. Used for
 * cost dashboards, budget enforcement (W6), and semantic-cache invalidation
 * signals (W5).
 */

import { Container } from "@azure/cosmos";
import { getDatabase, initializeCosmosDB } from "./database.config.js";

export const COSMOS_LLM_USAGE_CONTAINER_ID =
  process.env.COSMOS_LLM_USAGE_CONTAINER_ID || "llm_usage";

export interface LlmUsageDoc {
  /** Unique id. Pattern: `${turnId}__${timestamp}__${nonce}` or `${nonce}` when turnId is absent. */
  id: string;
  /** Partition key. Empty-ish callers get `__no_turn__` so partition is always string-valued. */
  turnId: string;
  /** Filled from the AsyncLocalStorage request context when available. */
  sessionId?: string;
  userId?: string;
  /** Deployment name passed to Azure OpenAI (`gpt-4o`, `gpt-4o-mini`, …). */
  model: string;
  /** Optional free-form label — W3.1 will populate with an `LlmCallPurpose`. */
  purpose?: string;
  /** 1-indexed attempt number for `completeJson` retries. */
  attempt: number;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
  costUsd: number;
  latencyMs: number;
  /** ms-epoch at the point the client received the response. */
  timestamp: number;
}

let llmUsageContainerInstance: Container | null = null;

/**
 * Lazily resolve the container. Called on the background flush path; safe to
 * invoke many times — only the first call creates the container.
 */
export async function waitForLlmUsageContainer(
  maxRetries = 20,
  retryDelayMs = 500
): Promise<Container> {
  if (llmUsageContainerInstance) return llmUsageContainerInstance;

  // Piggy-back on the global cosmos init. It is idempotent and tolerates
  // concurrent callers (returns the same in-flight promise).
  try {
    await initializeCosmosDB();
  } catch {
    /* fall through to retry loop */
  }

  for (let i = 0; i < maxRetries; i++) {
    const db = getDatabase();
    if (db) {
      try {
        const { container } = await db.containers.createIfNotExists({
          id: COSMOS_LLM_USAGE_CONTAINER_ID,
          partitionKey: "/turnId",
        });
        llmUsageContainerInstance = container;
        return container;
      } catch {
        // Serverless accounts or throughput-limit cases: try to read the
        // existing container. Matches createContainerSafely in database.config.
        const ref = db.container(COSMOS_LLM_USAGE_CONTAINER_ID);
        try {
          await ref.read();
          llmUsageContainerInstance = ref;
          return ref;
        } catch {
          /* not yet ready, continue polling */
        }
      }
    }
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }

  throw new Error(
    `CosmosDB container '${COSMOS_LLM_USAGE_CONTAINER_ID}' not initialized after ${maxRetries} attempts`
  );
}

/**
 * Write a batch of usage docs. Fires `items.create` in parallel — at 100 docs
 * per flush this is fine for the Cosmos SDK's connection pool. Returns per-doc
 * success/failure so the sink can log drops without crashing.
 */
export async function writeLlmUsageBatch(
  container: Container,
  docs: LlmUsageDoc[]
): Promise<{ succeeded: number; failed: number }> {
  if (docs.length === 0) return { succeeded: 0, failed: 0 };
  const results = await Promise.allSettled(
    docs.map((doc) => container.items.create(doc))
  );
  let succeeded = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === "fulfilled") succeeded++;
    else failed++;
  }
  return { succeeded, failed };
}
