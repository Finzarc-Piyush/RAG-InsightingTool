/**
 * Wave AD5 · live metrics aggregator for the admin (superadmin) dashboard.
 *
 * Queries the existing canonical containers + the new `usage_events` (Wave
 * AD3) and returns daily-grain series. The HTTP layer (Wave AD6) wraps each
 * function with `withMetricsCache` (60s TTL) and rebuckets on read into the
 * granularity the user picks (daily / weekly / monthly / quarterly / yearly).
 *
 * Marico-tenant scale: live cross-partition queries are well within Cosmos
 * RU budget; no pre-aggregation container is needed. Documented as a
 * "boring first" choice in the AD plan.
 *
 * Each `*ByDay` function returns `Array<{ dateKey, value }>` sorted ascending.
 * Empty windows yield empty arrays — callers that need zero-fill should walk
 * `buildDateKeyRange(from, to)` and merge.
 */

import { getAllSessions, type SessionListSummary } from "../../models/chat.model.js";
import { listAllDashboardsForSuperadmin } from "../../models/dashboard.model.js";
import { waitForLlmUsageContainer } from "../../models/llmUsage.model.js";
import { waitForPastAnalysesContainer } from "../../models/pastAnalysis.model.js";
import {
  waitForSharedAnalysesContainer,
  waitForSharedDashboardsContainer,
} from "../../models/database.config.js";
import { listUsageEvents } from "../../models/usageEvent.model.js";
import { dateKeyFromTimestamp } from "./bucketing.js";
import type { UsageEventDoc, UsageEventType } from "../../shared/schema.js";

export interface DailyPoint {
  dateKey: string;
  value: number;
}

export interface DailyRange {
  fromDateKey: string;
  toDateKey: string;
}

function inWindow(ts: number | null | undefined, fromMs: number, toMs: number): boolean {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return false;
  return ts >= fromMs && ts <= toMs;
}

function rangeMs(range: DailyRange): { fromMs: number; toMs: number } {
  // Inclusive: end of toDateKey.
  const fromY = Number(range.fromDateKey.slice(0, 4));
  const fromM = Number(range.fromDateKey.slice(4, 6)) - 1;
  const fromD = Number(range.fromDateKey.slice(6, 8));
  const toY = Number(range.toDateKey.slice(0, 4));
  const toM = Number(range.toDateKey.slice(4, 6)) - 1;
  const toD = Number(range.toDateKey.slice(6, 8));
  return {
    fromMs: Date.UTC(fromY, fromM, fromD, 0, 0, 0, 0),
    toMs: Date.UTC(toY, toM, toD, 23, 59, 59, 999),
  };
}

