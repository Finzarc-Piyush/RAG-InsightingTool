/**
 * Cosmos model for the `user_budget` container — daily per-user quota +
 * accumulated cost. One row per (userEmail, dateKey).
 *
 * Two write paths:
 *   1. Pre-turn: middleware atomically increments `questionsUsed`. The patch
 *      operation is the gate — if the increment makes the count exceed the
 *      configured daily quota, the request is rejected with 429.
 *   2. Post-turn: chat-stream calls `recordTurnSpend()` to accumulate cost +
 *      tokens. Best-effort; a Cosmos failure here just means the dashboard is
 *      slightly off — never affects the user's response.
 *
 * Lazy container init mirrors `llmUsage.model.ts` so a Cosmos hiccup at
 * startup can't block the chat pipeline.
 */

import { Container, PatchOperationType } from "@azure/cosmos";
import { getDatabase, initializeCosmosDB } from "./database.config.js";

export const COSMOS_USER_BUDGET_CONTAINER_ID =
  process.env.COSMOS_USER_BUDGET_CONTAINER_ID || "user_budget";

export interface UserBudgetDoc {
  /** `${userEmail}__${dateKey}` — deterministic, idempotent. */
  id: string;
  /** Lowercased email. Partition key. */
  userEmail: string;
  /** UTC `YYYYMMDD`. */
  dateKey: string;
  questionsUsed: number;
  costUsdAccumulated: number;
  tokensInputAccumulated: number;
  tokensOutputAccumulated: number;
  /** ms epoch of the most recent increment. */
  lastTurnAt: number;
}

let userBudgetContainerInstance: Container | null = null;

export async function waitForUserBudgetContainer(
  maxRetries = 20,
  retryDelayMs = 500
): Promise<Container> {
  if (userBudgetContainerInstance) return userBudgetContainerInstance;
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
          id: COSMOS_USER_BUDGET_CONTAINER_ID,
          partitionKey: "/userEmail",
        });
        userBudgetContainerInstance = container;
        return container;
      } catch {
        const ref = db.container(COSMOS_USER_BUDGET_CONTAINER_ID);
        try {
          await ref.read();
          userBudgetContainerInstance = ref;
          return ref;
        } catch {
          /* not yet ready, continue polling */
        }
      }
    }
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  throw new Error(
    `CosmosDB container '${COSMOS_USER_BUDGET_CONTAINER_ID}' not initialized after ${maxRetries} attempts`
  );
}

/**
 * UTC YYYYMMDD for an epoch. Bucket boundary is midnight UTC — a simple,
 * timezone-stable choice. Localising would create cross-DB inconsistencies
 * for users in different zones.
 */
export function dateKeyFromEpoch(epochMs: number = Date.now()): string {
  const d = new Date(epochMs);
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

/** Compose the deterministic doc id. */
export function userBudgetDocId(userEmail: string, dateKey: string): string {
  return `${userEmail.toLowerCase()}__${dateKey}`;
}

function freshDoc(userEmail: string, dateKey: string): UserBudgetDoc {
  return {
    id: userBudgetDocId(userEmail, dateKey),
    userEmail: userEmail.toLowerCase(),
    dateKey,
    questionsUsed: 0,
    costUsdAccumulated: 0,
    tokensInputAccumulated: 0,
    tokensOutputAccumulated: 0,
    lastTurnAt: 0,
  };
}

/**
 * Atomically increment `questionsUsed` and return the *new* row. Used by the
 * pre-turn quota gate (W6.2). When the row doesn't exist yet, create it with
 * `questionsUsed = 1` (single-shot upsert race-tolerant).
 */
export async function incrementQuestionsUsed(
  userEmail: string,
  nowMs: number = Date.now()
): Promise<UserBudgetDoc> {
  const dateKey = dateKeyFromEpoch(nowMs);
  const id = userBudgetDocId(userEmail, dateKey);
  const container = await waitForUserBudgetContainer();
  const partitionKey = userEmail.toLowerCase();

  // Try the atomic patch first (cheap, single round-trip when the row exists).
  try {
    const { resource } = await container.item(id, partitionKey).patch<UserBudgetDoc>({
      operations: [
        { op: PatchOperationType.incr, path: "/questionsUsed", value: 1 },
        { op: PatchOperationType.set, path: "/lastTurnAt", value: nowMs },
      ],
    });
    if (resource) return resource;
  } catch (err) {
    const code = (err as { code?: number; statusCode?: number })?.code
      ?? (err as { statusCode?: number })?.statusCode;
    if (code !== 404) throw err;
    // 404 → row doesn't exist yet, fall through to upsert.
  }

  // Upsert seed with questionsUsed = 1. If a concurrent request already
  // created the row, Cosmos's upsert wins last-write — for our scale the slop
  // (a single extra question on first call of the day under contention) is
  // acceptable.
  const seed: UserBudgetDoc = { ...freshDoc(userEmail, dateKey), questionsUsed: 1, lastTurnAt: nowMs };
  const { resource } = await container.items.upsert<UserBudgetDoc>(seed);
  if (!resource) {
    throw new Error("user_budget upsert returned no resource");
  }
  return resource;
}

/**
 * Add per-turn cost + tokens to today's budget row. Called from the chat
 * stream after the agent turn finishes. Best-effort — swallows errors so a
 * Cosmos hiccup never affects the user's response.
 */
export async function recordTurnSpend(args: {
  userEmail: string;
  costUsd: number;
  tokensInput: number;
  tokensOutput: number;
  nowMs?: number;
}): Promise<void> {
  const nowMs = args.nowMs ?? Date.now();
  const dateKey = dateKeyFromEpoch(nowMs);
  const id = userBudgetDocId(args.userEmail, dateKey);
  const partitionKey = args.userEmail.toLowerCase();
  try {
    const container = await waitForUserBudgetContainer();
    await container.item(id, partitionKey).patch({
      operations: [
        { op: PatchOperationType.incr, path: "/costUsdAccumulated", value: args.costUsd },
        { op: PatchOperationType.incr, path: "/tokensInputAccumulated", value: args.tokensInput },
        { op: PatchOperationType.incr, path: "/tokensOutputAccumulated", value: args.tokensOutput },
        { op: PatchOperationType.set, path: "/lastTurnAt", value: nowMs },
      ],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️ recordTurnSpend failed (best-effort): ${msg}`);
  }
}

/** Read today's budget row for a user. Returns null when no row exists. */
export async function readUserBudgetForToday(
  userEmail: string,
  nowMs: number = Date.now()
): Promise<UserBudgetDoc | null> {
  const dateKey = dateKeyFromEpoch(nowMs);
  const id = userBudgetDocId(userEmail, dateKey);
  const partitionKey = userEmail.toLowerCase();
  const container = await waitForUserBudgetContainer();
  try {
    const { resource } = await container.item(id, partitionKey).read<UserBudgetDoc>();
    return resource ?? null;
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 404) return null;
    throw err;
  }
}
