/**
 * W6.4 · Cost rollup queries for the admin console.
 *
 * Reads:
 *   - llm_usage   (Phase 1)  — every LLM call's cost + tokens
 *   - user_budget (Phase 6)  — per-user-per-day questions/cost accumulators
 *   - cost_alerts (Phase 6)  — outliers above the per-turn ceiling
 *
 * Returns plain JSON for the admin dashboard. All queries are bounded (top-N,
 * recent only) to keep RU costs sane.
 */

import { waitForLlmUsageContainer, type LlmUsageDoc } from "../../models/llmUsage.model.js";
import {
  COSMOS_USER_BUDGET_CONTAINER_ID,
  type UserBudgetDoc,
  dateKeyFromEpoch,
} from "../../models/userBudget.model.js";
import { COSMOS_COST_ALERTS_CONTAINER_ID, type CostAlertDoc } from "../telemetry/costAnomalyDetector.js";
import { getDatabase, initializeCosmosDB } from "../../models/database.config.js";
import type { Container } from "@azure/cosmos";

async function ensureContainer(name: string): Promise<Container | null> {
  try {
    await initializeCosmosDB();
  } catch {
    /* fall through */
  }
  const db = getDatabase();
  if (!db) return null;
  try {
    return db.container(name);
  } catch {
    return null;
  }
}

export interface AdminCostsSnapshot {
  generatedAt: number;
  todayDateKey: string;
  /** Top users today, sorted by accumulated cost desc. */
  topUsersToday: Array<{
    userEmail: string;
    questionsUsed: number;
    costUsdAccumulated: number;
    tokensInputAccumulated: number;
    tokensOutputAccumulated: number;
    lastTurnAt: number;
  }>;
  /** Recent cost alerts (W6.3), newest first. */
  recentAlerts: Array<{
    userEmail: string;
    turnId: string;
    sessionId?: string;
    costUsd: number;
    thresholdUsd: number;
    createdAt: number;
  }>;
  /** Per-purpose rollup of today's LLM spend (handy to spot what's driving cost). */
  spendByPurposeToday: Array<{
    purpose: string;
    callCount: number;
    costUsd: number;
    tokensInput: number;
    tokensOutput: number;
  }>;
  /** Aggregate totals so the page can show a single big number. */
  totalsToday: {
    questions: number;
    costUsd: number;
    tokensInput: number;
    tokensOutput: number;
  };
}

const TOP_USERS_LIMIT = 25;
const RECENT_ALERTS_LIMIT = 25;
const PURPOSE_LIMIT = 25;

export async function getAdminCostsSnapshot(now: number = Date.now()): Promise<AdminCostsSnapshot> {
  const todayDateKey = dateKeyFromEpoch(now);

  // ── Top users today (read straight from user_budget — already aggregated)
  const topUsersToday: AdminCostsSnapshot["topUsersToday"] = [];
  let totalQuestions = 0;
  let totalCost = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  const ub = await ensureContainer(COSMOS_USER_BUDGET_CONTAINER_ID);
  if (ub) {
    try {
      const { resources } = await ub.items
        .query<UserBudgetDoc>(
          {
            query:
              "SELECT * FROM c WHERE c.dateKey = @dk ORDER BY c.costUsdAccumulated DESC OFFSET 0 LIMIT @lim",
            parameters: [
              { name: "@dk", value: todayDateKey },
              { name: "@lim", value: TOP_USERS_LIMIT },
            ],
          },
          { enableCrossPartitionQuery: true } as never
        )
        .fetchAll();
      for (const r of resources) {
        topUsersToday.push({
          userEmail: r.userEmail,
          questionsUsed: r.questionsUsed,
          costUsdAccumulated: r.costUsdAccumulated,
          tokensInputAccumulated: r.tokensInputAccumulated,
          tokensOutputAccumulated: r.tokensOutputAccumulated,
          lastTurnAt: r.lastTurnAt,
        });
        totalQuestions += r.questionsUsed;
        totalCost += r.costUsdAccumulated;
        totalTokensIn += r.tokensInputAccumulated;
        totalTokensOut += r.tokensOutputAccumulated;
      }
    } catch {
      /* container may not exist yet — return empty */
    }
  }

  // ── Recent alerts
  const recentAlerts: AdminCostsSnapshot["recentAlerts"] = [];
  const alerts = await ensureContainer(COSMOS_COST_ALERTS_CONTAINER_ID);
  if (alerts) {
    try {
      const { resources } = await alerts.items
        .query<CostAlertDoc>(
          {
            query: "SELECT * FROM c ORDER BY c.createdAt DESC OFFSET 0 LIMIT @lim",
            parameters: [{ name: "@lim", value: RECENT_ALERTS_LIMIT }],
          },
          { enableCrossPartitionQuery: true } as never
        )
        .fetchAll();
      for (const r of resources) {
        recentAlerts.push({
          userEmail: r.userEmail,
          turnId: r.turnId,
          sessionId: r.sessionId,
          costUsd: r.costUsd,
          thresholdUsd: r.thresholdUsd,
          createdAt: r.createdAt,
        });
      }
    } catch {
      /* empty */
    }
  }

  // ── Spend by purpose today (aggregate llm_usage rows)
  const spendByPurposeToday: AdminCostsSnapshot["spendByPurposeToday"] = [];
  const usage = await ensureContainer("llm_usage").catch(() => null) || (await waitForLlmUsageContainer().catch(() => null));
  if (usage) {
    try {
      const cutoff = startOfDayUtcMs(now);
      // Cosmos doesn't support GROUP BY everywhere — pull the rows then aggregate in-memory.
      // Bounded by the cutoff so this is at most one day's worth of usage rows.
      const { resources } = await usage.items
        .query<LlmUsageDoc>(
          {
            query: "SELECT c.purpose, c.costUsd, c.promptTokens, c.completionTokens FROM c WHERE c.timestamp >= @cut",
            parameters: [{ name: "@cut", value: cutoff }],
          },
          { enableCrossPartitionQuery: true } as never
        )
        .fetchAll();
      const byPurpose = new Map<string, { callCount: number; costUsd: number; tokensInput: number; tokensOutput: number }>();
      for (const r of resources) {
        const k = r.purpose ?? "(untagged)";
        const acc = byPurpose.get(k) ?? { callCount: 0, costUsd: 0, tokensInput: 0, tokensOutput: 0 };
        acc.callCount += 1;
        acc.costUsd += r.costUsd ?? 0;
        acc.tokensInput += r.promptTokens ?? 0;
        acc.tokensOutput += r.completionTokens ?? 0;
        byPurpose.set(k, acc);
      }
      const sorted = [...byPurpose.entries()]
        .map(([purpose, v]) => ({ purpose, ...v }))
        .sort((a, b) => b.costUsd - a.costUsd)
        .slice(0, PURPOSE_LIMIT);
      spendByPurposeToday.push(...sorted);
    } catch {
      /* empty */
    }
  }

  return {
    generatedAt: now,
    todayDateKey,
    topUsersToday,
    recentAlerts,
    spendByPurposeToday,
    totalsToday: {
      questions: totalQuestions,
      costUsd: totalCost,
      tokensInput: totalTokensIn,
      tokensOutput: totalTokensOut,
    },
  };
}

function startOfDayUtcMs(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
}
