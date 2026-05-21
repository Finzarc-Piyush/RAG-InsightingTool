import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DashboardData } from '../modules/useDashboardState';
import { useToast } from '@/hooks/use-toast';
// W-EXP-12 · The client html-to-image + pptxgenjs imports were the engine
// of the rastered-screenshot deck path. They're gone — the server now does
// agentic deck composition (W-EXP-7) and ships a consultant-grade PPTX
// with native editable charts + tables.
import { DashboardSection, DashboardTile } from '../types';
import type { Layouts } from 'react-grid-layout';
import { dashboardsApi } from '@/lib/api/dashboards';
import { DashboardHeader } from './DashboardHeader';
import { DashboardTiles } from './DashboardTiles';
// DPF4 · the analytical content lived above the canvas pre-DR2 via
// `AnalysisSummaryPanel`. DR2 moved it to a right-side drawer triggered
// from the header so the canvas leads the page on first paint.
import { DashboardSummaryDrawer, hasAnySummaryContent } from './DashboardSummaryDrawer';
import { DashboardSheetTabs } from './DashboardSheetTabs';
import { DashboardGlobalFilterBar } from './DashboardGlobalFilterBar';
import { AddTileMenu } from './AddTileMenu';
import {
  availableFilterDefinitions,
  capturedActiveFilterToChartFilters,
  extractTileColumns,
  globalForTile,
} from '../dashboardGlobalFilters';
import { ShareDashboardDialog } from './ShareDashboardDialog';
import { ActiveChartFilters, hasActiveFilters } from '@/lib/chartFilters';
import {
  CROSS_FILTER_EVENT,
  applyCrossFilter,
  type CrossFilterEvent,
} from '../lib/crossFilter';
// Wave WD3-sheet · subscribe to the WD3 drill-through event family
// and render a side-sheet showing the underlying-rows request for
// the clicked (chart, column, value) pin.
import {
  DRILL_THROUGH_EVENT,
  type DrillThroughEvent,
} from '../lib/drillThrough';
import { DrillThroughSheet } from './DrillThroughSheet';
// Wave WD3-telemetry · fire-and-forget POST to /api/telemetry/drill-through
// when the listener accepts a validated DrillThroughEvent (quantify which
// chart kinds + columns get drilled into in Cosmos via recordUsageEvent).
// Wave WI4-telemetry · sibling helper for the WI4 explain-slice listener,
// emitting the BrushRegion discriminant as `regionKind`.
import {
  recordDashboardDrillThroughTelemetry,
  recordDashboardExplainSliceTelemetry,
} from '../../../lib/telemetry';
// Wave WI4-panel · subscribe to the WI4 explain-slice event family
// and render a side-panel showing the brushed sub-region's pin +
// (in a follow-on WI4-wire wave) the regenerated insight prose.
import {
  EXPLAIN_SLICE_EVENT,
  type ExplainSliceEvent,
} from '../lib/explainSlice';
import { ExplainSlicePanel } from './ExplainSlicePanel';
import { createInsightRegenCache } from '../lib/insightRegenCache';
import { createInsightHistoryStore } from '../lib/insightHistory';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Trash2, Loader2, Download } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useDashboardContext } from '../context/DashboardContext';
import { DashboardEditModeProvider } from '../context/DashboardEditModeContext';
import { getUserEmail } from '@/utils/userStorage';
// W-EXP-12 · exportTheme constants were consumed only by the deleted
// client-side renderer; the server-side renderer has its own brand
// palette source of truth. Keeping the file in case a future feature
// (e.g. inline preview) needs them — no current consumer.

interface DashboardViewProps {
  dashboard: DashboardData;
  onBack: () => void;
  onDeleteChart: (chartIndex: number, sheetId?: string) => void;
  onDeleteTable: (tableIndex: number, sheetId?: string) => void;
  isRefreshing?: boolean;
  onRefresh?: () => Promise<any>;
  permission?: "view" | "edit"; // Optional permission, defaults to checking ownership
}