function bumpCount(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function mapToSortedSeries(map: Map<string, number>): DailyPoint[] {
  return Array.from(map.entries())
    .map(([dateKey, value]) => ({ dateKey, value }))
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

// ─────────────────────────────────────────────────────────────────────────────
// Sessions / messages / charts — derived from getAllSessions()'s lightweight
// SessionListSummary projection (per-session counts, not per-message). For
// the admin KPI dashboard's "today we had N messages" view this is the right
// granularity; per-message timestamps would require fetching full chat docs.
// ─────────────────────────────────────────────────────────────────────────────

interface SessionsAggregate {
  activeUsersByDay: DailyPoint[];
  sessionsCreatedByDay: DailyPoint[];
  messagesByDay: DailyPoint[];
  chartsByDay: DailyPoint[];
  dauMauWau: { dau: number; wau: number; mau: number };
  topUsers: Array<{ userEmail: string; sessions: number; messages: number; charts: number }>;
}

/**
 * Aggregate every session-related KPI in one pass over the lightweight
 * SessionListSummary projection. Single cross-partition Cosmos query.
 */
export async function aggregateSessionMetrics(
  range: DailyRange
): Promise<SessionsAggregate> {
  const sessions = await getAllSessions(undefined);
  const { fromMs, toMs } = rangeMs(range);
  const sessionsBy = new Map<string, number>();
  const messagesBy = new Map<string, number>();
  const chartsBy = new Map<string, number>();
  const usersBy = new Map<string, Set<string>>(); // dateKey → distinct emails (last activity)
  const userTotals = new Map<string, { sessions: number; messages: number; charts: number }>();

  for (const s of sessions as SessionListSummary[]) {
    const owner = (s.username ?? "").trim().toLowerCase();
    // Activity timestamp for active-users — last update; falls back to createdAt.
    const activityTs = s.lastUpdatedAt ?? s.createdAt ?? null;
    if (inWindow(activityTs, fromMs, toMs) && owner) {
      const dk = dateKeyFromTimestamp(activityTs!);
      if (!usersBy.has(dk)) usersBy.set(dk, new Set());
      usersBy.get(dk)!.add(owner);
    }
    if (inWindow(s.createdAt, fromMs, toMs)) {
      const dk = dateKeyFromTimestamp(s.createdAt!);
      bumpCount(sessionsBy, dk);
      bumpCount(messagesBy, dk, s.messageCount ?? 0);
      bumpCount(chartsBy, dk, s.chartCount ?? 0);
      if (owner) {
        const t = userTotals.get(owner) ?? { sessions: 0, messages: 0, charts: 0 };
        t.sessions += 1;
        t.messages += s.messageCount ?? 0;
        t.charts += s.chartCount ?? 0;
        userTotals.set(owner, t);
      }
    }
  }

  const activeUsersByDay = Array.from(usersBy.entries())
    .map(([dateKey, set]) => ({ dateKey, value: set.size }))
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));

  // DAU / WAU / MAU computed from the requested window (DAU = today within
  // the window; WAU = last 7 days; MAU = last 30 days).
  const allUserSets = activeUsersByDay.map((p) => p);
  const dau = allUserSets[allUserSets.length - 1]?.value ?? 0;
  const lastSeven = new Set<string>();
  const lastThirty = new Set<string>();
  const today = new Date(toMs);
  const sevenAgo = today.getTime() - 7 * 86400000;
  const thirtyAgo = today.getTime() - 30 * 86400000;
  for (const [dk, set] of usersBy) {
    const t = Date.UTC(
      Number(dk.slice(0, 4)),
      Number(dk.slice(4, 6)) - 1,
      Number(dk.slice(6, 8))
    );
    if (t >= sevenAgo) for (const u of set) lastSeven.add(u);
    if (t >= thirtyAgo) for (const u of set) lastThirty.add(u);
  }

  const topUsers = Array.from(userTotals.entries())
    .map(([userEmail, t]) => ({ userEmail, ...t }))
    .sort((a, b) => b.messages - a.messages)
    .slice(0, 25);

  return {
    activeUsersByDay,
    sessionsCreatedByDay: mapToSortedSeries(sessionsBy),
    messagesByDay: mapToSortedSeries(messagesBy),
    chartsByDay: mapToSortedSeries(chartsBy),
    dauMauWau: { dau, wau: lastSeven.size, mau: lastThirty.size },
    topUsers,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboards created by day · count from the dashboards container.
// ─────────────────────────────────────────────────────────────────────────────

export async function getDashboardsCreatedByDay(range: DailyRange): Promise<DailyPoint[]> {
  const all = await listAllDashboardsForSuperadmin();
  const { fromMs, toMs } = rangeMs(range);
  const m = new Map<string, number>();
  for (const d of all as Array<{ createdAt?: number | null }>) {
    if (inWindow(d.createdAt ?? null, fromMs, toMs)) {
      bumpCount(m, dateKeyFromTimestamp(d.createdAt!));
    }
  }
  return mapToSortedSeries(m);
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM cost & usage by day · sum across the llm_usage container.
// ─────────────────────────────────────────────────────────────────────────────

export interface LlmAggregate {
  costUsdByDay: DailyPoint[];
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCalls: number;
  topUsersByCost: Array<{ userEmail: string; costUsd: number; calls: number }>;
}

export async function aggregateLlmMetrics(range: DailyRange): Promise<LlmAggregate> {
  const container = await waitForLlmUsageContainer();
  const { fromMs, toMs } = rangeMs(range);
  // Cosmos SQL filter on timestamp range — partition is /turnId so this is
  // cross-partition by necessity. Project only the fields we need.
  const { resources } = await container.items
    .query<{
      timestamp: number;
      costUsd: number;
      promptTokens: number;
      completionTokens: number;
      userId?: string;
    }>(
      {
        query:
          "SELECT c.timestamp, c.costUsd, c.promptTokens, c.completionTokens, c.userId FROM c WHERE c.timestamp >= @from AND c.timestamp <= @to",
        parameters: [
          { name: "@from", value: fromMs },
          { name: "@to", value: toMs },
        ],
      },
      {}
    )
    .fetchAll();

  const costBy = new Map<string, number>();
  let totalCostUsd = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  const userTotals = new Map<string, { costUsd: number; calls: number }>();
  for (const row of resources) {
    const dk = dateKeyFromTimestamp(row.timestamp);
    const cost = Number(row.costUsd ?? 0);
    bumpCount(costBy, dk, cost);
    totalCostUsd += cost;
    totalTokensIn += Number(row.promptTokens ?? 0);
    totalTokensOut += Number(row.completionTokens ?? 0);
    const owner = (row.userId ?? "").trim().toLowerCase();
    if (owner) {
      const t = userTotals.get(owner) ?? { costUsd: 0, calls: 0 };
      t.costUsd += cost;
      t.calls += 1;
      userTotals.set(owner, t);
    }
  }
  return {
    costUsdByDay: Array.from(costBy.entries())
      .map(([dateKey, value]) => ({ dateKey, value: Math.round(value * 10000) / 10000 }))
      .sort((a, b) => a.dateKey.localeCompare(b.dateKey)),
    totalCostUsd: Math.round(totalCostUsd * 10000) / 10000,
    totalTokensIn,
    totalTokensOut,
    totalCalls: resources.length,
    topUsersByCost: Array.from(userTotals.entries())
      .map(([userEmail, t]) => ({
        userEmail,
        costUsd: Math.round(t.costUsd * 10000) / 10000,
        calls: t.calls,
      }))
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, 25),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Feedback by day · group past_analyses' feedbackDetails by createdAt.
// ─────────────────────────────────────────────────────────────────────────────

export interface FeedbackAggregate {
  thumbsUpByDay: DailyPoint[];
  thumbsDownByDay: DailyPoint[];
  totalUp: number;
  totalDown: number;
  totalNone: number;
}

export async function aggregateFeedbackMetrics(range: DailyRange): Promise<FeedbackAggregate> {
  const container = await waitForPastAnalysesContainer();
  const { fromMs, toMs } = rangeMs(range);
  const { resources } = await container.items
    .query<{ feedback: string; updatedAt?: number; createdAt?: number; feedbackDetails?: Array<{ feedback: string; updatedAt?: number; createdAt?: number }> }>(
      {
        query:
          "SELECT c.feedback, c.feedbackDetails, c.createdAt FROM c WHERE c.createdAt >= @from AND c.createdAt <= @to",
        parameters: [
          { name: "@from", value: fromMs },
          { name: "@to", value: toMs },
        ],
      },
      {}
    )
    .fetchAll();
  const upBy = new Map<string, number>();
  const downBy = new Map<string, number>();
  let totalUp = 0;
  let totalDown = 0;
  let totalNone = 0;
  for (const row of resources) {
    const baseTs = row.createdAt ?? 0;
    const dk = dateKeyFromTimestamp(baseTs);
    if (row.feedback === "up") {
      bumpCount(upBy, dk);
      totalUp += 1;
    } else if (row.feedback === "down") {
      bumpCount(downBy, dk);
      totalDown += 1;
    } else {
      totalNone += 1;
    }
  }
  return {
    thumbsUpByDay: mapToSortedSeries(upBy),
    thumbsDownByDay: mapToSortedSeries(downBy),
    totalUp,
    totalDown,
    totalNone,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage events by day — exports, pivots, dashboard opens.
// ─────────────────────────────────────────────────────────────────────────────

export async function aggregateUsageEventMetrics(range: DailyRange): Promise<{
  dashboardsExportedByDay: DailyPoint[];
  pivotsGeneratedByDay: DailyPoint[];
  dashboardsOpenedByDay: DailyPoint[];
  raw: UsageEventDoc[];
}> {
  const events = await listUsageEvents({
    fromDateKey: range.fromDateKey,
    toDateKey: range.toDateKey,
    limit: 200_000,
  });
  const groupedBy = (eventType: UsageEventType): DailyPoint[] => {
    const m = new Map<string, number>();
    for (const e of events) if (e.eventType === eventType) bumpCount(m, e.dateKey);
    return mapToSortedSeries(m);
  };
  return {
    dashboardsExportedByDay: groupedBy("dashboard.exported"),
    pivotsGeneratedByDay: groupedBy("pivot.generated"),
    dashboardsOpenedByDay: groupedBy("dashboard.opened"),
    raw: events,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sharing — count invite-creation events from the shared_* containers.
// ─────────────────────────────────────────────────────────────────────────────

async function aggregateSharingFromContainer(
  fetchContainer: () => Promise<{ items: { query: <T>(spec: unknown, opts?: unknown) => { fetchAll: () => Promise<{ resources: T[] }> } } }>,
  range: DailyRange
): Promise<DailyPoint[]> {
  const container = await fetchContainer();
  const { fromMs, toMs } = rangeMs(range);
  const { resources } = await container.items
    .query<{ createdAt: number }>(
      {
        query:
          "SELECT c.createdAt FROM c WHERE c.createdAt >= @from AND c.createdAt <= @to",
        parameters: [
          { name: "@from", value: fromMs },
          { name: "@to", value: toMs },
        ],
      },
      {}
    )
    .fetchAll();
  const m = new Map<string, number>();
  for (const r of resources) {
    if (typeof r.createdAt === "number" && Number.isFinite(r.createdAt)) {
      bumpCount(m, dateKeyFromTimestamp(r.createdAt));
    }
  }
  return mapToSortedSeries(m);
}

export async function getChatsSharedByDay(range: DailyRange): Promise<DailyPoint[]> {
  return aggregateSharingFromContainer(
    () => waitForSharedAnalysesContainer() as unknown as Promise<{ items: { query: <T>(spec: unknown, opts?: unknown) => { fetchAll: () => Promise<{ resources: T[] }> } } }>,
    range
  );
}

export async function getDashboardsSharedByDay(range: DailyRange): Promise<DailyPoint[]> {
  return aggregateSharingFromContainer(
    () => waitForSharedDashboardsContainer() as unknown as Promise<{ items: { query: <T>(spec: unknown, opts?: unknown) => { fetchAll: () => Promise<{ resources: T[] }> } } }>,
    range
  );
}
