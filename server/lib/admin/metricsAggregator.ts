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
import { countTurnVotes } from "./feedbackVotes.js";
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
// Sessions created by day · the ONE session-derived metric whose correct event
// is the session's `createdAt`. Everything else (messages, charts, active
// users, top users, feedback) is per-turn activity and is derived from
// past_analyses below — attributing a session's lifetime counts to its
// createdAt day badly mis-buckets every windowed / time-series metric.
// ─────────────────────────────────────────────────────────────────────────────

export async function aggregateSessionsCreatedByDay(
  range: DailyRange
): Promise<DailyPoint[]> {
  const sessions = await getAllSessions(undefined);
  const { fromMs, toMs } = rangeMs(range);
  const sessionsBy = new Map<string, number>();
  for (const s of sessions as SessionListSummary[]) {
    if (inWindow(s.createdAt, fromMs, toMs)) {
      bumpCount(sessionsBy, dateKeyFromTimestamp(s.createdAt!));
    }
  }
  return mapToSortedSeries(sessionsBy);
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
// Per-turn activity & feedback · derived from past_analyses, the canonical
// one-doc-per-completed-turn event log. This is the correct source for any
// windowed / time-series metric because each doc carries the turn's own
// `createdAt`, `userId`, `sessionId`, per-turn chart count, and feedback.
//
// Known minor gap: exact-cache-hit replays (serveCachedExactAnswer) don't
// write a fresh past_analyses doc, so they aren't counted as new turns. That is
// an acceptable small undercount and far more correct than the previous
// session-lifetime-attributed-to-createdAt model.
// ─────────────────────────────────────────────────────────────────────────────

/** Projected past_analyses row — only the fields the aggregator needs. */
export interface PastAnalysisRow {
  createdAt: number;
  userId?: string | null;
  sessionId?: string | null;
  /** ARRAY_LENGTH(c.charts) — charts produced on this turn. */
  chartCount?: number | null;
  /** Answer-level sentiment (legacy / mirrored from the "answer" detail). */
  feedback?: string | null;
  /** Granular per-target feedback (answer + per-chart) — superset of `feedback`. */
  feedbackDetails?: Array<{ feedback?: string | null }> | null;
}

export interface PastAnalysisAggregate {
  turnsByDay: DailyPoint[];
  chartsByDay: DailyPoint[];
  activeUsersByDay: DailyPoint[];
  thumbsUpByDay: DailyPoint[];
  thumbsDownByDay: DailyPoint[];
  /** Distinct active users across the whole requested window. */
  windowActiveUsers: number;
  dauMauWau: { dau: number; wau: number; mau: number };
  totalUp: number;
  totalDown: number;
  totalNone: number;
  topUsers: Array<{ userEmail: string; sessions: number; messages: number; charts: number }>;
}

/**
 * Pure aggregation over the projected past_analyses rows for a window. Extracted
 * from the Cosmos call so it is unit-testable with synthetic rows.
 *
 * DAU = distinct users active on the window's final day (`toDateKey`).
 * WAU / MAU = distinct users in the trailing 7 / 30 days before the window end
 * (clamped to the window, since only in-window rows are passed in).
 */
export function summarizePastAnalysisRows(
  rows: PastAnalysisRow[],
  range: DailyRange
): PastAnalysisAggregate {
  const { fromMs, toMs } = rangeMs(range);
  const turnsBy = new Map<string, number>();
  const chartsBy = new Map<string, number>();
  const usersBy = new Map<string, Set<string>>();
  const upBy = new Map<string, number>();
  const downBy = new Map<string, number>();
  const windowUsers = new Set<string>();
  const dauUsers = new Set<string>();
  const wauUsers = new Set<string>();
  const mauUsers = new Set<string>();
  const userTotals = new Map<
    string,
    { messages: number; charts: number; sessions: Set<string> }
  >();
  let totalUp = 0;
  let totalDown = 0;
  let totalNone = 0;

  const wauFrom = toMs - 7 * 86400000;
  const mauFrom = toMs - 30 * 86400000;

  for (const row of rows) {
    const ts = row.createdAt;
    if (!inWindow(ts, fromMs, toMs)) continue;
    const dk = dateKeyFromTimestamp(ts);
    const charts = Number(row.chartCount ?? 0) || 0;
    bumpCount(turnsBy, dk);
    if (charts) bumpCount(chartsBy, dk, charts);

    const owner = (row.userId ?? "").trim().toLowerCase();
    if (owner) {
      if (!usersBy.has(dk)) usersBy.set(dk, new Set());
      usersBy.get(dk)!.add(owner);
      windowUsers.add(owner);
      if (dk === range.toDateKey) dauUsers.add(owner);
      if (ts >= wauFrom) wauUsers.add(owner);
      if (ts >= mauFrom) mauUsers.add(owner);
      const t =
        userTotals.get(owner) ?? { messages: 0, charts: 0, sessions: new Set<string>() };
      t.messages += 1;
      t.charts += charts;
      if (row.sessionId) t.sessions.add(row.sessionId);
      userTotals.set(owner, t);
    }

    const votes = countTurnVotes(row);
    if (votes.up) {
      bumpCount(upBy, dk, votes.up);
      totalUp += votes.up;
    }
    if (votes.down) {
      bumpCount(downBy, dk, votes.down);
      totalDown += votes.down;
    }
    if (!votes.up && !votes.down) totalNone += 1;
  }

  const activeUsersByDay = Array.from(usersBy.entries())
    .map(([dateKey, set]) => ({ dateKey, value: set.size }))
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));

  const topUsers = Array.from(userTotals.entries())
    .map(([userEmail, t]) => ({
      userEmail,
      sessions: t.sessions.size,
      messages: t.messages,
      charts: t.charts,
    }))
    .sort((a, b) => b.messages - a.messages)
    .slice(0, 25);

  return {
    turnsByDay: mapToSortedSeries(turnsBy),
    chartsByDay: mapToSortedSeries(chartsBy),
    activeUsersByDay,
    thumbsUpByDay: mapToSortedSeries(upBy),
    thumbsDownByDay: mapToSortedSeries(downBy),
    windowActiveUsers: windowUsers.size,
    dauMauWau: { dau: dauUsers.size, wau: wauUsers.size, mau: mauUsers.size },
    totalUp,
    totalDown,
    totalNone,
    topUsers,
  };
}