export function DashboardView({ dashboard, onBack, onDeleteChart, onDeleteTable, isRefreshing = false, onRefresh, permission }: DashboardViewProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [serverExportBusy, setServerExportBusy] = useState<"pdf" | "pptx" | null>(null);
  const [activeSheetId, setActiveSheetId] = useState<string | null>(null);
  // DR4 · two-tier filter state. `global` applies to every chart whose
  // data carries the column; `perTile` overrides global for that one tile.
  const [globalFilters, setGlobalFilters] = useState<ActiveChartFilters>({});
  const [perTileFilters, setPerTileFilters] = useState<Record<string, ActiveChartFilters>>({});
  const [editingSheetId, setEditingSheetId] = useState<string | null>(null);
  const [editSheetName, setEditSheetName] = useState('');
  const [deleteSheetDialogOpen, setDeleteSheetDialogOpen] = useState(false);
  const [sheetToDelete, setSheetToDelete] = useState<{ id: string; name: string } | null>(null);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [selectedSheetIds, setSelectedSheetIds] = useState<Set<string>>(new Set());
  const [addSheetDialogOpen, setAddSheetDialogOpen] = useState(false);
  const [newSheetName, setNewSheetName] = useState('');
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [summaryDrawerOpen, setSummaryDrawerOpen] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  // Wave WD3-sheet · captured DrillThroughEvent at the dashboard
  // level. `null` means the drill sheet is closed. The
  // `DRILL_THROUGH_EVENT` listener below sets this; the sheet's
  // `onOpenChange(false)` clears it back to `null` so a re-open with
  // the same payload re-fires the slide-in animation.
  const [drillThroughEvent, setDrillThroughEvent] = useState<DrillThroughEvent | null>(null);
  // Wave WI4-panel · captured ExplainSliceEvent at the dashboard
  // level. `null` means the explain-slice panel is closed. The
  // `EXPLAIN_SLICE_EVENT` listener below sets this; the panel's
  // `onOpenChange(false)` clears it back to `null`. Mirror of the
  // drillThroughEvent shape — the two captured events live as
  // siblings so a future wave can hold both panels open at once
  // (explain + drill on the same chart) if the UX warrants.
  const [explainSliceEvent, setExplainSliceEvent] = useState<ExplainSliceEvent | null>(null);
  const { toast } = useToast();
  const {
    addChartToDashboard,
    renameDashboard,
    renameSheet,
    reorderSheets,
    addSheet,
    removeSheet,
    deleteDashboard,
    refetch: refetchDashboards,
    patchSheetContent,
  } = useDashboardContext();

  // Wave WI2-wire-bind · shared per-DashboardView insight regen cache.
  // Held at the mount level so the user's "explore A, explore B, go
  // back to A" pattern hits the cache instead of re-firing the LLM.
  // Empty dep array keeps a single instance for the dashboard session.
  const insightRegenCache = useMemo(() => createInsightRegenCache(), []);
  // Wave WI6 · per-tile MRU history store for the "Recent insights"
  // dropdown in TileInsightFooter. Same mount-scoped lifecycle as the
  // regen cache. Each ChartTileBody records on a fresh regen and reads
  // the per-tile slice for its dropdown.
  // Wave WI6-persist · `storageScope: dashboard.id` scopes the
  // sessionStorage key so two dashboards on the same tab don't share
  // history slots. Captured at mount time (empty deps array) to match
  // the `insightRegenCache` lifetime above; navigation between
  // dashboards typically remounts DashboardView, so the new mount
  // hydrates from its own scoped key.
  const insightHistoryStore = useMemo(
    () => createInsightHistoryStore({ storageScope: dashboard.id }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Determine permission: if not provided, check if user owns the dashboard or has edit permission on shared dashboard
  const canEdit = useMemo(() => {
    if (permission !== undefined) {
      return permission === "edit";
    }
    // If it's a shared dashboard, use the shared permission
    if (dashboard.isShared && dashboard.sharedPermission) {
      return dashboard.sharedPermission === "edit";
    }
    // Check if user is a collaborator with edit permission
    const userEmail = getUserEmail()?.toLowerCase();
    if (dashboard.collaborators && userEmail) {
      const collaborator = dashboard.collaborators.find(
        (c) => c.userId.toLowerCase() === userEmail
      );
      if (collaborator && collaborator.permission === "edit") {
        return true;
      }
    }
    // Check ownership by comparing username with current user email
    const dashboardUsername = dashboard.username?.toLowerCase();
    return userEmail === dashboardUsername;
  }, [permission, dashboard]);

  // Get sheets or create default from charts (backward compatibility)
  const sheets = useMemo(() => {
    if (dashboard.sheets && dashboard.sheets.length > 0) {
      return dashboard.sheets.sort((a, b) => (a.order || 0) - (b.order || 0));
    }
    // Backward compatibility: create default sheet from charts
    return [{
      id: 'default',
      name: 'Overview',
      charts: dashboard.charts,
      tables: [],
      order: 0,
    }];
  }, [dashboard.sheets, dashboard.charts]);

  // Set active sheet on mount
  useEffect(() => {
    if (!activeSheetId && sheets.length > 0) {
      setActiveSheetId(sheets[0].id);
    }
  }, [activeSheetId, sheets]);

  const activeSheet = sheets.find(s => s.id === activeSheetId) || sheets[0];
  
  // Ensure activeSheetId is always set when we have sheets
  const currentSheetId = activeSheetId || (sheets.length > 0 ? sheets[0].id : null);

  const sections = useMemo<DashboardSection[]>(() => {
    if (!activeSheet) return [];

    const narrativeTiles: DashboardTile[] = (activeSheet.narrativeBlocks ?? [])
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((block) => ({
        kind: 'narrative' as const,
        id: `narrative-${block.id}`,
        title: block.title,
        block,
      }));

    // Chart and its keyInsight live in ONE tile — same container, same chat
    // pairing. The render branch in DashboardTiles.tsx pulls keyInsight off
    // tile.chart directly.
    const baseTiles: DashboardTile[] = activeSheet.charts.map((chart, index) => ({
      kind: 'chart' as const,
      id: `chart-${index}`,
      title: chart.title || `Chart ${index + 1}`,
      chart,
      index,
      metadata: {
        lastUpdated: dashboard.updatedAt,
      },
    }));

    const tableTiles: DashboardTile[] = (activeSheet.tables ?? []).map((table, index) => ({
      kind: 'table',
      id: `table-${index}`,
      title: table.caption || `Table ${index + 1}`,
      table,
      index,
    }));

    const pivotTiles: DashboardTile[] = (activeSheet.pivots ?? []).map((pivot, index) => ({
      kind: 'pivot',
      id: `pivot-${pivot.id || index}`,
      title: pivot.title || `Pivot ${index + 1}`,
      pivot,
      index,
    }));

    // Always return a section, even if there are no tiles (empty sheet)
    return [
      {
        id: activeSheet.id,
        title: activeSheet.name,
        description: `Charts and insights for ${activeSheet.name}`,
        tiles: [...narrativeTiles, ...baseTiles, ...pivotTiles, ...tableTiles],
      },
    ];
  }, [activeSheet, dashboard.updatedAt]);

  const persistGridTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlePersistGrid = useCallback(
    (layouts: Layouts) => {
      if (!canEdit || !currentSheetId) return;
      if (persistGridTimerRef.current) clearTimeout(persistGridTimerRef.current);
      persistGridTimerRef.current = setTimeout(async () => {
        try {
          await patchSheetContent(dashboard.id, currentSheetId, {
            gridLayout: layouts as Layouts,
          });
          if (onRefresh) await onRefresh();
          await refetchDashboards();
        } catch (e) {
          console.error(e);
          toast({
            title: 'Could not save layout',
            description: e instanceof Error ? e.message : 'Try again.',
            variant: 'destructive',
          });
        }
      }, 700);
    },
    [
      canEdit,
      currentSheetId,
      dashboard.id,
      onRefresh,
      patchSheetContent,
      refetchDashboards,
      toast,
    ]
  );

  const handleSeedLayoutFromLocal = useCallback(
    async (layouts: Layouts) => {
      if (!canEdit || !currentSheetId) return;
      await patchSheetContent(dashboard.id, currentSheetId, {
        gridLayout: layouts as Layouts,
      });
      if (onRefresh) await onRefresh();
      await refetchDashboards();
    },
    [
      canEdit,
      currentSheetId,
      dashboard.id,
      onRefresh,
      patchSheetContent,
      refetchDashboards,
    ]
  );

  const handleNarrativeSave = useCallback(
    async (blockId: string, title: string, body: string) => {
      if (!canEdit || !currentSheetId || !activeSheet?.narrativeBlocks?.length) return;
      const next = activeSheet.narrativeBlocks.map((b) =>
        b.id === blockId ? { ...b, title, body } : b
      );
      await patchSheetContent(dashboard.id, currentSheetId, { narrativeBlocks: next });
      if (onRefresh) await onRefresh();
      await refetchDashboards();
    },
    [
      activeSheet?.narrativeBlocks,
      canEdit,
      currentSheetId,
      dashboard.id,
      onRefresh,
      patchSheetContent,
      refetchDashboards,
    ]
  );

  // Wave DR6 · prepend a new narrative block via the existing
  // patchSheetContent endpoint. AddTileMenu calls this with a fully-
  // formed block (id + role + title + body); we slot it in at order 0
  // and re-number the rest so the new tile lands at the top of the
  // canvas. Existing block ordering is preserved.
  const handleAddNarrativeBlock = useCallback(
    async (block: {
      id: string;
      role: 'custom';
      title: string;
      body: string;
      order: number;
    }) => {
      if (!canEdit || !currentSheetId) return;
      const existing = (activeSheet?.narrativeBlocks ?? []).slice();
      // Re-number existing blocks so the new one sits first.
      const renumbered = existing.map((b, idx) => ({
        ...b,
        order: idx + 1,
      }));
      const next = [{ ...block, order: 0 }, ...renumbered];
      await patchSheetContent(dashboard.id, currentSheetId, { narrativeBlocks: next });
      if (onRefresh) await onRefresh();
      await refetchDashboards();
    },
    [
      activeSheet?.narrativeBlocks,
      canEdit,
      currentSheetId,
      dashboard.id,
      onRefresh,
      patchSheetContent,
      refetchDashboards,
    ]
  );

  const chartTiles = useMemo(
    () => sections.flatMap((section) => section.tiles).filter((tile): tile is DashboardTile & { kind: 'chart' } => tile.kind === 'chart'),
    [sections]
  );

  const activeSection = sections.find((section) => section.id === activeSheetId) ?? sections[0];

  useEffect(() => {
    const validIds = new Set(
      sections.flatMap((section) => section.tiles.map((tile) => tile.id))
    );
    setPerTileFilters((prev) => {
      let changed = false;
      const next: Record<string, ActiveChartFilters> = {};
      Object.entries(prev).forEach(([tileId, filters]) => {
        if (validIds.has(tileId)) {
          next[tileId] = filters;
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [sections]);

  // DR4 · seed `globalFilters` from the dashboard's captured-active-filter
  // (FA6) when the dashboard is first opened. Resetting on dashboard /
  // sheet change clears any per-tile overrides; users get a clean
  // starting point.
  useEffect(() => {
    setGlobalFilters(capturedActiveFilterToChartFilters(dashboard.capturedActiveFilter));
    setPerTileFilters({});
  }, [dashboard.id, dashboard.capturedActiveFilter, activeSheetId]);

  // WD2-wiring-bar · subscribe to chart-mark brush events published by
  // any renderer that's wrapped in a <DashboardTileProvider> (BarRenderer
  // is the first wired in this wave; the remaining 12 visx renderers +
  // ECharts adapter follow in WD2-wiring-rest). The toggle / append /
  // replace semantics live in `applyCrossFilter` so this effect is a
  // thin dispatch — single source-of-truth for the categorical brush
  // contract.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<CrossFilterEvent>).detail;
      if (!detail || typeof detail.column !== 'string') return;
      setGlobalFilters((prev) => applyCrossFilter(prev, detail));
    };
    window.addEventListener(CROSS_FILTER_EVENT, handler as EventListener);
    return () => {
      window.removeEventListener(CROSS_FILTER_EVENT, handler as EventListener);
    };
  }, []);

  // Wave WD3-sheet · subscribe to drill-through events fired by any
  // renderer wrapped in a <DashboardTileProvider>. Mirrors the
  // CROSS_FILTER_EVENT subscription above for code-locality —
  // dispatch and receive sit as a pair. The detail validation is
  // tighter than the cross-filter equivalent because the drill
  // payload must include `chartId` for the (future) server fetch.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<DrillThroughEvent>).detail;
      if (
        !detail ||
        typeof detail.chartId !== 'string' ||
        typeof detail.column !== 'string'
      ) {
        return;
      }
      // Wave WD3-telemetry · fire-and-forget observability call between
      // validation and sheet-open. `typeof detail.value` carries the
      // shape of the clicked mark's value without leaking PII (the raw
      // value itself never goes on the wire).
      // Wave WD3-WI4-sheetId-telemetry · also pass `activeSheetId` so
      // Cosmos can disambiguate "chart-N" rows across sheets — chartId
      // is locally unique per-sheet but globally collides on multi-sheet
      // dashboards. `?? undefined` keeps the field omitted (not null)
      // when no sheet is active, matching the helper's optional contract.
      void recordDashboardDrillThroughTelemetry({
        chartId: detail.chartId,
        column: detail.column,
        valueType: typeof detail.value,
        dashboardId: dashboard.id,
        sheetId: activeSheetId ?? undefined,
      });
      // Wave WD3-server-sheetId-resolution · inject activeSheetId onto
      // the event detail before storing it in state. Capturing at
      // click time (NOT at sheet-render time) means the server-side
      // chartId lookup resolves against the correct sheet even if the
      // user navigates to a different sheet while the side-sheet is
      // open. The conditional spread (...{ ..., ...(activeSheetId ?
      // { sheetId: activeSheetId } : {}) }) preserves the byte-
      // identical event shape for single-sheet dashboards, where
      // activeSheetId is non-null but the disambiguation is unneeded
      // — actually we DO inject it whenever non-null, since the
      // server's scoped lookup is strictly more precise than the
      // legacy walk, and single-sheet resolution is a degenerate case
      // of the multi-sheet path. The omit branch only fires when
      // activeSheetId is null (very early mount, no sheets yet).
      setDrillThroughEvent(
        activeSheetId ? { ...detail, sheetId: activeSheetId } : detail,
      );
    };
    window.addEventListener(DRILL_THROUGH_EVENT, handler as EventListener);
    return () => {
      window.removeEventListener(DRILL_THROUGH_EVENT, handler as EventListener);
    };
  }, [dashboard.id, activeSheetId]);

  // Wave WI4-panel · subscribe to EXPLAIN_SLICE_EVENT and open the
  // ExplainSlicePanel on receipt. Mirrors the DRILL_THROUGH_EVENT
  // listener above for code-locality — the two click-intents share
  // a shape, so dispatch + receive sit as a pair. The detail
  // validation requires `chartId` + `column` + `region` (the three
  // load-bearing fields); a missing region would mean a zero-width
  // brush that the dispatcher already short-circuited.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<ExplainSliceEvent>).detail;
      if (
        !detail ||
        typeof detail.chartId !== 'string' ||
        typeof detail.column !== 'string' ||
        !detail.region
      ) {
        return;
      }
      // Wave WI4-telemetry · fire-and-forget observability call between
      // validation and panel-open. `detail.region.kind` carries the
      // BrushRegion discriminant ("numeric" | "temporal" | "categorical"
      // | "box2d") — the shape of the brushed sub-domain without
      // leaking the raw bounds/values themselves.
      // Wave WD3-WI4-sheetId-telemetry · see the WD3 listener above for
      // the sheetId rationale — both observability paths join on the
      // same (dashboardId, sheetId, chartId) tuple.
      void recordDashboardExplainSliceTelemetry({
        chartId: detail.chartId,
        column: detail.column,
        regionKind: detail.region.kind,
        dashboardId: dashboard.id,
        sheetId: activeSheetId ?? undefined,
      });
      // Wave WI4-client-sheetId-resolution · inject activeSheetId onto
      // the event detail before storing it in state. Direct mirror of
      // the WD3 listener above; captures the user's sheet intent at
      // brush time (NOT at panel-render time) so the panel's chart
      // resolution remains stable even if the user navigates to a
      // different sheet while the panel is open. The omit branch only
      // fires when activeSheetId is null (very early mount, no sheets
      // yet) — the pre-wave event shape is preserved verbatim there.
      setExplainSliceEvent(
        activeSheetId ? { ...detail, sheetId: activeSheetId } : detail,
      );
    };
    window.addEventListener(EXPLAIN_SLICE_EVENT, handler as EventListener);
    return () => {
      window.removeEventListener(EXPLAIN_SLICE_EVENT, handler as EventListener);
    };
  }, [dashboard.id, activeSheetId]);

  const handleTileFiltersChange = useCallback((tileId: string, filters: ActiveChartFilters) => {
    setPerTileFilters((prev) => {
      const next = { ...prev };
      if (hasActiveFilters(filters)) {
        next[tileId] = filters;
      } else {
        delete next[tileId];
      }
      return next;
    });
  }, []);

  // Effective filter per tile = perTile override (when set) else the
  // global filter restricted to columns the tile actually has. The
  // restriction list also drives the "doesn't apply here" badge.
  const tileFiltersForRender = useMemo(() => {
    const result: Record<string, ActiveChartFilters> = {};
    const inapplicable: Record<string, string[]> = {};
    for (const section of sections) {
      for (const tile of section.tiles) {
        const r = globalForTile(tile, globalFilters, perTileFilters[tile.id]);
        result[tile.id] = r.applicable;
        if (r.inapplicableColumns.length > 0 && !perTileFilters[tile.id]) {
          inapplicable[tile.id] = r.inapplicableColumns;
        }
      }
    }
    return { effective: result, inapplicable };
  }, [sections, globalFilters, perTileFilters]);

  // For the global filter bar's "applies to N of M" hint.
  const globalFilterCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    let totalChartTiles = 0;
    for (const section of sections) {
      for (const tile of section.tiles) {
        if (tile.kind !== 'chart') continue;
        totalChartTiles++;
        for (const col of extractTileColumns(tile)) {
          if (col in globalFilters) counts[col] = (counts[col] ?? 0) + 1;
        }
      }
    }
    return { counts, totalChartTiles };
  }, [sections, globalFilters]);

  // WD1 · feed the global filter bar's `+ Add filter` picker. Aggregates
  // chart tile data across sheets, derives ChartFilterDefinitions, and
  // excludes columns already filtered. Memoised against sections +
  // globalFilters so the popover stays fast even on large dashboards.
  const availableFilters = useMemo(() => {
    const allTiles = sections.flatMap((s) => s.tiles);
    return availableFilterDefinitions(allTiles, globalFilters);
  }, [sections, globalFilters]);


  // Handle adding a new sheet
  const handleAddSheet = async () => {
    if (!newSheetName.trim()) return;
    
    try {
      const updated = await addSheet(dashboard.id, newSheetName.trim());
      const newSheet = updated.sheets?.find(s => s.name === newSheetName.trim());
      
      if (newSheet) {
        setActiveSheetId(newSheet.id);
      }
      
      toast({
        title: 'View Created',
        description: `View "${newSheetName.trim()}" has been created.`,
      });
      
      setAddSheetDialogOpen(false);
      setNewSheetName('');
      
      // Refetch to get updated dashboard
    if (onRefresh) {
      await onRefresh();
    }
      await refetchDashboards();
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error?.message || 'Failed to create view',
        variant: 'destructive',
      });
    }
  };

  // Handle export button click - open dialog
  const handleExportClick = () => {
    if (sheets.length === 1) {
      // If only one sheet, export directly
      handleExport([sheets[0].id]);
    } else {
      // Show dialog for sheet selection
      setSelectedSheetIds(new Set(sheets.map(s => s.id))); // Select all by default
      setExportDialogOpen(true);
    }
  };

  // W-EXP-12 · Client html-to-image PPT path replaced with server-side
  // agentic deck generation. The server endpoint (W-EXP-7 wiring) runs:
  //   runDeckPlanner (Claude Opus 4.7) → verifyDeckPlan (deterministic gate;
  //   one repair round on fail) → renderDeckPlanToPptxBuffer (pptxgenjs
  //   native shapes / addChart / addTable). Action-titled, exec-summary-up-
  //   front, methodology-at-the-back — see /Users/tida/.claude/plans/
  //   the-dashboard-download-feature-cozy-flask.md.
  //
  // Sheet selection from the dialog is preserved as informational context
  // (logged + sent in a non-load-bearing query param); the planner picks
  // its own layout sequence from the dashboard's answerEnvelope + chart
  // inventory. Per-sheet exports remain a future enhancement.
  const handleExport = async (sheetIdsToExport?: string[]) => {
    if (isExporting) return;
    const sheetsToExport = sheetIdsToExport || Array.from(selectedSheetIds);
    if (sheetsToExport.length === 0) {
      toast({ title: 'No views selected', description: 'Please select at least one view to export.' });
      return;
    }
    setIsExporting(true);
    setExportDialogOpen(false);
    try {
      await dashboardsApi.exportDashboard(dashboard.id, 'pptx');
      toast({
        title: 'Export complete',
        description: 'Downloaded a consultant-grade slide deck (action titles, exec summary, methodology).',
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Please try again.';
      toast({
        title: 'Export failed',
        description: msg,
        variant: 'destructive',
      });
    } finally {
      setIsExporting(false);
    }
  };

  // Handle sheet selection in export dialog
  const handleSheetToggle = (sheetId: string) => {
    setSelectedSheetIds(prev => {
      const next = new Set(prev);
      if (next.has(sheetId)) {
        next.delete(sheetId);
      } else {
        next.add(sheetId);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedSheetIds.size === sheets.length) {
      setSelectedSheetIds(new Set());
    } else {
      setSelectedSheetIds(new Set(sheets.map(s => s.id)));
    }
  };

  return (
    <DashboardEditModeProvider dashboardId={dashboard.id} canEdit={canEdit}>
    <div className="bg-muted/30 h-[calc(100vh-72px)] flex flex-col overflow-y-auto">
      <div className="flex-shrink-0 px-4 pt-6 pb-3 lg:px-8">
        <DashboardHeader
          dashboard={dashboard}
          name={dashboard.name}
          lastOpenedAt={dashboard.lastOpenedAt}
          updatedAt={dashboard.updatedAt}
          sheetCount={sheets.length}
          isExporting={isExporting}
          isExportingPdf={isExportingPdf}
          onBack={onBack}
          onExportPptx={handleExportClick}
          onExportPdf={async () => {
            if (isExportingPdf) return;
            setIsExportingPdf(true);
            try {
              await dashboardsApi.exportDashboard(dashboard.id, 'pdf');
            } catch (e) {
              toast({
                title: 'PDF export failed',
                description: e instanceof Error ? e.message : 'Try again.',
                variant: 'destructive',
              });
            } finally {
              setIsExportingPdf(false);
            }
          }}
          onShare={canEdit ? () => setShareDialogOpen(true) : undefined}
          onDelete={canEdit ? async () => {
            const confirmed = window.confirm(
              `Delete "${dashboard.name}"? This cannot be undone.`,
            );
            if (!confirmed) return;
            try {
              await deleteDashboard(dashboard.id);
              onBack();
            } catch (e) {
              toast({
                title: 'Could not delete dashboard',
                description: e instanceof Error ? e.message : 'Try again.',
                variant: 'destructive',
              });
            }
          } : undefined}
          onOpenSummary={() => setSummaryDrawerOpen(true)}
          hasSummary={hasAnySummaryContent({
            envelope: dashboard.answerEnvelope,
            businessActions: dashboard.businessActions,
            followUpPrompts: dashboard.followUpPrompts,
            investigationSummary: dashboard.investigationSummary,
            priorInvestigationsSnapshot: dashboard.priorInvestigationsSnapshot,
          })}
          capturedActiveFilter={dashboard.capturedActiveFilter}
          onRename={canEdit ? async (newName) => {
            try {
              await renameDashboard(dashboard.id, newName);
              if (onRefresh) {
                await onRefresh();
              }
              await refetchDashboards();
            } catch (error: any) {
              toast({
                title: 'Error',
                description: error?.message || 'Failed to rename dashboard',
                variant: 'destructive',
              });
              throw error;
            }
          } : undefined}
        />
      </div>

      <DashboardSummaryDrawer
        open={summaryDrawerOpen}
        onOpenChange={setSummaryDrawerOpen}
        envelope={dashboard.answerEnvelope}
        businessActions={dashboard.businessActions}
        followUpPrompts={dashboard.followUpPrompts}
        investigationSummary={dashboard.investigationSummary}
        priorInvestigationsSnapshot={dashboard.priorInvestigationsSnapshot}
      />

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {sheets.length > 0 && (
          <div className="flex-shrink-0 px-4 lg:px-8">
            <DashboardSheetTabs
              sheets={sheets.map((s) => ({
                id: s.id,
                name: s.name,
                chartCount: s.charts.length,
              }))}
              activeSheetId={activeSheetId}
              onSelect={setActiveSheetId}
              onRename={canEdit ? async (sheetId, newName) => {
                try {
                  await renameSheet(dashboard.id, sheetId, newName);
                  if (onRefresh) await onRefresh();
                  await refetchDashboards();
                } catch (error: any) {
                  toast({
                    title: 'Error',
                    description: error?.message || 'Failed to rename view',
                    variant: 'destructive',
                  });
                  throw error;
                }
              } : undefined}
              onDelete={canEdit ? (sheetId) => {
                const target = sheets.find((s) => s.id === sheetId);
                if (target) {
                  setSheetToDelete({ id: target.id, name: target.name });
                  setDeleteSheetDialogOpen(true);
                }
              } : undefined}
              onAdd={canEdit ? () => {
                setNewSheetName('');
                setAddSheetDialogOpen(true);
              } : undefined}
              onReorder={canEdit ? async (orderedIds) => {
                try {
                  await reorderSheets(dashboard.id, orderedIds);
                  if (onRefresh) await onRefresh();
                  await refetchDashboards();
                } catch (error: any) {
                  toast({
                    title: 'Error',
                    description: error?.message || 'Failed to reorder views',
                    variant: 'destructive',
                  });
                }
              } : undefined}
            />
          </div>
        )}

      <div className="flex-1 min-h-0 flex overflow-hidden">
        <div className="flex-1 min-h-0 flex flex-col gap-8 px-4 pb-8 lg:px-8 overflow-hidden">
          <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
            {activeSection ? (
              <section
                key={activeSection.id}
                id={`section-${activeSection.id}`}
                className="space-y-4"
                data-dashboard-section={activeSection.id}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-foreground">{activeSection.title}</h2>
                    {activeSection.description && (
                      <p className="text-sm text-muted-foreground">{activeSection.description}</p>
                    )}
                  </div>
                  {canEdit ? (
                    <AddTileMenu
                      onAddNarrative={handleAddNarrativeBlock}
                      onAddChart={async (chart) => {
                        if (!currentSheetId) return;
                        try {
                          await addChartToDashboard(dashboard.id, chart, currentSheetId);
                          if (onRefresh) await onRefresh();
                          await refetchDashboards();
                        } catch (e) {
                          toast({
                            title: 'Could not add chart',
                            description: e instanceof Error ? e.message : 'Try again.',
                            variant: 'destructive',
                          });
                          throw e;
                        }
                      }}
                    />
                  ) : null}
                </div>

                <DashboardGlobalFilterBar
                  global={globalFilters}
                  appliesToCountByColumn={globalFilterCounts.counts}
                  totalChartTiles={globalFilterCounts.totalChartTiles}
                  onChange={setGlobalFilters}
                  availableFilters={availableFilters}
                />

                <DashboardTiles
                  dashboardId={dashboard.id}
                  tiles={activeSection.tiles}
                  serverGridLayout={
                    (activeSheet?.gridLayout as Layouts | undefined) ?? null
                  }
                  onPersistServerGrid={handlePersistGrid}
                  onSeedLayoutFromLocalStorage={handleSeedLayoutFromLocal}
                  onNarrativeSave={handleNarrativeSave}
                  onDeleteChart={canEdit ? (chartIndex) => {
                    const sheetIdToUse = currentSheetId || (sheets.length > 0 ? sheets[0].id : undefined);
                    console.log('Deleting chart:', { chartIndex, sheetId: sheetIdToUse, activeSheetId, sheets });
                    onDeleteChart(chartIndex, sheetIdToUse || undefined);
                  } : undefined}
                  onDeleteTable={canEdit ? (tableIndex) => {
                    const sheetIdToUse = currentSheetId || (sheets.length > 0 ? sheets[0].id : undefined);
                    onDeleteTable(tableIndex, sheetIdToUse || undefined);
                  } : undefined}
                  filtersByTile={tileFiltersForRender.effective}
                  inapplicableColumnsByTile={tileFiltersForRender.inapplicable}
                  onTileFiltersChange={handleTileFiltersChange}
                  sheetId={currentSheetId || undefined}
                  onUpdate={onRefresh}
                  canEdit={canEdit}
                  insightRegenCache={insightRegenCache}
                  insightHistoryStore={insightHistoryStore}
                />
              </section>
            ) : (
              <div className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
                Select a section to get started.
              </div>
            )}
          </div>
        </div>
      </div>
      </div>

      {/* Export Sheet Selection Dialog */}
      <Dialog open={exportDialogOpen} onOpenChange={setExportDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Export Dashboard</DialogTitle>
            <DialogDescription>
              Choose views to include. <strong>Report PPTX</strong> rasterizes
              charts and pivots into a branded slide deck (cover, exec summary,
              recommendations, methodology). <strong>Download data (XLSX)</strong>{" "}
              gives you the raw rows behind every chart.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="flex items-center space-x-2 pb-2 border-b">
              <Checkbox
                id="select-all"
                checked={selectedSheetIds.size === sheets.length}
                onCheckedChange={handleSelectAll}
              />
              <Label
                htmlFor="select-all"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
              >
                Select All ({sheets.length} views)
              </Label>
            </div>
            <div className="space-y-3 max-h-[300px] overflow-y-auto">
              {sheets.map((sheet) => (
                <div key={sheet.id} className="flex items-center space-x-2">
                  <Checkbox
                    id={`sheet-${sheet.id}`}
                    checked={selectedSheetIds.has(sheet.id)}
                    onCheckedChange={() => handleSheetToggle(sheet.id)}
                  />
                  <Label
                    htmlFor={`sheet-${sheet.id}`}
                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer flex-1"
                  >
                    <div className="flex items-center justify-between">
                      <span>{sheet.name}</span>
                      <span className="text-xs text-muted-foreground ml-2">
                        {sheet.charts.length} chart{sheet.charts.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                  </Label>
                </div>
              ))}
            </div>
            {selectedSheetIds.size === 0 && (
              <p className="text-sm text-muted-foreground text-center py-2">
                Please select at least one view to export.
              </p>
            )}
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
            <div className="flex flex-wrap gap-2 w-full sm:w-auto">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!!serverExportBusy}
                onClick={async () => {
                  setServerExportBusy("pptx");
                  try {
                    const url = `/api/dashboards/${dashboard.id}/export/xlsx`;
                    const a = document.createElement("a");
                    a.href = url;
                    a.click();
                    toast({
                      title: "Download data",
                      description:
                        "Started XLSX download. One tab per chart with raw rows + provenance.",
                    });
                  } catch (e: any) {
                    toast({
                      title: "Download failed",
                      description: e?.message || "Could not download data.",
                      variant: "destructive",
                    });
                  } finally {
                    setServerExportBusy(null);
                  }
                }}
              >
                {serverExportBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Download data (XLSX)"
                )}
              </Button>
            </div>
            <div className="flex gap-2 w-full sm:w-auto justify-end">
            <Button
              variant="outline"
              onClick={() => {
                setExportDialogOpen(false);
                setSelectedSheetIds(new Set());
              }}
              disabled={isExporting}
            >
              Cancel
            </Button>
            <Button
              onClick={() => handleExport()}
              disabled={isExporting || selectedSheetIds.size === 0}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {isExporting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Exporting...
                </>
              ) : (
                <>
                  <Download className="h-4 w-4 mr-2" />
                  Report PPTX
                </>
              )}
            </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Sheet Confirmation Dialog */}
      <Dialog open={deleteSheetDialogOpen} onOpenChange={setDeleteSheetDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete View</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete the view "{sheetToDelete?.name}"? This will permanently remove all charts in this view. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeleteSheetDialogOpen(false);
                setSheetToDelete(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (!sheetToDelete) return;
                
                const wasActiveSheet = activeSheetId === sheetToDelete.id;
                
                try {
                  await removeSheet(dashboard.id, sheetToDelete.id);
                  
                  // If the deleted sheet was active, switch to the first remaining sheet
                  if (wasActiveSheet) {
                    const remainingSheets = sheets.filter(s => s.id !== sheetToDelete.id);
                    if (remainingSheets.length > 0) {
                      setActiveSheetId(remainingSheets[0].id);
                    }
                  }
                  
                  toast({
                    title: 'Sheet Deleted',
                    description: `Sheet "${sheetToDelete.name}" has been deleted.`,
                  });
                  
                  setDeleteSheetDialogOpen(false);
                  setSheetToDelete(null);
                  
                  // Refetch to get updated dashboard
                  if (onRefresh) {
                    await onRefresh();
                  }
                  await refetchDashboards();
                } catch (error: any) {
                  toast({
                    title: 'Error',
                    description: error?.message || 'Failed to delete sheet',
                    variant: 'destructive',
                  });
                }
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Sheet Dialog */}
      <Dialog open={addSheetDialogOpen} onOpenChange={setAddSheetDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add New View</DialogTitle>
            <DialogDescription>
              Create a new view to organize your charts. Enter a name for the view.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="new-sheet-name">View Name</Label>
            <Input
              id="new-sheet-name"
              value={newSheetName}
              onChange={(e) => setNewSheetName(e.target.value)}
              placeholder="Enter view name"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newSheetName.trim()) {
                  e.preventDefault();
                  handleAddSheet();
                }
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setAddSheetDialogOpen(false);
                setNewSheetName('');
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleAddSheet}
              disabled={!newSheetName.trim()}
            >
              Create View
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ShareDashboardDialog
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
        dashboardId={dashboard.id}
        dashboardName={dashboard.name}
      />
      {/* Wave WD3-sheet · drill-through receiver. Opens on
          cmd / ctrl-click of a chart mark inside any DashboardTile-
          wrapped renderer. Closes via overlay / Escape / Close
          button, which clears the event back to null so a re-open
          on the same payload re-fires the slide-in. */}
      <DrillThroughSheet
        dashboardId={dashboard.id}
        event={drillThroughEvent}
        onOpenChange={(open) => {
          if (!open) setDrillThroughEvent(null);
        }}
      />
      {/* Wave WI4-panel · explain-slice receiver. Opens on alt-drag
          (≥ BRUSH_MIN_PX = 6) of any WI4-wired chart mark inside a
          DashboardTile-wrapped renderer. Closes via overlay /
          Escape / Close button, which clears the event back to
          null so a re-brush on the same payload re-fires the
          slide-in.
          Wave WI4-wire · resolves the matching chart from
          `event.chartId` (`chart-${idx}` convention parallels
          DashboardView's tile id derivation at line 196) and threads
          it + the shared insightRegenCache into the panel so the
          regen hook can fire against the brushed slice. */}
      <ExplainSlicePanel
        event={explainSliceEvent}
        onOpenChange={(open) => {
          if (!open) setExplainSliceEvent(null);
        }}
        chart={(() => {
          if (!explainSliceEvent) return null;
          const m = /^chart-(\d+)$/.exec(explainSliceEvent.chartId);
          if (!m) return null;
          const idx = Number.parseInt(m[1], 10);
          // Wave WI4-client-sheetId-resolution · when the brush
          // listener captured an activeSheetId onto the event detail,
          // resolve the chart against the NAMED sheet rather than
          // whatever sheet is currently active. Captured-at-brush-time
          // semantics: the panel renders the chart the user actually
          // brushed, even if they've navigated to a different sheet
          // since. Predictable-failure on stale sheetId (sheet deleted
          // between brush and panel render): return null instead of
          // silently falling back to activeSheet — the no-chart branch
          // of ExplainSlicePanel then surfaces "Could not resolve the
          // chart for..." rather than re-resolving to a different
          // sheet's chart-N. Mirrors the server-side WD3 resolver's
          // stale-sheetId → chart_not_found contract.
          if (explainSliceEvent.sheetId) {
            const targetSheet = sheets.find(
              (s) => s.id === explainSliceEvent.sheetId,
            );
            return targetSheet?.charts[idx] ?? null;
          }
          // Legacy branch preserved verbatim for events with no
          // sheetId (degenerate no-sheets-yet mount, or any panel
          // mount that pre-dates this wave).
          if (!activeSheet) return null;
          return activeSheet.charts[idx] ?? null;
        })()}
        insightRegenCache={insightRegenCache}
      />
    </div>
    </DashboardEditModeProvider>
  );
}
