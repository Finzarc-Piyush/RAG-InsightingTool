/**
 * W61-detail · Admin · Per-session semantic-model viewer.
 *
 * Renders the auto-inferred metrics, dimensions, and hierarchies on a
 * single session's `ChatDocument.semanticModel`. Inline editing is
 * owned by the three sibling Card components
 * (`MetricsCard` / `DimensionsCard` / `HierarchiesCard`) extracted in
 * W61-host-extract; this file owns the data fetch, the save / revert /
 * delete / add / hierarchy-edit lifecycle handlers, and the modal
 * mount points (`<DeleteEntryConfirmation>` / `<AddEntryForm>` /
 * `<HierarchyEditor>`).
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
  addSemanticModelEntry,
  deleteSemanticModelEntry,
  fetchSemanticModelAuditLog,
  fetchSemanticModelDetail,
  NameAlreadyExistsError,
  patchSemanticModel,
  revertSemanticModel,
  type AdminSemanticModelAuditEntry,
  type AdminSemanticModelAuditLog,
  type AdminSemanticModelDetail,
  type AdminSemanticModelEntryKind,
} from "@/lib/api/admin";
import type {
  SemanticDimension,
  SemanticHierarchy,
  SemanticMetric,
  SemanticModel,
} from "@/shared/schema";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AdminNav } from "../Superadmin/AdminNav";
import {
  readFilterFromSearch,
  writeFilterToSearch,
} from "./lib/semanticModelFilterUrlSync";
import { buildRevertConfirmation } from "./lib/semanticModelAuditHistory";
import type { SemanticEntryFilter } from "./lib/semanticModelSourceFilter";
import { AuditHistoryCard } from "./components/AuditHistoryCard";
import { DeleteEntryConfirmation } from "./components/DeleteEntryConfirmation";
import { AddEntryForm } from "./components/AddEntryForm";
import { HierarchyEditor } from "./components/HierarchyEditor";
import { MetricsCard } from "./components/MetricsCard";
import {
  DimensionsCard,
  TEMPORAL_GRAIN_AUTO,
} from "./components/DimensionsCard";
import { HierarchiesCard } from "./components/HierarchiesCard";

function formatRelative(ms: number): string {
  if (!ms) return "—";
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  if (delta < 3600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86400_000) return `${Math.round(delta / 3600_000)}h ago`;
  return `${Math.round(delta / 86400_000)}d ago`;
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
  // Wave W61-source-filter · one global filter across metrics +
  // dimensions + hierarchies. Most-common workflow is "show me what
  // I edited" applied uniformly across all three sections; a per-card
  // filter would force three clicks for the same effect.
  //
  // Wave W61-filter-persist · the initial state reads from
  // `?filter=X` so a share-link or accidental-reload preserves the
  // active chip. The `useState` lazy initializer runs once on mount;
  // a downstream `useEffect` keeps the URL in sync on every change.
  const [sourceFilter, setSourceFilter] = useState<SemanticEntryFilter>(() =>
    typeof window === "undefined"
      ? "all"
      : readFilterFromSearch(window.location.search),
  );

  // Wave W61-audit-history-tab · collapsible "Audit history" section
  // state. Closed by default so the buffer fetch is opt-in — most
  // detail-page visits never open it. A single global `reverting`
  // index lets the per-row Revert buttons show in-flight state on
  // just the clicked row; other rows remain readable / clickable.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLog, setHistoryLog] = useState<AdminSemanticModelAuditLog | null>(
    null,
  );
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [reverting, setReverting] = useState<number | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);

  // Wave W61-delete-client · per-row delete state. `pendingDelete` is
  // the modal's open-or-closed signal — a non-null value renders the
  // confirmation modal, which in turn fetches the W61-references
  // count. `deletingEntry` is the in-flight mutation state (set while
  // the DELETE round-trip is pending) — disables every Delete button
  // to prevent the admin queueing up overlapping destructive ops.
  // A single `deleteError` slot scopes the failure to the modal body
  // rather than a page-level banner, matching the
  // `AlertDialogDescription` rendering shape.
  const [pendingDelete, setPendingDelete] = useState<{
    kind: AdminSemanticModelEntryKind;
    name: string;
  } | null>(null);
  const [deletingEntry, setDeletingEntry] = useState<{
    kind: AdminSemanticModelEntryKind;
    name: string;
  } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Wave W61-add-client · per-card add-entry state. `addOpen` is the
  // modal's open-or-closed signal — a non-null value renders the
  // AddEntryForm dialog for the matching kind. `addSubmitting` is the
  // in-flight mutation state (set while the POST round-trip is
  // pending). `addError` / `addNameCollision` scope failure surfaces
  // to the modal body — collision is the typed 409 case (rendered
  // inline under the name field by the form), generic submit error is
  // any other non-2xx.
  const [addOpen, setAddOpen] = useState<AdminSemanticModelEntryKind | null>(
    null,
  );
  const [addSubmitting, setAddSubmitting] =
    useState<AdminSemanticModelEntryKind | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [addNameCollision, setAddNameCollision] = useState<{
    kind: AdminSemanticModelEntryKind;
    name: string;
  } | null>(null);

  // Wave W61-hierarchy-edit · per-hierarchy levels-edit state.
  // `editingHierarchy` is the modal's open-signal — a non-null value
  // renders the HierarchyEditor modal with that hierarchy's levels
  // seeded into the draft. `editLevelsSubmitting` is the in-flight
  // flag (the hierarchy's `name` while the PATCH round-trip is
  // pending — same shape as `deletingEntry` so the row's per-mutation
  // gate doesn't conflict with other write mutations); `editLevelsError`
  // scopes the failure surface to the modal body.
  const [editingHierarchy, setEditingHierarchy] =
    useState<SemanticHierarchy | null>(null);
  const [editLevelsSubmitting, setEditLevelsSubmitting] =
    useState<string | null>(null);
  const [editLevelsError, setEditLevelsError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const nextSearch = writeFilterToSearch(
      window.location.search,
      sourceFilter,
    );
    const nextUrl =
      window.location.pathname +
      (nextSearch ? "?" + nextSearch : "") +
      window.location.hash;
    // `replaceState` rather than `pushState` so each chip click
    // doesn't accumulate a browser history entry — back-button
    // behaviour stays predictable (one entry per page visit, not
    // one per filter toggle).
    window.history.replaceState(window.history.state, "", nextUrl);
  }, [sourceFilter]);

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

  // Wave W61-audit-history-tab · fetch the prior-model ring buffer
  // when the admin opens the section, AND re-fetch whenever the
  // parent doc's `lastUpdatedAt` bumps (which happens on save or
  // revert — both grow the buffer by one entry, so the open list
  // would otherwise show stale state). Gated by `historyOpen` so
  // closed-section visits never pay the Cosmos round-trip.
  const lastUpdatedAt = data?.lastUpdatedAt;
  useEffect(() => {
    if (!sessionId || !historyOpen) return;
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError(null);
    fetchSemanticModelAuditLog(sessionId)
      .then((log) => {
        if (!cancelled) setHistoryLog(log);
      })
      .catch((err) => {
        if (!cancelled) {
          setHistoryError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, historyOpen, lastUpdatedAt]);

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

  /**
   * W61-edit-text · One handler per (entity, text-field) — keeps the
   * patch shape narrow so the optimistic update touches only the
   * edited cell. Description sets to `undefined` rather than the
   * empty string so the round-trip matches the zod schema's
   * `.optional()` (empty strings would re-emit on the server and
   * subtly drift the doc shape).
   */
  function patchMetric(
    metricName: string,
    patch: Partial<SemanticMetric>,
  ): void {
    if (!data) return;
    const nextModel: SemanticModel = {
      ...data.model,
      metrics: data.model.metrics.map((m) =>
        m.name === metricName ? { ...m, ...patch } : m,
      ),
    };
    void persistModel(nextModel);
  }

  function patchDimension(
    dimensionName: string,
    patch: Partial<SemanticDimension>,
  ): void {
    if (!data) return;
    const nextModel: SemanticModel = {
      ...data.model,
      dimensions: data.model.dimensions.map((d) =>
        d.name === dimensionName ? { ...d, ...patch } : d,
      ),
    };
    void persistModel(nextModel);
  }

  function emptyToUndef(s: string): string | undefined {
    const trimmed = s.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }

  /**
   * W61-edit-enums · clears `currencyCode` when the admin switches
   * away from `format: "currency"` — the field is meaningless without
   * the currency format, and leaving the stale code would surface in
   * the planner manifest as a misleading "(USD)" hint on a percent or
   * ratio metric. Server's `safeParse` doesn't strip it on its own.
   */
  function handleMetricFormatChange(
    metricName: string,
    nextFormat: SemanticMetric["format"],
  ): void {
    const patch: Partial<SemanticMetric> = { format: nextFormat };
    if (nextFormat !== "currency") {
      patch.currencyCode = undefined;
    }
    patchMetric(metricName, patch);
  }

  /**
   * W61-edit-enums · clears `temporalGrain` when the admin switches
   * away from `kind: "temporal"` — the grain only makes sense paired
   * with a temporal dimension, and a stale grain on a `categorical`
   * dimension would confuse the planner. The agent's
   * `temporalFacetColumns` derivation is the fallback when grain is
   * undefined and the kind IS temporal.
   */
  function handleDimensionKindChange(
    dimensionName: string,
    nextKind: SemanticDimension["kind"],
  ): void {
    const patch: Partial<SemanticDimension> = { kind: nextKind };
    if (nextKind !== "temporal") {
      patch.temporalGrain = undefined;
    }
    patchDimension(dimensionName, patch);
  }

  /**
   * W61-edit-enums · the `__auto__` sentinel from `TEMPORAL_GRAIN_OPTIONS`
   * maps to `undefined` at the save boundary; any concrete grain
   * (day / week / month / quarter / year) flows through as-is.
   */
  function handleTemporalGrainChange(
    dimensionName: string,
    nextGrain: string,
  ): void {
    const grain =
      nextGrain === TEMPORAL_GRAIN_AUTO
        ? undefined
        : (nextGrain as SemanticDimension["temporalGrain"]);
    patchDimension(dimensionName, { temporalGrain: grain });
  }

  /**
   * W61-audit-history-tab · revert affordance for a single audit
   * entry. The 0-based `indexFromNewest` matches the buffer's
   * newest-first ordering (so `0` is "undo my last save"). On success
   * we update `data` with the response envelope (byte-identical to
   * the W61-save shape — see `revertSemanticModel` in admin.ts); the
   * `data.lastUpdatedAt` bump triggers the audit-log re-fetch
   * effect above, which re-reads the now-grown buffer (the prior
   * current model was appended by the server's revert handler).
   */
  async function handleRevert(
    entry: AdminSemanticModelAuditEntry,
    indexFromNewest: number,
    total: number,
  ): Promise<void> {
    if (!data || reverting !== null) return;
    const prompt = buildRevertConfirmation(entry, indexFromNewest, total);
    if (typeof window !== "undefined" && !window.confirm(prompt)) return;
    setReverting(indexFromNewest);
    setRevertError(null);
    try {
      const res = await revertSemanticModel(sessionId, indexFromNewest);
      setData({
        ...data,
        lastUpdatedAt: res.lastUpdatedAt,
        model: res.model,
      });
    } catch (err) {
      setRevertError(err instanceof Error ? err.message : String(err));
    } finally {
      setReverting(null);
    }
  }

  /**
   * W61-delete-client · destructive op that removes a single entry
   * from the model. Mirrors the W61-audit-revert handler shape: a
   * single global in-flight flag (`deletingEntry`) prevents overlap;
   * the server returns the W61-save envelope so the success branch
   * reuses the same `setData` shape as PATCH / revert.
   *
   * The `data.lastUpdatedAt` bump triggers the audit-history-tab's
   * re-fetch effect — which is load-bearing, because the server
   * snapshotted the pre-delete model into the audit log so "undo
   * this delete via revert" works (per the W61 destructive-op +
   * audit-write-before-mutation convention).
   *
   * On success the modal is closed via `setPendingDelete(null)`;
   * on failure it stays open with `deleteError` populated so the
   * admin can read the error and either retry or cancel.
   */
  async function handleDelete(
    kind: AdminSemanticModelEntryKind,
    name: string,
  ): Promise<void> {
    if (!data || deletingEntry !== null) return;
    setDeletingEntry({ kind, name });
    setDeleteError(null);
    try {
      const res = await deleteSemanticModelEntry(sessionId, kind, name);
      setData({
        ...data,
        lastUpdatedAt: res.lastUpdatedAt,
        model: res.model,
      });
      setPendingDelete(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingEntry(null);
    }
  }

  /**
   * W61-add-client · additive op that appends a single new entry to
   * the model. Mirrors the W61-delete-client handler shape: a single
   * global in-flight flag (`addSubmitting`) prevents overlap; the
   * server returns the W61-save envelope so the success branch reuses
   * the same `setData` shape as PATCH / revert / delete.
   *
   * On 409 (name collision per kind) the typed
   * `NameAlreadyExistsError` is caught via `instanceof` and surfaces
   * inline under the modal's name field via `setAddNameCollision`.
   * Generic non-2xx surfaces via `setAddError` at the bottom of the
   * modal body. On success the modal is closed via `setAddOpen(null)`
   * and the `data.lastUpdatedAt` bump triggers the audit-history-tab's
   * re-fetch effect (the server snapshotted the pre-add model so
   * "undo this add via revert" works).
   */
  async function handleAdd(
    kind: AdminSemanticModelEntryKind,
    entry: SemanticMetric | SemanticDimension | SemanticHierarchy,
  ): Promise<void> {
    if (!data || addSubmitting !== null) return;
    setAddSubmitting(kind);
    setAddError(null);
    setAddNameCollision(null);
    try {
      const res = await addSemanticModelEntry(sessionId, kind, entry);
      setData({
        ...data,
        lastUpdatedAt: res.lastUpdatedAt,
        model: res.model,
      });
      setAddOpen(null);
    } catch (err) {
      if (err instanceof NameAlreadyExistsError) {
        setAddNameCollision({ kind: err.kind, name: err.entryName });
      } else {
        setAddError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setAddSubmitting(null);
    }
  }

  /**
   * Wave W61-hierarchy-edit · save the edited levels for the selected
   * hierarchy. Reuses the existing W61-save PATCH path
   * (`patchSemanticModel`) because hierarchies don't have a dedicated
   * endpoint — the modal hands back the new ordered levels array, we
   * build a `nextModel` with `hierarchies` re-mapped to swap in the
   * new levels for the matching name, and route through the wholesale
   * replace path. The server's W61-save handler runs the normal version
   * bump + audit-log + invalidation hook (W61-cache-invalidate) flow.
   *
   * Mirrors the W61-add-client `handleAdd` shape: own submitting flag,
   * own error slot, success path updates parent `data` (which causes
   * the audit-history-tab's `lastUpdatedAt`-keyed effect to re-fetch
   * the buffer so the pre-edit snapshot appears for revert-as-undo).
   */
  async function handleEditHierarchyLevels(
    hierarchyName: string,
    nextLevels: string[],
  ): Promise<void> {
    if (!data || editLevelsSubmitting !== null) return;
    setEditLevelsSubmitting(hierarchyName);
    setEditLevelsError(null);
    try {
      const nextModel: SemanticModel = {
        ...data.model,
        hierarchies: data.model.hierarchies.map((h) =>
          h.name === hierarchyName ? { ...h, levels: nextLevels } : h,
        ),
      };
      const res = await patchSemanticModel(sessionId, nextModel);
      setData({
        ...data,
        lastUpdatedAt: res.lastUpdatedAt,
        model: res.model,
      });
      setEditingHierarchy(null);
    } catch (err) {
      setEditLevelsError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditLevelsSubmitting(null);
    }
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
  const addDisabled =
    saving ||
    addSubmitting !== null ||
    deletingEntry !== null ||
    reverting !== null;

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

        <MetricsCard
          metrics={model.metrics}
          sourceFilter={sourceFilter}
          onSourceFilterChange={setSourceFilter}
          saving={saving}
          deletePending={deletingEntry !== null}
          addDisabled={addDisabled}
          onAdd={() => setAddOpen("metric")}
          onToggleExposed={handleToggleMetricExposed}
          onEditLabel={(name, next) => patchMetric(name, { label: next })}
          onEditDescription={(name, next) =>
            patchMetric(name, { description: emptyToUndef(next) })
          }
          onEditExpression={(name, next) =>
            patchMetric(name, { expression: next })
          }
          onEditFormat={handleMetricFormatChange}
          onEditCurrencyCode={(name, next) =>
            patchMetric(name, { currencyCode: emptyToUndef(next) })
          }
          onRequestDelete={(name) =>
            setPendingDelete({ kind: "metric", name })
          }
        />

        <DimensionsCard
          dimensions={model.dimensions}
          sourceFilter={sourceFilter}
          onSourceFilterChange={setSourceFilter}
          saving={saving}
          deletePending={deletingEntry !== null}
          addDisabled={addDisabled}
          onAdd={() => setAddOpen("dimension")}
          onToggleExposed={handleToggleDimensionExposed}
          onEditLabel={(name, next) =>
            patchDimension(name, { label: next })
          }
          onEditDescription={(name, next) =>
            patchDimension(name, { description: emptyToUndef(next) })
          }
          onEditKind={handleDimensionKindChange}
          onEditTemporalGrain={handleTemporalGrainChange}
          onRequestDelete={(name) =>
            setPendingDelete({ kind: "dimension", name })
          }
        />

        <HierarchiesCard
          hierarchies={model.hierarchies}
          sourceFilter={sourceFilter}
          onSourceFilterChange={setSourceFilter}
          saving={saving}
          deletePending={deletingEntry !== null}
          editLevelsPending={editLevelsSubmitting !== null}
          addDisabled={addDisabled}
          onAdd={() => setAddOpen("hierarchy")}
          onRequestDelete={(name) =>
            setPendingDelete({ kind: "hierarchy", name })
          }
          onRequestEditLevels={(h) => setEditingHierarchy(h)}
        />

        <AuditHistoryCard
          historyOpen={historyOpen}
          onOpenChange={setHistoryOpen}
          historyLog={historyLog}
          historyLoading={historyLoading}
          historyError={historyError}
          revertError={revertError}
          reverting={reverting}
          saving={saving}
          onRevert={(entry, idx, total) =>
            void handleRevert(entry, idx, total)
          }
        />
      </div>
      <DeleteEntryConfirmation
        pending={pendingDelete}
        sessionId={sessionId}
        deleting={deletingEntry !== null}
        deleteError={deleteError}
        onOpenChange={(next) => {
          // While a delete is in flight, swallow dismiss attempts —
          // the destructive op should resolve before the modal goes
          // away so the admin can see the success / failure result.
          if (!next && deletingEntry !== null) return;
          if (!next) {
            setPendingDelete(null);
            setDeleteError(null);
          }
        }}
        onConfirm={() => {
          if (!pendingDelete) return;
          void handleDelete(pendingDelete.kind, pendingDelete.name);
        }}
      />
      <AddEntryForm
        open={addOpen}
        submitting={addSubmitting !== null}
        submitError={addError}
        nameCollision={addNameCollision}
        onOpenChange={(next) => {
          // While an add is in flight, swallow dismiss attempts so the
          // admin sees the success / failure result inline (same
          // shape as DeleteEntryConfirmation).
          if (!next && addSubmitting !== null) return;
          if (!next) {
            setAddOpen(null);
            setAddError(null);
            setAddNameCollision(null);
          }
        }}
        onConfirm={(kind, entry) => {
          void handleAdd(kind, entry);
        }}
      />
      <HierarchyEditor
        hierarchy={editingHierarchy}
        submitting={editLevelsSubmitting !== null}
        submitError={editLevelsError}
        onOpenChange={(next) => {
          // While an edit is in flight, swallow dismiss attempts so
          // the admin sees the success / failure result inline (same
          // pattern as AddEntryForm + DeleteEntryConfirmation).
          if (!next && editLevelsSubmitting !== null) return;
          if (!next) {
            setEditingHierarchy(null);
            setEditLevelsError(null);
          }
        }}
        onConfirm={(name, nextLevels) => {
          void handleEditHierarchyLevels(name, nextLevels);
        }}
      />
    </>
  );
}
