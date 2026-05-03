/**
 * Read-only superadmin dashboard viewer. Fetches a dashboard via the
 * superadmin endpoint (bypasses collaborator check), renders the high-level
 * shape — name, owner, sheets/charts list. Full chart rendering reuses the
 * existing dashboard surface in a follow-up; for now this answers "what
 * dashboards exist" with enough detail for an admin pass.
 */

import { useEffect, useMemo } from "react";
import { useLocation, useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useSuperadmin } from "@/auth/useSuperadmin";
import { API_BASE_URL } from "@/lib/config";
import { getAuthorizationHeader } from "@/auth/msalToken";
import { getUserEmail } from "@/utils/userStorage";
import { Card } from "@/components/ui/card";
import { ShadowBanner } from "./ShadowBanner";

interface SuperadminDashboardDoc {
  id: string;
  username?: string;
  name?: string;
  sheets?: Array<{
    id: string;
    name: string;
    charts?: unknown[];
    tables?: unknown[];
  }>;
  charts?: unknown[];
}

async function fetchSuperadminDashboard(
  dashboardId: string
): Promise<SuperadminDashboardDoc> {
  const auth = await getAuthorizationHeader();
  const userEmail = getUserEmail();
  const res = await fetch(
    `${API_BASE_URL}/api/superadmin/dashboards/${encodeURIComponent(dashboardId)}`,
    {
      method: "GET",
      headers: {
        ...auth,
        ...(userEmail ? { "X-User-Email": userEmail } : {}),
      },
    }
  );
  if (!res.ok) throw new Error(`fetch dashboard ${dashboardId} failed (${res.status})`);
  const body = (await res.json()) as { dashboard: SuperadminDashboardDoc };
  return body.dashboard;
}

export default function SuperadminDashboardViewer() {
  const { isSuperadmin, isLoading: isAuthLoading } = useSuperadmin();
  const [, params] = useRoute<{ dashboardId: string }>(
    "/superadmin/dashboards/:dashboardId"
  );
  const [, setLocation] = useLocation();
  const dashboardId = params?.dashboardId ?? null;

  useEffect(() => {
    if (!isAuthLoading && !isSuperadmin) setLocation("/analysis");
  }, [isAuthLoading, isSuperadmin, setLocation]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["superadmin", "dashboard", dashboardId],
    queryFn: () => fetchSuperadminDashboard(dashboardId!),
    enabled: isSuperadmin && !!dashboardId,
    staleTime: 30 * 1000,
  });

  const sheets = useMemo(() => data?.sheets ?? [], [data]);

  if (isAuthLoading || !isSuperadmin || !dashboardId) return null;

  return (
    <div className="min-h-screen flex flex-col">
      <ShadowBanner ownerEmail={data?.username ?? null} />
      <div className="container mx-auto py-6 px-4 sm:px-6 max-w-5xl flex-1">
        {error ? (
          <Card className="p-6 border-destructive/40 bg-destructive/5">
            <p className="text-sm text-destructive">
              Couldn't load this dashboard.
            </p>
          </Card>
        ) : isLoading ? (
          <Card className="p-6 border-border/60 bg-card">
            <p className="text-sm text-muted-foreground">Loading dashboard…</p>
          </Card>
        ) : (
          <>
            <div className="mb-4">
              <h2 className="text-lg font-semibold text-foreground">
                {data?.name ?? "(untitled)"}
              </h2>
              <p className="text-xs text-muted-foreground mt-1">
                Owner:{" "}
                <span className="font-mono text-foreground">
                  {data?.username ?? "—"}
                </span>
              </p>
            </div>
            <div className="space-y-3">
              {sheets.length === 0 ? (
                <Card className="p-6 border-border/60 bg-card">
                  <p className="text-sm text-muted-foreground">
                    This dashboard has no sheets yet.
                  </p>
                </Card>
              ) : (
                sheets.map((sheet) => (
                  <Card
                    key={sheet.id}
                    className="p-4 border-border/60 bg-card"
                  >
                    <div className="text-sm font-medium text-foreground">
                      {sheet.name}
                    </div>
                    <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
                      <span>{sheet.charts?.length ?? 0} charts</span>
                      <span>{sheet.tables?.length ?? 0} tables</span>
                    </div>
                  </Card>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
