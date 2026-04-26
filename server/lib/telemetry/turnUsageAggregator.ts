/**
 * Global per-turn usage aggregator.
 *
 * Subscribes to the LLM-usage emitter at module load and keeps a running total
 * per `turnId`. Chat-stream code calls `takeTurnTotals(turnId)` right before
 * writing the `past_analyses` doc to get cost + token rollups for that turn.
 * `take` removes the entry so the Map stays bounded.
 *
 * A TTL sweep drops entries older than `ENTRY_TTL_MS` so abandoned turns
 * (network dropout, verifier bail-out) don't accumulate forever.
 */

import {
  registerLlmUsageListener,
  type LlmCallUsage,
} from "../agents/runtime/llmUsageEmitter.js";

const ENTRY_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

export interface TurnUsageTotals {
  turnId: string;
  costUsd: number;
  tokensInput: number;
  tokensOutput: number;
  cachedPromptTokens: number;
  callCount: number;
  /** ms epoch of the first observed event for this turn. */
  firstSeen: number;
  /** ms epoch of the most recent event. */
  lastSeen: number;
}

interface Entry extends TurnUsageTotals {
  // Entry extends the public shape with no extra private fields — the
  // `firstSeen`/`lastSeen` doubles as our TTL anchor.
}

const byTurnId = new Map<string, Entry>();
let sweepTimer: NodeJS.Timeout | null = null;
let unsubscribe: (() => void) | null = null;

function ensureStarted(): void {
  if (unsubscribe) return;
  unsubscribe = registerLlmUsageListener(onUsage);
  sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

function onUsage(u: LlmCallUsage): void {
  const tid = u.turnId;
  if (!tid) return; // events without a turnId are captured by llm_usage sink but not rolled up here
  let entry = byTurnId.get(tid);
  if (!entry) {
    entry = {
      turnId: tid,
      costUsd: 0,
      tokensInput: 0,
      tokensOutput: 0,
      cachedPromptTokens: 0,
      callCount: 0,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    };
    byTurnId.set(tid, entry);
  }
  entry.costUsd += u.costUsd;
  entry.tokensInput += u.promptTokens;
  entry.tokensOutput += u.completionTokens;
  entry.cachedPromptTokens += u.cachedPromptTokens ?? 0;
  entry.callCount += 1;
  entry.lastSeen = Date.now();
}

function sweep(): void {
  const cutoff = Date.now() - ENTRY_TTL_MS;
  for (const [tid, entry] of byTurnId) {
    if (entry.lastSeen < cutoff) {
      byTurnId.delete(tid);
    }
  }
}

/**
 * Take and remove the accumulated totals for a turn. Returns `null` if no
 * events were observed (e.g. the turn short-circuited before any LLM call or
 * all calls were made without a `turnId`).
 */
export function takeTurnTotals(turnId: string): TurnUsageTotals | null {
  ensureStarted();
  const entry = byTurnId.get(turnId);
  if (!entry) return null;
  byTurnId.delete(turnId);
  return { ...entry };
}

/** Test helpers — not for production callers. */
export function __resetTurnAggregatorForTest(): void {
  byTurnId.clear();
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}

// Subscribe eagerly on module load so we never miss events. Safe: the emitter
// is a cheap in-process Set; a subscribed but idle listener costs nothing.
ensureStarted();
