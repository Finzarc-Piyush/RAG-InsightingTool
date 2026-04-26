/**
 * W6.4 · Admin cost dashboard.
 *
 * Fetches /api/admin/costs and renders three tables:
 *   - Headline totals for today (questions / cost / tokens)
 *   - Top users today (sorted by cost)
 *   - Recent cost alerts (W6.3 fires)
 *   - Spend by purpose today (drives understanding of which call sites cost most)
 *
 * Server gates the endpoint by ADMIN_EMAILS env. Non-admins get a 403 which we
 * render as a "Not authorized" message — no client-side identity check needed.
 */

import { useEffect, useState } from "react";
import { fetchAdminCosts, type AdminCostsSnapshot } from "@/lib/api/admin";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

function formatUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export default function AdminCosts() {
  const [data, setData] = useState<AdminCostsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const snap = await fetchAdminCosts();
      setData(snap);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (loading && !data) {
    return (
      <div className="p-6 text-muted-foreground" data-testid="admin-costs-loading">
        Loading admin cost snapshot…
      </div>
    );
  }

  if (error) {
    const isForbidden = /\b403\b/.test(error);
    return (
      <div className="p-6">
        <Card className="p-6 border-destructive/30">
          <h2 className="text-lg font-semibold text-foreground mb-2">
            {isForbidden ? "Not authorized" : "Failed to load admin costs"}
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            {isForbidden
              ? "Your account isn't on the ADMIN_EMAILS allow-list."
              : error}
          </p>
          <Button onClick={() => void load()} variant="outline">Retry</Button>
        </Card>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Cost dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Today ({data.todayDateKey}) · generated {formatRelative(data.generatedAt)}
          </p>
        </div>
        <Button onClick={() => void load()} variant="outline" size="sm" disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </header>

      {/* Totals */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">Questions</div>
          <div className="text-2xl font-semibold text-foreground mt-1">
            {formatInt(data.totalsToday.questions)}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">Cost (USD)</div>
          <div className="text-2xl font-semibold text-foreground mt-1">
            {formatUsd(data.totalsToday.costUsd)}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">Input tokens</div>
          <div className="text-2xl font-semibold text-foreground mt-1">
            {formatInt(data.totalsToday.tokensInput)}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground uppercase tracking-wide">Output tokens</div>
          <div className="text-2xl font-semibold text-foreground mt-1">
            {formatInt(data.totalsToday.tokensOutput)}
          </div>
        </Card>
      </div>

      {/* Top users */}
      <Card className="p-4">
        <h2 className="text-base font-semibold text-foreground mb-3">Top users today</h2>
        {data.topUsersToday.length === 0 ? (
          <p className="text-sm text-muted-foreground">No usage yet today.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-2 pr-4">User</th>
                  <th className="py-2 pr-4 text-right">Questions</th>
                  <th className="py-2 pr-4 text-right">Cost</th>
                  <th className="py-2 pr-4 text-right">Tokens in</th>
                  <th className="py-2 pr-4 text-right">Tokens out</th>
                  <th className="py-2 text-right">Last turn</th>
                </tr>
              </thead>
              <tbody>
                {data.topUsersToday.map((u) => (
                  <tr key={u.userEmail} className="border-t border-border">
                    <td className="py-2 pr-4 font-mono text-xs">{u.userEmail}</td>
                    <td className="py-2 pr-4 text-right">{formatInt(u.questionsUsed)}</td>
                    <td className="py-2 pr-4 text-right">{formatUsd(u.costUsdAccumulated)}</td>
                    <td className="py-2 pr-4 text-right">{formatInt(u.tokensInputAccumulated)}</td>
                    <td className="py-2 pr-4 text-right">{formatInt(u.tokensOutputAccumulated)}</td>
                    <td className="py-2 text-right text-muted-foreground">
                      {u.lastTurnAt ? formatRelative(u.lastTurnAt) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Spend by purpose */}
      <Card className="p-4">
        <h2 className="text-base font-semibold text-foreground mb-3">Spend by purpose (today)</h2>
        {data.spendByPurposeToday.length === 0 ? (
          <p className="text-sm text-muted-foreground">No LLM calls recorded yet today.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-2 pr-4">Purpose</th>
                  <th className="py-2 pr-4 text-right">Calls</th>
                  <th className="py-2 pr-4 text-right">Cost</th>
                  <th className="py-2 pr-4 text-right">Tokens in</th>
                  <th className="py-2 text-right">Tokens out</th>
                </tr>
              </thead>
              <tbody>
                {data.spendByPurposeToday.map((p) => (
                  <tr key={p.purpose} className="border-t border-border">
                    <td className="py-2 pr-4 font-mono text-xs">{p.purpose}</td>
                    <td className="py-2 pr-4 text-right">{formatInt(p.callCount)}</td>
                    <td className="py-2 pr-4 text-right">{formatUsd(p.costUsd)}</td>
                    <td className="py-2 pr-4 text-right">{formatInt(p.tokensInput)}</td>
                    <td className="py-2 text-right">{formatInt(p.tokensOutput)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Recent alerts */}
      <Card className="p-4">
        <h2 className="text-base font-semibold text-foreground mb-3">
          Recent cost alerts (per-turn ceiling)
        </h2>
        {data.recentAlerts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No alerts. Healthy.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-2 pr-4">When</th>
                  <th className="py-2 pr-4">User</th>
                  <th className="py-2 pr-4">Turn</th>
                  <th className="py-2 pr-4 text-right">Cost</th>
                  <th className="py-2 text-right">Threshold</th>
                </tr>
              </thead>
              <tbody>
                {data.recentAlerts.map((a) => (
                  <tr key={`${a.userEmail}__${a.turnId}`} className="border-t border-border">
                    <td className="py-2 pr-4 text-muted-foreground">{formatRelative(a.createdAt)}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{a.userEmail}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{a.turnId.slice(0, 8)}…</td>
                    <td className="py-2 pr-4 text-right text-destructive font-semibold">
                      {formatUsd(a.costUsd)}
                    </td>
                    <td className="py-2 text-right text-muted-foreground">
                      {formatUsd(a.thresholdUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
