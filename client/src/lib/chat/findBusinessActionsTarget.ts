/**
 * Wave C1 · Pure helper that chooses which assistant message a server-emitted
 * `business_actions` SSE event should attach to.
 *
 * The agent loop fires the post-verifier business-actions sub-agent AFTER
 * the `response` event has been emitted and the AnswerCard is on screen.
 * The agent has up to 12s to resolve (BUSINESS_ACTIONS_TIMEOUT_MS). During
 * that 12s window the user can:
 *   - regenerate the assistant message (replacing the target)
 *   - fire a new turn (appending a fresh assistant message after the target)
 * Pre-C1 the SSE handler picked "the most recent assistant message" by
 * recency, which mis-attached the items in both cases above. C1 prefers
 * an EXACT timestamp match (within ±2000ms tolerance) and falls back to
 * recency only when no match is found OR when the server didn't ship a
 * timestamp.
 *
 * Why ±2000ms tolerance: client and server each call `Date.now()`
 * independently when stamping the assistant message timestamp in the W38
 * streaming-narrator path. Network round-trip + clock drift can put them
 * a second or two apart for the SAME logical message. Anything tighter
 * starves the exact-match pass and we fall back to recency unnecessarily.
 */

export interface BusinessActionsTargetCandidate {
  role: string;
  isIntermediate?: boolean;
  timestamp: number;
}

/**
 * Returns the index of the message to attach business actions to, or -1
 * if no eligible assistant message exists.
 *
 * @param messages    The current messages array (newest LAST).
 * @param serverTs    The server-shipped `messageTimestamp` from the
 *                    `business_actions` SSE event, or null when absent.
 * @param toleranceMs Window for exact-match (default 2000).
 */
export function findBusinessActionsTargetIndex(
  messages: ReadonlyArray<BusinessActionsTargetCandidate | undefined | null>,
  serverTs: number | null,
  toleranceMs = 2000
): number {
  // Pass 1 · exact-timestamp match (within tolerance). Iterate newest
  // first so the most-recent matching message wins under ties.
  if (serverTs !== null && Number.isFinite(serverTs)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (
        m &&
        m.role === 'assistant' &&
        !m.isIntermediate &&
        typeof m.timestamp === 'number' &&
        Math.abs(m.timestamp - serverTs) <= toleranceMs
      ) {
        return i;
      }
    }
  }
  // Pass 2 · most-recent assistant fallback (pre-C1 behavior).
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'assistant' && !m.isIntermediate) {
      return i;
    }
  }
  return -1;
}
