/**
 * Superadmin sessions table — every chat across every user, with feedback
 * summary badges. Two hardcoded emails (see server/lib/superadmin.ts) get
 * read access; the navbar entry is hidden for everyone else and direct URL
 * navigation redirects.
 *
 * Columns (per the user's choice):
 *  · User email (owner)
 *  · Dataset (fileName)
 *  · Last activity
 *  · Messages count
 *  · Feedback summary (▲ N / ▼ N / ◯ N)
 *  · "Open chat" deep link → /superadmin/sessions/:id
 *  · "Dashboards" link → /superadmin/dashboards?owner=<email>
 *
 * The Open chat link is the most important affordance per the user's note —
 * not every analysis has a dashboard.
 */

import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ThumbsUp, ThumbsDown, Circle, ExternalLink, Search } from "lucide-react";
import { useSuperadmin } from "@/auth/useSuperadmin";
import {
  fetchSuperadminSessions,
  type SuperadminSessionRow,
} from "@/lib/api/superadmin";
import { Card } from "@/components/ui/card";

function fmtRelativeOrISO(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const ageMs = Date.now() - d.getTime();
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return d.toISOString().slice(0, 10);
}

export default function SuperadminSessionsPage() {
  const { isSuperadmin, isLoading: isAuthLoading } = useSuperadmin();
  const [, setLocation] = useLocation();
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!isAuthLoading && !isSuperadmin) setLocation("/analysis");
  }, [isAuthLoading, isSuperadmin, setLocation]);

  const { data, isLoading, error } = useQuery<SuperadminSessionRow[]>({
    queryKey: ["superadmin", "sessions"],
    queryFn: fetchSuperadminSessions,
    enabled: isSuperadmin,
    staleTime: 60 * 1000,
  });

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return data;
    return data.filter(
      (r) =>
        (r.ownerEmail ?? "").toLowerCase().includes(needle) ||
        (r.fileName ?? "").toLowerCase().includes(needle)
    );
  }, [data, filter]);

  if (isAuthLoading || !isSuperadmin) return null;

  return (
    <div className="container mx-auto py-6 px-4 sm:px-6 max-w-7xl">
      <div className="mb-4 flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by user email or dataset…"
            className="w-full pl-8 pr-3 py-2 rounded-brand-md border border-border/60 bg-card text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
          />
        </div>
        <span className="text-xs text-muted-foreground">
          {filtered.length} {filtered.length === 1 ? "session" : "sessions"}
        </span>
      </div>

      {error ? (
        <Card className="p-6 border-destructive/40 bg-destructive/5">
          <p className="text-sm text-destructive">
            Couldn't load sessions. Refresh the page or check the server logs.
          </p>
        </Card>
      ) : isLoading ? (
        <Card className="p-6 border-border/60 bg-card">
          <p className="text-sm text-muted-foreground">Loading sessions…</p>
        </Card>
      ) : filtered.length === 0 ? (
        <Card className="p-6 border-border/60 bg-card">
          <p className="text-sm text-muted-foreground">
            No sessions match the current filter.
          </p>
        </Card>
      ) : (
        <Card className="border-border/60 bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 border-b border-border/60">
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">User</th>
                  <th className="px-3 py-2 font-medium">Dataset</th>
                  <th className="px-3 py-2 font-medium">Last activity</th>
                  <th className="px-3 py-2 font-medium text-right">Msgs</th>
                  <th className="px-3 py-2 font-medium">Feedback</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr
                    key={row.sessionId}
                    className="border-b border-border/40 hover:bg-muted/20 transition"
                  >
                    <td className="px-3 py-2 text-foreground font-mono text-xs">
                      {row.ownerEmail ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-foreground">
                      {row.fileName ?? <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {fmtRelativeOrISO(row.lastUpdatedAt ?? row.createdAt)}
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground">
                      {row.messageCount}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600 dark:text-emerald-400">
                          <ThumbsUp className="h-3 w-3" /> {row.feedbackCounts.up}
                        </span>
                        <span
                          className={
                            row.feedbackCounts.down > 0
                              ? "inline-flex items-center gap-1 rounded-full bg-destructive/10 px-1.5 py-0.5 text-destructive"
                              : "inline-flex items-center gap-1 rounded-full bg-muted/40 px-1.5 py-0.5 text-muted-foreground"
                          }
                        >
                          <ThumbsDown className="h-3 w-3" /> {row.feedbackCounts.down}
                        </span>
                        <span className="inline-flex items-center gap-1 rounded-full bg-muted/40 px-1.5 py-0.5 text-muted-foreground">
                          <Circle className="h-3 w-3" /> {row.feedbackCounts.none}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() =>
                          setLocation(`/superadmin/sessions/${row.sessionId}`)
                        }
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                      >
                        Open chat
                        <ExternalLink className="h-3 w-3" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
