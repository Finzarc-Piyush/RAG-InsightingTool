import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PivotTile } from './PivotTile';

// DR18D · chart rendering and ErrorBoundary moved into `ChartTileBody`
// when the chart-tile case was extracted to host the chart/pivot
// view-mode hook. Suspense / Skeleton / lazy(ChartRenderer) /
// ChartShim / AlertTriangle now live there.

// DR11 · right-click context menu for tiles. Items mirror the inline
// hover affordances but are discoverable via the standard OS gesture
// for power users.
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

const ResponsiveGridLayout = WidthProvider(Responsive);

import { ActiveChartFilters } from '@/lib/chartFilters';
import type { InsightRegenCache } from '../lib/insightRegenCache';
import type { InsightHistoryStore } from '../lib/insightHistory';
import { MarkdownRenderer } from '@/components/ui/markdown-renderer';
// DR18G · resolveLayoutsDropBySwap is no longer called. The helper
// + its tests stay in the codebase (deprecated) for revival if a
// future spec wants explicit swap-on-drop layered on top of vertical
// compaction. Removing the import here keeps tsc clean.
import { useLayoutHistory } from '@/pages/Dashboard/hooks/useLayoutHistory';
import { cn } from '@/lib/utils';
import { TileHeader } from './TileHeader';
import { useDashboardEditMode } from '../context/DashboardEditModeContext';
import { contentDrivenHeight } from '../contentDrivenHeight';
// DR18D · chart-tile body extracted so the per-tile chart/pivot
// view-mode hook (`useChartTileViewMode`) can host its state. The
// extraction also collects DR3 / DR8 / DR18B markup into one place.
import { ChartTileBody } from './ChartTileBody';
import { chartSpecToPivotConfig } from '@/components/charts/chartSpecToPivotConfig';
import { useChartTileViewMode } from '../hooks/useChartTileViewMode';
import { Table2 } from 'lucide-react';

interface DashboardTilesProps {
  dashboardId: string;
  tiles: DashboardTile[];
  onDeleteChart?: (chartIndex: number) => void;
  onDeleteTable?: (tableIndex: number) => void;
  onDeletePivot?: (pivotIndex: number) => void;
  /** Source session powering pivot tile data fetches. */
  sessionId?: string | null;
  filtersByTile: Record<string, ActiveChartFilters>;
  /**
   * DR4 · per-tile list of column names from the global filter that the
   * tile's data does not carry. Surfaced as a small badge in the tile
   * header so users see which globals don't apply where, instead of
   * silently no-op-ping. Empty / missing entry → no badge.
   */
  inapplicableColumnsByTile?: Record<string, string[]>;
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
  /**
   * Wave WI2-wire-bind · shared insight-regen cache instance scoped
   * to the parent `DashboardView` mount. Forwarded into every chart
   * tile so `useInsightRegen` reads/writes a single LRU+TTL store,
   * not a per-tile fallback. Optional so existing call sites stay
   * compatible.
   */
  insightRegenCache?: InsightRegenCache;
  /**
   * Wave WI6 · shared per-tile insight history store scoped to the
   * parent `DashboardView` mount. Forwarded into every chart tile so
   * the footer's "Recent insights" dropdown reads a single per-mount
   * navigator. Optional so existing call sites stay compatible.
   */
  insightHistoryStore?: InsightHistoryStore;
}

const COLS = { lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 } as const;
const ROW_HEIGHT = 32;
// DR8 · tighter gutters give the canvas a denser, dashboard-grade feel
// without compromising drag-grip ergonomics.
const GRID_MARGIN: [number, number] = [16, 16];
const STORAGE_PREFIX = 'dashboard-grid-layout:';
const HIDDEN_TILE_PREFIX = 'dashboard-hidden-tiles:';

type TileConfig = {
  w: number;
  h: number;
  minW: number;
  minH: number;
};

