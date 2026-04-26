/**
 * W6.3 · Cost-per-turn anomaly detector.
 *
 * Subscribes to the LLM-usage emitter and aggregates per-turn cost in a small
 * in-memory map. When a turn finishes (signalled by `recordAndCheckTurn()`),
 * the accumulated cost is compared to two thresholds:
 *
 *   - `COST_ALERT_PER_TURN_USD` (default $2.00)        — single-turn ceiling
 *   - `COST_ALERT_DAILY_X_MEDIAN` (default 5)          — multiple of user's
 *                                                       rolling 30-day median
 *                                                       (computed from the
 *                                                       user_budget container)
 *
 * On a hit, the detector writes a row to the `cost_alerts` Cosmos container
 * and emits a Sentry-shaped console.error so a downstream sink (Sentry MCP,
 * Slack, etc.) can pick it up. Hard ceiling never blocks the user — it's a
 * signal, not a brake. The brake is `BUDGET_GATE_ENFORCEMENT=enforce`.
 *
 * Daily-median check is currently a stub (TODO once we have ≥30 days of
 * `user_budget` history). Per-turn check is wired live.
 */

import { Container, PatchOperationType } from "@azure/cosmos";
import { getDatabase, initializeCosmosDB } from "../../models/database.config.js";
import {
  registerLlmUsageListener,
  type LlmCallUsage,
} from "../agents/runtime/llmUsageEmitter.js";

export const COSMOS_COST_ALERTS_CONTAINER_ID =
  process.env.COSMOS_COST_ALERTS_CONTAINER_ID || "cost_alerts";

const DEFAULT_PER_TURN_USD = 2.0;

/** $/turn ceiling. Tuned per-deployment via env. */
function perTurnThresholdUsd(): number {
  const raw = process.env.COST_ALERT_PER_TURN_USD;
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PER_TURN_USD;
  return n;
}

export interface CostAlertDoc {
  /** `${userEmail}__${turnId}` — deterministic, replays overwrite. */
  id: string;
  userEmail: string;
  turnId: string;
  sessionId?: string;
  reason: "per_turn_ceiling" | "daily_x_median";
  costUsd: number;
  thresholdUsd: number;
  callCount: number;
  tokensInput: number;
  tokensOutput: number;
  createdAt: number;
}

let alertsContainerInstance: Container | null = null;

async function waitForCostAlertsContainer(
  maxRetries = 20,
  retryDelayMs = 500
): Promise<Container> {
  if (alertsContainerInstance) return alertsContainerInstance;
  try {
    await initializeCosmosDB();
  } catch {
    /* fall through */
  }
  for (let i = 0; i < maxRetries; i++) {
    const db = getDatabase();
    if (db) {
      try {
        const { container } = await db.containers.createIfNotExists({
          id: COSMOS_COST_ALERTS_CONTAINER_ID,
          partitionKey: "/userEmail",
        });
        alertsContainerInstance = container;
        return container;
      } catch {
        const ref = db.container(COSMOS_COST_ALERTS_CONTAINER_ID);
        try {
          await ref.read();
          alertsContainerInstance = ref;
          return ref;
        } catch {
          /* keep polling */
        }
      }
    }
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  throw new Error(
    `CosmosDB container '${COSMOS_COST_ALERTS_CONTAINER_ID}' not initialized after ${maxRetries} attempts`
  );
}

interface TurnAccumulator {
  costUsd: number;
  callCount: number;
  tokensInput: number;
  tokensOutput: number;
  firstSeen: number;
}

const byTurnId = new Map<string, TurnAccumulator>();
let unsubscribe: (() => void) | null = null;

function ensureSubscribed(): void {
  if (unsubscribe) return;
  unsubscribe = registerLlmUsageListener(onUsage);
}

function onUsage(u: LlmCallUsage): void {
  const tid = u.turnId;
  if (!tid) return;
  let entry = byTurnId.get(tid);
  if (!entry) {
    entry = {
      costUsd: 0,
      callCount: 0,
      tokensInput: 0,
      tokensOutput: 0,
      firstSeen: Date.now(),
    };
    byTurnId.set(tid, entry);
  }
  entry.costUsd += u.costUsd;
  entry.callCount += 1;
  entry.tokensInput += u.promptTokens;
  entry.tokensOutput += u.completionTokens;
}

/**
 * Called from the chat-stream after the agent turn completes. Reads the
 * accumulator for this turn, evaluates thresholds, optionally writes to the
 * `cost_alerts` container, then drops the entry.
 *
 * Fire-and-forget — never throws (errors are logged + swallowed).
 */
export async function recordAndCheckTurn(args: {
  turnId: string;
  userEmail: string;
  sessionId?: string;
}): Promise<void> {
  ensureSubscribed();
  const entry = byTurnId.get(args.turnId);
  if (!entry) return;
  byTurnId.delete(args.turnId);

  const threshold = perTurnThresholdUsd();
  if (entry.costUsd <= threshold) return;

  const alert: CostAlertDoc = {
    id: `${args.userEmail.toLowerCase()}__${args.turnId}`,
    userEmail: args.userEmail.toLowerCase(),
    turnId: args.turnId,
    sessionId: args.sessionId,
    reason: "per_turn_ceiling",
    costUsd: entry.costUsd,
    thresholdUsd: threshold,
    callCount: entry.callCount,
    tokensInput: entry.tokensInput,
    tokensOutput: entry.tokensOutput,
    createdAt: Date.now(),
  };

  // Sentry-shaped console.error so a hook can capture it.
  console.error(
    `🚨 cost-alert: per_turn_ceiling user=${args.userEmail} turn=${args.turnId} cost=$${entry.costUsd.toFixed(4)} threshold=$${threshold.toFixed(2)} calls=${entry.callCount}`
  );

  try {
    const container = await waitForCostAlertsContainer();
    await container.items.upsert(alert);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️ cost-alert persist failed: ${msg}`);
  }
}

/** Test helpers — not for production. */
export function __resetCostAnomalyDetectorForTest(): void {
  byTurnId.clear();
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}

// Subscribe eagerly so we never miss a call even if recordAndCheckTurn fires
// before the chat-stream has imported this module.
ensureSubscribed();
