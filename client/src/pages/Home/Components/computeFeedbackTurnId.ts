/**
 * Wave AD1 · pure helper that decides which turnId — if any — should be
 * passed to <FeedbackButtons> for a given assistant message.
 *
 * Rules:
 *   1. Cache-hit messages (agentTrace.fromCache === true) intentionally return
 *      null — clicking thumbs on them would 404 because no past_analyses doc
 *      exists keyed by (currentSessionId, anyTurnId). Tracked as a follow-up.
 *   2. Otherwise prefer the agent-trace turnId (set by the agent loop or by
 *      the chatStream service for non-agentic / dataOps paths).
 *   3. As a last-resort defense-in-depth fallback, derive a stable per-turn
 *      id from the message timestamp so a future regression where neither
 *      path sets agentTrace.turnId doesn't silently hide thumbs again.
 */
export type MessageForFeedback = {
  agentTrace?: { turnId?: unknown; fromCache?: unknown } | unknown;
  timestamp?: unknown;
};

export function computeFeedbackTurnId(message: MessageForFeedback): string | null {
  const trace = (message.agentTrace ?? undefined) as
    | { turnId?: unknown; fromCache?: unknown }
    | undefined;
  if (trace?.fromCache === true) return null;
  if (typeof trace?.turnId === "string" && trace.turnId.length > 0) return trace.turnId;
  const ts = message.timestamp;
  if (typeof ts === "number" && Number.isFinite(ts)) return `ts-${ts}`;
  return null;
}
