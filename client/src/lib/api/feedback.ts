import { API_BASE_URL } from "@/lib/config";
import { getUserEmail } from "@/utils/userStorage";
import { getAuthorizationHeader } from "@/auth/msalToken";
import { logger } from "@/lib/logger";

export type Feedback = "up" | "down" | "none";

/**
 * W9 · structured reasons attached to a thumbs-down. Mirrors
 * `pastAnalysisFeedbackReasonSchema` on the server.
 */
export type FeedbackReason =
  | "vague"
  | "wrong_numbers"
  | "missing_context"
  | "too_long"
  | "too_short"
  | "format"
  | "other";

/**
 * Granular feedback target — answer / spawned sub-question / pivot. Omitted →
 * legacy answer-level write. Mirrors `pastAnalysisFeedbackTargetSchema`.
 */
export type FeedbackTarget = {
  type: "answer" | "subanswer" | "pivot";
  id: string;
};

/**
 * W5.5b · Send a thumbs up/down for a completed turn.
 * W9 · accepts optional reasons[] and comment for thumbs-down. Used to:
 *   - exclude the past-analysis row from the W5 cache via `feedback ne 'down'`
 *   - feed the W3.11 golden-question seeder (thumbs-up curated corpus)
 *   - inform the cost/quality dashboard with categorical reasons
 *
 * Resolves to `true` on a 2xx; logs + resolves `false` on any non-2xx so the
 * caller can revert local UI state. Never throws — ergonomic for hooks.
 */
export async function submitFeedback(args: {
  sessionId: string;
  turnId: string;
  feedback: Feedback;
  reasons?: FeedbackReason[];
  comment?: string;
  target?: FeedbackTarget;
}): Promise<boolean> {
  try {
    const auth = await getAuthorizationHeader();
    const userEmail = getUserEmail();
    const res = await fetch(`${API_BASE_URL}/api/feedback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...auth,
        ...(userEmail ? { "X-User-Email": userEmail } : {}),
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn(`feedback POST failed (${res.status}): ${body}`);
      return false;
    }
    return true;
  } catch (err) {
    logger.warn(`feedback POST threw: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
