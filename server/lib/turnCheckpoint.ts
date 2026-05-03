/**
 * Wave A4 · mid-turn checkpoint persistence.
 *
 * Writes a debounced snapshot of the running turn's `agentInternals` (working
 * memory, blackboard, reflector + verifier verdicts, per-step tool I/O) into
 * the chat doc's top-level `currentTurnCheckpoint` field. If the server
 * process crashes mid-turn, the next session load sees the checkpoint and
 * can render a "Last turn interrupted; here's what we had" affordance.
 *
 * Cleared at turn end (success path or fatal error). The persist queue (Wave
 * A3) is intentionally NOT used here — checkpoints are best-effort and should
 * not contend with the message-save serial chain. Failures swallow with a
 * console warning.
 */
import {
  getChatBySessionIdEfficient,
  updateChatDocument,
} from "../models/chat.model.js";
import type { AgentInternals } from "../shared/schema.js";

const CHECKPOINT_DEBOUNCE_MS = Math.max(
  1000,
  parseInt(process.env.AGENT_CHECKPOINT_DEBOUNCE_MS || "3000", 10) || 3000
);

interface CheckpointTimer {
  timer: ReturnType<typeof setTimeout> | null;
  pending: { question: string; agentInternals?: AgentInternals; stepsCompleted: number } | null;
  startedAt: number;
}
const timers = new Map<string, CheckpointTimer>();

/**
 * Schedule a debounced checkpoint write. Multiple calls within
 * `CHECKPOINT_DEBOUNCE_MS` collapse to a single write of the latest payload.
 *
 * Best-effort: failures are logged at warn level and discarded.
 */
export function scheduleTurnCheckpoint(opts: {
  sessionId: string;
  username: string;
  question: string;
  agentInternals?: AgentInternals;
  stepsCompleted: number;
  startedAt: number;
}): void {
  const slot = timers.get(opts.sessionId) ?? {
    timer: null,
    pending: null,
    startedAt: opts.startedAt,
  };
  slot.pending = {
    question: opts.question,
    agentInternals: opts.agentInternals,
    stepsCompleted: opts.stepsCompleted,
  };
  if (slot.timer) {
    timers.set(opts.sessionId, slot);
    return; // existing timer will fire with latest pending
  }
  slot.timer = setTimeout(() => {
    void writeCheckpoint(opts.sessionId, opts.username, slot);
  }, CHECKPOINT_DEBOUNCE_MS);
  timers.set(opts.sessionId, slot);
}

async function writeCheckpoint(
  sessionId: string,
  username: string,
  slot: CheckpointTimer
): Promise<void> {
  const pending = slot.pending;
  slot.timer = null;
  slot.pending = null;
  if (!pending) return;
  try {
    const doc = await getChatBySessionIdEfficient(sessionId);
    if (!doc) return;
    if (
      doc.username &&
      username &&
      doc.username.toLowerCase() !== username.toLowerCase() &&
      !doc.collaborators?.includes(username.toLowerCase())
    ) {
      return; // auth mismatch — silently skip
    }
    doc.currentTurnCheckpoint = {
      sessionId,
      question: pending.question.slice(0, 2000),
      startedAt: slot.startedAt,
      lastUpdatedAt: Date.now(),
      agentInternals: pending.agentInternals,
      stepsCompleted: pending.stepsCompleted,
    };
    await updateChatDocument(doc);
  } catch (err) {
    console.warn(
      `⚠️ turnCheckpoint write failed (session=${sessionId}):`,
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Clear the checkpoint on successful turn completion. Cancels any pending
 * debounced write so we don't race-write a stale snapshot.
 */
export async function clearTurnCheckpoint(
  sessionId: string,
  username: string
): Promise<void> {
  const slot = timers.get(sessionId);
  if (slot?.timer) {
    clearTimeout(slot.timer);
  }
  timers.delete(sessionId);
  try {
    const doc = await getChatBySessionIdEfficient(sessionId);
    if (!doc) return;
    if (
      doc.username &&
      username &&
      doc.username.toLowerCase() !== username.toLowerCase() &&
      !doc.collaborators?.includes(username.toLowerCase())
    ) {
      return;
    }
    if (!doc.currentTurnCheckpoint) return;
    delete doc.currentTurnCheckpoint;
    await updateChatDocument(doc);
  } catch (err) {
    console.warn(
      `⚠️ turnCheckpoint clear failed (session=${sessionId}):`,
      err instanceof Error ? err.message : err
    );
  }
}

/** Test/observability hook. */
export function __getCheckpointTimerCount(): number {
  return timers.size;
}
