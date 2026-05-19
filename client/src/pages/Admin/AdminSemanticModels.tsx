/**
 * W61-list · Admin · Semantic models index.
 *
 * Renders every session whose `ChatDocument.semanticModel` is defined
 * as a clickable row in a table. The detail / edit pages (W61-detail,
 * W61-save) are reachable by clicking through; for this wave the rows
 * are read-only links that surface the counts + last-edit metadata.
 *
 * Mirrors `AdminContextPacks.tsx` for layout, loading / error / 403
 * states, AdminNav placement, and refresh affordance.
 */

import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  fetchSemanticModels,
  type AdminSemanticModelListEntry,
  type AdminSemanticModelListSnapshot,
} from "@/lib/api/admin";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AdminNav } from "../Superadmin/AdminNav";

function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}

function formatRelative(ms: number): string {
  if (!ms) return "—";
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  if (delta < 3600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86400_000) return `${Math.round(delta / 3600_000)}h ago`;
  const days = Math.round(delta / 86400_000);
  return `${days}d ago`;
}

function totalDeclarations(e: AdminSemanticModelListEntry): number {
  return e.metricsCount + e.dimensionsCount + e.hierarchiesCount;
}

export default function AdminSemanticModels() {
  const [, setLocation] = useLocation();
  const [data, setData] = useState<AdminSemanticModelListSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const snap = await fetchSemanticModels();
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
      <>
        <AdminNav />
        <div
          className="p-6 text-muted-foreground"
          data-testid="admin-semantic-models-loading"
        >
          Loading semantic models…
        </div>
      </>
    );
  }

  if (error) {
    const isForbidden = /\b403\b/.test(error);
    return (
      <>
        <AdminNav />
        <div className="p-6">
          <Card className="p-6 border-destructive/30">
            <h2 className="text-lg font-semibold text-foreground mb-2">
              {isForbidden
                ? "Not authorized"
                : "Failed to load semantic models"}
            </h2>
            <p className="text-sm text-muted-foreground mb-4">
              {isForbidden
                ? "Your account isn't on the admin allow-list."
                : error}
            </p>
            <Button onClick={() => void load()} variant="outline">
              Retry
            </Button>
          </Card>
        </div>
      </>
    );
  }

  if (!data) return null;

  const totalSessions = data.sessions.length;
  const totalMetrics = data.sessions.reduce((s, e) => s + e.metricsCount, 0);
  const totalDimensions = data.sessions.reduce(
    (s, e) => s + e.dimensionsCount,
    0,
  );

  return (
    <>
      <AdminNav />
      <div className="p-6 space-y-6 max-w-7xl mx-auto">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">
              Semantic models
            </h1>
            <p className="text-sm text-muted-foreground">
              Auto-inferred at upload (W57). Click a session to review or
              edit its metrics, dimensions, and hierarchies.
            </p>
          </div>
          <Button
            onClick={() => void load()}
            variant="outline"
            size="sm"
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </header>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Card className="p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wide">
              Sessions
            </div>
            <div className="text-2xl font-semibold text-foreground mt-1">
              {formatInt(totalSessions)}
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wide">
              Metrics across all models
            </div>
            <div className="text-2xl font-semibold text-foreground mt-1">
              {formatInt(totalMetrics)}
            </div>
          </Card>
          <Card className="p-4">
            <div className="text-xs text-muted-foreground uppercase tracking-wide">
              Dimensions across all models
            </div>
            <div className="text-2xl font-semibold text-foreground mt-1">
              {formatInt(totalDimensions)}
            </div>
          </Card>
        </div>

        {totalSessions === 0 ? (
          <Card className="p-6 border-border/50">
            <p className="text-sm text-muted-foreground">
              No sessions have a semantic model yet. Models are inferred
              automatically at upload (W57); existing sessions persisted
              before W57 won't appear here.
            </p>
          </Card>
        ) : (
          <Card className="p-0 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/30">
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="py-3 px-4">Session</th>
                    <th className="py-3 px-4">Model</th>
                    <th className="py-3 px-4 text-right">Metrics</th>
                    <th className="py-3 px-4 text-right">Dimensions</th>
                    <th className="py-3 px-4 text-right">Hierarchies</th>
                    <th className="py-3 px-4">Owner</th>
                    <th className="py-3 px-4">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sessions.map((s) => (
                    <tr
                      key={s.id}
                      className="border-t border-border align-top hover:bg-muted/20 transition-colors cursor-pointer"
                      data-testid={`admin-semantic-model-row-${s.sessionId}`}
                      onClick={() =>
                        setLocation(
                          `/admin/semantic-models/${encodeURIComponent(
                            s.sessionId,
                          )}`,
                        )
                      }
                    >
                      <td className="py-3 px-4">
                        <div className="font-medium text-foreground">
                          {s.fileName || "(unnamed dataset)"}
                        </div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {s.sessionId}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-foreground">
                          {s.modelName}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          v{s.version}
                          {totalDeclarations(s) === 0
                            ? " · empty model"
                            : ""}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right tabular-nums">
                        {formatInt(s.metricsCount)}
                      </td>
                      <td className="py-3 px-4 text-right tabular-nums">
                        {formatInt(s.dimensionsCount)}
                      </td>
                      <td className="py-3 px-4 text-right tabular-nums">
                        {formatInt(s.hierarchiesCount)}
                      </td>
                      <td className="py-3 px-4 text-muted-foreground">
                        {s.username}
                      </td>
                      <td className="py-3 px-4 text-muted-foreground">
                        {formatRelative(s.lastUpdatedAt)}
                        {s.modelUpdatedBy ? (
                          <div className="text-xs">
                            by {s.modelUpdatedBy}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
