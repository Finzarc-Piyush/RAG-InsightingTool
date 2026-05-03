import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DashboardData } from '../modules/useDashboardState';
import { useToast } from '@/hooks/use-toast';
import * as htmlToImage from 'html-to-image';
import PptxGenJS from 'pptxgenjs';
import { DashboardSection, DashboardTile } from '../types';
import type { Layouts } from 'react-grid-layout';
import { dashboardsApi } from '@/lib/api/dashboards';
import { DashboardHeader } from './DashboardHeader';
import { DashboardTiles } from './DashboardTiles';
import { CapturedFilterBanner } from './CapturedFilterBanner';
import { ShareDashboardDialog } from './ShareDashboardDialog';
import { ActiveChartFilters, hasActiveFilters } from '@/lib/chartFilters';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { ChevronLeft, ChevronRight, FileText, Edit2, Check, X, Trash2, Download, Loader2, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useDashboardContext } from '../context/DashboardContext';
import { getUserEmail } from '@/utils/userStorage';
import {
  EXPORT_BRAND,
  EXPORT_FONT_FAMILY,
  EXPORT_PIXEL_RATIO,
  SLIDE_HEIGHT_IN,
  SLIDE_WIDTH_IN,
} from '../exportTheme';

interface DashboardViewProps {
  dashboard: DashboardData;
  onBack: () => void;
  onDeleteChart: (chartIndex: number, sheetId?: string) => void;
  onDeleteTable: (tableIndex: number, sheetId?: string) => void;
  isRefreshing?: boolean;
  onRefresh?: () => Promise<any>;
  permission?: "view" | "edit"; // Optional permission, defaults to checking ownership
}

const PPT_LAYOUT = 'LAYOUT_16x9';

