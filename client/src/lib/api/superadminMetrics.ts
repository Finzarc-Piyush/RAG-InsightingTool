/**
 * Wave AD6 · client API for the superadmin metrics + feedback endpoints.
 */
import { API_BASE_URL } from "@/lib/config";
import { getUserEmail } from "@/utils/userStorage";
import { getAuthorizationHeader } from "@/auth/msalToken";

export type Granularity = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";

export interface DailyPoint {
  dateKey: string;
  value: number;
}

export interface BucketedPoint {
  key: string;
  startMs: number;
  value: number;
}

export interface MetricsOverview {
  range: { fromDateKey: string; toDateKey: string };
  granularity: Granularity;
  kpis: {
    activeUsers: { window: number; dau: number; wau: number; mau: number };
    sessionsCreated: number;
    messages: number;
    cacheHits: number;
    charts: number;
    pivotsGenerated: number;
    dashboardsCreated: number;
    dashboardsExported: number;
    dashboardsOpened: number;
    chatsShared: number;
    dashboardsShared: number;
    thumbsUp: number;
    thumbsDown: number;
    thumbsTotal: number;
    thumbsDownRate: number;
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
    llmCalls: number;
    avgMessagesPerSession: number;
  };
  series: Record<string, BucketedPoint[]>;
  seriesDaily: Record<string, DailyPoint[]>;
  topUsersByActivity: Array<{
    userEmail: string;
    sessions: number;
    messages: number;
    charts: number;
  }>;
  topUsersByCost: Array<{ userEmail: string; costUsd: number; calls: number }>;
}

async function authedHeaders(): Promise<Record<string, string>> {
  const auth = await getAuthorizationHeader();
  const userEmail = getUserEmail();
  return {
    ...auth,
    ...(userEmail ? { "X-User-Email": userEmail } : {}),
  };
}

export async function fetchSuperadminMetricsOverview(args: {
  fromDateKey: string;
  toDateKey: string;
  granularity: Granularity;
}): Promise<MetricsOverview> {
  const headers = await authedHeaders();
  const params = new URLSearchParams({
    from: args.fromDateKey,
    to: args.toDateKey,
    granularity: args.granularity,
  });
  const res = await fetch(
    `${API_BASE_URL}/api/superadmin/metrics/overview?${params.toString()}`,
    { headers }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`superadmin/metrics/overview ${res.status}: ${body || res.statusText}`);
  }
  return (await res.json()) as MetricsOverview;
}

export interface FeedbackRow {
  id: string;
  sessionId: string;
  turnId: string;
  userId: string;
  question: string;
  answer: string;
  feedback: "up" | "down" | "none";
  feedbackReasons?: string[];
  feedbackComment?: string;
  feedbackDetails?: Array<{
    target: { type: string; id: string };
    feedback: "up" | "down" | "none";
    reasons?: string[];
    comment?: string | null;
    createdAt: number;
    updatedAt: number;
  }>;
  createdAt: number;
}

export async function fetchSuperadminFeedback(args: {
  fromDateKey: string;
  toDateKey: string;
  sentiment?: "up" | "down" | "none";
  userEmail?: string;
  limit?: number;
}): Promise<{ items: FeedbackRow[]; count: number }> {
  const headers = await authedHeaders();
  const params = new URLSearchParams({
    from: args.fromDateKey,
    to: args.toDateKey,
    ...(args.sentiment ? { sentiment: args.sentiment } : {}),
    ...(args.userEmail ? { userEmail: args.userEmail } : {}),
    ...(args.limit ? { limit: String(args.limit) } : {}),
  });
  const res = await fetch(
    `${API_BASE_URL}/api/superadmin/feedback?${params.toString()}`,
    { headers }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`superadmin/feedback ${res.status}: ${body || res.statusText}`);
  }
  return (await res.json()) as { items: FeedbackRow[]; count: number };
}
