/**
 * W61-detail · Admin · Per-session semantic-model viewer.
 *
 * Read-only render of the auto-inferred metrics, dimensions, and
 * hierarchies on a single session's `ChatDocument.semanticModel`. The
 * follow-on W61-save wave will add inline edit forms + a PATCH endpoint.
 *
 * Why structural React rendering rather than passing
 * `formatMetricCatalog`'s markdown string into `react-markdown`: the
 * client doesn't depend on `react-markdown`, the structural render
 * gives richer typography (`tabular-nums` for counts, `<code>` for
 * snake-case identifiers, monospace expressions, per-section headings),
 * and the planner-side manifest stays exact-byte for prompt-cache hits.
 * The duplication is real but small (3 column tables vs the manifest's
 * 4 line shapes per entry) and well-contained.
 */

import { useEffect, useState } from "react";
import { useRoute, useLocation } from "wouter";
import {
  fetchSemanticModelDetail,
  type AdminSemanticModelDetail,
} from "@/lib/api/admin";
import type {
  SemanticDimension,
  SemanticHierarchy,
  SemanticMetric,
} from "@/shared/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AdminNav } from "../Superadmin/AdminNav";

function formatRelative(ms: number): string {
  if (!ms) return "—";
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  if (delta < 3600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86400_000) return `${Math.round(delta / 3600_000)}h ago`;
  return `${Math.round(delta / 86400_000)}d ago`;
}

function formatHint(m: SemanticMetric): string {
  const parts: string[] = [m.format];
  if (m.format === "currency" && m.currencyCode) {
    parts[0] = `currency (${m.currencyCode})`;
  }
  if (m.decimals !== undefined) {
    parts.push(`${m.decimals} dp`);
  }
  return parts.join(", ");
}

function MetricRow({ m }: { m: SemanticMetric }) {
  return (
    <tr className="border-t border-border align-top hover:bg-muted/10 transition-colors">
      <td className="py-3 px-4">
        <div className="font-mono text-sm text-foreground">{m.name}</div>
        <div className="text-xs text-muted-foreground">{m.label}</div>
        {m.description ? (
          <div className="text-xs text-muted-foreground mt-1 italic">
            {m.description}
          </div>
        ) : null}
      </td>
      <td className="py-3 px-4">
        <code className="text-xs bg-muted/40 px-1.5 py-0.5 rounded">
          {m.expression}
        </code>
      </td>
      <td className="py-3 px-4 text-xs text-muted-foreground">
        {formatHint(m)}
      </td>
      <td className="py-3 px-4 text-xs text-muted-foreground">
        {m.references.length === 0 ? "—" : m.references.join(", ")}
      </td>
      <td className="py-3 px-4 text-xs">
        <span
          className={
            m.exposed
              ? "px-2 py-0.5 rounded-full bg-primary/15 text-primary font-medium"
              : "px-2 py-0.5 rounded-full bg-muted text-muted-foreground"
          }
        >
          {m.exposed ? "exposed" : "hidden"}
        </span>
      </td>
    </tr>
  );
}

function DimensionRow({ d }: { d: SemanticDimension }) {
  return (
    <tr className="border-t border-border align-top hover:bg-muted/10 transition-colors">
      <td className="py-3 px-4">
        <div className="font-mono text-sm text-foreground">{d.name}</div>
        <div className="text-xs text-muted-foreground">{d.label}</div>
        {d.description ? (
          <div className="text-xs text-muted-foreground mt-1 italic">
            {d.description}
          </div>
        ) : null}
      </td>
      <td className="py-3 px-4 font-mono text-xs text-muted-foreground">
        {d.column}
      </td>
      <td className="py-3 px-4 text-xs text-muted-foreground">
        {d.kind}
        {d.kind === "temporal" && d.temporalGrain
          ? ` (${d.temporalGrain})`
          : ""}
      </td>
      <td className="py-3 px-4 text-xs">
        <span
          className={
            d.exposed
              ? "px-2 py-0.5 rounded-full bg-primary/15 text-primary font-medium"
              : "px-2 py-0.5 rounded-full bg-muted text-muted-foreground"
          }
        >
          {d.exposed ? "exposed" : "hidden"}
        </span>
      </td>
    </tr>
  );
}

function HierarchyRow({ h }: { h: SemanticHierarchy }) {
  return (
    <tr className="border-t border-border align-top hover:bg-muted/10 transition-colors">
      <td className="py-3 px-4">
        <div className="font-mono text-sm text-foreground">{h.name}</div>
        <div className="text-xs text-muted-foreground">{h.label}</div>
        {h.description ? (
          <div className="text-xs text-muted-foreground mt-1 italic">
            {h.description}
          </div>
        ) : null}
      </td>
      <td className="py-3 px-4 text-xs text-muted-foreground">
        {h.levels.join(" → ")}
      </td>
    </tr>
  );
}

