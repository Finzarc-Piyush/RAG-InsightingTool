import React, { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { DashboardTile } from '@/pages/Dashboard/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Trash2, Edit2, Loader2 } from 'lucide-react';
import { Responsive, WidthProvider, Layout, Layouts } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { EditInsightModal } from './EditInsightModal';
import { EditTableCaptionModal } from './EditTableCaptionModal';
import { useToast } from '@/hooks/use-toast';
import { useDashboardContext } from '../context/DashboardContext';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

// Lazy load ChartRenderer to reduce initial bundle size
const ChartRenderer = lazy(() => import('@/pages/Home/Components/ChartRenderer').then(module => ({ default: module.ChartRenderer })));

const ResponsiveGridLayout = WidthProvider(Responsive);

import { ActiveChartFilters } from '@/lib/chartFilters';
import { MarkdownRenderer } from '@/components/ui/markdown-renderer';
import { resolveLayoutsDropBySwap } from './dashboardGridLogic';
import { useLayoutHistory } from '@/pages/Dashboard/hooks/useLayoutHistory';

interface DashboardTilesProps {
  dashboardId: string;
  tiles: DashboardTile[];
  onDeleteChart?: (chartIndex: number) => void;
  onDeleteTable?: (tableIndex: number) => void;
  filtersByTile: Record<string, ActiveChartFilters>;
  onTileFiltersChange: (tileId: string, filters: ActiveChartFilters) => void;
  sheetId?: string;
  onUpdate?: () => void;
  canEdit?: boolean; // Whether the user can edit this dashboard
  /** Server-persisted grid; when set, preferred over localStorage for initial layout. */
  serverGridLayout?: Layouts | null;
  onPersistServerGrid?: (layouts: Layouts) => void;
  /** Immediate PATCH (no debounce) — used to seed Cosmos from localStorage once. */
  onSeedLayoutFromLocalStorage?: (layouts: Layouts) => Promise<void>;
  onNarrativeSave?: (blockId: string, title: string, body: string) => Promise<void>;
}

const COLS = { lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 } as const;
const ROW_HEIGHT = 32;
const GRID_MARGIN: [number, number] = [24, 24];
const STORAGE_PREFIX = 'dashboard-grid-layout:';
const HIDDEN_TILE_PREFIX = 'dashboard-hidden-tiles:';

type TileConfig = {
  w: number;
  h: number;
  minW: number;
  minH: number;
};

const TILE_CONFIG: Record<DashboardTile['kind'], TileConfig> = {
  chart: { w: 6, h: 12, minW: 3, minH: 4 },
  insight: { w: 4, h: 7, minW: 2, minH: 2 },
  action: { w: 4, h: 7, minW: 2, minH: 2 }, // Kept for backward compatibility but no longer used
  table: { w: 4, h: 8, minW: 2, minH: 3 },
  narrative: { w: 6, h: 10, minW: 3, minH: 4 },
};

const ResponsiveLayoutKeys = Object.keys(COLS) as Array<keyof typeof COLS>;

const placeTilesForCols = (tiles: DashboardTile[], cols: number): Layout[] => {
  if (cols <= 0) return [];
  const columnHeights = Array(cols).fill(0);

  return tiles.map((tile) => {
    const config = TILE_CONFIG[tile.kind];
    const w = Math.min(config.w, cols);
    const minW = Math.min(config.minW, cols);
    const h = config.h;
    const minH = config.minH;

    let bestX = 0;
    let bestY = Number.MAX_SAFE_INTEGER;

    for (let x = 0; x <= cols - w; x++) {
      const slice = columnHeights.slice(x, x + w);
      const height = Math.max(...slice);
      if (height < bestY) {
        bestY = height;
        bestX = x;
      }
    }

    for (let i = bestX; i < bestX + w; i++) {
      columnHeights[i] = bestY + h;
    }

    return {
      i: tile.id,
      x: bestX,
      y: bestY,
      w,
      h,
      minW,
      minH,
    };
  });
};

const generateLayouts = (tiles: DashboardTile[]): Layouts => {
  const baseLayouts: Layouts = {};

  ResponsiveLayoutKeys.forEach((key) => {
    baseLayouts[key] = placeTilesForCols(tiles, COLS[key]);
  });

  return baseLayouts;
};

const layoutStorageKey = (dashboardId: string, sheetId?: string) =>
  `${STORAGE_PREFIX}${dashboardId}${sheetId ? `:${sheetId}` : ''}`;

const loadStoredLayouts = (dashboardId: string, sheetId?: string): Layouts | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(layoutStorageKey(dashboardId, sheetId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed as Layouts;
    }
  } catch (error) {
    console.warn('Failed to parse stored dashboard layout', error);
  }
  return null;
};

