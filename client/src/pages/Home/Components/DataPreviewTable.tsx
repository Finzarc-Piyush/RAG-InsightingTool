import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { usePreviewTableSort } from '@/hooks/usePreviewTableSort';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Download, Loader2, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { downloadModifiedDataset, fetchSessionSampleRows } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import type { TemporalDisplayGrain, TemporalFacetColumnMeta } from '@/shared/schema';
import { formatDateCellForGrain, inferTemporalGrainFromSample } from '@/lib/temporalDisplayFormat';
import { facetColumnHeaderLabelForColumn, formatTemporalFacetValue } from '@/lib/temporalFacetDisplay';
import {
  buildPivotModel,
  createInitialPivotConfig,
  flattenPivotTree,
  normalizePivotConfig,
  syncFilterSelectionsWithFilters,
} from '@/lib/pivot';
import { logger } from '@/lib/logger';
import type { FilterSelections, PivotUiConfig } from '@/lib/pivot/types';
import { formatAnalysisNumber, parseNumericCell } from '@/lib/formatAnalysisNumber';
import { PivotFieldPanel } from './pivot/PivotFieldPanel';
import { PivotGrid } from './pivot/PivotGrid';

interface DataPreviewTableProps {
  data: Record<string, any>[];
  title?: string;
  maxRows?: number;
  sessionId?: string | null; // Session ID for downloading the full modified dataset
  /**
   * Schema column list for the dataset.
   * When provided, pivot/analysis UI should use this ordering instead of keys present
   * only in the current preview rows (so filters don't shrink available columns).
   */
  columns?: string[];
  numericColumns?: string[];
  dateColumns?: string[];
  temporalDisplayGrainsByColumn?: Record<string, TemporalDisplayGrain>;
  temporalFacetColumns?: TemporalFacetColumnMeta[];
  variant?: "dataset" | "analysis";
}

function inferNumericColumns(
  rows: Record<string, any>[],
  columnKeys: string[]
): string[] {
  const sample = rows.slice(0, 500);
  const out: string[] = [];
  for (const col of columnKeys) {
    let n = 0;
    let numeric = 0;
    for (const row of sample) {
      const v = row[col];
      if (v === null || v === undefined || v === '') continue;
      n++;
      const parsed = parseNumericCell(v);
      if (parsed !== null) numeric++;
    }
    if (n >= 2 && numeric / n >= 0.75) out.push(col);
  }
  return out;
}

function isIdLikeColumn(field: string): boolean {
  const f = field.trim().toLowerCase();
  return (
    f === 'id' ||
    f.endsWith('_id') ||
    f.endsWith(' id') ||
    f.includes(' id ') ||
    f.includes('row id') ||
    f.includes('order id') ||
    f.includes('customer id') ||
    f.includes('product id')
  );
}