const TILE_CONFIG: Record<DashboardTile['kind'], TileConfig> = {
  // 3-up by default: w=4 of a 12-col grid for chart/pivot tiles.
  // DR8 · default height drops 16 → 14 since the keyInsight footer
  // (DR3) carries less vertical chrome than the pre-DR3 strip.
  chart: { w: 4, h: 14, minW: 3, minH: 6 },
  insight: { w: 4, h: 7, minW: 2, minH: 2 }, // Legacy standalone-insight kind; no longer emitted by DashboardView.
  action: { w: 4, h: 7, minW: 2, minH: 2 }, // Kept for backward compatibility but no longer used
  table: { w: 4, h: 8, minW: 2, minH: 3 },
  narrative: { w: 6, h: 10, minW: 3, minH: 4 },
  pivot: { w: 4, h: 12, minW: 3, minH: 4 },
};

const ResponsiveLayoutKeys = Object.keys(COLS) as Array<keyof typeof COLS>;

const placeTilesForCols = (tiles: DashboardTile[], cols: number): Layout[] => {
  if (cols <= 0) return [];
  const columnHeights = Array(cols).fill(0);

  return tiles.map((tile) => {
    const config = TILE_CONFIG[tile.kind];
    const w = Math.min(config.w, cols);
    const minW = Math.min(config.minW, cols);
    // DR18A · narrative tiles seed at content-aware height; other
    // kinds stay at the fixed default. Persisted layouts are
    // unaffected (this code only runs at fresh-seed time).
    const h = contentDrivenHeight(tile, config, w);
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
        const w = Math.min(config.w, COLS[key]);
        filtered.push({
          i: tile.id,
          x: 0,
          y: filtered.length > 0 ? Math.max(...filtered.map((item) => item.y + item.h)) : 0,
          w,
          // DR18A · same content-aware seed for tiles inserted by the
          // ensure-layouts path (e.g. a narrative tile freshly added
          // via the AddTileMenu).
          h: contentDrivenHeight(tile, config, w),
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
  onDeletePivot,
  sessionId,
  filtersByTile,
  inapplicableColumnsByTile,
  onTileFiltersChange,
  sheetId,
  onUpdate,
  canEdit = true, // Default to true for backward compatibility
  serverGridLayout,
  onPersistServerGrid,
  onSeedLayoutFromLocalStorage,
  onNarrativeSave,
  insightRegenCache,
  insightHistoryStore,
}) => {
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => loadHiddenTiles(dashboardId));
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<
    { type: 'chart' | 'insight' | 'table' | 'pivot'; index: number; title: string; chartIndex?: number } | null
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
  // DR3 · drag/resize affordances and the action-slot inside TileHeader
  // are gated on edit mode. Permission (canEdit) is still enforced at
  // mutation time; mode is the user's *current* intent.
  const { mode: editMode } = useDashboardEditMode();
  const isEditing = canEdit && editMode === 'edit';

  useEffect(() => {
    setHiddenIds(loadHiddenTiles(dashboardId));
  }, [dashboardId]);

  const visibleTiles = useMemo(
    () => tiles.filter((tile) => !hiddenIds.has(tile.id)),
    [hiddenIds, tiles]
  );

  const fallbackLayouts = useMemo(() => generateLayouts(visibleTiles), [visibleTiles]);
  const [layouts, setLayouts] = useState<Layouts>(() => fallbackLayouts);

  // Dashboard UX polish · aria-live announcements for keyboard + screen-reader
  // users. Paired with an sr-only region rendered below the grid.
  const [layoutAnnouncement, setLayoutAnnouncement] = useState<string>("");
  const tileNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const tile of visibleTiles) {
      const friendly =
        (tile as { title?: string }).title ||
        tile.id ||
        tile.kind;
      map.set(tile.id, friendly);
    }
    return map;
  }, [visibleTiles]);

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

  // DR18G · drag-drop with vertical compaction. The grid is configured
  // with `compactType="vertical"` (see `<ResponsiveGridLayout>` below)
  // so RGL packs tiles toward the top after every drop. Drop on
  // another tile pushes it (and others) aside, then everything
  // compacts up to fill any gaps. The pre-DR18G swap-on-collision
  // logic is removed — vertical compaction handles the cascade-push
  // UX naturally.
  //
  //  - Snapshot layouts when a drag begins (still used for undo via
  //    layoutHistory).
  //  - While dragging, update visuals but don't persist (drag emits
  //    many onLayoutChange events).
  //  - On drag stop, persist the as-is layout (RGL has already
  //    compacted it) and record an undo entry.
  const isDraggingRef = useRef(false);
  const layoutsAtDragStartRef = useRef<Layouts | null>(null);
  const draggedIdRef = useRef<string | null>(null);

  // Dashboard UX polish · keyboard move-mode.
  // Tab to focus a tile; Space to grab; Arrow keys to nudge one grid cell;
  // Space again to commit (reuses the same swap resolver as mouse drops);
  // Escape to cancel and restore the pre-grab layout.
  const [grabbedTileId, setGrabbedTileId] = useState<string | null>(null);
  const layoutsAtGrabRef = useRef<Layouts | null>(null);

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
      setLayoutAnnouncement("Reverted the last layout change.");
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
    // DR18G · with vertical compaction enabled on the grid, RGL has
    // already laid out + compacted `layouts` by the time onDragStop
    // fires (via the upstream `onLayoutChange`). The pre-DR18G
    // `resolveLayoutsDropBySwap` call has been removed: it existed
    // to undo cascade-pushes that vertical compaction now naturally
    // resolves. Persist the as-is layout, push to history, announce.
    const draggedId = draggedIdRef.current;
    isDraggingRef.current = false;
    layoutsAtDragStartRef.current = null;
    draggedIdRef.current = null;
    const sanitized = ensureLayoutsForTiles(layouts, visibleTiles, fallbackLayouts);
    if (sanitized !== layouts) setLayouts(sanitized);
    persistLayouts(dashboardId, sanitized, sheetId);
    onPersistServerGrid?.(sanitized);
    layoutHistory.push(sanitized);
    if (draggedId) {
      const draggedName = tileNameById.get(draggedId) ?? "Tile";
      setLayoutAnnouncement(`${draggedName} moved.`);
    }
  }, [
    dashboardId,
    sheetId,
    layouts,
    fallbackLayouts,
    layoutHistory,
    visibleTiles,
    onPersistServerGrid,
    tileNameById,
  ]);

  // Dashboard UX polish · keyboard move handlers.
  // Nudges operate on the `lg` breakpoint (12 cols). Narrower viewports
  // are mouse-friendly by default; the tile is still Tab-focusable there
  // so screen readers hear the tile's aria-label.
  const LG_COLS = 12;

  const nudgeGrabbedTile = useCallback(
    (dx: number, dy: number) => {
      if (!grabbedTileId) return;
      setLayouts((prev) => {
        const lgArr = prev.lg ?? [];
        const target = lgArr.find((l) => l.i === grabbedTileId);
        if (!target) return prev;
        const maxX = Math.max(0, LG_COLS - target.w);
        const nextX = Math.min(maxX, Math.max(0, target.x + dx));
        const nextY = Math.max(0, target.y + dy);
        if (nextX === target.x && nextY === target.y) return prev;
        const nextLg = lgArr.map((l) =>
          l.i === grabbedTileId ? { ...l, x: nextX, y: nextY } : l
        );
        return { ...prev, lg: nextLg };
      });
    },
    [grabbedTileId]
  );

  const beginGrab = useCallback(
    (tileId: string) => {
      layoutsAtGrabRef.current = structuredClone(layouts);
      setGrabbedTileId(tileId);
      const name = tileNameById.get(tileId) ?? "Tile";
      setLayoutAnnouncement(
        `${name} grabbed. Use arrow keys to move, Space to drop, Escape to cancel.`
      );
    },
    [layouts, tileNameById]
  );

  const commitGrab = useCallback(() => {
    // DR18G · same simplification as `handleDragStop`. Vertical
    // compaction in the grid means RGL has already arranged the
    // layout to its final compacted form via onLayoutChange; this
    // commit just persists that state and advances the history
    // stack. Keyboard arrow up/down become near-no-ops with vertical
    // compact (the tile bubbles back to its compacted slot); left/
    // right still relocate horizontally. Documented limitation —
    // future polish wave can reframe up/down as "swap with vertical
    // neighbor" if requested.
    const id = grabbedTileId;
    if (!id) {
      setGrabbedTileId(null);
      return;
    }
    const sanitized = ensureLayoutsForTiles(layouts, visibleTiles, fallbackLayouts);
    if (sanitized !== layouts) setLayouts(sanitized);
    persistLayouts(dashboardId, sanitized, sheetId);
    onPersistServerGrid?.(sanitized);
    layoutHistory.push(sanitized);
    const name = tileNameById.get(id) ?? "Tile";
    setLayoutAnnouncement(`${name} placed.`);
    setGrabbedTileId(null);
    layoutsAtGrabRef.current = null;
  }, [
    grabbedTileId,
    layouts,
    visibleTiles,
    fallbackLayouts,
    dashboardId,
    sheetId,
    onPersistServerGrid,
    layoutHistory,
    tileNameById,
  ]);

  const cancelGrab = useCallback(() => {
    const before = layoutsAtGrabRef.current;
    if (before) {
      setLayouts(before);
    }
    const name = grabbedTileId ? tileNameById.get(grabbedTileId) ?? "Tile" : "Tile";
    setLayoutAnnouncement(`${name} move cancelled.`);
    setGrabbedTileId(null);
    layoutsAtGrabRef.current = null;
  }, [grabbedTileId, tileNameById]);

  const handleTileKeyDown = useCallback(
    (tileId: string) =>
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (!canEdit) return;
        // Space toggles grab-mode / commits a grab.
        if (e.key === " " || e.key === "Spacebar") {
          e.preventDefault();
          if (grabbedTileId === tileId) commitGrab();
          else if (grabbedTileId === null) beginGrab(tileId);
          return;
        }
        if (grabbedTileId !== tileId) return;
        if (e.key === "Escape") {
          e.preventDefault();
          cancelGrab();
          return;
        }
        const arrowMap: Record<string, [number, number]> = {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, -1],
          ArrowDown: [0, 1],
        };
        const delta = arrowMap[e.key];
        if (delta) {
          e.preventDefault();
          nudgeGrabbedTile(delta[0], delta[1]);
        }
      },
    [canEdit, grabbedTileId, beginGrab, commitGrab, cancelGrab, nudgeGrabbedTile]
  );

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
    } else if (tile.kind === 'pivot') {
      setPendingDelete({ type: 'pivot', index: tile.index, title: tile.title || `Pivot ${tile.index + 1}` });
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
    } else if (pendingDelete.type === 'pivot') {
      if (!onDeletePivot) {
        toast({
          title: 'Error',
          description: 'Pivot deletion is not available for this view.',
          variant: 'destructive',
        });
        setDeleteConfirmOpen(false);
        setPendingDelete(null);
        return;
      }
      onDeletePivot(pendingDelete.index);
      setDeleteConfirmOpen(false);
      setPendingDelete(null);
    }
  }, [pendingDelete, onDeleteChart, onDeleteTable, onDeletePivot, updateChartInsightOrRecommendation, dashboardId, sheetId, onUpdate, toast]);

  useEffect(() => {
    persistHiddenTiles(dashboardId, hiddenIds);
  }, [dashboardId, hiddenIds]);

  /**
   * DR11 · wrap a tile body in a right-click context menu when there
   * are items to show. In view mode `items` is empty and the wrapper
   * is skipped so the user never sees an empty popover.
   */
  const withContextMenu = (
    node: React.ReactNode,
    items: React.ReactNode,
  ): React.ReactNode => {
    if (!isEditing) return node;
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{node}</ContextMenuTrigger>
        <ContextMenuContent className="w-48">{items}</ContextMenuContent>
      </ContextMenu>
    );
  };

  const renderTileContent = (tile: DashboardTile) => {
    switch (tile.kind) {
      case 'chart': {
        const inapplicable = inapplicableColumnsByTile?.[tile.id] ?? [];
        const canPivot = chartSpecToPivotConfig(tile.chart) !== null;
        const chartContextItems = (
          <>
            {canPivot ? (
              <ChartTilePivotMenuItem dashboardId={dashboardId} tileId={tile.id} />
            ) : null}
            {tile.chart.keyInsight !== undefined ? (
              <ContextMenuItem
                onSelect={() =>
                  setEditingTile({
                    type: 'insight',
                    chartIndex: tile.index,
                    text: tile.chart.keyInsight ?? '',
                  })
                }
              >
                <Edit2 className="h-3.5 w-3.5 mr-2" />
                Edit insight
              </ContextMenuItem>
            ) : null}
            {canEdit ? (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onSelect={() => handleDeleteClick(tile)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5 mr-2" />
                  Delete chart
                </ContextMenuItem>
              </>
            ) : null}
          </>
        );
        return withContextMenu(
          <ChartTileBody
            tile={tile}
            dashboardId={dashboardId}
            canEdit={canEdit}
            isEditing={isEditing}
            inapplicableColumns={inapplicable}
            filters={filtersByTile[tile.id]}
            onFiltersChange={(next) => onTileFiltersChange(tile.id, next)}
            onDeleteClick={() => handleDeleteClick(tile)}
            onEditInsight={() =>
              setEditingTile({
                type: 'insight',
                chartIndex: tile.index,
                text: tile.chart.keyInsight ?? '',
              })
            }
            insightRegenCache={insightRegenCache}
            insightHistoryStore={insightHistoryStore}
          />,
          chartContextItems,
        );
      }
      case 'insight': {
        const chartIndex = tile.relatedChartId ? parseInt(tile.relatedChartId.replace('chart-', ''), 10) : -1;
        return (
          <Card className="relative flex h-full flex-col overflow-hidden border border-primary/20 bg-primary/5 shadow-elev-1 transition-[transform,box-shadow] duration-base ease-standard hover:shadow-elev-2 hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:hover:translate-y-0 dashboard-tile-grab-area group" data-dashboard-tile="insight">
            <TileHeader
              title={tile.title || 'Insight'}
              titleClassName="text-primary"
              actions={canEdit ? (
                <>
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
                </>
              ) : undefined}
            />
            <CardContent className="flex-1 overflow-auto pt-0 px-4 pb-4">
              <p className="text-sm text-foreground/90 leading-relaxed">{tile.narrative}</p>
            </CardContent>
          </Card>
        );
      }
      case 'narrative': {
        // Narrative delete is intentionally absent — the existing
        // dispatcher (`handleDeleteClick`) has no narrative branch and
        // adding one needs the patchSheetContent path. Edit covers the
        // common case for this wave.
        const narrativeContextItems = canEdit && onNarrativeSave ? (
          <ContextMenuItem
            onSelect={() =>
              setEditingNarrative({
                blockId: tile.block.id,
                title: tile.block.title,
                body: tile.block.body,
              })
            }
          >
            <Edit2 className="h-3.5 w-3.5 mr-2" />
            Edit narrative
          </ContextMenuItem>
        ) : null;
        return withContextMenu(
          <Card
            className="relative flex h-full flex-col overflow-hidden border border-border/60 bg-muted/20 shadow-elev-1 transition-[transform,box-shadow] duration-base ease-standard hover:shadow-elev-2 hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:hover:translate-y-0 dashboard-tile-grab-area group"
            data-dashboard-tile="narrative"
          >
            <TileHeader
              title={tile.title}
              actions={canEdit && onNarrativeSave ? (
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
              ) : undefined}
            />
            <CardContent className="flex-1 overflow-auto pt-0 px-4 pb-4">
              <div className="text-sm text-foreground/90 leading-relaxed prose prose-sm dark:prose-invert max-w-none">
                <MarkdownRenderer content={tile.block.body} />
              </div>
            </CardContent>
          </Card>,
          narrativeContextItems,
        );
      }
      case 'pivot': {
        return (
          <PivotTile
            pivot={tile.pivot}
            sessionId={sessionId}
            canEdit={canEdit}
            onDelete={canEdit ? () => handleDeleteClick(tile) : undefined}
          />
        );
      }
      case 'table': {
        const tableContextItems = canEdit ? (
          <>
            <ContextMenuItem
              onSelect={() => setEditingTable({ tableIndex: tile.index, caption: tile.title })}
            >
              <Edit2 className="h-3.5 w-3.5 mr-2" />
              Edit caption
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              onSelect={() => handleDeleteClick(tile)}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" />
              Delete table
            </ContextMenuItem>
          </>
        ) : null;
        return withContextMenu(
          <Card className="relative flex h-full flex-col overflow-hidden border border-border/60 bg-card shadow-elev-1 transition-[transform,box-shadow] duration-base ease-standard hover:shadow-elev-2 hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:hover:translate-y-0 dashboard-tile-grab-area group" data-dashboard-tile="table">
            <TileHeader
              title={tile.title || `Table ${tile.index + 1}`}
              actions={canEdit ? (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
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
                </>
              ) : undefined}
            />
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
          </Card>,
          tableContextItems,
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
        isResizable={isEditing}
        isDraggable={isEditing}
        resizeHandles={isEditing ? ['s', 'e', 'n', 'w', 'se', 'sw', 'ne', 'nw'] : []}
        onLayoutChange={handleLayoutChange}
        onDragStart={handleDragStart}
        onDragStop={handleDragStop}
        draggableHandle={isEditing ? ".dashboard-tile-grab-area" : ""}
        // DR18G · vertical compaction. Pre-DR18G the grid ran with
        // `compactType={null}` + custom `resolveLayoutsDropBySwap` on
        // drop, which produced a cascade-push bug: dropping a chart
        // onto another shoved the target (and everything below) down,
        // and they stayed shifted because there was no compaction. The
        // custom restore logic could itself create new overlaps,
        // re-triggering RGL's collision push and leaving tiles
        // "pushed by a thousand miles." Vertical compaction makes
        // tiles always pack toward the top — drop on a tile pushes
        // it aside, then everything compacts. Empty space below is
        // automatically reclaimed. Existing dashboards self-heal:
        // gaps close on first render, persisting their compacted
        // form on the next layout-change event.
        compactType="vertical"
        preventCollision={false}
        draggableCancel="[data-dashboard-tile='chart'] button, [data-dashboard-tile='insight'] button, [data-dashboard-tile='table'] button, [data-dashboard-tile='narrative'] button, [data-dashboard-tile='narrative'] textarea, [data-dashboard-tile='narrative'] input, [data-dashboard-tile='pivot'] button"
      >
        {visibleTiles.map((tile) => {
          const isGrabbed = grabbedTileId === tile.id;
          return (
            <div
              key={tile.id}
              className={cn(
                "h-full w-full rounded-brand-lg outline-none",
                // Focus ring whenever the wrapper itself has focus.
                "focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                // Grab-mode ring — stronger and always visible while
                // arrows are in play.
                isGrabbed
                  ? "ring-2 ring-primary/80 ring-offset-2 ring-offset-background shadow-elev-3"
                  : undefined
              )}
              role="group"
              aria-roledescription="dashboard tile"
              aria-label={tileNameById.get(tile.id) ?? tile.id}
              aria-grabbed={isGrabbed || undefined}
              tabIndex={isEditing ? 0 : -1}
              onKeyDown={handleTileKeyDown(tile.id)}
            >
              {renderTileContent(tile)}
            </div>
          );
        })}
      </ResponsiveGridLayout>

      {/*
        Dashboard UX polish · screen-reader announcer.
        sr-only + aria-live="polite" so the surface stays invisible to
        sighted users but AT announces tile moves, swaps, and undos.
      */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {layoutAnnouncement}
      </div>

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
              {pendingDelete?.type === 'pivot' && (
                <>Are you sure you want to delete the pivot "{pendingDelete.title}"? This action cannot be undone.</>
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

/**
 * DR18D · context-menu item that flips the chart tile between chart
 * and pivot view. Renders inside the chart-tile context menu (DR11).
 * Lives at the end of the file because it needs `useChartTileViewMode`
 * — the chart tile's body itself is in `ChartTileBody.tsx`, but the
 * context menu items are composed in `DashboardTiles.renderTileContent`
 * outside the body, so this thin wrapper bridges the two.
 */
function ChartTilePivotMenuItem({
  dashboardId,
  tileId,
}: {
  dashboardId: string;
  tileId: string;
}) {
  const { mode, toggle } = useChartTileViewMode(dashboardId, tileId);
  return (
    <ContextMenuItem onSelect={() => toggle()}>
      <Table2 className="h-3.5 w-3.5 mr-2" />
      {mode === 'pivot' ? 'View as chart' : 'View as pivot table'}
    </ContextMenuItem>
  );
}