const persistLayouts = (dashboardId: string, layouts: Layouts, sheetId?: string) => {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(layoutStorageKey(dashboardId, sheetId), JSON.stringify(layouts));
  } catch (error) {
    console.warn('Failed to persist dashboard layout', error);
  }
};

const ensureLayoutsForTiles = (layouts: Layouts, tiles: DashboardTile[], fallback: Layouts): Layouts => {
  const tileIds = new Set(tiles.map((tile) => tile.id));
  const next: Layouts = {};

  ResponsiveLayoutKeys.forEach((key) => {
    const current = layouts[key] ? [...layouts[key]] : [];
    const base = fallback[key] ?? [];

    const filtered = current.filter((item) => tileIds.has(item.i));

    const missingTiles = tiles.filter((tile) => !filtered.some((item) => item.i === tile.id));
    missingTiles.forEach((tile) => {
      const fallbackItem = base.find((item) => item.i === tile.id);
      if (fallbackItem) {
        filtered.push({ ...fallbackItem });
      } else {
        const config = TILE_CONFIG[tile.kind];
        filtered.push({
          i: tile.id,
          x: 0,
          y: filtered.length > 0 ? Math.max(...filtered.map((item) => item.y + item.h)) : 0,
          w: Math.min(config.w, COLS[key]),
          h: config.h,
          minW: Math.min(config.minW, COLS[key]),
          minH: config.minH,
        });
      }
    });

    next[key] = filtered;
  });

  return next;
};

const loadHiddenTiles = (dashboardId: string): Set<string> => {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(`${HIDDEN_TILE_PREFIX}${dashboardId}`);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((id) => typeof id === 'string'));
    }
  } catch (error) {
    console.warn('Failed to parse hidden tile ids', error);
  }
  return new Set();
};

const persistHiddenTiles = (dashboardId: string, hidden: Set<string>) => {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(`${HIDDEN_TILE_PREFIX}${dashboardId}`, JSON.stringify(Array.from(hidden)));
  } catch (error) {
    console.warn('Failed to persist hidden tile ids', error);
  }
};

