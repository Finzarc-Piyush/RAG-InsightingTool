/**
 * Wave AD7 · Admin (superadmin) KPI dashboard.
 *
 * Replaces the pre-AD7 2-card stub with a full usage + quality observability
 * surface for piyush@finzarc.com (the sole hardcoded superadmin per Wave AD2).
 *
 * Layout:
 *   1. Toolbar — date range + granularity (Daily / Weekly / Monthly / Quarterly / Yearly)
 *   2. KPI cards grid (12 metrics in a 4×3 grid)
 *   3. Time-series panel — metric selector with bucketed chart
 *   4. Top users by activity / cost
 *   5. Recent feedback stream — latest comments with click-through to source turn
 *   6. Footer links — All sessions, All dashboards (existing pages)
 *
 * Defence-in-depth: redirects non-superadmin away even if they navigate
 * directly. The server endpoints remain the security boundary.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useSuperadmin } from "@/auth/useSuperadmin";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AdminNav } from "./AdminNav";
import {
  fetchSuperadminMetricsOverview,
  fetchSuperadminFeedback,
  type Granularity,
  type MetricsOverview,
  type FeedbackRow,
} from "@/lib/api/superadminMetrics";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

const GRANULARITY_OPTIONS: ReadonlyArray<{ key: Granularity; label: string }> = [
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
  { key: "quarterly", label: "Quarterly" },
  { key: "yearly", label: "Yearly" },
];

const METRIC_OPTIONS: ReadonlyArray<{ key: string; label: string; isCurrency?: boolean }> = [
  { key: "activeUsers", label: "Active users" },
  { key: "sessionsCreated", label: "Sessions created" },
  { key: "messages", label: "Messages" },
  { key: "charts", label: "Charts" },
  { key: "pivotsGenerated", label: "Pivots generated" },
  { key: "dashboardsCreated", label: "Dashboards created" },
  { key: "dashboardsExported", label: "Dashboards exported" },
  { key: "dashboardsOpened", label: "Dashboards opened" },
  { key: "chatsShared", label: "Chats shared" },
  { key: "dashboardsShared", label: "Dashboards shared" },
  { key: "thumbsUp", label: "Thumbs up" },
  { key: "thumbsDown", label: "Thumbs down" },
  { key: "costUsd", label: "LLM cost (USD)", isCurrency: true },
];

function todayDateKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}
function nDaysAgoDateKey(n: number): string {
  const d = new Date(Date.now() - n * 86400000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}
function dateKeyToInputValue(dk: string): string {
  return `${dk.slice(0, 4)}-${dk.slice(4, 6)}-${dk.slice(6, 8)}`;
}
function inputValueToDateKey(value: string): string {
  return value.replace(/-/g, "");
}

function formatNumber(n: number, opts: { isCurrency?: boolean; isPercent?: boolean } = {}): string {
  if (opts.isCurrency) return `$${n.toFixed(2)}`;
  if (opts.isPercent) return `${(n * 100).toFixed(1)}%`;
  if (n >= 1000) return n.toLocaleString("en-US");
  return Math.round(n * 100) / 100 + "";
}

function KpiCard({
  label,
  value,
  subline,
  onClick,
}: {
  label: string;
  value: string;
  subline?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-brand-md border border-border/60 bg-card p-4 text-left hover:bg-muted/30 transition disabled:cursor-default"
      disabled={!onClick}
    >
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold text-foreground mt-1">{value}</div>
      {subline ? <div className="text-xs text-muted-foreground mt-1">{subline}</div> : null}
    </button>
  );
}

function FeedbackRowItem({ row, onOpen }: { row: FeedbackRow; onOpen: () => void }) {
  const isUp = row.feedback === "up";
  const isDown = row.feedback === "down";
  const dateStr = new Date(row.createdAt).toLocaleString();
  return (
    <div className="rounded-brand-md border border-border/60 bg-card p-3 flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs">
          <span
            className={
              isUp
                ? "rounded-full px-2 py-0.5 bg-primary/10 text-primary"
                : isDown
                ? "rounded-full px-2 py-0.5 bg-destructive/10 text-destructive"
                : "rounded-full px-2 py-0.5 bg-muted text-muted-foreground"
            }
          >
            {isUp ? "👍" : isDown ? "👎" : "—"}
          </span>
          <span className="font-medium text-foreground">{row.userId}</span>
          <span className="text-muted-foreground">{dateStr}</span>
        </div>
        <button
          type="button"
          onClick={onOpen}
          className="text-xs text-primary hover:underline"
        >
          View turn →
        </button>
      </div>
      <div className="text-sm text-foreground line-clamp-1">{row.question}</div>
      {row.feedbackComment ? (
        <div className="text-sm text-muted-foreground italic">"{row.feedbackComment}"</div>
      ) : null}
      {row.feedbackReasons && row.feedbackReasons.length > 0 ? (
        <div className="flex flex-wrap gap-1 mt-1">
          {row.feedbackReasons.map((r) => (
            <span
              key={r}
              className="rounded-full border border-border/60 bg-muted/30 px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {r}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function SuperadminLanding() {
  const { isSuperadmin, isLoading: superadminLoading, hasResolved, email } = useSuperadmin();
  const [, setLocation] = useLocation();

  // Default window: last 30 days, Daily.
  const [fromDateKey, setFromDateKey] = useState(() => nDaysAgoDateKey(29));
  const [toDateKey, setToDateKey] = useState(() => todayDateKey());
  const [granularity, setGranularity] = useState<Granularity>("daily");
  const [overview, setOverview] = useState<MetricsOverview | null>(null);
  const [feedback, setFeedback] = useState<FeedbackRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedMetric, setSelectedMetric] = useState<string>("activeUsers");

  // Wave AD7 follow-up · NO destructive redirect on a stale-cache miss.
  // The server-side `requireSuperadmin` middleware is the security boundary;
  // here we render an authoritative "Not authorized" branch when the /me
  // endpoint has resolved AND returned `isSuperadmin: false`. While the
  // request is in flight (`!hasResolved`) we render a loading state so a
  // brief flash never bounces the user.

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const [ov, fb] = await Promise.all([
        fetchSuperadminMetricsOverview({ fromDateKey, toDateKey, granularity }),
        fetchSuperadminFeedback({ fromDateKey, toDateKey, limit: 50 }),
      ]);
      setOverview(ov);
      setFeedback(fb.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isSuperadmin) return;
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuperadmin, fromDateKey, toDateKey, granularity]);

  const selectedSeries = useMemo(() => {
    if (!overview) return [];
    return overview.series[selectedMetric] ?? [];
  }, [overview, selectedMetric]);

  if (superadminLoading || !hasResolved) {
    return (
      <>
        <AdminNav />
        <div className="container mx-auto py-12 px-6 text-sm text-muted-foreground">
          Checking admin access…
        </div>
      </>
    );
  }

  if (!isSuperadmin) {
    return (
      <>
        <AdminNav />
        <div className="container mx-auto py-12 px-6 max-w-2xl">
          <Card className="p-6 border-destructive/30">
            <h2 className="text-lg font-semibold text-foreground mb-2">
              Not authorized
            </h2>
            <p className="text-sm text-muted-foreground">
              Admin access is hardcoded to a single email. The server saw{" "}
              <code className="text-foreground">{email ?? "(no email)"}</code>{" "}
              for this session.
            </p>
            <p className="text-sm text-muted-foreground mt-2">
              If you should have access, log out and back in to refresh your
              session token, or contact the platform owner.
            </p>
            <div className="mt-4 flex gap-2">
              <Button variant="outline" onClick={() => setLocation("/analysis")}>
                Back to analysis
              </Button>
            </div>
          </Card>
        </div>
      </>
    );
  }

  return (
    <>
      <AdminNav />
      <div className="container mx-auto py-6 px-6 space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Admin overview</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Usage, quality, and cost across every user. Read-only — admin
            access is hardcoded to a single email.
          </p>
        </div>
      </header>

      <Card className="p-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          From
          <input
            type="date"
            value={dateKeyToInputValue(fromDateKey)}
            onChange={(e) => setFromDateKey(inputValueToDateKey(e.target.value))}
            className="rounded-brand-sm border border-border/60 bg-background px-2 py-1 text-sm text-foreground"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          To
          <input
            type="date"
            value={dateKeyToInputValue(toDateKey)}
            onChange={(e) => setToDateKey(inputValueToDateKey(e.target.value))}
            className="rounded-brand-sm border border-border/60 bg-background px-2 py-1 text-sm text-foreground"
          />
        </label>
        <div className="flex items-center gap-1">
          {GRANULARITY_OPTIONS.map((opt) => (
            <Button
              key={opt.key}
              type="button"
              size="sm"
              variant={granularity === opt.key ? "default" : "outline"}
              onClick={() => setGranularity(opt.key)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
        <Button type="button" variant="outline" onClick={() => void reload()}>
          Refresh
        </Button>
      </Card>

      {loading && !overview ? (
        <div className="text-sm text-muted-foreground">Loading metrics…</div>
      ) : error ? (
        <Card className="p-6 border-destructive/30">
          <h2 className="text-lg font-semibold text-foreground mb-2">
            Failed to load metrics
          </h2>
          <p className="text-sm text-muted-foreground mb-4">{error}</p>
          <Button onClick={() => void reload()} variant="outline">
            Retry
          </Button>
        </Card>
      ) : overview ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            <KpiCard
              label="Active users"
              value={formatNumber(overview.kpis.activeUsers.window)}
              subline={`DAU ${overview.kpis.activeUsers.dau} · WAU ${overview.kpis.activeUsers.wau} · MAU ${overview.kpis.activeUsers.mau}`}
            />
            <KpiCard label="Sessions" value={formatNumber(overview.kpis.sessionsCreated)} />
            <KpiCard label="Messages" value={formatNumber(overview.kpis.messages)} />
            <KpiCard label="Charts" value={formatNumber(overview.kpis.charts)} />
            <KpiCard
              label="Pivots generated"
              value={formatNumber(overview.kpis.pivotsGenerated)}
            />
            <KpiCard
              label="Dashboards created"
              value={formatNumber(overview.kpis.dashboardsCreated)}
            />
            <KpiCard
              label="Dashboards exported"
              value={formatNumber(overview.kpis.dashboardsExported)}
            />
            <KpiCard
              label="Dashboards opened"
              value={formatNumber(overview.kpis.dashboardsOpened)}
            />
            <KpiCard label="Chats shared" value={formatNumber(overview.kpis.chatsShared)} />
            <KpiCard
              label="Dashboards shared"
              value={formatNumber(overview.kpis.dashboardsShared)}
            />
            <KpiCard
              label="Thumbs up / down"
              value={`${formatNumber(overview.kpis.thumbsUp)} / ${formatNumber(
                overview.kpis.thumbsDown
              )}`}
              subline={`Down rate ${formatNumber(overview.kpis.thumbsDownRate, { isPercent: true })}`}
            />
            <KpiCard
              label="LLM cost"
              value={formatNumber(overview.kpis.costUsd, { isCurrency: true })}
              subline={`${formatNumber(overview.kpis.llmCalls)} calls · ${formatNumber(
                overview.kpis.tokensIn + overview.kpis.tokensOut
              )} tokens`}
            />
          </div>

          <Card className="p-4">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h3 className="text-sm font-semibold text-foreground">Time series</h3>
              <select
                value={selectedMetric}
                onChange={(e) => setSelectedMetric(e.target.value)}
                className="rounded-brand-sm border border-border/60 bg-background px-2 py-1 text-sm text-foreground"
              >
                {METRIC_OPTIONS.map((opt) => (
                  <option key={opt.key} value={opt.key}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ width: "100%", height: 300 }}>
              <ResponsiveContainer>
                <LineChart data={selectedSeries}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="key" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card className="p-4">
              <h3 className="text-sm font-semibold text-foreground mb-3">
                Top users by activity
              </h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-muted-foreground border-b border-border/40">
                    <th className="py-2">User</th>
                    <th className="py-2 text-right">Sessions</th>
                    <th className="py-2 text-right">Messages</th>
                    <th className="py-2 text-right">Charts</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.topUsersByActivity.slice(0, 10).map((u) => (
                    <tr key={u.userEmail} className="border-b border-border/20">
                      <td className="py-2 text-foreground">{u.userEmail}</td>
                      <td className="py-2 text-right text-foreground">{u.sessions}</td>
                      <td className="py-2 text-right text-foreground">{u.messages}</td>
                      <td className="py-2 text-right text-foreground">{u.charts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>

            <Card className="p-4">
              <h3 className="text-sm font-semibold text-foreground mb-3">Top users by cost</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-muted-foreground border-b border-border/40">
                    <th className="py-2">User</th>
                    <th className="py-2 text-right">Cost</th>
                    <th className="py-2 text-right">Calls</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.topUsersByCost.slice(0, 10).map((u) => (
                    <tr key={u.userEmail} className="border-b border-border/20">
                      <td className="py-2 text-foreground">{u.userEmail}</td>
                      <td className="py-2 text-right text-foreground">
                        {formatNumber(u.costUsd, { isCurrency: true })}
                      </td>
                      <td className="py-2 text-right text-foreground">{u.calls}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>

          <Card className="p-4">
            <h3 className="text-sm font-semibold text-foreground mb-3">
              Recent feedback ({feedback.length})
            </h3>
            {feedback.length === 0 ? (
              <p className="text-sm text-muted-foreground">No feedback in this window yet.</p>
            ) : (
              <div className="space-y-2 max-h-[480px] overflow-y-auto">
                {feedback.map((row) => (
                  <FeedbackRowItem
                    key={row.id}
                    row={row}
                    onOpen={() => setLocation(`/superadmin/sessions/${row.sessionId}`)}
                  />
                ))}
              </div>
            )}
          </Card>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <button
              type="button"
              onClick={() => setLocation("/superadmin/sessions")}
              className="rounded-brand-md border border-border/60 bg-card p-6 text-left hover:bg-muted/30 transition"
            >
              <div className="text-sm font-semibold text-foreground">All sessions</div>
              <p className="text-xs text-muted-foreground mt-1">
                Every chat across every user, with feedback summary badges.
              </p>
            </button>
            <button
              type="button"
              onClick={() => setLocation("/superadmin/dashboards")}
              className="rounded-brand-md border border-border/60 bg-card p-6 text-left hover:bg-muted/30 transition"
            >
              <div className="text-sm font-semibold text-foreground">All dashboards</div>
              <p className="text-xs text-muted-foreground mt-1">
                Every saved dashboard, scoped per user.
              </p>
            </button>
          </div>
        </>
      ) : null}
      </div>
    </>
  );
}
