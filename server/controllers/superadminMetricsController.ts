/**
 * Wave AD6 · admin (superadmin) usage + quality metrics endpoints.
 *
 * GET /api/superadmin/metrics/overview?from=YYYYMMDD&to=YYYYMMDD&granularity=daily|weekly|monthly|quarterly|yearly
 *   Headline KPIs (12 cards) + every time series, ready to render. Bucketed
 *   server-side to whatever granularity the client picked. Cached 60s.
 *
 * GET /api/superadmin/feedback?from=&to=&sentiment=&userEmail=&limit=
 *   Stream of recent feedback rows with link-back to (sessionId, turnId).
 *
 * Both gated by `requireSuperadmin` upstream in routes/superadmin.ts.
 */

import type { Request, Response } from "express";
import {
  fetchPastAnalysisRows,
  summarizePastAnalysisRows,
  aggregateLlmMetrics,
  aggregateSessionsCreatedByDay,
  aggregateUsageEventMetrics,
  getDashboardsCreatedByDay,
  getChatsSharedByDay,
  getDashboardsSharedByDay,
  type DailyPoint,
  type DailyRange,
  type PastAnalysisRow,
} from "../lib/admin/metricsAggregator.js";
import { withMetricsCache } from "../lib/admin/metricsCache.js";
import {
  rebucketDailySeries,
  GRANULARITIES,
  type Granularity,
} from "../lib/admin/bucketing.js";
import { waitForPastAnalysesContainer } from "../models/pastAnalysis.model.js";
import { logger } from "../lib/logger.js";

function parseDateKey(raw: unknown, fallback: string): string {
  if (typeof raw === "string" && /^\d{8}$/.test(raw)) return raw;
  return fallback;
}

function defaultRange(): DailyRange {
  const today = new Date();
  const fromDate = new Date(today.getTime() - 29 * 86400000);
  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return { fromDateKey: fmt(fromDate), toDateKey: fmt(today) };
}

function parseGranularity(raw: unknown): Granularity {
  if (typeof raw === "string" && (GRANULARITIES as ReadonlyArray<string>).includes(raw)) {
    return raw as Granularity;
  }
  return "daily";
}

interface BucketedPoint {
  key: string;
  startMs: number;
  value: number;
}

function bucketPoints(points: DailyPoint[], g: Granularity): BucketedPoint[] {
  if (g === "daily") {
    return points.map((p) => ({
      key: p.dateKey,
      startMs: Date.UTC(
        Number(p.dateKey.slice(0, 4)),
        Number(p.dateKey.slice(4, 6)) - 1,
        Number(p.dateKey.slice(6, 8))
      ),
      value: p.value,
    }));
  }
  return rebucketDailySeries<number>(
    points.map((p) => ({ dateKey: p.dateKey, value: p.value })),
    g,
    (acc, v) => acc + v,
    () => 0
  ).map((b) => ({ key: b.key, startMs: b.startMs, value: b.value }));
}