export const DashboardTiles: React.FC<DashboardTilesProps> = ({
  dashboardId,
  tiles,
  onDeleteChart,
  onDeleteTable,
  filtersByTile,
  onTileFiltersChange,
  sheetId,
  onUpdate,
  canEdit = true, // Default to true for backward compatibility
  serverGridLayout,
  onPersistServerGrid,
  onSeedLayoutFromLocalStorage,
  onNarrativeSave,
}) => {
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => loadHiddenTiles(dashboardId));
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<
    { type: 'chart' | 'insight' | 'table'; index: number; title: string; chartIndex?: number } | null
  >(null);
  const [editingTile, setEditingTile] = useState<{ type: 'insight'; chartIndex: number; text: string } | null>(null);
  const [editingTable, setEditingTable] = useState<{ tableIndex: number; caption: string } | null>(null);
  const [editingNarrative, setEditingNarrative] = useState<{
    blockId: string;
    title: string;
    body: string;
  } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const { toast } = useToast();
  const { updateChartInsightOrRecommendation, updateTableCaption } = useDashboardContext();

  useEffect(() => {
    setHiddenIds(loadHiddenTiles(dashboardId));
  }, [dashboardId]);

  const visibleTiles = useMemo(
    () => tiles.filter((tile) => !hiddenIds.has(tile.id)),
    [hiddenIds, tiles]
  );

  const fallbackLayouts = useMemo(() => generateLayouts(visibleTiles), [visibleTiles]);
  const [layouts, setLayouts] = useState<Layouts>(() => fallbackLayouts);

  const layoutMigrateAttemptedRef = useRef(new Set<string>());

  const serverGridIsEmpty = useMemo(() => {
    if (!serverGridLayout || typeof serverGridLayout !== "object") return true;
    return ResponsiveLayoutKeys.every(
      (k) => !Array.isArray(serverGridLayout[k]) || serverGridLayout[k]!.length === 0
    );
  }, [serverGridLayout]);

  useEffect(() => {
    if (!canEdit || !sheetId || !onSeedLayoutFromLocalStorage) return;
    if (!serverGridIsEmpty) return;
    const migrateKey = `${dashboardId}:${sheetId}`;
    if (layoutMigrateAttemptedRef.current.has(migrateKey)) return;
    const stored = loadStoredLayouts(dashboardId, sheetId);
    if (!stored) return;
    const hasStoredLayout = ResponsiveLayoutKeys.some(
      (k) => Array.isArray(stored[k]) && stored[k]!.length > 0
    );
    if (!hasStoredLayout) return;
    layoutMigrateAttemptedRef.current.add(migrateKey);
    const merged = ensureLayoutsForTiles(stored, visibleTiles, fallbackLayouts);
    void onSeedLayoutFromLocalStorage(merged)
      .then(() => {
        try {
          localStorage.removeItem(layoutStorageKey(dashboardId, sheetId));
        } catch {
          /* ignore */
        }
      })
      .catch(() => {
        layoutMigrateAttemptedRef.current.delete(migrateKey);
      });
  }, [
    canEdit,
    sheetId,
    dashboardId,
    serverGridIsEmpty,
    onSeedLayoutFromLocalStorage,
    visibleTiles,
    fallbackLayouts,
  ]);

  useEffect(() => {
    if (serverGridLayout && Object.keys(serverGridLayout).length > 0) {
      const merged = ensureLayoutsForTiles(serverGridLayout, visibleTiles, fallbackLayouts);
      setLayouts(merged);
      return;
    }
    const stored = loadStoredLayouts(dashboardId, sheetId);
    if (stored) {
      const merged = ensureLayoutsForTiles(stored, visibleTiles, fallbackLayouts);
      setLayouts(merged);
    } else {
      setLayouts(fallbackLayouts);
    }
  }, [dashboardId, sheetId, serverGridLayout, fallbackLayouts, visibleTiles]);

  useEffect(() => {
    setLayouts((prev) => ensureLayoutsForTiles(prev, visibleTiles, fallbackLayouts));
  }, [visibleTiles, fallbackLayouts]);

  // Drag-drop swap semantics (fixes cascade-push UX):
  //  - Snapshot layouts when a drag begins.
  //  - While dragging, update visuals but don't persist (drag emits many layout changes).
  //  - On drag stop, resolve the final position via resolveLayoutsDropBySwap
  //    which swaps overlapped tiles, cancels cascade pushes on non-dragged
  //    tiles, and reverts on ambiguous drops.
  const isDraggingRef = useRef(false);
  const layoutsAtDragStartRef = useRef<Layouts | null>(null);
  const draggedIdRef = useRef<string | null>(null);

  // Dashboard UX polish · undo stack. Committed layouts are pushed after
  // every user-driven change (drag, resize); Cmd/Ctrl+Z restores the
  // previous snapshot via onUndo. Read-only dashboards (canEdit=false)
  // disable the hook so the global keybinding is free.
  const layoutHistory = useLayoutHistory({
    dashboardId,
    sheetId,
    enabled: canEdit,
    onUndo: (previous) => {
      setLayouts(previous);
      persistLayouts(dashboardId, previous, sheetId);
      onPersistServerGrid?.(previous);
    },
  });

  const handleLayoutChange = useCallback(
    (_current: Layout[], allLayouts: Layouts) => {
      const sanitized = ensureLayoutsForTiles(allLayouts, visibleTiles, fallbackLayouts);
      setLayouts(sanitized);
      // Defer persistence during an active drag; handleDragStop will apply
      // the resolved layout once the gesture completes.
      if (isDraggingRef.current) return;
      persistLayouts(dashboardId, sanitized, sheetId);
      onPersistServerGrid?.(sanitized);
      // Record non-drag layout commits (resize, tile add/remove) in the
      // undo stack. Drag commits are recorded from handleDragStop below.
      layoutHistory.push(sanitized);
    },
    [
      dashboardId,
      sheetId,
      fallbackLayouts,
      visibleTiles,
      onPersistServerGrid,
      layoutHistory,
    ]
  );

  const handleDragStart = useCallback(
    (_layout: Layout[], _oldItem: Layout, newItem: Layout) => {
      isDraggingRef.current = true;
      draggedIdRef.current = newItem.i;
      // Structured clone to avoid mutation from subsequent onLayoutChange calls.
      layoutsAtDragStartRef.current = JSON.parse(JSON.stringify(layouts));
    },
    [layouts]
  );

  const handleDragStop = useCallback(() => {
    const before = layoutsAtDragStartRef.current;
    const draggedId = draggedIdRef.current;
    isDraggingRef.current = false;
    layoutsAtDragStartRef.current = null;
    draggedIdRef.current = null;
    if (!before || !draggedId) {
      persistLayouts(dashboardId, layouts, sheetId);
      onPersistServerGrid?.(layouts);
      layoutHistory.push(layouts);
      return;
    }
    const resolved = resolveLayoutsDropBySwap(before, layouts, draggedId);
    const sanitized = ensureLayoutsForTiles(resolved, visibleTiles, fallbackLayouts);
    setLayouts(sanitized);
    persistLayouts(dashboardId, sanitized, sheetId);
    onPersistServerGrid?.(sanitized);
    layoutHistory.push(sanitized);
  }, [
    dashboardId,
    sheetId,
    layouts,
    fallbackLayouts,
    layoutHistory,
    visibleTiles,
    onPersistServerGrid,
  ]);

  const handleHideTile = useCallback(
    (tileId: string) => {
      setHiddenIds((prev) => {
        const next = new Set(prev);
        next.add(tileId);
        persistHiddenTiles(dashboardId, next);
        return next;
      });
    },
    [dashboardId]
  );

  const handleRestoreTiles = useCallback(() => {
    setHiddenIds(() => {
      const next = new Set<string>();
      persistHiddenTiles(dashboardId, next);
      return next;
    });
  }, [dashboardId]);

  const handleDeleteClick = useCallback((tile: DashboardTile) => {
    if (tile.kind === 'chart') {
      setPendingDelete({ type: 'chart', index: tile.index, title: tile.title || `Chart ${tile.index + 1}` });
      setDeleteConfirmOpen(true);
    } else if (tile.kind === 'insight') {
      // For insights, just remove the insight, not the chart
      if (tile.relatedChartId) {
        const relatedTile = tiles.find(t => t.id === tile.relatedChartId);
        if (relatedTile && relatedTile.kind === 'chart') {
          setPendingDelete({ 
            type: 'insight', 
            index: relatedTile.index,
            chartIndex: relatedTile.index,
            title: tile.title || 'Key Insight'
          });
          setDeleteConfirmOpen(true);
        }
      }
    } else if (tile.kind === 'table') {
      setPendingDelete({ type: 'table', index: tile.index, title: tile.title || `Table ${tile.index + 1}` });
      setDeleteConfirmOpen(true);
    }
  }, [tiles]);

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;

    if (pendingDelete.type === 'chart') {
      // Delete the entire chart
      if (!onDeleteChart) {
        toast({
          title: 'Error',
          description: 'Chart deletion is not available for this view.',
          variant: 'destructive',
        });
        setDeleteConfirmOpen(false);
        setPendingDelete(null);
        return;
      }
      onDeleteChart(pendingDelete.index);
      setDeleteConfirmOpen(false);
      setPendingDelete(null);
    } else if (pendingDelete.type === 'insight') {
      // Just remove the insight, not the chart
      if (pendingDelete.chartIndex === undefined) {
        toast({
          title: 'Error',
          description: 'Unable to delete: chart index not found',
          variant: 'destructive',
        });
        setDeleteConfirmOpen(false);
        setPendingDelete(null);
        return;
      }

      setIsSaving(true);
      try {
        await updateChartInsightOrRecommendation(
          dashboardId,
          pendingDelete.chartIndex,
          { keyInsight: '' },
          sheetId
        );
        
        toast({
          title: 'Success',
          description: 'Key insight deleted successfully.',
        });
        
        setDeleteConfirmOpen(false);
        setPendingDelete(null);
        
        // Refetch dashboards to get the updated data
        if (onUpdate) {
          await onUpdate();
        }
      } catch (error: any) {
        toast({
          title: 'Error',
          description: error?.message || 'Failed to delete insight',
          variant: 'destructive',
        });
      } finally {
        setIsSaving(false);
      }
    } else if (pendingDelete.type === 'table') {
      if (!onDeleteTable) {
        toast({
          title: 'Error',
          description: 'Table deletion is not available for this view.',
          variant: 'destructive',
        });
        setDeleteConfirmOpen(false);
        setPendingDelete(null);
        return;
      }

      onDeleteTable(pendingDelete.index);
      setDeleteConfirmOpen(false);
      setPendingDelete(null);
    }
  }, [pendingDelete, onDeleteChart, onDeleteTable, updateChartInsightOrRecommendation, dashboardId, sheetId, onUpdate, toast]);

  useEffect(() => {
    persistHiddenTiles(dashboardId, hiddenIds);
  }, [dashboardId, hiddenIds]);

  const renderTileContent = (tile: DashboardTile) => {
    switch (tile.kind) {
      case 'chart':
        return (
          <Card className="relative flex h-full flex-col overflow-hidden border border-border/60 bg-background shadow-elev-1 transition-[transform,box-shadow] duration-base ease-standard hover:shadow-elev-2 hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:hover:translate-y-0 dashboard-tile-grab-area group" data-dashboard-tile="chart">
            <CardHeader className="flex w-full items-center justify-between pb-2 pt-3 px-4">
            <div className="flex items-center justify-between w-full">
                <CardTitle className="text-base text-foreground">
                  {tile.title || `Chart ${tile.index + 1}`}
                </CardTitle>
                {canEdit && (
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      aria-label="Remove chart from dashboard"
                      onClick={() => handleDeleteClick(tile)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col gap-3 pt-0 px-4">
              <div className="flex-1 min-h-[120px] min-w-0" data-dashboard-chart-node>
                <Suspense fallback={<Skeleton className="h-full w-full" />}>
                  <ChartRenderer
                    chart={tile.chart}
                    index={tile.index}
                    isSingleChart={false}
                    showAddButton={false}
                    useChartOnlyModal
                    fillParent
                    enableFilters
                    filters={filtersByTile[tile.id]}
                    onFiltersChange={(next) => onTileFiltersChange(tile.id, next)}
                  />
                </Suspense>
              </div>
            </CardContent>
          </Card>
        );
      case 'insight': {
        const chartIndex = tile.relatedChartId ? parseInt(tile.relatedChartId.replace('chart-', ''), 10) : -1;
        return (
          <Card className="relative flex h-full flex-col overflow-hidden border border-primary/20 bg-primary/5 shadow-elev-1 transition-[transform,box-shadow] duration-base ease-standard hover:shadow-elev-2 hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:hover:translate-y-0 dashboard-tile-grab-area group" data-dashboard-tile="insight">
            <CardHeader className="flex w-full items-center justify-between pb-2 pt-3 px-4">
              <div className="flex items-center justify-between w-full">
                {tile.title && (
                  <CardTitle className="text-sm font-semibold text-primary flex-1 min-w-0">{tile.title}</CardTitle>
                )}
                {canEdit && (
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-primary hover:text-primary/80"
                      aria-label="Edit insight"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (chartIndex >= 0) {
                          setEditingTile({ type: 'insight', chartIndex, text: tile.narrative });
                        }
                      }}
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      aria-label="Remove insight tile"
                      onClick={() => handleDeleteClick(tile)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="flex-1 overflow-auto pt-0 px-4 pb-4">
              <p className="text-sm text-foreground/90 leading-relaxed">{tile.narrative}</p>
            </CardContent>
          </Card>
        );
      }
      case 'narrative':
        return (
          <Card
            className="relative flex h-full flex-col overflow-hidden border border-border/60 bg-muted/20 shadow-elev-1 transition-[transform,box-shadow] duration-base ease-standard hover:shadow-elev-2 hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:hover:translate-y-0 dashboard-tile-grab-area group"
            data-dashboard-tile="narrative"
          >
            <CardHeader className="flex w-full items-center justify-between pb-2 pt-3 px-4">
              <div className="flex items-center justify-between w-full gap-2">
                <CardTitle className="text-base text-foreground flex-1 min-w-0">
                  {tile.title}
                </CardTitle>
                {canEdit && onNarrativeSave && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 flex-shrink-0"
                    aria-label="Edit narrative"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingNarrative({
                        blockId: tile.block.id,
                        title: tile.block.title,
                        body: tile.block.body,
                      });
                    }}
                  >
                    <Edit2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="flex-1 overflow-auto pt-0 px-4 pb-4">
              <div className="text-sm text-foreground/90 leading-relaxed prose prose-sm dark:prose-invert max-w-none">
                <MarkdownRenderer content={tile.block.body} />
              </div>
            </CardContent>
          </Card>
        );
      case 'table': {
        return (
          <Card className="relative flex h-full flex-col overflow-hidden border border-primary/20 bg-primary/5 shadow-elev-1 transition-[transform,box-shadow] duration-base ease-standard hover:shadow-elev-2 hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:hover:translate-y-0 dashboard-tile-grab-area group" data-dashboard-tile="table">
            <CardHeader className="flex w-full items-center justify-between pb-2 pt-3 px-4">
              <div className="flex items-center justify-between w-full">
                <CardTitle className="text-sm font-semibold text-primary flex-1 min-w-0">
                  {tile.title || `Table ${tile.index + 1}`}
                </CardTitle>
                {canEdit && (
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-primary hover:text-primary/80"
                      aria-label="Edit table caption"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingTable({ tableIndex: tile.index, caption: tile.title });
                      }}
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      aria-label="Remove table tile"
                      onClick={() => handleDeleteClick(tile)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="flex-1 overflow-auto pt-0 px-4 pb-4">
              <div className="max-h-[220px] overflow-y-auto rounded-md border bg-background/50">
                {/* Reuse the existing table primitive for consistent styling */}
                <Table>
                  <TableHeader>
                    <TableRow>
                      {tile.table.columns.map((col, idx) => (
                        <TableHead key={idx} className="text-xs font-semibold text-muted-foreground">
                          {col}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tile.table.rows.map((row, rIdx) => (
                      <TableRow key={rIdx}>
                        {tile.table.columns.map((_, cIdx) => (
                          <TableCell key={cIdx} className="text-sm text-foreground">
                            {row?.[cIdx] ?? ''}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        );
      }
      default:
        return null;
    }
  };

  const hasHiddenTiles = hiddenIds.size > 0;

  return (
    <div className="space-y-4">
      <ResponsiveGridLayout
        className="dashboard-grid"
        layouts={layouts}
        cols={COLS}
        rowHeight={ROW_HEIGHT}
        margin={GRID_MARGIN}
        isResizable={canEdit}
        isDraggable={canEdit}
        resizeHandles={canEdit ? ['s', 'e', 'n', 'w', 'se', 'sw', 'ne', 'nw'] : []}
        onLayoutChange={handleLayoutChange}
        onDragStart={handleDragStart}
        onDragStop={handleDragStop}
        draggableHandle={canEdit ? ".dashboard-tile-grab-area" : ""}
        compactType={null}
        preventCollision={false}
        draggableCancel="[data-dashboard-tile='chart'] button, [data-dashboard-tile='insight'] button, [data-dashboard-tile='table'] button, [data-dashboard-tile='narrative'] button, [data-dashboard-tile='narrative'] textarea, [data-dashboard-tile='narrative'] input"
      >
        {visibleTiles.map((tile) => (
          <div key={tile.id} className="h-full w-full">
            {renderTileContent(tile)}
          </div>
        ))}
      </ResponsiveGridLayout>

      {hasHiddenTiles && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={handleRestoreTiles}>
            Restore hidden tiles
          </Button>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Deletion</DialogTitle>
            <DialogDescription>
              {pendingDelete?.type === 'chart' && (
                <>Are you sure you want to delete the chart "{pendingDelete.title}"? This will also remove its associated insights. This action cannot be undone.</>
              )}
              {pendingDelete?.type === 'insight' && (
                <>Are you sure you want to delete the key insight? This will remove only the insight, and the chart will remain. This action cannot be undone.</>
              )}
              {pendingDelete?.type === 'table' && (
                <>Are you sure you want to delete the table "{pendingDelete.title}"? This action cannot be undone.</>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setDeleteConfirmOpen(false);
              setPendingDelete(null);
            }}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirmDelete} disabled={isSaving}>
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                'Delete'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!editingNarrative}
        onOpenChange={(open) => {
          if (!open) setEditingNarrative(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit narrative</DialogTitle>
            <DialogDescription>Update the section title and body. Saved to the dashboard.</DialogDescription>
          </DialogHeader>
          {editingNarrative && (
            <div className="grid gap-3 py-2">
              <Input
                value={editingNarrative.title}
                onChange={(e) =>
                  setEditingNarrative((prev) =>
                    prev ? { ...prev, title: e.target.value } : prev
                  )
                }
                placeholder="Title"
              />
              <Textarea
                value={editingNarrative.body}
                onChange={(e) =>
                  setEditingNarrative((prev) =>
                    prev ? { ...prev, body: e.target.value } : prev
                  )
                }
                className="min-h-[200px]"
                placeholder="Body"
              />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingNarrative(null)}>
              Cancel
            </Button>
            <Button
              disabled={isSaving || !onNarrativeSave || !editingNarrative?.body.trim()}
              onClick={async () => {
                if (!editingNarrative || !onNarrativeSave) return;
                setIsSaving(true);
                try {
                  await onNarrativeSave(
                    editingNarrative.blockId,
                    editingNarrative.title.trim() || 'Section',
                    editingNarrative.body.trim()
                  );
                  setEditingNarrative(null);
                  toast({ title: 'Saved', description: 'Narrative updated.' });
                  if (onUpdate) await onUpdate();
                } catch (error: any) {
                  toast({
                    title: 'Error',
                    description: error?.message || 'Save failed',
                    variant: 'destructive',
                  });
                } finally {
                  setIsSaving(false);
                }
              }}
            >
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Insight Modal */}
      {editingTile && (
        <EditInsightModal
          isOpen={!!editingTile}
          onClose={() => setEditingTile(null)}
          onSave={async (text: string) => {
            if (editingTile.chartIndex < 0) return;
            setIsSaving(true);
            try {
              await updateChartInsightOrRecommendation(
                dashboardId,
                editingTile.chartIndex,
                { keyInsight: text },
                sheetId
              );
              setEditingTile(null);
              toast({
                title: 'Success',
                description: 'Key insight updated successfully.',
              });
              // Refetch dashboards to get the updated data
              if (onUpdate) {
                await onUpdate();
              }
            } catch (error: any) {
              toast({
                title: 'Error',
                description: error?.message || 'Failed to update insight',
                variant: 'destructive',
              });
            } finally {
              setIsSaving(false);
            }
          }}
          title="Key Insight"
          initialText={editingTile.text}
          isLoading={isSaving}
        />
      )}

      {/* Edit Table Caption Modal */}
      {editingTable && (
        <EditTableCaptionModal
          isOpen={!!editingTable}
          onClose={() => setEditingTable(null)}
          onSave={async (caption) => {
            setIsSaving(true);
            try {
              await updateTableCaption(dashboardId, editingTable.tableIndex, { caption }, sheetId);
              setEditingTable(null);
              toast({
                title: 'Success',
                description: 'Table caption updated successfully.',
              });
              if (onUpdate) {
                await onUpdate();
              }
            } catch (error: any) {
              toast({
                title: 'Error',
                description: error?.message || 'Failed to update table caption',
                variant: 'destructive',
              });
            } finally {
              setIsSaving(false);
            }
          }}
          title="Table Caption"
          initialCaption={editingTable.caption}
          isLoading={isSaving}
        />
      )}
    </div>
  );
};