export function DashboardView({ dashboard, onBack, onDeleteChart, onDeleteTable, isRefreshing = false, onRefresh, permission }: DashboardViewProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [serverExportBusy, setServerExportBusy] = useState<"pdf" | "pptx" | null>(null);
  const [activeSheetId, setActiveSheetId] = useState<string | null>(null);
  const [isSheetSidebarOpen, setIsSheetSidebarOpen] = useState(true);
  const [tileFilters, setTileFilters] = useState<Record<string, ActiveChartFilters>>({});
  const [editingSheetId, setEditingSheetId] = useState<string | null>(null);
  const [editSheetName, setEditSheetName] = useState('');
  const [deleteSheetDialogOpen, setDeleteSheetDialogOpen] = useState(false);
  const [sheetToDelete, setSheetToDelete] = useState<{ id: string; name: string } | null>(null);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [selectedSheetIds, setSelectedSheetIds] = useState<Set<string>>(new Set());
  const [addSheetDialogOpen, setAddSheetDialogOpen] = useState(false);
  const [newSheetName, setNewSheetName] = useState('');
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const { toast } = useToast();
  const {
    renameDashboard,
    renameSheet,
    addSheet,
    removeSheet,
    refetch: refetchDashboards,
    patchSheetContent,
  } = useDashboardContext();

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

  const chartTiles = useMemo(
    () => sections.flatMap((section) => section.tiles).filter((tile): tile is DashboardTile & { kind: 'chart' } => tile.kind === 'chart'),
    [sections]
  );

  const activeSection = sections.find((section) => section.id === activeSheetId) ?? sections[0];

  useEffect(() => {
    const validIds = new Set(
      sections.flatMap((section) => section.tiles.map((tile) => tile.id))
    );
    setTileFilters((prev) => {
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

  useEffect(() => {
    setTileFilters({});
  }, [dashboard.id, activeSheetId]);

  const handleTileFiltersChange = useCallback((tileId: string, filters: ActiveChartFilters) => {
    setTileFilters((prev) => {
      const next = { ...prev };
      if (hasActiveFilters(filters)) {
        next[tileId] = filters;
      } else {
        delete next[tileId];
      }
      return next;
    });
  }, []);


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

  // W12 · rich PPTX assembly. Slide order:
  //   1. Cover (dashboard name + envelope.tldr + date + brand band)
  //   2. Executive Summary block (one slide per featured chart/pivot, with
  //      keyInsight / matching finding alongside)
  //   3. Recommendations (envelope.recommendations grouped by horizon)
  //   4. All Artefacts slides (every captured tile, no exec chrome)
  //   5. Methodology + caveats (envelope.methodology / caveats / domainLens)
  //   6. Closing (original question + footer)
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
      const pptx = new PptxGenJS();
      pptx.layout = PPT_LAYOUT;
      pptx.author = 'Marico Insighting Tool';

      const slideW = SLIDE_WIDTH_IN;
      const slideH = SLIDE_HEIGHT_IN;
      const envelope = dashboard.answerEnvelope;
      const today = new Date().toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });

      // ── Cover slide ─────────────────────────────────────────────────
      const cover = pptx.addSlide();
      cover.background = { color: EXPORT_BRAND.background };
      // brand accent band on the left edge
      cover.addShape(pptx.ShapeType.rect, {
        x: 0,
        y: 0,
        w: 0.18,
        h: slideH,
        fill: { color: EXPORT_BRAND.primary },
        line: { color: EXPORT_BRAND.primary },
      });
      cover.addText(dashboard.name || 'Dashboard', {
        x: 0.7,
        y: 2.2,
        w: slideW - 1.4,
        h: 1.0,
        fontSize: 36,
        bold: true,
        color: EXPORT_BRAND.title,
        fontFace: EXPORT_FONT_FAMILY,
      });
      if (envelope?.tldr) {
        cover.addText(envelope.tldr, {
          x: 0.7,
          y: 3.4,
          w: slideW - 1.4,
          h: 1.6,
          fontSize: 16,
          color: EXPORT_BRAND.foreground,
          fontFace: EXPORT_FONT_FAMILY,
          valign: 'top',
        });
      }
      cover.addText(today, {
        x: 0.7,
        y: slideH - 0.8,
        w: slideW - 1.4,
        h: 0.4,
        fontSize: 11,
        color: EXPORT_BRAND.muted,
        fontFace: EXPORT_FONT_FAMILY,
      });
      cover.addText('Marico Insighting Tool', {
        x: 0.7,
        y: slideH - 0.45,
        w: slideW - 1.4,
        h: 0.3,
        fontSize: 10,
        color: EXPORT_BRAND.muted,
        fontFace: EXPORT_FONT_FAMILY,
      });

      // ── Capture every tile across all selected sheets ──────────────
      const originalActiveSheetId = activeSheetId;
      type CapturedTile = {
        sheetName: string;
        kind: 'chart' | 'pivot';
        title: string;
        keyInsight?: string;
        imgData?: string;
      };
      const captured: CapturedTile[] = [];

      for (const sheetId of sheetsToExport) {
        const sheet = sheets.find((s) => s.id === sheetId);
        if (!sheet) continue;

        setActiveSheetId(sheetId);
        // Allow PivotTile fetches + chart renders to settle before capture.
        await new Promise((r) => setTimeout(r, 800));

        const chartNodes = Array.from(
          document.querySelectorAll('[data-dashboard-chart-node]')
        ) as HTMLElement[];
        for (let i = 0; i < (sheet.charts?.length ?? 0); i++) {
          const node = chartNodes[i];
          let imgData: string | undefined;
          if (node) {
            try {
              imgData = await htmlToImage.toPng(node, {
                cacheBust: true,
                backgroundColor: '#FFFFFF',
                style: { boxShadow: 'none' },
                pixelRatio: EXPORT_PIXEL_RATIO,
                quality: 1.0,
              });
            } catch (err) {
              console.warn('Chart capture failed', err);
            }
          }
          captured.push({
            sheetName: sheet.name,
            kind: 'chart',
            title: sheet.charts[i]?.title ?? `Chart ${i + 1}`,
            keyInsight: sheet.charts[i]?.keyInsight,
            imgData,
          });
        }

        // Pivot capture (W11) — uses the same pixelRatio path.
        const pivotNodes = Array.from(
          document.querySelectorAll('[data-dashboard-pivot-node]')
        ) as HTMLElement[];
        for (let i = 0; i < (sheet.pivots?.length ?? 0); i++) {
          const node = pivotNodes[i];
          let imgData: string | undefined;
          if (node) {
            try {
              imgData = await htmlToImage.toPng(node, {
                cacheBust: true,
                backgroundColor: '#FFFFFF',
                style: { boxShadow: 'none' },
                pixelRatio: EXPORT_PIXEL_RATIO,
                quality: 1.0,
              });
            } catch (err) {
              console.warn('Pivot capture failed', err);
            }
          }
          captured.push({
            sheetName: sheet.name,
            kind: 'pivot',
            title: sheet.pivots![i]?.title ?? `Pivot ${i + 1}`,
            imgData,
          });
        }
      }

      setActiveSheetId(originalActiveSheetId);

      // Helper: a content slide with the brand header band.
      const addContentSlide = (title: string) => {
        const s = pptx.addSlide();
        s.background = { color: EXPORT_BRAND.background };
        s.addShape(pptx.ShapeType.rect, {
          x: 0,
          y: 0,
          w: slideW,
          h: 0.18,
          fill: { color: EXPORT_BRAND.primary },
          line: { color: EXPORT_BRAND.primary },
        });
        s.addText(title, {
          x: 0.4,
          y: 0.3,
          w: slideW - 0.8,
          h: 0.6,
          fontSize: 22,
          bold: true,
          color: EXPORT_BRAND.title,
          fontFace: EXPORT_FONT_FAMILY,
        });
        return s;
      };

      // Helper: render a captured tile onto a slide with insight panel.
      const addTileSlide = (
        title: string,
        imgData: string | undefined,
        insightPairs: Array<{ heading: string; body: string }>
      ) => {
        const s = addContentSlide(title);
        const imgX = 0.4;
        const imgY = 1.1;
        const imgW = 7.6;
        const imgH = 5.5;
        if (imgData) {
          s.addImage({ data: imgData, x: imgX, y: imgY, w: imgW, h: imgH });
        } else {
          s.addText('(Image capture unavailable)', {
            x: imgX,
            y: imgY,
            w: imgW,
            h: imgH,
            fontSize: 12,
            color: EXPORT_BRAND.muted,
            fontFace: EXPORT_FONT_FAMILY,
          });
        }
        const rightX = imgX + imgW + 0.3;
        const rightW = slideW - rightX - 0.4;
        let y = imgY;
        for (const p of insightPairs) {
          if (!p.body?.trim()) continue;
          s.addText(p.heading, {
            x: rightX,
            y,
            w: rightW,
            h: 0.3,
            fontSize: 12,
            bold: true,
            color: EXPORT_BRAND.primary,
            fontFace: EXPORT_FONT_FAMILY,
          });
          y += 0.35;
          s.addText(p.body, {
            x: rightX,
            y,
            w: rightW,
            h: 1.6,
            fontSize: 11,
            color: EXPORT_BRAND.foreground,
            fontFace: EXPORT_FONT_FAMILY,
            wrap: true,
            valign: 'top',
          });
          y += 1.7;
        }
        return s;
      };

      // ── Executive summary slides ──────────────────────────────────
      const execSheet = sheets.find(
        (s) => s.id === 'sheet_summary' || s.name.toLowerCase().includes('executive')
      );
      const execChartTitles = new Set(
        (execSheet?.charts ?? []).map((c) => c.title?.toLowerCase()).filter(Boolean) as string[]
      );
      const execPivotTitles = new Set(
        (execSheet?.pivots ?? []).map((p) => p.title?.toLowerCase()).filter(Boolean) as string[]
      );
      const execTiles = captured.filter((t) =>
        t.kind === 'chart'
          ? execChartTitles.has(t.title.toLowerCase())
          : execPivotTitles.has(t.title.toLowerCase())
      );
      const findingByTitle = new Map<string, string>();
      for (const f of envelope?.findings ?? []) {
        if (f.headline) findingByTitle.set(f.headline.toLowerCase(), f.evidence ?? '');
      }
      for (const t of execTiles) {
        const matchedFinding = findingByTitle.get(t.title.toLowerCase());
        addTileSlide(`Executive summary — ${t.title}`, t.imgData, [
          { heading: 'Key insight', body: t.keyInsight ?? '' },
          { heading: 'Evidence', body: matchedFinding ?? '' },
        ]);
      }

      // ── Recommendations slide ─────────────────────────────────────
      if (envelope?.recommendations?.length) {
        const s = addContentSlide('Recommendations');
        const groups: Record<string, string[]> = { now: [], this_quarter: [], strategic: [] };
        for (const r of envelope.recommendations) {
          const horizon = r.horizon ?? 'now';
          (groups[horizon] ??= []).push(`• ${r.action} — ${r.rationale}`);
        }
        const labels: Record<string, string> = {
          now: 'Now',
          this_quarter: 'This quarter',
          strategic: 'Strategic',
        };
        let y = 1.2;
        for (const horizon of ['now', 'this_quarter', 'strategic'] as const) {
          const items = groups[horizon];
          if (!items?.length) continue;
          s.addText(labels[horizon], {
            x: 0.4,
            y,
            w: slideW - 0.8,
            h: 0.4,
            fontSize: 14,
            bold: true,
            color: EXPORT_BRAND.primary,
            fontFace: EXPORT_FONT_FAMILY,
          });
          y += 0.45;
          s.addText(items.join('\n'), {
            x: 0.4,
            y,
            w: slideW - 0.8,
            h: 0.5 * items.length + 0.4,
            fontSize: 12,
            color: EXPORT_BRAND.foreground,
            fontFace: EXPORT_FONT_FAMILY,
            valign: 'top',
            wrap: true,
          });
          y += 0.5 * items.length + 0.5;
        }
      }

      // ── All Artefacts slides ──────────────────────────────────────
      // Includes every captured tile not already on Sheet 1 (avoid dupes).
      const execTitleSet = new Set(execTiles.map((t) => `${t.kind}::${t.title.toLowerCase()}`));
      const restTiles = captured.filter(
        (t) => !execTitleSet.has(`${t.kind}::${t.title.toLowerCase()}`)
      );
      for (const t of restTiles) {
        addTileSlide(t.title, t.imgData, t.keyInsight ? [{ heading: 'Key insight', body: t.keyInsight }] : []);
      }

      // ── Methodology + caveats slide ───────────────────────────────
      if (envelope?.methodology || envelope?.caveats?.length || envelope?.domainLens) {
        const s = addContentSlide('Methodology');
        let y = 1.2;
        if (envelope.methodology) {
          s.addText(envelope.methodology, {
            x: 0.4,
            y,
            w: slideW - 0.8,
            h: 1.6,
            fontSize: 12,
            color: EXPORT_BRAND.foreground,
            fontFace: EXPORT_FONT_FAMILY,
            valign: 'top',
            wrap: true,
          });
          y += 1.7;
        }
        if (envelope.caveats?.length) {
          s.addText('Caveats', {
            x: 0.4,
            y,
            w: slideW - 0.8,
            h: 0.4,
            fontSize: 14,
            bold: true,
            color: EXPORT_BRAND.primary,
            fontFace: EXPORT_FONT_FAMILY,
          });
          y += 0.45;
          s.addText(envelope.caveats.map((c: string) => `• ${c}`).join('\n'), {
            x: 0.4,
            y,
            w: slideW - 0.8,
            h: 0.4 * envelope.caveats.length + 0.3,
            fontSize: 12,
            color: EXPORT_BRAND.foreground,
            fontFace: EXPORT_FONT_FAMILY,
            valign: 'top',
            wrap: true,
          });
          y += 0.4 * envelope.caveats.length + 0.4;
        }
        if (envelope.domainLens) {
          s.addText('Domain context', {
            x: 0.4,
            y,
            w: slideW - 0.8,
            h: 0.4,
            fontSize: 14,
            bold: true,
            color: EXPORT_BRAND.primary,
            fontFace: EXPORT_FONT_FAMILY,
          });
          y += 0.45;
          s.addText(envelope.domainLens, {
            x: 0.4,
            y,
            w: slideW - 0.8,
            h: 1.2,
            fontSize: 12,
            color: EXPORT_BRAND.foreground,
            fontFace: EXPORT_FONT_FAMILY,
            valign: 'top',
            wrap: true,
          });
        }
      }

      // ── Closing slide ─────────────────────────────────────────────
      const closing = addContentSlide('Original question');
      // Original question lives in sheet narrative blocks — find a "custom" block
      // titled "Original question" or fall back to the dashboard name.
      const originalQ = (() => {
        for (const s of sheets) {
          for (const b of s.narrativeBlocks ?? []) {
            if (b.title?.toLowerCase().startsWith('original question')) return b.body;
          }
        }
        return '';
      })();
      if (originalQ) {
        closing.addText(originalQ, {
          x: 0.4,
          y: 1.2,
          w: slideW - 0.8,
          h: 4.5,
          fontSize: 16,
          color: EXPORT_BRAND.foreground,
          fontFace: EXPORT_FONT_FAMILY,
          valign: 'top',
          wrap: true,
        });
      }
      closing.addText('Generated by Marico Insighting Tool', {
        x: 0.4,
        y: slideH - 0.55,
        w: slideW - 0.8,
        h: 0.3,
        fontSize: 10,
        color: EXPORT_BRAND.muted,
        fontFace: EXPORT_FONT_FAMILY,
      });

      const fileName =
        sheetsToExport.length === sheets.length
          ? `${dashboard.name || 'dashboard'}.pptx`
          : `${dashboard.name || 'dashboard'}_${sheetsToExport.length}_sheets.pptx`;

      await pptx.writeFile({ fileName });
      toast({
        title: 'Export complete',
        description: `Downloaded ${fileName}.`,
      });
    } catch (err) {
      console.error(err);
      toast({
        title: 'Export failed',
        description: 'Please try again or contact support.',
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
    <div className="bg-muted/30 h-[calc(100vh-72px)] flex flex-col overflow-y-auto">
      <div className="flex-shrink-0 px-4 pt-8 pb-4 lg:px-8">
        <DashboardHeader
          name={dashboard.name}
          lastOpenedAt={dashboard.lastOpenedAt}
          updatedAt={dashboard.updatedAt}
          sheetCount={sheets.length}
          isExporting={isExporting}
          onBack={onBack}
          onExport={handleExportClick}
          onShare={canEdit ? () => setShareDialogOpen(true) : undefined}
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

        {/* Wave-FA6 · Provenance banner: when the dashboard was captured under
            an active filter, surface the filter conditions so the viewer knows
            this dashboard reflects a slice of the dataset, not the whole. */}
        {dashboard.capturedActiveFilter && dashboard.capturedActiveFilter.conditions.length > 0 && (
          <CapturedFilterBanner spec={dashboard.capturedActiveFilter} />
        )}
      </div>

      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Collapsible Sheet Sidebar */}
        {sheets.length > 0 && (
          <>
            <div
              className={cn(
                "flex-shrink-0 bg-background border-r border-border transition-all duration-300 ease-in-out overflow-hidden",
                isSheetSidebarOpen ? "w-64" : "w-0"
              )}
            >
              <div className="h-full flex flex-col">
                <div className="flex items-center justify-between p-4 border-b">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-sm text-foreground">Views</h3>
                    {canEdit && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => {
                          setNewSheetName('');
                          setAddSheetDialogOpen(true);
                        }}
                      >
                        <Plus className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => setIsSheetSidebarOpen(false)}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                  <div className="space-y-1">
                    {sheets.map((sheet) => {
                      const isActive = activeSheetId === sheet.id;
                      const isEditing = editingSheetId === sheet.id;
                      
                      const handleStartEdit = (e: React.MouseEvent) => {
                        e.stopPropagation();
                        setEditingSheetId(sheet.id);
                        setEditSheetName(sheet.name);
                      };

                      const handleSaveSheet = async (e: React.MouseEvent) => {
                        e.stopPropagation();
                        if (!editSheetName.trim() || editSheetName.trim() === sheet.name) {
                          setEditingSheetId(null);
                          return;
                        }
                        try {
                          await renameSheet(dashboard.id, sheet.id, editSheetName.trim());
                          setEditingSheetId(null);
                          if (onRefresh) {
                            await onRefresh();
                          }
                          await refetchDashboards();
                        } catch (error: any) {
                          toast({
                            title: 'Error',
                            description: error?.message || 'Failed to rename view',
                            variant: 'destructive',
                          });
                        }
                      };

                      const handleCancelEdit = (e: React.MouseEvent) => {
                        e.stopPropagation();
                        setEditingSheetId(null);
                        setEditSheetName('');
                      };

                      const handleKeyDown = (e: React.KeyboardEvent) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleSaveSheet(e as any);
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          handleCancelEdit(e as any);
                        }
                      };

                      const handleDeleteClick = (e: React.MouseEvent) => {
                        e.stopPropagation();
                        setSheetToDelete({ id: sheet.id, name: sheet.name });
                        setDeleteSheetDialogOpen(true);
                      };

                      return (
                        <div
                          key={sheet.id}
                          className={cn(
                            // UX-4 · Sheet sidebar row. Active = left
                            // accent bar + subtle primary tint; hover =
                            // surface-hover utility from the tokens.
                            "relative w-full flex items-center gap-2 px-3 py-2.5 rounded-brand-md transition-colors duration-quick ease-standard group",
                            isActive && !isEditing
                              ? "bg-primary/10 text-foreground"
                              : "text-foreground hover:surface-hover"
                          )}
                        >
                          {isActive && !isEditing ? (
                            <span
                              aria-hidden="true"
                              className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-primary animate-brand-underline origin-top"
                            />
                          ) : null}
                          <FileText
                            className={cn(
                              "h-4 w-4 flex-shrink-0",
                              isActive && !isEditing
                                ? "text-primary"
                                : "text-muted-foreground"
                            )}
                          />
                          {isEditing ? (
                            <div className="flex-1 flex items-center gap-1">
                              <Input
                                value={editSheetName}
                                onChange={(e) => setEditSheetName(e.target.value)}
                                onKeyDown={handleKeyDown}
                                onClick={(e) => e.stopPropagation()}
                                className="h-7 text-sm"
                                autoFocus
                              />
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={handleSaveSheet}
                                className="h-6 w-6"
                              >
                                <Check className="h-3 w-3" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={handleCancelEdit}
                                className="h-6 w-6"
                              >
                                <X className="h-3 w-3" />
                              </Button>
                            </div>
                          ) : (
                            <>
                              <button
                                onClick={() => setActiveSheetId(sheet.id)}
                                className="flex-1 min-w-0 text-left"
                              >
                                <div
                                  className={cn(
                                    "font-medium text-sm truncate",
                                    isActive && "text-foreground"
                                  )}
                                >
                                  {sheet.name}
                                </div>
                                <div className="text-xs truncate text-muted-foreground">
                                  {sheet.charts.length} chart{sheet.charts.length !== 1 ? 's' : ''}
                                </div>
                              </button>
                              {canEdit && (
                                <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-quick ease-standard">
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={handleStartEdit}
                                    className="h-6 w-6 flex-shrink-0"
                                    aria-label="Rename view"
                                  >
                                    <Edit2 className="h-3 w-3" />
                                  </Button>
                                  {sheets.length > 1 && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      onClick={handleDeleteClick}
                                      className="h-6 w-6 flex-shrink-0 hover:text-destructive"
                                      aria-label="Delete view"
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </Button>
                                  )}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
            
            {/* Collapsed Sidebar Toggle Button */}
            {!isSheetSidebarOpen && (
              <div className="flex-shrink-0 border-r border-border">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-full w-8 rounded-none"
                  onClick={() => setIsSheetSidebarOpen(true)}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}
          </>
        )}

        <div className="flex-1 min-h-0 flex flex-col gap-8 px-4 pb-8 lg:px-8 overflow-hidden">
          <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
            {activeSection ? (
              <section
                key={activeSection.id}
                id={`section-${activeSection.id}`}
                className="space-y-4"
                data-dashboard-section={activeSection.id}
              >
                <div>
                  <h2 className="text-lg font-semibold text-foreground">{activeSection.title}</h2>
                  {activeSection.description && (
                    <p className="text-sm text-muted-foreground">{activeSection.description}</p>
                  )}
                </div>

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
                  filtersByTile={tileFilters}
                  onTileFiltersChange={handleTileFiltersChange}
                  sheetId={currentSheetId || undefined}
                  onUpdate={onRefresh}
                  canEdit={canEdit}
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
    </div>
  );
}
