import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { usePreviewTableSort } from '@/hooks/usePreviewTableSort';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Download, Lightbulb, Loader2, PanelRightClose, PanelRightOpen } from 'lucide-react';
import {
  downloadModifiedDataset,
  fetchSessionSampleRows,
  pivotQuery,
  pivotDrillthrough,
} from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import type {
  TemporalDisplayGrain,
  TemporalFacetColumnMeta,
  PivotModel as PivotModelContract,
  PivotQueryRequest,
  ChartSpec,
} from '@/shared/schema';
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
import { parseDateLike } from '@/lib/parseDateLike';
import { api } from '@/lib/httpClient';
import { recommendPivotChart, type PivotChartKind } from '@/lib/pivot/chartRecommendation';
import { PivotFieldPanel } from './pivot/PivotFieldPanel';
import { PivotGrid, type PivotShowValuesAsMode } from './pivot/PivotGrid';
import { ChartRenderer } from './ChartRenderer';
import { MarkdownRenderer } from '@/components/ui/markdown-renderer';

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
  onChartAdded?: (chart: ChartSpec) => void;
  pivotDefaults?: {
    rows?: string[];
    values?: string[];
  };
  /** Shown above the analysis table when the agent emits an intermediate summary (e.g. tool row count). */
  analysisIntermediateInsight?: string;
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

/** Columns that parse as dates in preview rows (created/derived dims not in schema dateColumns). */
function inferDateLikeColumns(
  rows: Record<string, any>[],
  columnKeys: string[],
  numericSet: Set<string>
): string[] {
  const sample = rows.slice(0, 500);
  const out: string[] = [];
  for (const col of columnKeys) {
    if (numericSet.has(col)) continue;
    if (isIdLikeColumn(col)) continue;
    if (String(col).startsWith('__tf_')) {
      out.push(col);
      continue;
    }
    let n = 0;
    let ok = 0;
    for (const row of sample) {
      const v = row[col];
      if (v === null || v === undefined || v === '') continue;
      n++;
      if (parseDateLike(v) !== null) ok++;
    }
    if (n >= 3 && ok / n >= 0.7) out.push(col);
  }
  return out;
}