export function DataPreviewTable({ 
  data, 
  title, 
  maxRows = 100, 
  sessionId,
  columns: schemaColumns,
  numericColumns: numericColumnsProp,
  dateColumns = [],
  temporalDisplayGrainsByColumn = {},
  temporalFacetColumns = [],
  variant = "dataset",
}: DataPreviewTableProps) {
  const [downloadingFormat, setDownloadingFormat] = useState<'xlsx' | null>(null);
  const { toast } = useToast();

  const [pivotConfig, setPivotConfig] = useState<PivotUiConfig>(() =>
    createInitialPivotConfig([], [], [], [])
  );
  const [filterSelections, setFilterSelections] = useState<FilterSelections>({});
  /** Tracks distinct filter values seen on prior syncs so new values can merge into selections. */
  const filterDistinctSnapshotRef = useRef<Record<string, Set<string>>>({});
  const [collapsedPivotGroups, setCollapsedPivotGroups] = useState<Set<string>>(
    () => new Set()
  );
  const [pivotPanelOpen, setPivotPanelOpen] = useState(true);
  const [analysisView, setAnalysisView] = useState<'pivot' | 'flat'>('pivot');
  /** Row-level rows from columnar store when sessionId is set (defense in depth vs aggregated-only preview). */
  const [sessionSampleRows, setSessionSampleRows] = useState<
    Record<string, unknown>[] | null
  >(null);

  useEffect(() => {
    if (variant !== 'analysis' || !sessionId) {
      setSessionSampleRows(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchSessionSampleRows(sessionId, 2000);
        if (!cancelled && Array.isArray(res.rows)) {
          setSessionSampleRows(res.rows as Record<string, unknown>[]);
        }
      } catch {
        if (!cancelled) setSessionSampleRows(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [variant, sessionId]);

  /** Prefer session sample for pivot when available; otherwise message preview rows. */
  const pivotRows = useMemo((): Record<string, unknown>[] => {
    const base = data ?? [];
    if (variant !== 'analysis') return base;
    if (sessionSampleRows && sessionSampleRows.length > 0) return sessionSampleRows;
    return base;
  }, [variant, data, sessionSampleRows]);

  // Schema-driven keys: used only for pivot config + “choose fields” UI.
  const schemaColumnKeys = useMemo(() => {
    const accept = (c: string) =>
      variant === "analysis" ? true : !String(c).startsWith("__tf_");

    const ordered: string[] = [];
    const seen = new Set<string>();

    if (schemaColumns && schemaColumns.length > 0) {
      for (const k of schemaColumns) {
        const key = String(k);
        if (!accept(key)) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        ordered.push(key);
      }
    }

    // Defensive fallback: append any keys found in the preview rows that aren't
    // present in the schema list. This prevents regressions when payload/schema diverge.
    if (Array.isArray(pivotRows) && pivotRows.length > 0) {
      const limit = Math.min(pivotRows.length, 500);
      for (let i = 0; i < limit; i++) {
        const row = pivotRows[i];
        if (!row) continue;
        for (const k of Object.keys(row)) {
          if (!accept(k)) continue;
          if (seen.has(k)) continue;
          seen.add(k);
          ordered.push(k);
        }
      }
    }

    return ordered;
  }, [pivotRows, variant, schemaColumns]);

  // Data-driven keys: used only for the analysis “Flat table” so we don’t show
  // columns that don’t actually exist in the current preview payload.
  const flatColumnKeys = useMemo(() => {
    if (!data || data.length === 0) return [];

    const limit = Math.min(data.length, 500);
    const ordered: string[] = [];
    const seen = new Set<string>();

    const accept = (c: string) =>
      variant === "analysis" ? true : !String(c).startsWith("__tf_");

    // Stable ordering: first-seen order, scanning rows from the beginning.
    for (let i = 0; i < limit; i++) {
      const row = data[i];
      if (!row) continue;
      for (const k of Object.keys(row)) {
        if (!accept(k)) continue;
        if (seen.has(k)) continue;
        seen.add(k);
        ordered.push(k);
      }
    }

    return ordered;
  }, [data, variant]);

  const numericColumns = useMemo(() => {
    const schemaNumeric = numericColumnsProp?.length
      ? numericColumnsProp
      : inferNumericColumns(pivotRows, schemaColumnKeys);

    if (!pivotRows?.length) return schemaNumeric;

    // Augment numeric measures discovered in the *actual preview payload*.
    // Some derived/renamed measures may not exist in schemaNumeric.
    const inferredFromPreview = inferNumericColumns(pivotRows, schemaColumnKeys);

    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of schemaNumeric) {
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
    }
    for (const c of inferredFromPreview) {
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c);
    }

    return out;
  }, [numericColumnsProp, pivotRows, schemaColumnKeys]);

  const numericColumnsSet = useMemo(() => new Set(numericColumns), [numericColumns]);

  const numericCandidatesInPreview = useMemo(() => {
    if (!pivotRows?.length) return [];
    const out: string[] = [];
    for (const col of numericColumns) {
      let found = false;
      for (const row of pivotRows) {
        const n = parseNumericCell(row[col]);
        if (n !== null) {
          found = true;
          break;
        }
      }
      if (found) out.push(col);
    }
    return out;
  }, [pivotRows, numericColumns]);

  const dimensionCandidatesInPreview = useMemo(() => {
    if (!pivotRows?.length) return [];
    const out: string[] = [];
    for (const col of schemaColumnKeys) {
      if (numericColumnsSet.has(col)) continue;
      let nonBlankCount = 0;
      for (const row of pivotRows) {
        const v = row[col];
        if (v === null || v === undefined) continue;
        const s = String(v).trim();
        if (!s || s.toLowerCase() === 'null' || s === '(blank)') continue;
        nonBlankCount += 1;
        if (nonBlankCount > 0) break;
      }
      if (nonBlankCount > 0) out.push(col);
    }
    return out;
  }, [pivotRows, schemaColumnKeys, numericColumnsSet]);

  const { defaultRowDim, defaultValueMeasures } = useMemo(() => {
    if (!pivotRows?.length) {
      return { defaultRowDim: null as string | null, defaultValueMeasures: [] as string[] };
    }

    // Pick best default dimension:
    // - non-numeric
    // - has non-blank values
    // - avoid ID-like columns (they aren't useful as row labels)
    let bestRow: { col: string; nonBlank: number; unique: number; schemaIndex: number } | null = null;
    for (const col of dimensionCandidatesInPreview) {
      if (isIdLikeColumn(col)) continue;
      const schemaIndex = schemaColumnKeys.indexOf(col);

      const uniques = new Set<string>();
      let nonBlank = 0;
      for (const row of pivotRows) {
        const v = row[col];
        if (v === null || v === undefined) continue;
        const s = String(v).trim();
        if (!s || s.toLowerCase() === 'null' || s === '(blank)') continue;
        nonBlank += 1;
        uniques.add(s);
      }

      if (nonBlank === 0) continue;
      const unique = uniques.size;
      const score = nonBlank + unique * 0.01;

      const bestScore = bestRow
        ? bestRow.nonBlank + bestRow.unique * 0.01
        : -Infinity;

      if (!bestRow || score > bestScore || (score === bestScore && schemaIndex < bestRow.schemaIndex)) {
        bestRow = { col, nonBlank, unique, schemaIndex };
      }
    }

    const defaultRowDimFallback =
      dimensionCandidatesInPreview.find((c) => !isIdLikeColumn(c)) ??
      dimensionCandidatesInPreview[0] ??
      null;

    const defaultRowDimResolved = bestRow?.col ?? defaultRowDimFallback;

    // Pick best default measure:
    // - numeric candidate with parseable values in preview
    // - avoid ID-like numeric columns
    let bestMeasure: { col: string; numericCount: number; sumAbs: number } | null = null;
    const measureCandidates = numericCandidatesInPreview.filter((c) => !isIdLikeColumn(c));
    const candidates = measureCandidates.length > 0 ? measureCandidates : numericCandidatesInPreview;

    for (const col of candidates) {
      let numericCount = 0;
      let sumAbs = 0;
      for (const row of pivotRows) {
        const n = parseNumericCell(row[col]);
        if (n === null) continue;
        numericCount += 1;
        sumAbs += Math.abs(n);
      }
      if (numericCount === 0) continue;
      if (!bestMeasure) {
        bestMeasure = { col, numericCount, sumAbs };
        continue;
      }
      if (
        numericCount > bestMeasure.numericCount ||
        (numericCount === bestMeasure.numericCount && sumAbs > bestMeasure.sumAbs)
      ) {
        bestMeasure = { col, numericCount, sumAbs };
      }
    }

    const defaultValueMeasuresResolved = bestMeasure ? [bestMeasure.col] : [];

    return {
      defaultRowDim: defaultRowDimResolved,
      defaultValueMeasures: defaultValueMeasuresResolved,
    };
  }, [
    pivotRows,
    dimensionCandidatesInPreview,
    numericCandidatesInPreview,
    schemaColumnKeys,
  ]);

  const pivotDataSignature = useMemo(() => {
    return `${schemaColumnKeys.join('\0')}\0${numericColumns.join('\0')}\0${
      defaultRowDim ?? ''
    }\0${defaultValueMeasures.join('\0')}`;
  }, [schemaColumnKeys, numericColumns, defaultRowDim, defaultValueMeasures]);

  useEffect(() => {
    if (variant !== 'analysis') return;
    setPivotConfig(
      normalizePivotConfig(
        schemaColumnKeys,
        createInitialPivotConfig(
          schemaColumnKeys,
          numericColumns,
          defaultRowDim ? [defaultRowDim] : [],
          defaultValueMeasures
        )
      )
    );
    setFilterSelections({});
    filterDistinctSnapshotRef.current = {};
    setCollapsedPivotGroups(new Set());
    setAnalysisView('pivot');
  }, [variant, pivotDataSignature]);

  useEffect(() => {
    if (variant !== 'analysis') return;
    setFilterSelections((prev) =>
      syncFilterSelectionsWithFilters(
        pivotRows as Record<string, unknown>[],
        pivotConfig.filters,
        prev,
        filterDistinctSnapshotRef
      )
    );
  }, [variant, pivotRows, pivotConfig.filters, pivotDataSignature]);

  const canPivot = useMemo(() => {
    if (variant !== 'analysis') return false;
    return Boolean(defaultRowDim && defaultValueMeasures.length > 0);
  }, [variant, defaultRowDim, defaultValueMeasures.length]);

  const normalizedPivotConfig = useMemo(
    () => normalizePivotConfig(schemaColumnKeys, pivotConfig),
    [schemaColumnKeys, pivotConfig]
  );

  // Help debug: pivot fields present in schema but missing from preview row keys won't show data until rows include them.
  useEffect(() => {
    if (variant !== 'analysis' || !pivotRows?.length) return;
    const sampleKeys = new Set<string>();
    for (let i = 0; i < Math.min(pivotRows.length, 500); i++) {
      const row = pivotRows[i];
      if (!row) continue;
      for (const k of Object.keys(row)) sampleKeys.add(k);
    }
    const pivotFields = [
      ...normalizedPivotConfig.rows,
      ...normalizedPivotConfig.columns,
      ...normalizedPivotConfig.filters,
    ];
    for (const f of pivotFields) {
      if (!sampleKeys.has(f)) {
        logger.debug(
          '[DataPreviewTable] Pivot field has no values in current preview rows:',
          f
        );
      }
    }
  }, [variant, pivotRows, normalizedPivotConfig]);

  const pivotModel = useMemo(() => {
    if (variant !== 'analysis' || !canPivot || analysisView !== 'pivot') return null;
    return buildPivotModel(
      pivotRows as Record<string, unknown>[],
      normalizedPivotConfig,
      normalizedPivotConfig.values,
      filterSelections
    );
  }, [
    variant,
    canPivot,
    analysisView,
    pivotRows,
    normalizedPivotConfig,
    filterSelections,
  ]);

  const pivotFlatRows = useMemo(() => {
    if (!pivotModel) return [];
    return flattenPivotTree(pivotModel.tree, collapsedPivotGroups);
  }, [pivotModel, collapsedPivotGroups]);

  const togglePivotCollapse = useCallback((pathKey: string) => {
    setCollapsedPivotGroups((prev) => {
      const next = new Set(prev);
      if (next.has(pathKey)) next.delete(pathKey);
      else next.add(pathKey);
      return next;
    });
  }, []);

  const handlePivotConfigChange = useCallback(
    (next: PivotUiConfig) =>
      setPivotConfig(normalizePivotConfig(schemaColumnKeys, next)),
    [schemaColumnKeys]
  );

  const handleRowSortChange = useCallback(
    (byValueSpecId: string) => {
      setPivotConfig((prev) => {
        const prevSort = prev.rowSort;
        const nextDirection =
          prevSort?.byValueSpecId === byValueSpecId && prevSort.direction === 'desc'
            ? 'asc'
            : 'desc';
        const next: PivotUiConfig = {
          ...prev,
          rowSort: { byValueSpecId, direction: nextDirection },
        };
        return normalizePivotConfig(schemaColumnKeys, next);
      });
    },
    [schemaColumnKeys]
  );

  const { sortedData, handleSort, getSortIcon } = usePreviewTableSort({
    data,
    columns: flatColumnKeys,
    numericColumns,
    dateColumns,
    variant,
  });

  const displayData = useMemo(() => {
    if (!sortedData || sortedData.length === 0) return [];
    return sortedData.slice(0, maxRows);
  }, [sortedData, maxRows]);

  const resolvedGrainsByColumn = useMemo(() => {
    const out: Record<string, TemporalDisplayGrain> = { ...temporalDisplayGrainsByColumn };
    for (const col of dateColumns) {
      if (!out[col]) {
        const vals = pivotRows.slice(0, 500).map((row) => row[col]);
        out[col] = inferTemporalGrainFromSample(vals);
      }
    }
    return out;
  }, [pivotRows, dateColumns, temporalDisplayGrainsByColumn]);

  const facetMetaByName = useMemo(() => {
    const m: Record<string, TemporalFacetColumnMeta> = {};
    for (const meta of temporalFacetColumns ?? []) {
      m[meta.name] = meta;
    }
    return m;
  }, [temporalFacetColumns]);

  const handleDownload = async (format: 'xlsx') => {
    if (!sessionId) {
      toast({
        title: 'Error',
        description: 'Session ID is required to download the dataset',
        variant: 'destructive',
      });
      return;
    }

    setDownloadingFormat(format);
    try {
      await downloadModifiedDataset(sessionId, format);
      toast({
        title: 'Success',
        description: `Dataset downloaded as ${format.toUpperCase()}`,
      });
    } catch (error: any) {
      toast({
        title: 'Download Failed',
        description: error?.message || 'Failed to download dataset',
        variant: 'destructive',
      });
    } finally {
      setDownloadingFormat(null);
    }
  };

  const renderFlatAnalysisCell = (col: string, raw: unknown): ReactNode => {
    if (raw === null || raw === undefined) {
      return <span className="text-muted-foreground italic">null</span>;
    }
    const facetMeta = facetMetaByName[col];
    if (facetMeta) {
      const formatted = formatTemporalFacetValue(raw, facetMeta.grain);
      return formatted ?? String(raw);
    }
    if (dateColumns.includes(col)) {
      const g = resolvedGrainsByColumn[col];
      const formatted =
        g !== undefined ? formatDateCellForGrain(raw, g) : null;
      return formatted ?? String(raw);
    }
    if (numericColumns.includes(col)) {
      const n = parseNumericCell(raw);
      return n !== null ? formatAnalysisNumber(n) : String(raw);
    }
    return String(raw);
  };

  // Early return after all hooks:
  // - For dataset preview, keep the existing "No data to display" behavior.
  // - For analysis mode, render pivot chrome even when rows are empty so the user can
  //   still change fields and debug filters.
  if (!data) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">No data to display</p>
      </Card>
    );
  }

  if (data.length === 0 && !(variant === 'analysis' && canPivot)) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">No data to display</p>
      </Card>
    );
  }

  // Flat table column set should reflect exactly the preview payload we received.
  const columns = flatColumnKeys;

  const showPivotChrome =
    variant === 'analysis' && canPivot && analysisView === 'pivot' && pivotModel;

  return (
    <Card className="p-4 mt-2 overflow-hidden border-border/60 shadow-sm bg-gradient-to-br from-card to-card/95">
      {(title ||
        sessionId ||
        (variant === 'analysis' && canPivot)) && (
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          {title && (
            <h4 className="text-sm font-semibold text-foreground">{title}</h4>
          )}
          <div className="flex items-center gap-2 ml-auto flex-wrap">
            {variant === 'analysis' && canPivot && (
              <div className="flex rounded-lg border border-border/80 bg-muted/30 p-0.5">
                <Button
                  type="button"
                  variant={analysisView === 'pivot' ? 'secondary' : 'ghost'}
                  size="sm"
                  className="text-xs h-8 px-3"
                  onClick={() => setAnalysisView('pivot')}
                >
                  Pivot
                </Button>
                <Button
                  type="button"
                  variant={analysisView === 'flat' ? 'secondary' : 'ghost'}
                  size="sm"
                  className="text-xs h-8 px-3"
                  onClick={() => setAnalysisView('flat')}
                >
                  Flat table
                </Button>
              </div>
            )}
            {sessionId && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleDownload('xlsx')}
                  disabled={downloadingFormat !== null}
                  className="text-xs"
                >
                  {downloadingFormat === 'xlsx' ? (
                    <>
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      Downloading...
                    </>
                  ) : (
                    <>
                      <Download className="h-3 w-3 mr-1" />
                      Download Excel
                    </>
                  )}
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      <div
        className={
          variant === 'analysis' && canPivot
            ? 'flex gap-0 items-stretch min-w-0'
            : undefined
        }
      >
        <div
          className={
            variant === 'analysis' && canPivot
              ? 'flex-1 min-w-0 pr-2'
              : undefined
          }
        >
          {showPivotChrome && pivotModel ? (
            normalizedPivotConfig.values.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center border rounded-lg border-dashed">
                Add at least one field to <strong>Values</strong> in Pivot fields.
              </p>
            ) : (
              <PivotGrid
                model={pivotModel}
                flatRows={pivotFlatRows}
                onToggleCollapse={togglePivotCollapse}
                temporalFacetColumns={temporalFacetColumns}
                    rowSort={normalizedPivotConfig.rowSort}
                    onRowSortChange={handleRowSortChange}
              />
            )
          ) : (
            <div
              className={
                variant === 'analysis' && canPivot
                  ? 'overflow-x-auto max-h-[500px] overflow-y-auto border border-border rounded-lg'
                  : 'overflow-x-auto max-w-[42rem] max-h-[500px] overflow-y-auto border border-border rounded-md'
              }
            >
              <table className="w-max border-collapse text-sm min-w-full">
                <thead className="sticky top-0 bg-muted/40 z-10">
                  <tr className="border-b border-border">
                    {columns.map((col) => (
                      <th
                        key={col}
                        className="px-3 py-2 text-left font-semibold text-foreground bg-muted/40 whitespace-nowrap"
                      >
                        <button
                          type="button"
                          onClick={() => handleSort(col)}
                          className="inline-flex items-center font-semibold text-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 rounded"
                        >
                          {variant === "analysis"
                            ? facetColumnHeaderLabelForColumn(col, temporalFacetColumns)
                            : col}
                          {getSortIcon(col)}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {displayData.map((row, idx) => (
                    <tr
                      key={idx}
                      className="border-b border-border hover:bg-muted/30 transition-colors"
                    >
                      {columns.map((col) => {
                        const raw = row[col];
                        return (
                          <td
                            key={col}
                            className="px-3 py-2 text-foreground whitespace-nowrap"
                          >
                            {variant === 'analysis'
                              ? renderFlatAnalysisCell(col, raw)
                              : raw === null || raw === undefined ? (
                                  <span className="text-muted-foreground italic">null</span>
                                ) : dateColumns.includes(col) ? (
                                  (() => {
                                    const g = resolvedGrainsByColumn[col];
                                    const formatted =
                                      g !== undefined
                                        ? formatDateCellForGrain(raw, g)
                                        : null;
                                    return formatted ?? String(raw);
                                  })()
                                ) : (
                                  String(raw)
                                )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <AnimatePresence mode="popLayout">
          {variant === 'analysis' && canPivot && (
            <motion.div
              key="pivot-panel"
              initial={false}
              animate={{
                width: pivotPanelOpen ? 300 : 44,
                opacity: 1,
              }}
              transition={{ type: 'spring', stiffness: 380, damping: 32 }}
              className="shrink-0 flex flex-col border-l border-border/60 bg-muted/10 rounded-r-lg overflow-hidden"
            >
              <div className="flex flex-1 min-h-0 min-w-0">
                <button
                  type="button"
                  onClick={() => setPivotPanelOpen((o) => !o)}
                  className="shrink-0 w-11 flex flex-col items-center justify-center gap-1 py-3 border-r border-border/50 bg-muted/20 hover:bg-muted/40 transition-colors text-muted-foreground hover:text-foreground"
                  aria-expanded={pivotPanelOpen}
                  aria-label={pivotPanelOpen ? 'Collapse pivot fields' : 'Expand pivot fields'}
                >
                  {pivotPanelOpen ? (
                    <PanelRightClose className="h-4 w-4" />
                  ) : (
                    <PanelRightOpen className="h-4 w-4" />
                  )}
                  <span
                    className="text-[10px] font-semibold uppercase tracking-wider"
                    style={{
                      writingMode: 'vertical-rl',
                      transform: 'rotate(180deg)',
                    }}
                  >
                    Fields
                  </span>
                </button>
                <AnimatePresence initial={false}>
                  {pivotPanelOpen && (
                    <motion.div
                      key="panel-inner"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.15 }}
                      className="flex-1 min-w-0 p-2.5 overflow-hidden"
                    >
                      <PivotFieldPanel
                        config={normalizedPivotConfig}
                        onConfigChange={handlePivotConfigChange}
                        filterSelections={filterSelections}
                        onFilterSelectionsChange={setFilterSelections}
                        data={data as Record<string, unknown>[]}
                        numericColumns={numericColumns}
                        temporalFacetColumns={temporalFacetColumns}
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {data.length > maxRows && !(variant === 'analysis' && canPivot && analysisView === 'pivot') && (
        <p className="text-xs text-muted-foreground mt-2">
          Showing {maxRows} of {data.length} rows
        </p>
      )}
    </Card>
  );
}

interface DataSummaryTableProps {
  summary: Array<{
    variable: string;
    datatype: string;
    total_values: number;
    null_values: number;
    non_null_values: number;
    mean?: number | null;
    median?: number | null;
    std_dev?: number | null;
    min?: number | null;
    max?: number | null;
    mode?: any;
  }>;
}

export function DataSummaryTable({ summary }: DataSummaryTableProps) {
  if (!summary || summary.length === 0) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">No summary data available</p>
      </Card>
    );
  }

  return (
    <Card className="p-4 mt-2">
      <h4 className="text-sm font-semibold mb-3 text-foreground">Data Summary</h4>
      <div className="overflow-x-auto max-h-[500px] overflow-y-auto border border-border rounded-md">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 bg-muted/40 z-10">
            <tr className="border-b border-border">
              <th className="px-3 py-2 text-left font-semibold text-foreground bg-muted/40">Variable</th>
              <th className="px-3 py-2 text-left font-semibold text-foreground bg-muted/40">Datatype</th>
              <th className="px-3 py-2 text-left font-semibold text-foreground bg-muted/40">#Values</th>
              <th className="px-3 py-2 text-left font-semibold text-foreground bg-muted/40">#Nulls</th>
              <th className="px-3 py-2 text-left font-semibold text-foreground bg-muted/40">Mean</th>
              <th className="px-3 py-2 text-left font-semibold text-foreground bg-muted/40">Median</th>
              <th className="px-3 py-2 text-left font-semibold text-foreground bg-muted/40">Mode</th>
              <th className="px-3 py-2 text-left font-semibold text-foreground bg-muted/40">STD Dev</th>
            </tr>
          </thead>
          <tbody>
            {summary.map((row, idx) => (
              <tr
                key={idx}
                className="border-b border-border hover:bg-muted/30 transition-colors"
              >
                <td className="px-3 py-2 text-foreground font-medium">{row.variable}</td>
                <td className="px-3 py-2 text-muted-foreground">{row.datatype}</td>
                <td className="px-3 py-2 text-foreground">{row.total_values}</td>
                <td className="px-3 py-2 text-foreground">{row.null_values}</td>
                <td className="px-3 py-2 text-foreground">
                  {row.mean !== null && row.mean !== undefined
                    ? typeof row.mean === 'number'
                      ? row.mean.toFixed(2)
                      : String(row.mean)
                    : '-'}
                </td>
                <td className="px-3 py-2 text-foreground">
                  {row.median !== null && row.median !== undefined
                    ? typeof row.median === 'number'
                      ? row.median.toFixed(2)
                      : String(row.median)
                    : '-'}
                </td>
                <td className="px-3 py-2 text-foreground">
                  {row.mode !== null && row.mode !== undefined
                    ? String(row.mode)
                    : '-'}
                </td>
                <td className="px-3 py-2 text-foreground">
                  {row.std_dev !== null && row.std_dev !== undefined
                    ? typeof row.std_dev === 'number'
                      ? row.std_dev.toFixed(2)
                      : String(row.std_dev)
                    : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
