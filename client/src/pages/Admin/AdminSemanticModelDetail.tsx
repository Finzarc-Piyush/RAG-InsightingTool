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
  patchSemanticModel,
  type AdminSemanticModelDetail,
} from "@/lib/api/admin";
import type {
  SemanticDimension,
  SemanticHierarchy,
  SemanticMetric,
  SemanticModel,
} from "@/shared/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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

interface ExposedToggleProps {
  exposed: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
}

function ExposedToggle({
  exposed,
  disabled,
  onChange,
  ariaLabel,
}: ExposedToggleProps) {
  return (
    <Switch
      checked={exposed}
      disabled={disabled}
      onCheckedChange={onChange}
      aria-label={ariaLabel}
    />
  );
}

function MetricRow({
  m,
  saving,
  onToggleExposed,
}: {
  m: SemanticMetric;
  saving: boolean;
  onToggleExposed: (next: boolean) => void;
}) {
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
      <td className="py-3 px-4">
        <ExposedToggle
          exposed={m.exposed}
          disabled={saving}
          onChange={onToggleExposed}
          ariaLabel={`Toggle ${m.label} exposed`}
        />
      </td>
    </tr>
  );
}

function DimensionRow({
  d,
  saving,
  onToggleExposed,
}: {
  d: SemanticDimension;
  saving: boolean;
  onToggleExposed: (next: boolean) => void;
}) {
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
      <td className="py-3 px-4">
        <ExposedToggle
          exposed={d.exposed}
          disabled={saving}
          onChange={onToggleExposed}
          ariaLabel={`Toggle ${d.label} exposed`}
        />
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
  // Wave W61-save · saving status surfaces a banner + disables every
  // toggle while a PATCH is in flight. A single shared flag is cheaper
  // than per-row state and matches "auto-save on toggle" UX (the user
  // shouldn't fire two PATCHes at once anyway since the second would
  // race the first's response into the cache).
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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

  async function persistModel(nextModel: SemanticModel): Promise<void> {
    if (!data) return;
    // Optimistic update so the toggle responds instantly.
    const prior = data;
    setData({ ...prior, model: nextModel });
    setSaving(true);
    setSaveError(null);
    try {
      const res = await patchSemanticModel(sessionId, nextModel);
      // Reconcile with the server's authoritative view (version bump,
      // updatedAt / updatedBy stamping that the server controls).
      setData({
        ...prior,
        lastUpdatedAt: res.lastUpdatedAt,
        model: res.model,
      });
    } catch (err) {
      // Roll back the optimistic toggle.
      setData(prior);
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function handleToggleMetricExposed(metricName: string, next: boolean): void {
    if (!data) return;
    const nextModel: SemanticModel = {
      ...data.model,
      metrics: data.model.metrics.map((m) =>
        m.name === metricName ? { ...m, exposed: next } : m,
      ),
    };
    void persistModel(nextModel);
  }

  function handleToggleDimensionExposed(
    dimensionName: string,
    next: boolean,
  ): void {
    if (!data) return;
    const nextModel: SemanticModel = {
      ...data.model,
      dimensions: data.model.dimensions.map((d) =>
        d.name === dimensionName ? { ...d, exposed: next } : d,
      ),
    };
    void persistModel(nextModel);
  }

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

        {saving ? (
          <Card className="p-3 border-primary/30 bg-primary/5 text-sm text-foreground">
            Saving…
          </Card>
        ) : null}
        {saveError ? (
          <Card className="p-3 border-destructive/30 bg-destructive/5 text-sm text-destructive">
            Save failed: {saveError}. Change rolled back; try again.
          </Card>
        ) : null}

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
                      <MetricRow
                        key={m.name}
                        m={m}
                        saving={saving}
                        onToggleExposed={(next) =>
                          handleToggleMetricExposed(m.name, next)
                        }
                      />
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
                      <DimensionRow
                        key={d.name}
                        d={d}
                        saving={saving}
                        onToggleExposed={(next) =>
                          handleToggleDimensionExposed(d.name, next)
                        }
                      />
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
