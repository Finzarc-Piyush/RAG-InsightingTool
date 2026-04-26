/**
 * W6.2 · Per-user-per-day quota gate for the chat-stream endpoint.
 *
 * Three modes (`BUDGET_GATE_ENFORCEMENT`):
 *   - `off`         → middleware is a no-op, no Cosmos read/write.
 *   - `warn_only`   → atomic increment runs, response carries an
 *                     `X-Budget-Status` header but never rejects. Use during
 *                     rollout to confirm legitimate users stay under the cap.
 *   - `enforce`     → reject with 429 once `questionsUsed >= DAILY_QUESTION_QUOTA`.
 *                     The 429 body carries `usage` + `retryAfterSec` so the
 *                     client can render a friendly banner.
 *
 * The increment is atomic at the Cosmos level. Concurrent requests from the
 * same user can each pass the read-side check then collectively exceed the
 * limit by a small margin (max +N where N = parallel inflight requests).
 * Acceptable slop at the scale we're designing for.
 *
 * Cost accumulation is a separate path — `recordTurnSpend` runs from
 * chatStream after the agent completes (W6.2's other half).
 */

import type { Request, Response, NextFunction } from "express";
import { getAuthenticatedEmail } from "../utils/auth.helper.js";
import {
  incrementQuestionsUsed,
  type UserBudgetDoc,
} from "../models/userBudget.model.js";

const DEFAULT_DAILY_QUOTA = 20;

export type BudgetMode = "off" | "warn_only" | "enforce";

function mode(): BudgetMode {
  const raw = (process.env.BUDGET_GATE_ENFORCEMENT || "off").toLowerCase();
  if (raw === "warn_only") return "warn_only";
  if (raw === "enforce") return "enforce";
  return "off";
}

function dailyQuota(): number {
  const raw = process.env.DAILY_QUESTION_QUOTA;
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAILY_QUOTA;
  return Math.floor(n);
}

/** ms until next UTC midnight — used in the 429 response so the client knows when it can retry. */
export function secondsUntilUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
  return Math.ceil((next - now) / 1000);
}

/**
 * Express middleware. Intended to be mounted on `/api/chat/stream` only — the
 * upload/data-ops paths shouldn't burn the same quota.
 */
export async function budgetGate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const m = mode();
  if (m === "off") {
    next();
    return;
  }

  const userEmail = getAuthenticatedEmail(req);
  if (!userEmail) {
    // Auth middleware should already have rejected; if we got here without an
    // email it's a misconfiguration. Don't block the request — let the next
    // handler do its own auth check.
    next();
    return;
  }

  const quota = dailyQuota();
  let updated: UserBudgetDoc;
  try {
    updated = await incrementQuestionsUsed(userEmail);
  } catch (err) {
    // Cosmos hiccup. Don't block the user — log and move on. Worst case we
    // skip a quota check for one request.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️ budgetGate: increment failed (${msg}) — passing through`);
    next();
    return;
  }

  const overQuota = updated.questionsUsed > quota;

  // Always advertise the user's standing in headers so the client can render a
  // running counter.
  res.setHeader("X-Budget-Used", String(updated.questionsUsed));
  res.setHeader("X-Budget-Quota", String(quota));
  res.setHeader("X-Budget-Status", overQuota ? "over" : "ok");

  if (overQuota && m === "enforce") {
    const retryAfter = secondsUntilUtcMidnight();
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({
      error: "quota_exceeded",
      message: `Daily question limit reached (${updated.questionsUsed}/${quota}). Resets at midnight UTC.`,
      usage: {
        questionsUsed: updated.questionsUsed,
        quota,
        retryAfterSec: retryAfter,
      },
    });
    return;
  }

  if (overQuota && m === "warn_only") {
    console.warn(
      `⚠️ budgetGate WARN_ONLY: ${userEmail} exceeded quota (${updated.questionsUsed}/${quota})`
    );
  }

  next();
}