export default function AdminSemanticModelDetail() {
  const [, params] = useRoute<{ sessionId: string }>(
    "/admin/semantic-models/:sessionId",
  );
  const [, setLocation] = useLocation();
  const sessionId = params?.sessionId ?? "";
  const [data, setData] = useState<AdminSemanticModelDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchSemanticModelDetail(sessionId)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (loading && !data) {
    return (
      <>
        <AdminNav />
        <div
          className="p-6 text-muted-foreground"
          data-testid="admin-semantic-model-detail-loading"
        >
          Loading semantic model for {sessionId}…
        </div>
      </>
    );
  }

  if (error) {
    const isForbidden = /\b403\b/.test(error);
    const isNotFound = /\b404\b/.test(error);
    return (
      <>
        <AdminNav />
        <div className="p-6">
          <Card className="p-6 border-destructive/30">
            <h2 className="text-lg font-semibold text-foreground mb-2">
              {isForbidden
                ? "Not authorized"
                : isNotFound
                ? "Semantic model not found"
                : "Failed to load semantic model"}
            </h2>
            <p className="text-sm text-muted-foreground mb-4">
              {isForbidden
                ? "Your account isn't on the admin allow-list."
                : isNotFound
                ? "Either the session id is invalid, or this session pre-dates the W57 inference pipeline and has no semantic model."
                : error}
            </p>
            <Button
              onClick={() => setLocation("/admin/semantic-models")}
              variant="outline"
            >
              Back to index
            </Button>
          </Card>
        </div>
      </>
    );
  }

  if (!data) return null;

  const { model } = data;
  const totalDeclarations =
    model.metrics.length + model.dimensions.length + model.hierarchies.length;

  return (
    <>
      <AdminNav />
      <div className="p-6 space-y-6 max-w-7xl mx-auto">
        <header className="space-y-2">
          <Button
            onClick={() => setLocation("/admin/semantic-models")}
            variant="ghost"
            size="sm"
            className="text-muted-foreground -ml-2"
          >
            ← Back to index
          </Button>
          <div className="flex items-baseline justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-2xl font-semibold text-foreground">
                {model.name}
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Session{" "}
                <span className="font-mono">{data.sessionId}</span> ·{" "}
                {data.fileName || "(unnamed dataset)"} · owned by{" "}
                {data.username || "(unknown)"}
              </p>
            </div>
            <div className="text-xs text-muted-foreground">
              v{model.version} · session last updated{" "}
              {formatRelative(data.lastUpdatedAt)}
              {model.updatedBy ? (
                <div>
                  Model last edited by {model.updatedBy}
                  {model.updatedAt
                    ? ` at ${new Date(model.updatedAt).toLocaleString()}`
                    : ""}
                </div>
              ) : (
                <div>Auto-inferred (never manually edited)</div>
              )}
            </div>
          </div>
        </header>

        {totalDeclarations === 0 ? (
          <Card className="p-6 border-border/50">
            <p className="text-sm text-muted-foreground">
              The model has no declared metrics, dimensions, or hierarchies.
              The planner will fall back to raw{" "}
              <code className="bg-muted/40 px-1 rounded">
                execute_query_plan
              </code>{" "}
              against the dataset schema.
            </p>
          </Card>
        ) : null}

        <Card className="p-0 overflow-hidden">
          <header className="px-4 py-3 border-b border-border flex items-baseline justify-between">
            <h2 className="text-base font-semibold text-foreground">
              Metrics
            </h2>
            <span className="text-xs text-muted-foreground tabular-nums">
              {model.metrics.length}
            </span>
          </header>
          {model.metrics.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              No metrics declared.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/30">
                  <tr className="text-left text-muted-foreground">
                    <th className="py-3 px-4">Name</th>
                    <th className="py-3 px-4">Expression</th>
                    <th className="py-3 px-4">Format</th>
                    <th className="py-3 px-4">References</th>
                    <th className="py-3 px-4">Exposed</th>
                  </tr>
                </thead>
                <tbody>
                  {[...model.metrics]
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((m) => (
                      <MetricRow key={m.name} m={m} />
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card className="p-0 overflow-hidden">
          <header className="px-4 py-3 border-b border-border flex items-baseline justify-between">
            <h2 className="text-base font-semibold text-foreground">
              Dimensions
            </h2>
            <span className="text-xs text-muted-foreground tabular-nums">
              {model.dimensions.length}
            </span>
          </header>
          {model.dimensions.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              No dimensions declared.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/30">
                  <tr className="text-left text-muted-foreground">
                    <th className="py-3 px-4">Name</th>
                    <th className="py-3 px-4">Column</th>
                    <th className="py-3 px-4">Kind</th>
                    <th className="py-3 px-4">Exposed</th>
                  </tr>
                </thead>
                <tbody>
                  {[...model.dimensions]
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((d) => (
                      <DimensionRow key={d.name} d={d} />
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card className="p-0 overflow-hidden">
          <header className="px-4 py-3 border-b border-border flex items-baseline justify-between">
            <h2 className="text-base font-semibold text-foreground">
              Hierarchies
            </h2>
            <span className="text-xs text-muted-foreground tabular-nums">
              {model.hierarchies.length}
            </span>
          </header>
          {model.hierarchies.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              No hierarchies declared.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/30">
                  <tr className="text-left text-muted-foreground">
                    <th className="py-3 px-4">Name</th>
                    <th className="py-3 px-4">Levels (top → bottom)</th>
                  </tr>
                </thead>
                <tbody>
                  {[...model.hierarchies]
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((h) => (
                      <HierarchyRow key={h.name} h={h} />
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