export function DataPreviewTable({ 
  data, 
  title, 
  maxRows = 100, 
  sessionId,
  columns: schemaColumns,
  numericColumns: numericColumnsProp,
  dateColumns: dateColumnsFromSchema = [],
  temporalDisplayGrainsByColumn = {},
  temporalFacetColumns = [],
  variant = "dataset",
  onChartAdded,
  pivotDefaults,
  analysisIntermediateInsight,
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
  const [analysisView, setAnalysisView] = useState<'pivot' | 'flat' | 'chart'>('pivot');
  const [chartType, setChartType] = useState<PivotChartKind>('bar');
  const [chartTitle, setChartTitle] = useState('Pivot chart');
  const [chartXCol, setChartXCol] = useState('');
  const [chartYCol, setChartYCol] = useState('');
  const [chartZCol, setChartZCol] = useState('');
  const [chartSeriesCol, setChartSeriesCol] = useState('');
  const [chartBarLayout, setChartBarLayout] = useState<'stacked' | 'grouped'>('stacked');
  const [chartRecommendationReason, setChartRecommendationReason] = useState<string | null>(
    null
  );
  const [chartPreview, setChartPreview] = useState<ChartSpec | null>(null);
  const [chartPreviewLoading, setChartPreviewLoading] = useState(false);
  const [chartPreviewError, setChartPreviewError] = useState<string | null>(null);
  const chartPreviewRequestSeqRef = useRef(0);
  const [pivotTopN, setPivotTopN] = useState<number | null>(null);
  const [showValuesAs, setShowValuesAs] = useState<PivotShowValuesAsMode>('raw');
  const [showSubtotals, setShowSubtotals] = useState(true);
  const [showGrandTotal, setShowGrandTotal] = useState(true);
  const [drillthrough, setDrillthrough] = useState<{
    loading: boolean;
    error: string | null;
    count: number | null;
    rows: Record<string, unknown>[];
  } | null>(null);
  /** Row-level rows from columnar store when sessionId is set (defense in depth vs aggregated-only preview). */
  const [sessionSampleRows, setSessionSampleRows] = useState<
    Record<string, unknown>[] | null
  >(null);
  const [sessionSampleError, setSessionSampleError] = useState<string | null>(null);

  useEffect(() => {
    if (variant !== 'analysis' || !sessionId) {
      setSessionSampleRows(null);
      setSessionSampleError(null);
      return;
    }
    let cancelled = false;
    setSessionSampleError(null);
    void (async () => {
      try {
        const res = await fetchSessionSampleRows(sessionId, 2000);
        if (!cancelled && Array.isArray(res.rows)) {
          setSessionSampleRows(res.rows as Record<string, unknown>[]);
          setSessionSampleError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setSessionSampleRows(null);
          setSessionSampleError(
            e instanceof Error ? e.message : 'Failed to fetch session sample rows'
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [variant, sessionId]);

  /** Analysis pivot defaults prefer message-local preview rows before global session sample rows. */
  const pivotRows = useMemo((): Record<string, unknown>[] => {
    const base = data ?? [];
    if (variant !== 'analysis') return base;
    if (base.length > 0) return base;
    return sessionSampleRows ?? [];
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

  const effectiveDateColumns = useMemo(() => {
    const base: string[] = [];
    const seen = new Set<string>();
    for (const c of dateColumnsFromSchema) {
      if (seen.has(c)) continue;
      seen.add(c);
      base.push(c);
    }
    for (const m of temporalFacetColumns ?? []) {
      if (seen.has(m.name)) continue;
      if (pivotRows.some((r) => r[m.name] != null && String(r[m.name]).trim() !== '')) {
        seen.add(m.name);
        base.push(m.name);
      }
    }
    for (const c of inferDateLikeColumns(pivotRows, schemaColumnKeys, numericColumnsSet)) {
      if (seen.has(c)) continue;
      seen.add(c);
      base.push(c);
    }
    return base;
  }, [
    dateColumnsFromSchema,
    temporalFacetColumns,
    pivotRows,
    schemaColumnKeys,
    numericColumnsSet,
  ]);

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
    const hintedRows = Array.isArray(pivotDefaults?.rows) ? pivotDefaults.rows : [];
    const hintedValues = Array.isArray(pivotDefaults?.values) ? pivotDefaults.values : [];

    const hintedRowDim =
      hintedRows.find((c) => dimensionCandidatesInPreview.includes(c)) ??
      hintedRows.find((c) => schemaColumnKeys.includes(c) && !numericColumnsSet.has(c)) ??
      null;
    const hintedValueMeasure =
      hintedValues.find((c) => numericCandidatesInPreview.includes(c)) ??
      hintedValues.find((c) => numericColumns.includes(c) && schemaColumnKeys.includes(c)) ??
      null;

    if (!pivotRows?.length) {
      return {
        defaultRowDim: hintedRowDim,
        defaultValueMeasures: hintedValueMeasure ? [hintedValueMeasure] : [],
      };
    }

    // Pick best default dimension:
    // - non-numeric
    // - has non-blank values
    // - avoid ID-like columns (they aren't useful as row labels)
    let bestRow: {
      col: string;
      nonBlank: number;
      unique: number;
      schemaIndex: number;
      score: number;
    } | null = null;
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
      const cardinalityRatio = nonBlank > 0 ? unique / nonBlank : 1;
      // Favor broadly-populated business dimensions while avoiding high-cardinality
      // fields (e.g. product names/near-identifiers) as default pivot rows.
      const score = nonBlank - cardinalityRatio * 4 + Math.min(unique, 20) * 0.02;

      const bestScore = bestRow ? bestRow.score : -Infinity;

      if (!bestRow || score > bestScore || (score === bestScore && schemaIndex < bestRow.schemaIndex)) {
        bestRow = { col, nonBlank, unique, schemaIndex, score };
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
      defaultRowDim: hintedRowDim ?? defaultRowDimResolved,
      defaultValueMeasures:
        hintedValueMeasure != null ? [hintedValueMeasure] : defaultValueMeasuresResolved,
    };
  }, [
    pivotDefaults,
    pivotRows,
    dimensionCandidatesInPreview,
    numericCandidatesInPreview,
    schemaColumnKeys,
    numericColumnsSet,
    numericColumns,
  ]);

  useEffect(() => {
    if (variant !== 'analysis') return;
    if (process.env.NODE_ENV === 'production') return;
    if (pivotDefaults?.rows?.length || pivotDefaults?.values?.length) {
      logger.debug('[DataPreviewTable] Using pivotDefaults hint', {
        rows: pivotDefaults?.rows ?? [],
        values: pivotDefaults?.values ?? [],
        chosenRow: defaultRowDim,
        chosenValues: defaultValueMeasures,
      });
      return;
    }
    logger.debug('[DataPreviewTable] Pivot default fallback path', {
      chosenRow: defaultRowDim,
      chosenValues: defaultValueMeasures,
      dimensionCandidates: dimensionCandidatesInPreview.slice(0, 10),
    });
  }, [
    variant,
    pivotDefaults,
    defaultRowDim,
    defaultValueMeasures,
    dimensionCandidatesInPreview,
  ]);

  const pivotDataSignature = useMemo(() => {
    return `${schemaColumnKeys.join('\0')}\0${numericColumns.join('\0')}\0${
      defaultRowDim ?? ''
    }\0${defaultValueMeasures.join('\0')}`;
  }, [schemaColumnKeys, numericColumns, defaultRowDim, defaultValueMeasures]);

  const [serverPivotModel, setServerPivotModel] = useState<PivotModelContract | null>(
    null
  );
  const [serverPivotMeta, setServerPivotMeta] = useState<{
    source?: "duckdb" | "sample";
    rowCount?: number;
    colKeyCount?: number;
    truncated?: boolean;
  } | null>(null);
  const [serverPivotLoading, setServerPivotLoading] = useState(false);
  const [serverPivotError, setServerPivotError] = useState<string | null>(null);
  const serverPivotRequestSeqRef = useRef(0);

  const canPivot = useMemo(() => {
    if (variant !== 'analysis') return false;
    return Boolean(defaultRowDim && defaultValueMeasures.length > 0);
  }, [variant, defaultRowDim, defaultValueMeasures.length]);

  const normalizedPivotConfig = useMemo(
    () => normalizePivotConfig(schemaColumnKeys, pivotConfig),
    [schemaColumnKeys, pivotConfig]
  );

  const chartDimensionOptions = useMemo(() => {
    return schemaColumnKeys.filter((c) => !numericColumnsSet.has(c));
  }, [schemaColumnKeys, numericColumnsSet]);

  const chartMeasureOptions = useMemo(() => {
    return numericColumns.filter((c) => schemaColumnKeys.includes(c));
  }, [numericColumns, schemaColumnKeys]);

  const recommendedPivotChart = useMemo(() => {
    if (variant !== 'analysis' || !canPivot) return null;
    return recommendPivotChart({
      pivotConfig: normalizedPivotConfig,
      numericColumns,
      dateColumns: effectiveDateColumns,
      rowCount: serverPivotMeta?.rowCount ?? pivotRows.length,
      colKeyCount: serverPivotMeta?.colKeyCount ?? 0,
    });
  }, [
    variant,
    canPivot,
    normalizedPivotConfig,
    numericColumns,
    effectiveDateColumns,
    serverPivotMeta?.rowCount,
    serverPivotMeta?.colKeyCount,
    pivotRows.length,
  ]);

  const chartXOptions = useMemo(() => {
    if (chartType === 'scatter') return chartMeasureOptions;
    return chartDimensionOptions;
  }, [chartType, chartMeasureOptions, chartDimensionOptions]);

  const chartYOptions = useMemo(() => {
    if (chartType === 'scatter') return chartMeasureOptions;
    if (chartType === 'heatmap') return chartDimensionOptions;
    return chartMeasureOptions;
  }, [chartType, chartMeasureOptions, chartDimensionOptions]);

  const pivotQueryRequest = useMemo((): PivotQueryRequest | null => {
    if (variant !== "analysis") return null;
    if (!sessionId) return null;
    if (!canPivot) return null;
    if (analysisView !== "pivot") return null;
    if (!normalizedPivotConfig) return null;

    const rowFields = normalizedPivotConfig.rows;
    const colFields = normalizedPivotConfig.columns;
    const filterFields = normalizedPivotConfig.filters;

    // Payload guard: don't send full "all values" selections to the backend.
    // Only include selections that represent an explicit user exclusion.
    const filterSelectionsObj: Record<string, string[]> = {};
    for (const f of filterFields) {
      const sel = filterSelections[f];
      if (!sel) continue;
      const snap = filterDistinctSnapshotRef.current[f];

      const selArr = Array.from(sel);
      if (snap) {
        // If selection equals the last known "all distinct values" snapshot, omit it.
        const isAll =
          sel.size === snap.size && selArr.every((v) => snap.has(v));
        if (isAll) continue;
      }

      filterSelectionsObj[f] = selArr;
    }

    const filterSelections =
      Object.keys(filterSelectionsObj).length > 0
        ? filterSelectionsObj
        : undefined;

    return {
      rowFields,
      colFields,
      filterFields,
      filterSelections,
      valueSpecs: normalizedPivotConfig.values,
      rowSort: normalizedPivotConfig.rowSort,
    };
  }, [
    variant,
    sessionId,
    canPivot,
    analysisView,
    normalizedPivotConfig,
    filterSelections,
  ]);

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
    setServerPivotModel(null);
    setServerPivotMeta(null);
    setServerPivotError(null);
    setServerPivotLoading(false);
    setDrillthrough(null);
    setSessionSampleError(null);
    setChartType('bar');
    setChartTitle('Pivot chart');
    setChartXCol('');
    setChartYCol('');
    setChartZCol('');
    setChartSeriesCol('');
    setChartBarLayout('stacked');
    setChartRecommendationReason(null);
    setChartPreview(null);
    setChartPreviewError(null);
    setChartPreviewLoading(false);
  }, [variant, pivotDataSignature]);

  // Backend pivot query (Excel-like interaction loop)
  useEffect(() => {
    if (!pivotQueryRequest) return;
    if (!sessionId) return;

    const seq = ++serverPivotRequestSeqRef.current;
    setServerPivotLoading(true);
    setServerPivotError(null);

    const t = setTimeout(() => {
      void (async () => {
        try {
          const resp = await pivotQuery(sessionId, pivotQueryRequest);
          if (seq !== serverPivotRequestSeqRef.current) return; // stale response
          setServerPivotModel(resp.model);
          setServerPivotMeta(resp.meta ?? null);
        } catch (e) {
          if (seq !== serverPivotRequestSeqRef.current) return; // stale response
          const msg =
            e instanceof Error ? e.message : "Failed to fetch pivot result";
          setServerPivotError(msg);
          setServerPivotModel(null);
          setServerPivotMeta(null);
        } finally {
          if (seq !== serverPivotRequestSeqRef.current) return;
          setServerPivotLoading(false);
        }
      })();
    }, 180);

    return () => {
      clearTimeout(t);
    };
  }, [pivotQueryRequest, sessionId]);

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

  useEffect(() => {
    if (variant !== 'analysis') return;
    if (analysisView !== 'chart') return;
    if (!recommendedPivotChart) return;
    setChartType(recommendedPivotChart.chartType);
    setChartTitle('Pivot chart');
    setChartXCol(recommendedPivotChart.x ?? '');
    setChartYCol(recommendedPivotChart.y ?? '');
    setChartZCol(recommendedPivotChart.z ?? '');
    setChartSeriesCol(recommendedPivotChart.seriesColumn ?? '');
    setChartBarLayout(recommendedPivotChart.barLayout);
    setChartRecommendationReason(recommendedPivotChart.reason);
    setChartPreview(null);
    setChartPreviewError(null);
  }, [variant, analysisView, recommendedPivotChart, pivotDataSignature]);

  useEffect(() => {
    if (analysisView !== 'chart') return;
    setChartPreview(null);
    setChartPreviewError(null);
  }, [analysisView, chartType, chartXCol, chartYCol, chartZCol, chartSeriesCol, chartBarLayout]);

  useEffect(() => {
    if (analysisView !== 'chart') return;
    if (chartXCol && chartXOptions.includes(chartXCol)) return;
    setChartXCol(chartXOptions[0] ?? '');
  }, [analysisView, chartXCol, chartXOptions]);

  useEffect(() => {
    if (analysisView !== 'chart') return;
    if (chartYCol && chartYOptions.includes(chartYCol)) return;
    setChartYCol(chartYOptions[0] ?? '');
  }, [analysisView, chartYCol, chartYOptions]);

  useEffect(() => {
    if (analysisView !== 'chart') return;
    if (chartType !== 'heatmap') return;
    if (chartZCol && chartMeasureOptions.includes(chartZCol)) return;
    setChartZCol(chartMeasureOptions[0] ?? '');
  }, [analysisView, chartType, chartZCol, chartMeasureOptions]);

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

  const effectivePivotModel = serverPivotModel ?? pivotModel;

  const pivotModelForRender = useMemo(() => {
    if (!effectivePivotModel) return null;
    if (pivotTopN == null || pivotTopN <= 0) return effectivePivotModel;

    // Limit the first row hierarchy level (Excel-like Top N on rows).
    const limitedNodes = (effectivePivotModel as any).tree.nodes.slice(
      0,
      pivotTopN
    );
    return {
      ...(effectivePivotModel as any),
      tree: {
        ...(effectivePivotModel as any).tree,
        nodes: limitedNodes,
      },
    };
  }, [effectivePivotModel, pivotTopN]);

  const pivotFlatRows = useMemo(() => {
    if (!pivotModelForRender) return [];
    const all = flattenPivotTree((pivotModelForRender as any).tree, collapsedPivotGroups);
    return all.filter((r) => {
      if (!showSubtotals && r.kind === "subtotal") return false;
      if (!showGrandTotal && r.kind === "grand") return false;
      return true;
    });
  }, [pivotModelForRender, collapsedPivotGroups, showSubtotals, showGrandTotal]);

  const togglePivotCollapse = useCallback((pathKey: string) => {
    setCollapsedPivotGroups((prev) => {
      const next = new Set(prev);
      if (next.has(pathKey)) next.delete(pathKey);
      else next.add(pathKey);
      return next;
    });
  }, []);

  const handleDrillthroughCell = useCallback(
    async ({
      rowPathKey,
      colKey,
      // valueSpecId isn't needed for the raw row query; it just helps the user locate the cell.
    }: {
      rowPathKey: string;
      colKey: string | null;
      valueSpecId: string;
    }) => {
      if (!sessionId) return;
      if (variant !== "analysis") return;

      const rowFields = normalizedPivotConfig.rows;
      const rowValues = rowPathKey.split("\x1f");
      if (rowValues.length !== rowFields.length) return;

      const filterFields = normalizedPivotConfig.filters;
      const filterSelectionsObj: Record<string, string[]> = {};
      for (const f of filterFields) {
        const sel = filterSelections[f];
        if (!sel) continue;
        const snap = filterDistinctSnapshotRef.current[f];
        const selArr = Array.from(sel);
        if (snap) {
          const isAll = sel.size === snap.size && selArr.every((v) => snap.has(v));
          if (isAll) continue;
        }
        filterSelectionsObj[f] = selArr;
      }

      const colField = normalizedPivotConfig.columns[0] ?? null;
      const valueFields = normalizedPivotConfig.values.map((v) => v.field);

      setDrillthrough({
        loading: true,
        error: null,
        count: null,
        rows: [],
      });

      try {
        const resp = await pivotDrillthrough(sessionId, {
          rowFields,
          rowValues,
          colField,
          colKey,
          filterFields,
          filterSelections: Object.keys(filterSelectionsObj).length
            ? filterSelectionsObj
            : undefined,
          valueFields,
          limit: 200,
        });
        setDrillthrough({
          loading: false,
          error: null,
          count: resp.count,
          rows: resp.rows,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Drillthrough failed";
        setDrillthrough({
          loading: false,
          error: msg,
          count: null,
          rows: [],
        });
      }
    },
    [
      sessionId,
      variant,
      normalizedPivotConfig,
      filterSelections,
      filterDistinctSnapshotRef,
      pivotDrillthrough,
    ]
  );

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
          prevSort?.primary !== 'rowLabel' &&
          prevSort?.byValueSpecId === byValueSpecId &&
          prevSort.direction === 'desc'
            ? 'asc'
            : 'desc';
        const next: PivotUiConfig = {
          ...prev,
          rowSort: {
            byValueSpecId,
            direction: nextDirection,
            primary: 'measure',
          },
        };
        return normalizePivotConfig(schemaColumnKeys, next);
      });
    },
    [schemaColumnKeys]
  );

  const handleRowLabelSortChange = useCallback(() => {
    setPivotConfig((prev) => {
      const prevSort = prev.rowSort;
      const nextDirection =
        prevSort?.primary === 'rowLabel' && prevSort.direction === 'desc'
          ? 'asc'
          : 'desc';
      const next: PivotUiConfig = {
        ...prev,
        rowSort: { primary: 'rowLabel', direction: nextDirection },
      };
      return normalizePivotConfig(schemaColumnKeys, next);
    });
  }, [schemaColumnKeys]);

  const { sortedData, handleSort, getSortIcon } = usePreviewTableSort({
    data,
    columns: flatColumnKeys,
    numericColumns,
    dateColumns: effectiveDateColumns,
    variant,
  });

  const displayData = useMemo(() => {
    if (!sortedData || sortedData.length === 0) return [];
    return sortedData.slice(0, maxRows);
  }, [sortedData, maxRows]);

  const resolvedGrainsByColumn = useMemo(() => {
    const out: Record<string, TemporalDisplayGrain> = { ...temporalDisplayGrainsByColumn };
    for (const col of effectiveDateColumns) {
      if (!out[col]) {
        const vals = pivotRows.slice(0, 500).map((row) => row[col]);
        out[col] = inferTemporalGrainFromSample(vals);
      }
    }
    return out;
  }, [pivotRows, effectiveDateColumns, temporalDisplayGrainsByColumn]);

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

  const chartConfigValidationError = useMemo(() => {
    if (analysisView !== 'chart') return null;
    if (!sessionId) return 'Session is required to preview chart data.';
    if (!chartXCol || !chartYCol) return 'Choose X and Y columns.';
    if (chartType !== 'heatmap' && !chartMeasureOptions.includes(chartYCol)) {
      return 'Y axis must be numeric for this chart type.';
    }
    if (chartType === 'scatter' && !chartMeasureOptions.includes(chartXCol)) {
      return 'Scatter chart requires numeric X and Y columns.';
    }
    if (chartType === 'heatmap' && !chartZCol) return 'Heatmap requires a numeric Z value.';
    if (serverPivotMeta?.rowCount === 0) return 'No rows match current filters.';
    return null;
  }, [
    analysisView,
    sessionId,
    chartXCol,
    chartYCol,
    chartType,
    chartZCol,
    chartMeasureOptions,
    serverPivotMeta?.rowCount,
  ]);

  const runChartPreview = useCallback(async () => {
    if (chartConfigValidationError) {
      setChartPreviewError(chartConfigValidationError);
      setChartPreview(null);
      return;
    }
    if (!sessionId) return;
    const seq = ++chartPreviewRequestSeqRef.current;
    setChartPreviewLoading(true);
    setChartPreviewError(null);
    try {
      const body: Record<string, unknown> = {
        title: chartTitle.trim() || 'Pivot chart',
        type: chartType,
        x: chartXCol,
        y: chartType === 'heatmap' ? chartYCol : chartYCol,
        aggregate: chartType === 'scatter' ? 'none' : 'sum',
      };
      if (chartType === 'heatmap') {
        body.z = chartZCol;
      }
      if (chartType === 'bar' && chartSeriesCol) {
        body.seriesColumn = chartSeriesCol;
        body.barLayout = chartBarLayout;
      }
      const res = await api.post<{ chart: ChartSpec }>(
        `/api/sessions/${sessionId}/chart-preview`,
        { chart: body }
      );
      if (seq !== chartPreviewRequestSeqRef.current) return;
      setChartPreview(res.chart);
    } catch (e) {
      if (seq !== chartPreviewRequestSeqRef.current) return;
      setChartPreview(null);
      setChartPreviewError(e instanceof Error ? e.message : 'Chart preview failed');
    } finally {
      if (seq !== chartPreviewRequestSeqRef.current) return;
      setChartPreviewLoading(false);
    }
  }, [
    chartConfigValidationError,
    sessionId,
    chartTitle,
    chartType,
    chartXCol,
    chartYCol,
    chartZCol,
    chartSeriesCol,
    chartBarLayout,
  ]);

  const addChartToChat = useCallback(() => {
    if (!chartPreview || !onChartAdded) return;
    onChartAdded(chartPreview);
    toast({
      title: 'Chart added',
      description: 'Chart was added to this chat.',
    });
  }, [chartPreview, onChartAdded, toast]);

  const renderFlatAnalysisCell = (col: string, raw: unknown): ReactNode => {
    if (raw === null || raw === undefined) {
      return <span className="text-muted-foreground italic">null</span>;
    }
    const facetMeta = facetMetaByName[col];
    if (facetMeta) {
      const formatted = formatTemporalFacetValue(raw, facetMeta.grain);
      return formatted ?? String(raw);
    }
    if (effectiveDateColumns.includes(col)) {
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
    variant === 'analysis' && canPivot && analysisView === 'pivot' && effectivePivotModel;

  const trimmedAnalysisInsight = analysisIntermediateInsight?.trim() ?? "";
  const toolPreviewRowCount = data.length;
  const pivotResultRowCount = serverPivotMeta?.rowCount;
  const showPivotVersusToolRowClarification =
    variant === "analysis" &&
    Boolean(trimmedAnalysisInsight) &&
    analysisView === "pivot" &&
    Boolean(sessionId) &&
    !serverPivotLoading &&
    pivotResultRowCount != null &&
    pivotResultRowCount !== toolPreviewRowCount;

  return (
    <Card className="p-4 mt-2 overflow-hidden border-border/60 shadow-sm bg-gradient-to-br from-card to-card/95">
      {variant === "analysis" && trimmedAnalysisInsight && (
        <div className="mb-3">
          <Card className="p-4 bg-primary/5 border-l-4 border-l-primary shadow-sm border-border/60">
            <div className="flex items-center gap-2 mb-2">
              <Lightbulb className="w-4 h-4 text-primary" />
              <h4 className="text-sm font-semibold text-foreground">Key insight</h4>
            </div>
            <div className="text-sm text-foreground">
              <MarkdownRenderer content={trimmedAnalysisInsight} />
            </div>
            {showPivotVersusToolRowClarification && (
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                The pivot below is computed from the full session dataset ({pivotResultRowCount}{" "}
                {pivotResultRowCount === 1 ? "row" : "rows"} for the current layout). The summary
                above describes the analytical query result ({toolPreviewRowCount}{" "}
                {toolPreviewRowCount === 1 ? "row" : "rows"}).
              </p>
            )}
          </Card>
        </div>
      )}
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
                <Button
                  type="button"
                  variant={analysisView === 'chart' ? 'secondary' : 'ghost'}
                  size="sm"
                  className="text-xs h-8 px-3"
                  onClick={() => setAnalysisView('chart')}
                >
                  Generate chart
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
            {analysisView === 'chart' ? (
              <div className="rounded-lg border border-border/60 bg-muted/10 p-3 space-y-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <label className="text-xs text-muted-foreground">Chart type</label>
                    <select
                      className="w-full rounded border border-border/60 bg-background px-2 py-1.5 text-xs"
                      value={chartType}
                      onChange={(e) => setChartType(e.target.value as PivotChartKind)}
                    >
                      <option value="bar">Bar</option>
                      <option value="line">Line</option>
                      <option value="area">Area</option>
                      <option value="scatter">Scatter</option>
                      <option value="pie">Pie</option>
                      <option value="heatmap">Heatmap</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs text-muted-foreground">Title</label>
                    <input
                      className="w-full rounded border border-border/60 bg-background px-2 py-1.5 text-xs"
                      value={chartTitle}
                      onChange={(e) => setChartTitle(e.target.value)}
                      placeholder="Pivot chart"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs text-muted-foreground">X axis</label>
                    <select
                      className="w-full rounded border border-border/60 bg-background px-2 py-1.5 text-xs"
                      value={chartXCol || ''}
                      onChange={(e) => setChartXCol(e.target.value)}
                    >
                      <option value="">Select column</option>
                      {chartXOptions.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs text-muted-foreground">
                      {chartType === 'heatmap' ? 'Columns (Y)' : 'Y axis'}
                    </label>
                    <select
                      className="w-full rounded border border-border/60 bg-background px-2 py-1.5 text-xs"
                      value={chartYCol || ''}
                      onChange={(e) => setChartYCol(e.target.value)}
                    >
                      <option value="">Select column</option>
                      {chartYOptions.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                  {chartType === 'heatmap' && (
                    <div className="space-y-1.5 md:col-span-2">
                      <label className="text-xs text-muted-foreground">Value (Z)</label>
                      <select
                        className="w-full rounded border border-border/60 bg-background px-2 py-1.5 text-xs"
                        value={chartZCol || ''}
                        onChange={(e) => setChartZCol(e.target.value)}
                      >
                        <option value="">Select numeric column</option>
                        {chartMeasureOptions.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {chartType === 'bar' && (
                    <>
                      <div className="space-y-1.5">
                        <label className="text-xs text-muted-foreground">Series column (optional)</label>
                        <select
                          className="w-full rounded border border-border/60 bg-background px-2 py-1.5 text-xs"
                          value={chartSeriesCol || ''}
                          onChange={(e) => setChartSeriesCol(e.target.value)}
                        >
                          <option value="">None</option>
                          {chartDimensionOptions
                            .filter((c) => c !== chartXCol && c !== chartYCol)
                            .map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                        </select>
                      </div>
                      {chartSeriesCol ? (
                        <div className="space-y-1.5">
                          <label className="text-xs text-muted-foreground">Bar layout</label>
                          <select
                            className="w-full rounded border border-border/60 bg-background px-2 py-1.5 text-xs"
                            value={chartBarLayout}
                            onChange={(e) =>
                              setChartBarLayout(e.target.value as 'stacked' | 'grouped')
                            }
                          >
                            <option value="stacked">Stacked</option>
                            <option value="grouped">Grouped</option>
                          </select>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="text-xs"
                    onClick={() => void runChartPreview()}
                    disabled={chartPreviewLoading || Boolean(chartConfigValidationError)}
                  >
                    {chartPreviewLoading ? (
                      <>
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                        Updating preview...
                      </>
                    ) : (
                      'Update preview'
                    )}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="text-xs"
                    onClick={addChartToChat}
                    disabled={!chartPreview || !onChartAdded}
                  >
                    Add to chat
                  </Button>
                  {chartRecommendationReason ? (
                    <span className="text-[11px] text-muted-foreground">
                      Recommended: {chartRecommendationReason}
                    </span>
                  ) : null}
                </div>
                {(chartConfigValidationError || chartPreviewError) && (
                  <p className="text-xs text-destructive" role="alert">
                    {chartConfigValidationError ?? chartPreviewError}
                  </p>
                )}
                <div className="rounded-lg border border-border/60 bg-background p-2 min-h-[220px]">
                  {chartPreview ? (
                    <ChartRenderer chart={chartPreview} index={0} isSingleChart showAddButton={false} />
                  ) : (
                    <div className="h-[220px] flex items-center justify-center text-xs text-muted-foreground">
                      Configure chart options and click Update preview.
                    </div>
                  )}
                </div>
              </div>
            ) : showPivotChrome && effectivePivotModel ? (
              normalizedPivotConfig.values.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center border rounded-lg border-dashed">
                  Add at least one field to <strong>Values</strong> in Pivot fields.
                </p>
              ) : sessionSampleError && !effectivePivotModel ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-6 text-sm text-destructive text-center">
                  Pivot unavailable: {sessionSampleError}
                </div>
              ) : serverPivotLoading ? (
                <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-6 text-sm text-muted-foreground text-center">
                  Computing pivot…
                </div>
              ) : serverPivotError ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-6 text-sm text-destructive text-center">
                  Pivot failed: {serverPivotError}
                </div>
              ) : serverPivotMeta?.rowCount === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center border rounded-lg border-dashed">
                  No rows match current filters (<code>no_rows_after_filters</code>).
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-3 mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Top N</span>
                      <input
                        type="number"
                        min={1}
                        className="w-20 rounded border border-border/60 bg-background px-2 py-1 text-xs"
                        value={pivotTopN ?? ''}
                        onChange={(e) => {
                          const v = e.target.value.trim();
                          if (!v) {
                            setPivotTopN(null);
                            return;
                          }
                          const n = Number(v);
                          setPivotTopN(Number.isFinite(n) && n > 0 ? n : null);
                        }}
                        placeholder="(off)"
                      />
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Show</span>
                      <select
                        className="rounded border border-border/60 bg-background px-2 py-1 text-xs"
                        value={showValuesAs}
                        onChange={(e) => setShowValuesAs(e.target.value as PivotShowValuesAsMode)}
                      >
                        <option value="raw">Raw</option>
                        <option value="percentOfColumnTotal">% of column total</option>
                      </select>
                    </div>

                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={showSubtotals}
                        onChange={(e) => setShowSubtotals(e.target.checked)}
                      />
                      Subtotals
                    </label>

                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={showGrandTotal}
                        onChange={(e) => setShowGrandTotal(e.target.checked)}
                      />
                      Grand total
                    </label>
                  </div>

                  <PivotGrid
                    model={pivotModelForRender as any}
                    flatRows={pivotFlatRows}
                    onToggleCollapse={togglePivotCollapse}
                    temporalFacetColumns={temporalFacetColumns}
                    rowSort={normalizedPivotConfig.rowSort}
                    onRowSortChange={handleRowSortChange}
                    onRowLabelSortChange={handleRowLabelSortChange}
                    showValuesAs={showValuesAs}
                    onDrillthroughCell={handleDrillthroughCell}
                  />

                  {drillthrough && (
                    <div className="mt-3 rounded-lg border border-border/60 bg-background/70 p-3">
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <div>
                          <div className="text-xs text-muted-foreground">
                            Drillthrough rows
                          </div>
                          <div className="text-sm font-semibold">
                            {drillthrough.loading
                              ? 'Loading...'
                              : `${drillthrough.count ?? 0} rows`}
                          </div>
                          {drillthrough.error && (
                            <div className="text-xs text-destructive mt-1">
                              {drillthrough.error}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          className="text-xs rounded border border-border/60 px-2 py-1 hover:bg-muted"
                          onClick={() => setDrillthrough(null)}
                        >
                          Close
                        </button>
                      </div>

                      {drillthrough.loading ? null : (
                        <div className="overflow-x-auto max-h-[260px]">
                          <table className="w-full border-collapse text-xs">
                            <thead className="sticky top-0 bg-muted/30 z-10">
                              <tr>
                                {drillthrough.rows[0]
                                  ? Object.keys(drillthrough.rows[0]!).map((c) => (
                                      <th
                                        key={c}
                                        className="text-left px-2 py-1 border-b border-border/60 whitespace-nowrap"
                                      >
                                        {c}
                                      </th>
                                    ))
                                  : null}
                              </tr>
                            </thead>
                            <tbody>
                              {drillthrough.rows.slice(0, 50).map((r, idx) => (
                                <tr key={idx} className="border-b border-border/40">
                                  {drillthrough.rows[0]
                                    ? Object.keys(drillthrough.rows[0]!).map((c) => (
                                        <td key={c} className="px-2 py-1 whitespace-nowrap">
                                          {String(
                                            (r as any)[c] ?? ''
                                          )}
                                        </td>
                                      ))
                                    : null}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </>
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
                                ) : effectiveDateColumns.includes(col) ? (
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
                        data={pivotRows as Record<string, unknown>[]}
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

      {data.length > maxRows &&
        !(variant === 'analysis' && canPivot && analysisView !== 'flat') && (
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
