/**
 * Superadmin dashboards table — every dashboard across every user. Optional
 * `?owner=<email>` query param filters to a single user (used by the sessions
 * page's "User dashboards" chip in a follow-up).
 */

import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Search } from "lucide-react";
import { useSuperadmin } from "@/auth/useSuperadmin";
import {
  fetchSuperadminDashboards,
  type SuperadminDashboardRow,
} from "@/lib/api/superadmin";
import { Card } from "@/components/ui/card";

function fmtDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

export default function SuperadminDashboardsPage() {
  const { isSuperadmin, isLoading: isAuthLoading } = useSuperadmin();
  const [, setLocation] = useLocation();
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!isAuthLoading && !isSuperadmin) setLocation("/analysis");
  }, [isAuthLoading, isSuperadmin, setLocation]);

  const { data, isLoading, error } = useQuery<SuperadminDashboardRow[]>({
    queryKey: ["superadmin", "dashboards"],
    queryFn: fetchSuperadminDashboards,
    enabled: isSuperadmin,
    staleTime: 60 * 1000,
  });

  const ownerFromQuery = useMemo(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    return params.get("owner");
  }, []);

  const filtered = useMemo(() => {
    if (!data) return [];
    let rows = data;
    if (ownerFromQuery) {
      rows = rows.filter((r) => r.ownerEmail === ownerFromQuery);
    }
    const needle = filter.trim().toLowerCase();
    if (needle) {
      rows = rows.filter(
        (r) =>
          (r.ownerEmail ?? "").toLowerCase().includes(needle) ||
          (r.name ?? "").toLowerCase().includes(needle)
      );
    }
    return rows;
  }, [data, filter, ownerFromQuery]);

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
            placeholder="Filter by user email or dashboard name…"
            className="w-full pl-8 pr-3 py-2 rounded-brand-md border border-border/60 bg-card text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
          />
        </div>
        {ownerFromQuery && (
          <span className="text-xs text-muted-foreground">
            owner: <span className="font-mono text-foreground">{ownerFromQuery}</span>
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          {filtered.length} {filtered.length === 1 ? "dashboard" : "dashboards"}
        </span>
      </div>

      {error ? (
        <Card className="p-6 border-destructive/40 bg-destructive/5">
          <p className="text-sm text-destructive">Couldn't load dashboards.</p>
        </Card>
      ) : isLoading ? (
        <Card className="p-6 border-border/60 bg-card">
          <p className="text-sm text-muted-foreground">Loading dashboards…</p>
        </Card>
      ) : filtered.length === 0 ? (
        <Card className="p-6 border-border/60 bg-card">
          <p className="text-sm text-muted-foreground">
            No dashboards match the current filter.
          </p>
        </Card>
      ) : (
        <Card className="border-border/60 bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 border-b border-border/60">
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2 font-medium">User</th>
                  <th className="px-3 py-2 font-medium">Dashboard</th>
                  <th className="px-3 py-2 font-medium">Updated</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr
                    key={row.dashboardId}
                    className="border-b border-border/40 hover:bg-muted/20 transition"
                  >
                    <td className="px-3 py-2 text-foreground font-mono text-xs">
                      {row.ownerEmail ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-foreground">{row.name}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {fmtDate(row.updatedAt ?? row.createdAt)}
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() =>
                          setLocation(
                            `/superadmin/dashboards/${row.dashboardId}`
                          )
                        }
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                      >
                        Open
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