export async function getSuperadminMetricsOverview(req: Request, res: Response) {
  try {
    const def = defaultRange();
    const range: DailyRange = {
      fromDateKey: parseDateKey(req.query.from, def.fromDateKey),
      toDateKey: parseDateKey(req.query.to, def.toDateKey),
    };
    const granularity = parseGranularity(req.query.granularity);
    const cacheKey = `overview__${range.fromDateKey}__${range.toDateKey}`;

    const overview = await withMetricsCache(cacheKey, async () => {
      const [
        paRows,
        llm,
        events,
        sessionsCreatedByDay,
        dashboardsCreated,
        chatsShared,
        dashboardsShared,
      ] = await Promise.all([
        fetchPastAnalysisRows(range),
        aggregateLlmMetrics(range),
        aggregateUsageEventMetrics(range),
        aggregateSessionsCreatedByDay(range),
        getDashboardsCreatedByDay(range),
        getChatsSharedByDay(range),
        getDashboardsSharedByDay(range),
      ]);

      // Fold cache-served questions into the per-turn activity. A cache hit
      // doesn't write a fresh past_analyses doc, so we synthesize a lightweight
      // turn row (no charts, no feedback) from each `analysis.cache_hit` usage
      // event and aggregate them together — a single pass keeps distinct
      // active-user counts correct (a user with a fresh turn AND a cache hit on
      // the same day is counted once).
      const cacheHitRows: PastAnalysisRow[] = events.raw
        .filter((e) => e.eventType === "analysis.cache_hit")
        .map((e) => ({
          createdAt: e.timestamp,
          userId: e.userEmail,
          sessionId: e.sessionId ?? null,
          chartCount: 0,
        }));
      const activity = summarizePastAnalysisRows([...paRows, ...cacheHitRows], range);

      const sessionsCount = sessionsCreatedByDay.reduce((s, p) => s + p.value, 0);
      const messagesCount = activity.turnsByDay.reduce((s, p) => s + p.value, 0);
      const chartsCount = activity.chartsByDay.reduce((s, p) => s + p.value, 0);
      const cacheHitsCount = events.cacheHitsByDay.reduce((s, p) => s + p.value, 0);
      const dashboardsCreatedCount = dashboardsCreated.reduce((s, p) => s + p.value, 0);
      const dashboardsExportedCount = events.dashboardsExportedByDay.reduce(
        (s, p) => s + p.value,
        0
      );
      const pivotsGeneratedCount = events.pivotsGeneratedByDay.reduce(
        (s, p) => s + p.value,
        0
      );
      const dashboardsOpenedCount = events.dashboardsOpenedByDay.reduce(
        (s, p) => s + p.value,
        0
      );
      const chatsSharedCount = chatsShared.reduce((s, p) => s + p.value, 0);
      const dashboardsSharedCount = dashboardsShared.reduce((s, p) => s + p.value, 0);

      return {
        range,
        kpis: {
          activeUsers: {
            window: activity.windowActiveUsers, // distinct users across the whole window
            dau: activity.dauMauWau.dau,
            wau: activity.dauMauWau.wau,
            mau: activity.dauMauWau.mau,
          },
          sessionsCreated: sessionsCount,
          messages: messagesCount,
          cacheHits: cacheHitsCount,
          charts: chartsCount,
          pivotsGenerated: pivotsGeneratedCount,
          dashboardsCreated: dashboardsCreatedCount,
          dashboardsExported: dashboardsExportedCount,
          dashboardsOpened: dashboardsOpenedCount,
          chatsShared: chatsSharedCount,
          dashboardsShared: dashboardsSharedCount,
          thumbsUp: activity.totalUp,
          thumbsDown: activity.totalDown,
          thumbsTotal: activity.totalUp + activity.totalDown,
          thumbsDownRate:
            activity.totalUp + activity.totalDown > 0
              ? activity.totalDown / (activity.totalUp + activity.totalDown)
              : 0,
          costUsd: llm.totalCostUsd,
          tokensIn: llm.totalTokensIn,
          tokensOut: llm.totalTokensOut,
          llmCalls: llm.totalCalls,
          avgMessagesPerSession: sessionsCount > 0 ? messagesCount / sessionsCount : 0,
        },
        seriesDaily: {
          activeUsers: activity.activeUsersByDay,
          sessionsCreated: sessionsCreatedByDay,
          messages: activity.turnsByDay,
          cacheHits: events.cacheHitsByDay,
          charts: activity.chartsByDay,
          dashboardsCreated,
          dashboardsExported: events.dashboardsExportedByDay,
          dashboardsOpened: events.dashboardsOpenedByDay,
          pivotsGenerated: events.pivotsGeneratedByDay,
          chatsShared,
          dashboardsShared,
          thumbsUp: activity.thumbsUpByDay,
          thumbsDown: activity.thumbsDownByDay,
          costUsd: llm.costUsdByDay,
        },
        topUsersByActivity: activity.topUsers,
        topUsersByCost: llm.topUsersByCost,
      };
    });

    // Apply user-chosen granularity to every series at response time. The
    // daily payload stays cached so toggling granularity is essentially free.
    const bucketed = Object.fromEntries(
      Object.entries(overview.seriesDaily).map(([k, v]) => [k, bucketPoints(v as DailyPoint[], granularity)])
    );

    return res.json({
      ...overview,
      granularity,
      series: bucketed,
    });
  } catch (err) {
    logger.error("⚠️ superadmin/metrics/overview failed:", err);
    return res
      .status(500)
      .json({ error: "superadmin_metrics_overview_failed", message: err instanceof Error ? err.message : String(err) });
  }
}

export async function getSuperadminFeedbackStream(req: Request, res: Response) {
  try {
    const def = defaultRange();
    const fromDateKey = parseDateKey(req.query.from, def.fromDateKey);
    const toDateKey = parseDateKey(req.query.to, def.toDateKey);
    const sentiment = typeof req.query.sentiment === "string" ? req.query.sentiment : null;
    const userEmail = typeof req.query.userEmail === "string" ? req.query.userEmail.toLowerCase() : null;
    const limit = Math.max(
      1,
      Math.min(
        typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) || 100 : 100,
        500
      )
    );

    const fromMs = Date.UTC(
      Number(fromDateKey.slice(0, 4)),
      Number(fromDateKey.slice(4, 6)) - 1,
      Number(fromDateKey.slice(6, 8))
    );
    const toMs =
      Date.UTC(
        Number(toDateKey.slice(0, 4)),
        Number(toDateKey.slice(4, 6)) - 1,
        Number(toDateKey.slice(6, 8))
      ) +
      86400000 -
      1;

    const container = await waitForPastAnalysesContainer();
    const conditions = [
      "c.createdAt >= @from",
      "c.createdAt <= @to",
      "(IS_DEFINED(c.feedbackComment) OR c.feedback != 'none')",
    ];
    const params: Array<{ name: string; value: unknown }> = [
      { name: "@from", value: fromMs },
      { name: "@to", value: toMs },
    ];
    if (sentiment === "up" || sentiment === "down" || sentiment === "none") {
      conditions.push("c.feedback = @sentiment");
      params.push({ name: "@sentiment", value: sentiment });
    }
    if (userEmail) {
      conditions.push("LOWER(c.userId) = @user");
      params.push({ name: "@user", value: userEmail });
    }
    const sql = `SELECT TOP ${limit} c.id, c.sessionId, c.turnId, c.userId, c.question, c.answer, c.feedback, c.feedbackReasons, c.feedbackComment, c.feedbackDetails, c.createdAt FROM c WHERE ${conditions.join(" AND ")} ORDER BY c.createdAt DESC`;
    const { resources } = await container.items
      .query({ query: sql, parameters: params as unknown as Array<{ name: string; value: string | number | boolean }> })
      .fetchAll();
    return res.json({ items: resources, count: resources.length });
  } catch (err) {
    logger.error("⚠️ superadmin/feedback failed:", err);
    return res
      .status(500)
      .json({ error: "superadmin_feedback_failed" });
  }
}