/**
 * Query the projected past_analyses rows for a window (no aggregation). Single
 * cross-partition query; the heavy chart bodies are never fetched (we project
 * ARRAY_LENGTH).
 *
 * Split from the summarize step so the caller can MERGE in extra per-turn rows
 * before a single aggregation pass — e.g. cache-hit usage events, which don't
 * write a fresh past_analyses doc. One pass keeps distinct-active-user counts
 * correct (a user with both a fresh turn and a cache hit on the same day is
 * counted once).
 */
export async function fetchPastAnalysisRows(
  range: DailyRange
): Promise<PastAnalysisRow[]> {
  const container = await waitForPastAnalysesContainer();
  const { fromMs, toMs } = rangeMs(range);
  const { resources } = await container.items
    .query<PastAnalysisRow>(
      {
        query:
          "SELECT c.createdAt, c.userId, c.sessionId, c.feedback, c.feedbackDetails, " +
          "IIF(IS_DEFINED(c.charts) AND IS_ARRAY(c.charts), ARRAY_LENGTH(c.charts), 0) AS chartCount " +
          "FROM c WHERE c.createdAt >= @from AND c.createdAt <= @to",
        parameters: [
          { name: "@from", value: fromMs },
          { name: "@to", value: toMs },
        ],
      },
      {}
    )
    .fetchAll();
  return resources;
}

/** Fetch + aggregate per-turn activity from past_analyses (no extra rows). */
export async function aggregatePastAnalysisMetrics(
  range: DailyRange
): Promise<PastAnalysisAggregate> {
  return summarizePastAnalysisRows(await fetchPastAnalysisRows(range), range);
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage events by day — exports, pivots, dashboard opens.
// ─────────────────────────────────────────────────────────────────────────────

export async function aggregateUsageEventMetrics(range: DailyRange): Promise<{
  dashboardsExportedByDay: DailyPoint[];
  pivotsGeneratedByDay: DailyPoint[];
  dashboardsOpenedByDay: DailyPoint[];
  cacheHitsByDay: DailyPoint[];
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
    cacheHitsByDay: groupedBy("analysis.cache_hit"),
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
