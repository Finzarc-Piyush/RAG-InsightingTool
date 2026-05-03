import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { usePreviewTableSort } from '@/hooks/usePreviewTableSort';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { FeedbackButtons } from './FeedbackButtons';
import {
  BarChart3,
  Download,
  Lightbulb,
  Loader2,
  Maximize2,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Table2,
  X,
} from 'lucide-react';
import {
  downloadModifiedDataset,
  fetchPivotColumnDistincts,
  fetchSessionSampleRows,
  pivotQuery,
  pivotDrillthrough,
  sessionsApi,
} from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import type {
  TemporalDisplayGrain,
  TemporalFacetColumnMeta,
  PivotModel as PivotModelContract,
  PivotQueryRequest,
  ChartSpec,
  ChartSpecV2,
  DashboardPivotSpec,
  PivotState,
} from '@/shared/schema';
import { isChartSpecV2 } from '@/shared/schema';
import { AddPivotToDashboardModal } from './DashboardModal/AddPivotToDashboardModal';
import { formatDateCellForGrain, inferTemporalGrainFromSample } from '@/lib/temporalDisplayFormat';
import {
  facetColumnHeaderLabelForColumn,
  formatTemporalFacetValue,
  isTemporalFacetFieldId,
} from '@/lib/temporalFacetDisplay';
import {
  buildPivotModel,
  createInitialPivotConfig,
  flattenPivotTree,
  normalizePivotConfig,
  pivotSliceFilterFields,
  syncFilterSelectionsWithFilters,
} from '@/lib/pivot';
import { downloadPivotGridAsXlsx } from '@/lib/pivot/exportPivotToXlsx';
import { logger } from '@/lib/logger';
import type { FilterSelections, PivotModel, PivotUiConfig } from '@/lib/pivot/types';
import { formatAnalysisNumber, parseNumericCell } from '@/lib/formatAnalysisNumber';
import { parseDateLike } from '@/lib/parseDateLike';
import { api } from '@/lib/httpClient';
import { withInflightLimit } from '@/lib/inflightLimiter';
import {
  recommendPivotChart,
  recommendPivotChartForType,
  type PivotChartKind,
} from '@/lib/pivot/chartRecommendation';
import {
  buildPivotChartSpecV2,
  isV2PivotMark,
} from '@/lib/pivot/buildPivotChartSpec';
import {
  chartTypeValidityForPivot,
  PIVOT_CHART_KINDS,
  type PivotChartValidityMap,
} from '@/lib/pivot/chartTypeValidity';

// PV4 · UI ordering + display labels for the Change Chart Type dropdown.
// Order: Compare → Trend → Distribution → Composition → Multi-measure → Flow.
const CHART_KIND_DROPDOWN_ORDER: ReadonlyArray<PivotChartKind> = [
  'bar',
  'line',
  'area',
  'scatter',
  'pie',
  'donut',
  'heatmap',
  'radar',
  'bubble',
  'waterfall',
];
const CHART_KIND_LABEL: Record<PivotChartKind, string> = {
  bar: 'Bar',
  line: 'Line',
  area: 'Area',
  scatter: 'Scatter',
  pie: 'Pie',
  donut: 'Donut',
  heatmap: 'Heatmap',
  radar: 'Radar',
  bubble: 'Bubble',
  waterfall: 'Waterfall',
};
type V1ChartType = 'bar' | 'line' | 'area' | 'scatter' | 'pie' | 'heatmap';
const V2_TO_V1_FALLBACK: Record<'donut' | 'radar' | 'bubble' | 'waterfall', V1ChartType> = {
  donut: 'pie',
  radar: 'bar',
  bubble: 'scatter',
  waterfall: 'bar',
};
function coerceChartTypeForPersistence(kind: PivotChartKind): V1ChartType {
  if (kind === 'donut' || kind === 'radar' || kind === 'bubble' || kind === 'waterfall') {
    return V2_TO_V1_FALLBACK[kind];
  }
  return kind;
}
import { PivotFieldPanel } from './pivot/PivotFieldPanel';
import { PivotFilterChips } from './pivot/PivotFilterChips';
import { PivotGrid, type PivotShowValuesAsMode } from './pivot/PivotGrid';
import { ChartRenderer } from './ChartRenderer';
import { ChartShim } from '@/components/charts/ChartShim';
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
    columns?: string[];
    filterFields?: string[];
    filterSelections?: Record<string, string[]>;
  };
  /** Shown above the analysis table when the agent emits an intermediate summary (e.g. tool row count). */
  analysisIntermediateInsight?: string;
  /** Insight from the final answer envelope — shown in the Key insight box for non-intermediate pivot responses. */
  pivotInsight?: string;
  /**
   * Original user question that produced this analytical message. Threaded down
   * so live chart/pivot key-insight refetches receive the same `userQuestion`
   * that the agent-turn pipeline does — keeps live refetches qualitatively as
   * rich as the original turn instead of degrading to flat statistical sentences.
   */
  userQuestion?: string;
  /**
   * W-PivotState · persisted full pivot + chart UI state for THIS message,
   * loaded from Cosmos on session reopen. When provided, takes precedence over
   * `pivotDefaults`-driven hydration. Pairs with `messageTimestamp` (used to
   * address the message in the PATCH endpoint).
   */
  initialPivotState?: PivotState;
  /** W-PivotState · numeric ms-epoch timestamp of the assistant message. */
  messageTimestamp?: number;
  /**
   * W-PivotState · while the agent's streaming turn is in flight for this
   * message, suppress the debounced PATCH so we don't race the server's
   * read-modify-write on `chatDocument.messages`.
   */
  streamingActive?: boolean;
  /** Forwarded to ChartRenderer → ChartModal so the trailing "Next, …" insight chip can pre-fill the composer. */
  onSuggestedQuestionClick?: (question: string) => void;
  /** Turn id for the per-pivot feedback target. When absent the thumbs row is hidden. */
  feedbackTurnId?: string | null;
  /** Initial state for the per-pivot thumbs (hydrated from feedbackDetails). */
  pivotFeedbackInitial?: { feedback: "up" | "down" | "none"; comment?: string };
  /** When true, suppresses feedback interaction (superadmin shadow viewer). */
  feedbackReadOnly?: boolean;
}

function inferNumericColumns(
  rows: Record<string, any>[],
  columnKeys: string[]
): string[] {
  const sample = rows.slice(0, 500);
  const out: string[] = [];
  for (const col of columnKeys) {
    if (isTemporalFacetFieldId(col)) continue;
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
    if (isTemporalFacetFieldId(col)) {
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
  pivotInsight,
  userQuestion,
  initialPivotState,
  messageTimestamp,
  streamingActive,
  onSuggestedQuestionClick,
  feedbackTurnId,
  pivotFeedbackInitial,
  feedbackReadOnly = false,
}: DataPreviewTableProps) {
  const [downloadingFormat, setDownloadingFormat] = useState<'xlsx' | null>(null);
  const [pivotAddDialogPivot, setPivotAddDialogPivot] =
    useState<DashboardPivotSpec | null>(null);
  const { toast } = useToast();

  const [pivotConfig, setPivotConfig] = useState<PivotUiConfig>(() =>
    createInitialPivotConfig([], [], [], [])
  );
  const [filterSelections, setFilterSelections] = useState<FilterSelections>({});
  /** Tracks distinct filter values seen on prior syncs so new values can merge into selections. */
  const filterDistinctSnapshotRef = useRef<Record<string, Set<string>>>({});
  /**
   * Parallel provenance ref to `filterDistinctSnapshotRef`. Distinguishes
   * authoritative DuckDB-derived snapshots from sample-row fallbacks so the
   * first authoritative sync after a sample-only sync re-narrows to the
   * agent hint instead of merging the full universe into the selection.
   */
  const filterDistinctProvenanceRef = useRef<
    Record<string, "authoritative" | "sample">
  >({});
  const filterDistinctFetchSeqRef = useRef(0);
  const [sessionFilterDistincts, setSessionFilterDistincts] = useState<
    Record<string, string[]>
  >({});
  const [sessionFilterDistinctsErrors, setSessionFilterDistinctsErrors] =
    useState<Record<string, string>>({});
  /**
   * Bumping this counter forces the per-field distincts fetch to re-fire even
   * when `pivotDistinctFieldsSignature` is unchanged. Used by the popover's
   * "Retry" button after a prior fetch failed.
   */
  const [filterDistinctsRetryNonce, setFilterDistinctsRetryNonce] = useState(0);
  const [collapsedPivotGroups, setCollapsedPivotGroups] = useState<Set<string>>(
    () => new Set()
  );
  const [pivotPanelOpen, setPivotPanelOpen] = useState(true);
  const [pivotExpanded, setPivotExpanded] = useState(false);
  /** Chart subview inside expanded pivot (keeps `analysisView === 'pivot'` for server pivot queries). */
  const [expandedWorkspaceTab, setExpandedWorkspaceTab] = useState<'pivot' | 'chart'>('chart');
  const pivotExpandButtonRef = useRef<HTMLButtonElement>(null);
  const pivotWasExpandedRef = useRef(false);
  const [analysisView, setAnalysisView] = useState<'pivot' | 'flat' | 'chart'>('chart');
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
  const [chartPreview, setChartPreview] = useState<ChartSpec | ChartSpecV2 | null>(null);
  const [chartPreviewLoading, setChartPreviewLoading] = useState(false);
  const [chartPreviewError, setChartPreviewError] = useState<string | null>(null);
  const chartPreviewRequestSeqRef = useRef(0);
  /** Tracks the config hash at the time of the last successful chart-preview API call. */
  const lastChartConfigRef = useRef<string>('');
  const [chartInsight, setChartInsight] = useState<{
    hash: string;
    text: string | null;
    loading: boolean;
    error: string | null;
  } | null>(null);
  const chartInsightSeqRef = useRef(0);
  /**
   * Hash + outcome for which an insight fetch was last launched. Outcome-aware so
   * a transient empty/error result does not poison the dedupe (a failed run at hash
   * H must remain refetchable when the user lands on H again). Only `success` and
   * in-flight `pending` short-circuit subsequent runs.
   */
  type InsightOutcome = 'pending' | 'success' | 'empty' | 'error';
  const lastInsightHashRef = useRef<{ hash: string; outcome: InsightOutcome }>({
    hash: '',
    outcome: 'success',
  });
  // Pivot-view live insight (Bug 1). Mirrors `chartInsight` but is driven by
  // pivot config changes instead of chart-view chartPreview changes, so insights
  // refresh whenever the user mutates rows / columns / values / filters.
  const [pivotKeyInsight, setPivotKeyInsight] = useState<{
    hash: string;
    text: string | null;
    loading: boolean;
    error: string | null;
  } | null>(null);
  const pivotInsightSeqRef = useRef(0);
  const lastPivotInsightHashRef = useRef<{ hash: string; outcome: InsightOutcome }>({
    hash: '',
    outcome: 'success',
  });
  /** When true, do not overwrite chart axis fields from auto-recommendation. */
  const chartMappingManualRef = useRef(false);
  /**
   * PV6 · When true, the user has explicitly picked a chartType (via the
   * Change Chart Type dropdown OR via persisted state) and the auto-track
   * effect must not clobber it. Reset whenever the pivot's structural
   * signature changes — a new pivot warrants a fresh recommendation.
   */
  const chartTypeUserPickedRef = useRef(false);
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
      variant === "analysis" ? true : !isTemporalFacetFieldId(c);

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

  /** Pivot field universe: schema columns plus temporal facet ids (often missing from columnar `columns`). */
  const pivotFieldKeys = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const k of schemaColumnKeys) {
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
    for (const m of temporalFacetColumns ?? []) {
      const name = m?.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
    return out;
  }, [schemaColumnKeys, temporalFacetColumns]);

  // Data-driven keys: used only for the analysis “Flat table” so we don’t show
  // columns that don’t actually exist in the current preview payload.
  const flatColumnKeys = useMemo(() => {
    if (!data || data.length === 0) return [];

    const limit = Math.min(data.length, 500);
    const ordered: string[] = [];
    const seen = new Set<string>();

    const accept = (c: string) =>
      variant === "analysis" ? true : !isTemporalFacetFieldId(c);

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

  const { defaultPivotRowKeys, defaultPivotColumnKeys, defaultValueMeasures } = useMemo(() => {
    const hintedRows = Array.isArray(pivotDefaults?.rows) ? pivotDefaults.rows : [];
    const hintedColumns = Array.isArray(pivotDefaults?.columns)
      ? pivotDefaults.columns
      : [];
    const hintedValues = Array.isArray(pivotDefaults?.values) ? pivotDefaults.values : [];
    return {
      defaultPivotRowKeys: hintedRows,
      defaultPivotColumnKeys: hintedColumns,
      defaultValueMeasures: hintedValues,
    };
  }, [pivotDefaults]);

  const pivotFilterDefaultsKey = useMemo(() => {
    const ff = pivotDefaults?.filterFields ?? [];
    const fs = pivotDefaults?.filterSelections ?? {};
    return JSON.stringify({
      ff: [...ff].sort(),
      fs: Object.keys(fs)
        .sort()
        .reduce<Record<string, string[]>>((acc, k) => {
          acc[k] = [...(fs[k] ?? [])].sort();
          return acc;
        }, {}),
    });
  }, [pivotDefaults]);

  useEffect(() => {
    if (variant !== 'analysis') return;
    if (process.env.NODE_ENV === 'production') return;
    const hintedRows = pivotDefaults?.rows ?? [];
    const hintedValues = pivotDefaults?.values ?? [];
    const defaultFilterKeys = (pivotDefaults?.filterFields ?? []).filter((k) =>
      pivotFieldKeys.includes(k)
    );
    const hintedColumns = pivotDefaults?.columns ?? [];
    const resolved = createInitialPivotConfig(
      pivotFieldKeys,
      numericColumns,
      defaultPivotRowKeys,
      defaultValueMeasures,
      {
        defaultFilterKeys,
        defaultColumnKeys: Array.isArray(hintedColumns) ? hintedColumns : [],
      }
    );
    logger.debug('[DataPreviewTable] Pivot defaults from message', {
      hintedRows,
      hintedColumns,
      hintedValues,
      chosenRows: defaultPivotRowKeys,
      chosenValues: defaultValueMeasures,
      resolvedRows: resolved.rows,
      resolvedColumns: resolved.columns,
      resolvedValues: resolved.values.map((v) => v.field),
      resolvedFilters: resolved.filters,
    });
  }, [
    variant,
    pivotDefaults,
    pivotFieldKeys,
    numericColumns,
    defaultPivotRowKeys,
    defaultPivotColumnKeys,
    defaultValueMeasures,
  ]);

  const pivotDataSignature = useMemo(() => {
    return `${pivotFieldKeys.join('\0')}\0${numericColumns.join('\0')}\0${defaultPivotRowKeys.join(
      '\0'
    )}\0${defaultPivotColumnKeys.join('\0')}\0${defaultValueMeasures.join(
      '\0'
    )}\0${pivotFilterDefaultsKey}`;
  }, [
    pivotFieldKeys,
    numericColumns,
    defaultPivotRowKeys,
    defaultPivotColumnKeys,
    defaultValueMeasures,
    pivotFilterDefaultsKey,
  ]);

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

  const normalizedPivotConfig = useMemo(
    () => normalizePivotConfig(pivotFieldKeys, pivotConfig),
    [pivotFieldKeys, pivotConfig]
  );

  const pivotSyncFields = useMemo(
    () => pivotSliceFilterFields(normalizedPivotConfig),
    [normalizedPivotConfig]
  );

  const pivotDistinctFieldsSignature = useMemo(
    () => pivotSyncFields.join('\0'),
    [pivotSyncFields]
  );

  const canPivot = useMemo(() => {
    if (variant !== 'analysis') return false;
    return (
      normalizedPivotConfig.rows.length > 0 && normalizedPivotConfig.values.length > 0
    );
  }, [variant, normalizedPivotConfig]);

  const chartMeasureOptions = useMemo(() => {
    return numericColumns.filter((c) => schemaColumnKeys.includes(c));
  }, [numericColumns, schemaColumnKeys]);

  /**
   * Column keys actually present on the rendered data rows. Used to keep the
   * chart recommender from picking field names that exist only in the schema
   * (e.g. base table columns "Shipping Time (Days)") when the agent's result
   * was aggregated under an alias ("Average Shipping Time"). Without this the
   * chart silently binds to a non-existent column and renders empty.
   */
  const actualResultColumns = useMemo(() => {
    if (variant !== 'analysis') return undefined;
    const first = pivotRows[0];
    if (!first || typeof first !== 'object') return undefined;
    return Object.keys(first);
  }, [variant, pivotRows]);

  /**
   * PV7 · sample values for temporal detection. Indexed by every plausible
   * "row-dim" candidate the recommender might consider — both the configured
   * pivot.rows AND the actualResultColumns (the agent often aliases the
   * dimension column, e.g. "Order Date" → "Order Period"). Capped at 30
   * samples per column so the memo stays cheap even for large pivots.
   */
  const sampleValuesByField = useMemo<Record<string, ReadonlyArray<unknown>>>(() => {
    const out: Record<string, unknown[]> = {};
    if (variant !== 'analysis') return out;
    const candidates = new Set<string>();
    for (const r of normalizedPivotConfig.rows) candidates.add(r);
    if (actualResultColumns) for (const c of actualResultColumns) candidates.add(c);
    if (candidates.size === 0) return out;
    const limit = Math.min(30, pivotRows.length);
    for (const col of candidates) {
      const samples: unknown[] = [];
      for (let i = 0; i < limit; i++) {
        const row = pivotRows[i] as Record<string, unknown> | undefined;
        if (!row) continue;
        const v = row[col];
        if (v != null && v !== '') samples.push(v);
      }
      if (samples.length > 0) out[col] = samples;
    }
    return out;
  }, [variant, normalizedPivotConfig.rows, actualResultColumns, pivotRows]);

  const recommendedPivotChart = useMemo(() => {
    if (variant !== 'analysis' || !canPivot) return null;
    return recommendPivotChart({
      pivotConfig: normalizedPivotConfig,
      numericColumns,
      dateColumns: effectiveDateColumns,
      rowCount: serverPivotMeta?.rowCount ?? pivotRows.length,
      colKeyCount: serverPivotMeta?.colKeyCount ?? 0,
      actualResultColumns,
      sampleValuesByField,
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
    actualResultColumns,
    sampleValuesByField,
  ]);

  // PV4 · validity map for the Change Chart Type dropdown — disables marks
  // that don't fit the current pivot config and surfaces the reason as a
  // tooltip. Same shape function the agent's chart compiler can reuse.
  const chartValidity = useMemo<PivotChartValidityMap | null>(() => {
    if (variant !== 'analysis' || !canPivot) return null;
    return chartTypeValidityForPivot({
      pivotConfig: normalizedPivotConfig,
      numericColumns,
      dateColumns: effectiveDateColumns,
      rowCount: serverPivotMeta?.rowCount ?? pivotRows.length,
      colKeyCount: serverPivotMeta?.colKeyCount ?? 0,
      actualResultColumns,
      sampleValuesByField,
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
    actualResultColumns,
    sampleValuesByField,
  ]);

  const pivotQueryRequest = useMemo((): PivotQueryRequest | null => {
    if (variant !== "analysis") return null;
    if (!sessionId) return null;
    if (!canPivot) return null;
    if (!normalizedPivotConfig) return null;

    const rowFields = normalizedPivotConfig.rows;
    const colFields = normalizedPivotConfig.columns;
    const filterFields = pivotSliceFilterFields(normalizedPivotConfig);

    const filterSelectionsPayload: Record<string, string[]> = {};
    for (const f of filterFields) {
      const sel = filterSelections[f];
      if (!sel) continue;
      const snap = filterDistinctSnapshotRef.current[f];

      const selArr = Array.from(sel);
      // Snapshot is the full authoritative DuckDB distinct set (no paging in
      // PF3+). If the user's selection equals the snapshot, the filter is a
      // no-op — omit the field from the payload so the server returns the
      // full dataset for that dimension.
      if (snap) {
        const isAll =
          sel.size === snap.size && selArr.every((v) => snap.has(v));
        if (isAll) continue;
      }

      filterSelectionsPayload[f] = selArr;
    }

    const filterSelectionsForRequest =
      Object.keys(filterSelectionsPayload).length > 0
        ? filterSelectionsPayload
        : undefined;

    return {
      rowFields,
      colFields,
      filterFields,
      filterSelections: filterSelectionsForRequest,
      valueSpecs: normalizedPivotConfig.values,
      rowSort: normalizedPivotConfig.rowSort,
    };
  }, [
    variant,
    sessionId,
    canPivot,
    normalizedPivotConfig,
    filterSelections,
  ]);

  const pivotFilterPayloadForChart = useMemo(() => {
    const fields = pivotSliceFilterFields(normalizedPivotConfig);
    const filterSelectionsPayload: Record<string, string[]> = {};
    for (const f of fields) {
      const sel = filterSelections[f];
      if (!sel) continue;
      const snap = filterDistinctSnapshotRef.current[f];
      const selArr = Array.from(sel);
      if (snap) {
        const isAll =
          sel.size === snap.size && selArr.every((v) => snap.has(v));
        if (isAll) continue;
      }
      filterSelectionsPayload[f] = selArr;
    }
    return {
      pivotFilterFields: fields,
      pivotFilterSelections:
        Object.keys(filterSelectionsPayload).length > 0
          ? filterSelectionsPayload
          : undefined,
    };
  }, [normalizedPivotConfig, filterSelections]);

  useEffect(() => {
    if (variant !== 'analysis') return;
    const defaultFilterKeys = (pivotDefaults?.filterFields ?? []).filter((k) =>
      pivotFieldKeys.includes(k)
    );
    // W-PivotState · when a persisted pivotState is being restored for THIS
    // message, leave the user-state setters alone — the hydration effect below
    // is the source of truth. We still reset the data-shape side (server pivot
    // model, drillthrough cache) so stale aggregates from a different field
    // signature don't bleed in.
    if (!initialPivotState) {
      setPivotConfig(
        normalizePivotConfig(
          pivotFieldKeys,
          createInitialPivotConfig(
            pivotFieldKeys,
            numericColumns,
            defaultPivotRowKeys,
            defaultValueMeasures,
            {
              defaultFilterKeys,
              defaultColumnKeys: defaultPivotColumnKeys.filter((k) =>
                pivotFieldKeys.includes(k)
              ),
            }
          )
        )
      );
      setFilterSelections({});
      filterDistinctSnapshotRef.current = {};
      filterDistinctProvenanceRef.current = {};
      setCollapsedPivotGroups(new Set());
      setAnalysisView('chart');
      setChartType('bar');
      // PV6 · No persisted state → auto-track effect should drive chartType
      // from the recommendation as soon as pivot data materializes.
      chartTypeUserPickedRef.current = false;
      setChartTitle('Pivot chart');
      setChartXCol('');
      setChartYCol('');
      setChartZCol('');
      setChartSeriesCol('');
      setChartBarLayout('stacked');
      setChartRecommendationReason(null);
      setChartPreview(null);
      setExpandedWorkspaceTab('chart');
      lastChartConfigRef.current = '';
    }
    setServerPivotModel(null);
    setServerPivotMeta(null);
    setServerPivotError(null);
    setServerPivotLoading(false);
    setDrillthrough(null);
    setSessionSampleError(null);
    setChartPreviewError(null);
    setChartPreviewLoading(false);
  }, [variant, pivotDataSignature, initialPivotState]);

  /**
   * W-PivotState · hydrate from `initialPivotState` once per message identity.
   *
   * Runs AFTER the reset-effect above so it overrides whatever defaults that
   * effect applied. Keyed off `messageTimestamp` so a different message in the
   * same DataPreviewTable instance re-hydrates. Falls back to `pivotDefaults`
   * (which the reset-effect already handles) when `initialPivotState` is absent.
   *
   * Sets `chartMappingManualRef = true` so the auto-recommend effect (which
   * watches `chartLayoutForPreview`) does not overwrite the restored chart axes.
   */
  const lastHydratedMessageRef = useRef<number | 'none'>('none');
  useEffect(() => {
    if (variant !== 'analysis') return;
    if (!initialPivotState) return;
    const key = messageTimestamp ?? 'none';
    if (lastHydratedMessageRef.current === key) return;
    if (pivotFieldKeys.length === 0) return; // wait for schema columns to arrive

    lastHydratedMessageRef.current = key;

    setPivotConfig(
      normalizePivotConfig(pivotFieldKeys, {
        rows: initialPivotState.config.rows ?? [],
        columns: initialPivotState.config.columns ?? [],
        values: initialPivotState.config.values ?? [],
        filters: initialPivotState.config.filters ?? [],
        unused: initialPivotState.config.unused ?? [],
        rowSort: initialPivotState.config.rowSort,
      })
    );

    if (initialPivotState.filterSelections) {
      const next: FilterSelections = {};
      for (const [k, vals] of Object.entries(initialPivotState.filterSelections)) {
        next[k] = new Set(vals);
      }
      setFilterSelections(next);
    }

    if (initialPivotState.analysisView) {
      setAnalysisView(initialPivotState.analysisView);
    }

    if (initialPivotState.chart) {
      const c = initialPivotState.chart;
      setChartType(c.type);
      // PV6 · Respect the persisted user pick — block the auto-track effect
      // from clobbering it on first render.
      chartTypeUserPickedRef.current = true;
      setChartXCol(c.xCol);
      setChartYCol(c.yCol);
      setChartZCol(c.zCol ?? '');
      setChartSeriesCol(c.seriesCol);
      setChartBarLayout(c.barLayout);
      // Lock auto-recommend so the restored axes survive subsequent renders.
      chartMappingManualRef.current = true;
    }
  }, [variant, initialPivotState, messageTimestamp, pivotFieldKeys]);

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
    if (variant !== 'analysis' || !sessionId) {
      setSessionFilterDistincts({});
      setSessionFilterDistinctsErrors({});
      return;
    }
    const fields = [...new Set(pivotSyncFields)];
    if (fields.length === 0) {
      setSessionFilterDistincts({});
      setSessionFilterDistinctsErrors({});
      return;
    }
    let cancelled = false;
    const seq = ++filterDistinctFetchSeqRef.current;
    // Clear any prior error markers for the fields we're about to refetch so
    // the popover doesn't flash "Couldn't load values" while the retry is in
    // flight.
    setSessionFilterDistinctsErrors((prev) => {
      if (fields.every((f) => !(f in prev))) return prev;
      const next = { ...prev };
      for (const f of fields) delete next[f];
      return next;
    });
    void (async () => {
      const values: Record<string, string[]> = {};
      const errors: Record<string, string> = {};
      await Promise.all(
        fields.map(async (f) => {
          try {
            // Full DuckDB distincts (no pagination, no cap that bites in
            // practice). Same authoritative table the agent's tools see.
            values[f] = await fetchPivotColumnDistincts(sessionId, f);
          } catch (e) {
            errors[f] =
              e instanceof Error ? e.message : 'Failed to load filter values';
          }
        })
      );
      if (cancelled || seq !== filterDistinctFetchSeqRef.current) return;
      setSessionFilterDistincts(values);
      setSessionFilterDistinctsErrors((prev) => {
        const next = { ...prev };
        for (const [f, msg] of Object.entries(errors)) next[f] = msg;
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [
    variant,
    sessionId,
    pivotDistinctFieldsSignature,
    filterDistinctsRetryNonce,
  ]);

  // Per-field render-time resolution: every field in the FILTERS shelf is
  // either 'loading' (we haven't completed a fetch attempt yet), 'loaded'
  // (sessionFilterDistincts has the key — value list is authoritative), or
  // 'error' (last fetch attempt failed). Derived synchronously from
  // pivotSyncFields membership rather than effect-set state, so the popover
  // can never render "No values to filter" in the sub-frame window before
  // the fetch effect runs.
  const filterDistinctsResolution = useMemo<
    Record<string, 'loading' | 'loaded' | 'error'>
  >(() => {
    const out: Record<string, 'loading' | 'loaded' | 'error'> = {};
    for (const f of pivotSyncFields) {
      if (Object.prototype.hasOwnProperty.call(sessionFilterDistincts, f)) {
        out[f] = 'loaded';
      } else if (Object.prototype.hasOwnProperty.call(sessionFilterDistinctsErrors, f)) {
        out[f] = 'error';
      } else {
        out[f] = 'loading';
      }
    }
    return out;
  }, [pivotSyncFields, sessionFilterDistincts, sessionFilterDistinctsErrors]);

  const handleRetryFilterDistincts = useCallback((field: string) => {
    setSessionFilterDistinctsErrors((prev) => {
      if (!(field in prev)) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
    setFilterDistinctsRetryNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (variant !== 'analysis') return;
    setFilterSelections((prev) =>
      syncFilterSelectionsWithFilters(
        pivotRows as Record<string, unknown>[],
        pivotSyncFields,
        prev,
        filterDistinctSnapshotRef,
        temporalFacetColumns,
        sessionFilterDistincts,
        pivotDefaults?.filterSelections ?? null,
        filterDistinctProvenanceRef
      )
    );
  }, [
    variant,
    pivotRows,
    pivotSyncFields,
    pivotDataSignature,
    sessionFilterDistincts,
    temporalFacetColumns,
  ]);

  const chartUiActive =
    variant === 'analysis' &&
    (analysisView === 'chart' ||
      (pivotExpanded && expandedWorkspaceTab === 'chart'));

  useEffect(() => {
    if (!pivotExpanded) setExpandedWorkspaceTab('chart');
  }, [pivotExpanded]);

  const chartLayoutForPreview = useMemo(() => {
    if (variant !== 'analysis' || !canPivot) return null;
    return recommendPivotChartForType(
      {
        pivotConfig: normalizedPivotConfig,
        numericColumns,
        dateColumns: effectiveDateColumns,
        rowCount: serverPivotMeta?.rowCount ?? pivotRows.length,
        colKeyCount: serverPivotMeta?.colKeyCount ?? 0,
        actualResultColumns,
        sampleValuesByField,
      },
      chartType
    );
  }, [
    variant,
    canPivot,
    normalizedPivotConfig,
    numericColumns,
    effectiveDateColumns,
    serverPivotMeta?.rowCount,
    serverPivotMeta?.colKeyCount,
    pivotRows.length,
    chartType,
    actualResultColumns,
    sampleValuesByField,
  ]);

  const pivotChartLayoutSignature = useMemo(
    () =>
      JSON.stringify({
        rows: normalizedPivotConfig.rows,
        columns: normalizedPivotConfig.columns,
        values: normalizedPivotConfig.values,
      }),
    [normalizedPivotConfig.rows, normalizedPivotConfig.columns, normalizedPivotConfig.values]
  );

  useEffect(() => {
    chartMappingManualRef.current = false;
  }, [pivotChartLayoutSignature, chartType]);

  useEffect(() => {
    if (pivotQueryRequest && chartType === 'scatter') {
      setChartType('bar');
    }
  }, [pivotQueryRequest, chartType]);

  const chartConfigHash = useMemo(
    () =>
      JSON.stringify({
        chartType,
        chartXCol,
        chartYCol,
        chartZCol,
        chartSeriesCol,
        chartBarLayout,
        chartTitle,
        pivotQueryRequest,
      }),
    [chartType, chartXCol, chartYCol, chartZCol, chartSeriesCol, chartBarLayout, chartTitle, pivotQueryRequest]
  );

  /**
   * W-PivotState · debounced PATCH to persist the user's pivot+chart UI state.
   *
   * Skips:
   *  - non-analysis variants (no pivot UI),
   *  - missing sessionId / messageTimestamp (anonymous / unsaved messages),
   *  - while the agent's streaming turn for THIS message is in flight (the
   *    server is read-modify-writing the same chat doc; PATCHes during that
   *    window race with the streaming append),
   *  - the first emission after hydration (so re-applying the same state we
   *    just loaded doesn't generate a write).
   *
   * Debounce window: 1500 ms. Slow enough that rapid drag-and-drop coalesces
   * into one network call; short enough that a quick toggle is durable before
   * the user navigates away.
   */
  const pivotStatePatchSeqRef = useRef(0);
  const lastPatchedPivotStateHashRef = useRef<string>('__init__');
  useEffect(() => {
    if (variant !== 'analysis') return;
    if (!sessionId) return;
    if (!Number.isFinite(messageTimestamp)) return;
    if (streamingActive) return;

    const payload: PivotState = {
      schemaVersion: 1,
      config: {
        rows: normalizedPivotConfig.rows,
        columns: normalizedPivotConfig.columns,
        values: normalizedPivotConfig.values,
        filters: normalizedPivotConfig.filters,
        unused: normalizedPivotConfig.unused,
        rowSort: normalizedPivotConfig.rowSort,
      },
      filterSelections: Object.fromEntries(
        Object.entries(filterSelections).map(([k, set]) => [k, Array.from(set)])
      ),
      analysisView,
      chart: {
        // PV3 · PivotState schema persists only v1 marks today. Coerce v2
        // marks to their nearest v1 equivalent so persistence keeps working
        // and a session reload doesn't lose the user's general intent.
        type: coerceChartTypeForPersistence(chartType),
        xCol: chartXCol,
        yCol: chartYCol,
        zCol: chartZCol || undefined,
        seriesCol: chartSeriesCol,
        barLayout: chartBarLayout,
      },
      // Preserve sidebar-managed metadata (pin, custom name) so a config-edit
      // PATCH does not clobber a concurrent pin/rename from the sidebar.
      // `initialPivotState` re-renders with the latest server-truth via
      // `message.pivotState`, so this stays current.
      ...(initialPivotState?.pinned !== undefined
        ? { pinned: initialPivotState.pinned }
        : {}),
      ...(initialPivotState?.customName !== undefined
        ? { customName: initialPivotState.customName }
        : {}),
    };

    const hash = JSON.stringify(payload);
    if (lastPatchedPivotStateHashRef.current === hash) return;

    // First emission after mount/hydration: record-and-skip so we don't
    // overwrite Cosmos with the same state we just loaded.
    if (lastPatchedPivotStateHashRef.current === '__init__') {
      lastPatchedPivotStateHashRef.current = hash;
      return;
    }

    const seq = ++pivotStatePatchSeqRef.current;
    const t = setTimeout(() => {
      void (async () => {
        try {
          await sessionsApi.updateMessagePivotState(
            sessionId,
            messageTimestamp as number,
            payload
          );
          if (seq !== pivotStatePatchSeqRef.current) return;
          lastPatchedPivotStateHashRef.current = hash;
        } catch (e) {
          // Non-fatal — the user's state is still authoritative locally; next
          // edit will retry. Don't toast (would be noisy on every flaky write).
          logger.debug('[DataPreviewTable] pivotState PATCH failed', e);
        }
      })();
    }, 1500);

    return () => {
      clearTimeout(t);
    };
  }, [
    variant,
    sessionId,
    messageTimestamp,
    streamingActive,
    normalizedPivotConfig,
    filterSelections,
    analysisView,
    chartType,
    chartXCol,
    chartYCol,
    chartZCol,
    chartSeriesCol,
    chartBarLayout,
    // Track sidebar-managed metadata so a pin/rename from the sidebar
    // re-runs this effect with the new payload (idempotent for the field
    // itself; ensures subsequent config edits include the updated meta).
    initialPivotState?.pinned,
    initialPivotState?.customName,
  ]);

  /**
   * W-PivotState · when a different message renders into this DataPreviewTable
   * instance, reset the patch-skip ref so the new message's hydration can also
   * skip its own first emission.
   */
  useEffect(() => {
    lastPatchedPivotStateHashRef.current = '__init__';
  }, [messageTimestamp]);

  const pivotChartValueFieldOptions = useMemo(
    () => normalizedPivotConfig.values.map((v) => v.field).filter(Boolean) as string[],
    [normalizedPivotConfig.values]
  );

  const pivotChartSeriesOptions = useMemo(() => {
    const opts: string[] = [];
    const col0 = normalizedPivotConfig.columns[0];
    if (col0) opts.push(col0);
    for (const r of normalizedPivotConfig.rows) {
      if (r && r !== chartXCol && !opts.includes(r)) opts.push(r);
    }
    return opts;
  }, [normalizedPivotConfig.rows, normalizedPivotConfig.columns, chartXCol]);

  /**
   * PV6 · `chartType` auto-tracks the recommender so the chart card always
   * shows the most appropriate mark for the current pivot shape — until the
   * user explicitly picks a type from the dropdown. Pre-PV6 a "fire-on-edge"
   * effect set chartType only on the first chartUiActive=false→true edge,
   * which silently locked the type to whatever default was set when the
   * recommendation arrived (often 'bar' before pivotRows materialized) and
   * never re-applied — the symptom the user reported as "always shows bar
   * even when X is a date".
   *
   * `chartTypeUserPickedRef` (declared near `chartMappingManualRef` above)
   * is the manual-override sentinel — set true on dropdown selection AND on
   * hydrate-from-persisted, reset false when the pivot's structural
   * signature changes.
   */
  useEffect(() => {
    chartTypeUserPickedRef.current = false;
  }, [pivotChartLayoutSignature]);
  useEffect(() => {
    if (!chartUiActive) return;
    if (chartTypeUserPickedRef.current) return;
    if (!recommendedPivotChart) return;
    if (recommendedPivotChart.chartType === chartType) return;
    // Mirror the scatter coercion: scatter is incompatible with a server
    // pivot layout, so don't auto-flip there even if the recommender returns
    // scatter — would oscillate against the coercion effect at L1107.
    if (pivotQueryRequest && recommendedPivotChart.chartType === 'scatter') return;
    setChartType(recommendedPivotChart.chartType);
  }, [chartUiActive, recommendedPivotChart, chartType, pivotQueryRequest]);

  useEffect(() => {
    if (!(chartUiActive || pivotExpanded) || !chartLayoutForPreview) return;
    if (chartMappingManualRef.current) return;
    setChartTitle('Pivot chart');
    setChartXCol(chartLayoutForPreview.x ?? '');
    setChartYCol(chartLayoutForPreview.y ?? '');
    setChartZCol(chartLayoutForPreview.z ?? '');
    setChartSeriesCol(chartLayoutForPreview.seriesColumn ?? '');
    setChartBarLayout(chartLayoutForPreview.barLayout);
    setChartRecommendationReason(chartLayoutForPreview.reason);
  }, [chartUiActive, pivotExpanded, chartLayoutForPreview]);

  const resetChartMappingToRecommended = useCallback(() => {
    chartMappingManualRef.current = false;
    if (!chartLayoutForPreview) return;
    setChartTitle('Pivot chart');
    setChartXCol(chartLayoutForPreview.x ?? '');
    setChartYCol(chartLayoutForPreview.y ?? '');
    setChartZCol(chartLayoutForPreview.z ?? '');
    setChartSeriesCol(chartLayoutForPreview.seriesColumn ?? '');
    setChartBarLayout(chartLayoutForPreview.barLayout);
    setChartRecommendationReason(chartLayoutForPreview.reason);
  }, [chartLayoutForPreview]);

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

  useEffect(() => {
    if (analysisView !== 'pivot') {
      setPivotExpanded(false);
      setExpandedWorkspaceTab('pivot');
    }
  }, [analysisView]);

  useEffect(() => {
    if (!pivotExpanded) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [pivotExpanded]);

  useEffect(() => {
    if (!pivotExpanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPivotExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pivotExpanded]);

  useEffect(() => {
    if (pivotWasExpandedRef.current && !pivotExpanded) {
      queueMicrotask(() => pivotExpandButtonRef.current?.focus());
    }
    pivotWasExpandedRef.current = pivotExpanded;
  }, [pivotExpanded]);

  const pivotModel = useMemo(() => {
    if (variant !== 'analysis' || !canPivot || analysisView !== 'pivot') return null;
    return buildPivotModel(
      pivotRows as Record<string, unknown>[],
      normalizedPivotConfig,
      normalizedPivotConfig.values,
      filterSelections,
      temporalFacetColumns
    );
  }, [
    variant,
    canPivot,
    analysisView,
    pivotRows,
    normalizedPivotConfig,
    filterSelections,
  ]);

  // In analysis variant the server pivot (operating on the full DuckDB session
  // table) is the authoritative source. The client-side `pivotModel` is built
  // from the agent's narrow output sample and silently drops rows for filter
  // values that don't appear in that sample — exactly the user-visible bug
  // this gating is here to prevent. Errors and loading states are already
  // surfaced via `serverPivotError` / `serverPivotLoading` downstream.
  const effectivePivotModel =
    variant === 'analysis' && sessionId
      ? serverPivotModel
      : serverPivotModel ?? pivotModel;

  const handlePivotSliceFilterChange = useCallback(
    (field: string, next: Set<string>) => {
      setFilterSelections((prev) => ({ ...prev, [field]: next }));
    },
    []
  );

  const handleClearPivotFilterField = useCallback(
    (field: string) => {
      const distincts = sessionFilterDistincts[field] ?? [];
      setFilterSelections((prev) => ({
        ...prev,
        [field]: new Set(distincts),
      }));
    },
    [sessionFilterDistincts]
  );

  const handleClearAllPivotFilters = useCallback(() => {
    setFilterSelections((prev) => {
      const next: FilterSelections = { ...prev };
      for (const f of normalizedPivotConfig.filters) {
        const distincts = sessionFilterDistincts[f] ?? [];
        next[f] = new Set(distincts);
      }
      return next;
    });
  }, [normalizedPivotConfig.filters, sessionFilterDistincts]);

  const handlePivotHideColumnMember = useCallback(
    (colField: string, memberKey: string) => {
      setFilterSelections((prev) => {
        const snap = filterDistinctSnapshotRef.current[colField];
        const fromModel = new Set(
          (effectivePivotModel as PivotModelContract | null)?.colKeys ?? []
        );
        const universe =
          snap && snap.size > 0 ? snap : fromModel.size > 0 ? fromModel : new Set([memberKey]);
        const cur = prev[colField] ? new Set(prev[colField]) : new Set(universe);
        cur.delete(memberKey);
        return { ...prev, [colField]: cur };
      });
    },
    [effectivePivotModel]
  );

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

  /** Full pivot tree for Excel export (ignores Top N UI slice). */
  const pivotExportFlatRows = useMemo(() => {
    if (!effectivePivotModel) return [];
    const all = flattenPivotTree((effectivePivotModel as PivotModelContract).tree, collapsedPivotGroups);
    return all.filter((r) => {
      if (!showSubtotals && r.kind === "subtotal") return false;
      if (!showGrandTotal && r.kind === "grand") return false;
      return true;
    });
  }, [effectivePivotModel, collapsedPivotGroups, showSubtotals, showGrandTotal]);

  const handlePivotWorkspaceBgClick = useCallback(
    (e: React.MouseEvent) => {
      if (pivotExpanded) return;
      const el = e.target as HTMLElement;
      if (el.closest('button, a, input, select, textarea, label, [role="button"]')) return;
      if (el.closest('table')) return;
      setPivotExpanded(true);
    },
    [pivotExpanded]
  );

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

      const filterFields = pivotSliceFilterFields(normalizedPivotConfig);
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
      setPivotConfig(normalizePivotConfig(pivotFieldKeys, next)),
    [pivotFieldKeys]
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
        return normalizePivotConfig(pivotFieldKeys, next);
      });
    },
    [pivotFieldKeys]
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
      return normalizePivotConfig(pivotFieldKeys, next);
    });
  }, [pivotFieldKeys]);

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
    const exportPivotTable =
      variant === 'analysis' &&
      canPivot &&
      effectivePivotModel &&
      (analysisView === 'pivot' || pivotExpanded);

    if (exportPivotTable) {
      if (effectivePivotModel.colField && effectivePivotModel.colKeys.length === 0) {
        toast({
          title: 'Nothing to export',
          description:
            'No column keys match the current filters. Adjust filters or the column field.',
          variant: 'destructive',
        });
        return;
      }
      if (pivotExportFlatRows.length === 0) {
        toast({
          title: 'Nothing to export',
          description: 'The pivot has no rows to export.',
          variant: 'destructive',
        });
        return;
      }
      setDownloadingFormat(format);
      try {
        downloadPivotGridAsXlsx(
          effectivePivotModel as unknown as PivotModel,
          pivotExportFlatRows,
          temporalFacetColumns ?? [],
          showValuesAs,
          title
        );
        toast({
          title: 'Success',
          description: 'Pivot downloaded as XLSX',
        });
      } finally {
        setDownloadingFormat(null);
      }
      return;
    }

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
    if (!chartUiActive) return null;
    if (!sessionId) return 'Session is required to preview chart data.';
    if (chartType === 'scatter' && pivotQueryRequest) {
      return 'Scatter is not available with a server pivot layout (it would use raw rows, not your pivot aggregates). Pick Bar, Line, Area, Pie, or Heatmap, or use Build chart from the chat bar for row-level scatter.';
    }
    // PV3 · v2-only marks (donut/radar/bubble/waterfall) build a ChartSpecV2
    // from the materialized pivot rows; they don't need the v1 X/Y/numeric
    // constraints below. The recommender already validated the field shape.
    if (isV2PivotMark(chartType)) {
      if (!chartXCol || !chartYCol) return 'Choose X and Y columns.';
      return null;
    }
    if (!chartXCol || !chartYCol) return 'Choose X and Y columns.';
    const yOkMeasure = chartMeasureOptions.includes(chartYCol);
    const yOkPivotValue = pivotChartValueFieldOptions.includes(chartYCol);
    if (chartType !== 'heatmap' && !yOkMeasure && !yOkPivotValue) {
      return 'Y axis must be a pivot value or numeric column for this chart type.';
    }
    const xOkScatter =
      chartMeasureOptions.includes(chartXCol) ||
      pivotChartValueFieldOptions.includes(chartXCol);
    if (chartType === 'scatter' && chartXCol && chartYCol && (!xOkScatter || (!yOkMeasure && !yOkPivotValue))) {
      return 'Scatter chart requires numeric X and Y columns (pivot value fields allowed).';
    }
    if (chartType === 'heatmap' && !chartZCol) return 'Heatmap requires a numeric Z value.';
    const zOkMeasure = chartMeasureOptions.includes(chartZCol);
    const zOkPivotValue = pivotChartValueFieldOptions.includes(chartZCol);
    if (
      chartType === 'heatmap' &&
      chartZCol &&
      !zOkMeasure &&
      !zOkPivotValue
    ) {
      return 'Heatmap Z must be a pivot value or numeric column.';
    }
    if (serverPivotMeta?.rowCount === 0) return 'No rows match current filters.';
    return null;
  }, [
    chartUiActive,
    sessionId,
    chartXCol,
    chartYCol,
    chartType,
    chartZCol,
    chartMeasureOptions,
    pivotChartValueFieldOptions,
    pivotQueryRequest,
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

    // PV3 · v2-only marks build a ChartSpecV2 client-side from the
    // materialized pivot rows. Skips the server `/chart-preview` round-trip.
    if (isV2PivotMark(chartType)) {
      try {
        if (pivotFlatRows.length === 0) {
          setChartPreview(null);
          setChartPreviewError('No rows to chart from the current pivot.');
          return;
        }
        const v2Spec = buildPivotChartSpecV2({
          chartType,
          recommendation: {
            chartType,
            x: chartXCol || null,
            y: chartYCol || null,
            z: chartZCol || null,
            seriesColumn: chartSeriesCol || null,
            barLayout: chartBarLayout,
            reason: chartRecommendationReason ?? '',
          },
          pivotFlatRows: pivotFlatRows as Array<Record<string, unknown>>,
          valueFields: pivotChartValueFieldOptions,
          title: chartTitle.trim() || 'Pivot chart',
        });
        if (seq !== chartPreviewRequestSeqRef.current) return;
        if (!v2Spec) {
          setChartPreview(null);
          setChartPreviewError('Could not build chart from this pivot configuration.');
          return;
        }
        setChartPreview(v2Spec);
      } finally {
        if (seq === chartPreviewRequestSeqRef.current) setChartPreviewLoading(false);
      }
      return;
    }

    try {
      const body: Record<string, unknown> = {
        title: chartTitle.trim() || 'Pivot chart',
        type: chartType,
        x: chartXCol,
        y: chartType === 'heatmap' ? chartYCol : chartYCol,
      };
      // Omit default aggregate so chart-preview can infer none vs sum from row grain (row fallback).
      if (chartType === 'scatter') {
        body.aggregate = 'none';
      }
      if (chartType === 'heatmap') {
        body.z = chartZCol;
      }
      if (
        (chartType === 'bar' || chartType === 'line' || chartType === 'area') &&
        chartSeriesCol
      ) {
        body.seriesColumn = chartSeriesCol;
        body.barLayout = chartBarLayout;
      }
      const res = await withInflightLimit('chart-preview', () =>
        api.post<{ chart: ChartSpec }>(
          `/api/sessions/${sessionId}/chart-preview`,
          {
            chart: body,
            pivotFilterFields: pivotFilterPayloadForChart.pivotFilterFields,
            pivotFilterSelections: pivotFilterPayloadForChart.pivotFilterSelections,
            ...(pivotQueryRequest ? { pivotQuery: pivotQueryRequest } : {}),
          }
        )
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
    chartRecommendationReason,
    pivotFlatRows,
    pivotChartValueFieldOptions,
    pivotFilterPayloadForChart.pivotFilterFields,
    pivotFilterPayloadForChart.pivotFilterSelections,
    pivotQueryRequest,
  ]);

  useEffect(() => {
    if (!chartUiActive || !sessionId) return;
    if (chartConfigValidationError) {
      setChartPreviewError(chartConfigValidationError);
      setChartPreview(null);
      lastChartConfigRef.current = '';
      return;
    }
    // Skip the API call when the chart is already rendered for this exact config
    // (e.g. user toggled back to chart view without changing anything).
    if (chartPreview !== null && chartConfigHash === lastChartConfigRef.current) return;
    const t = window.setTimeout(() => {
      lastChartConfigRef.current = chartConfigHash;
      void runChartPreview();
    }, 280);
    return () => clearTimeout(t);
  }, [
    chartUiActive,
    sessionId,
    chartConfigValidationError,
    chartConfigHash,
    chartPreview,
    runChartPreview,
  ]);

  // Fetch chart key insight after the preview settles.
  //   • Triggered ONLY by a new `chartPreview` reference (assigned by
  //     runChartPreview after a successful POST), so the preview is always in
  //     sync with the `chartConfigHash` captured in this closure — no fetching
  //     against a stale preview when the hash flips ahead of the preview (Bug B).
  //   • `lastInsightHashRef` is a ref (not state) so updating it does not
  //     retrigger the effect that owns it (Bug A).
  //   • The ref is committed INSIDE the timeout, not at effect-entry, so a
  //     synthetic re-mount (React StrictMode / Vite Fast Refresh) cleanly
  //     re-runs the effect after cleanup cancels the timer — without the
  //     ref-update path the second mount would short-circuit and the fetch
  //     would never fire (Bug D).
  useEffect(() => {
    if (!sessionId || !chartPreview) return;
    // PV3 · The /chart-key-insight endpoint expects v1 ChartSpec; skip the
    // fetch for v2 specs. Pivot key insight (chartView=pivot) handles v2 via
    // the synthetic-spec path it builds itself.
    if (isChartSpecV2(chartPreview)) return;
    // Outcome-aware dedupe: only short-circuit when a successful (or in-flight)
    // run already covers this hash. Empty/error outcomes remain refetchable.
    if (
      lastInsightHashRef.current.hash === chartConfigHash &&
      (lastInsightHashRef.current.outcome === 'success' ||
        lastInsightHashRef.current.outcome === 'pending')
    ) {
      return;
    }
    // Empty-result preview (e.g., "no rows after filters"): keep the prior text
    // visible (don't blank to null) so the user retains context while they
    // adjust filters. Server now returns 200 keyInsight:'' for the same case.
    const previewData = (chartPreview as { data?: unknown[] }).data;
    if (!Array.isArray(previewData) || previewData.length === 0) {
      lastInsightHashRef.current = { hash: chartConfigHash, outcome: 'empty' };
      setChartInsight((prev) => ({
        hash: chartConfigHash,
        text: prev?.text ?? null,
        loading: false,
        error: null,
      }));
      return;
    }
    const requestHash = chartConfigHash;
    const seq = ++chartInsightSeqRef.current;
    setChartInsight((prev) => ({
      hash: requestHash,
      text: prev?.text ?? null,
      loading: true,
      error: null,
    }));
    const t = window.setTimeout(() => {
      lastInsightHashRef.current = { hash: requestHash, outcome: 'pending' };
      void (async () => {
        try {
          const res = await withInflightLimit('chart-key-insight', () =>
            api.post<{ keyInsight: string }>(
              `/api/sessions/${sessionId}/chart-key-insight`,
              { chart: chartPreview, userQuestion }
            )
          );
          if (seq !== chartInsightSeqRef.current) return;
          const text = res.keyInsight ?? '';
          lastInsightHashRef.current = {
            hash: requestHash,
            outcome: text.trim().length > 0 ? 'success' : 'empty',
          };
          setChartInsight((prev) => ({
            hash: requestHash,
            // Preserve prior text when the new response is empty (server-side
            // zero-row fallback) so the card doesn't suddenly disappear.
            text: text.trim().length > 0 ? text : prev?.text ?? null,
            loading: false,
            error: null,
          }));
        } catch (e) {
          if (seq !== chartInsightSeqRef.current) return;
          lastInsightHashRef.current = { hash: requestHash, outcome: 'error' };
          setChartInsight((prev) => ({
            hash: requestHash,
            text: prev?.text ?? null,
            loading: false,
            error: e instanceof Error ? e.message : 'Insight unavailable',
          }));
        }
      })();
    }, 500);
    return () => clearTimeout(t);
    // chartConfigHash intentionally excluded from deps: relying on chartPreview
    // ref changes guarantees we never fetch with a stale preview (see Bug B).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartPreview, sessionId, userQuestion]);

  // Hash for the pivot-view live insight: pivot config + filters. Materialized
  // pivot data (`pivotFlatRows`) drives the actual fetch trigger so we never
  // POST against pre-server-query stale rows.
  const pivotInsightConfigHash = useMemo(
    () =>
      JSON.stringify({
        rows: normalizedPivotConfig.rows,
        columns: normalizedPivotConfig.columns,
        values: normalizedPivotConfig.values,
        pivotFilterPayloadForChart,
      }),
    [
      normalizedPivotConfig.rows,
      normalizedPivotConfig.columns,
      normalizedPivotConfig.values,
      pivotFilterPayloadForChart,
    ]
  );

  // Pivot-view live key insight refetch (Bug 1). Fires whenever the materialized
  // pivot result changes, regardless of `chartUiActive`. Builds a synthetic
  // ChartSpec from the leaf data rows and POSTs to /chart-key-insight with the
  // user's original question so the LLM produces a substantive insight aligned
  // with the current pivot shape — instead of the message-frozen one that may
  // narrate dimensions no longer present.
  useEffect(() => {
    if (!sessionId) return;
    if (variant !== 'analysis') return;
    const rowDims = normalizedPivotConfig.rows;
    const valueSpecs = normalizedPivotConfig.values;
    if (rowDims.length === 0 || valueSpecs.length === 0) return;
    if (
      lastPivotInsightHashRef.current.hash === pivotInsightConfigHash &&
      (lastPivotInsightHashRef.current.outcome === 'success' ||
        lastPivotInsightHashRef.current.outcome === 'pending')
    ) {
      return;
    }

    const xCol = rowDims[0];
    const primaryValue = valueSpecs[0];
    const dataRows: Record<string, string | number | null>[] = [];
    for (const r of pivotFlatRows) {
      if (r.kind !== 'data') continue;
      const row: Record<string, string | number | null> = { [xCol]: r.label };
      for (const vs of valueSpecs) {
        const n = r.values?.flatValues?.[vs.id];
        row[vs.field] =
          typeof n === 'number' && Number.isFinite(n) ? n : null;
      }
      dataRows.push(row);
    }

    if (dataRows.length === 0) {
      lastPivotInsightHashRef.current = {
        hash: pivotInsightConfigHash,
        outcome: 'empty',
      };
      setPivotKeyInsight((prev) => ({
        hash: pivotInsightConfigHash,
        text: prev?.text ?? null,
        loading: false,
        error: null,
      }));
      return;
    }

    const requestHash = pivotInsightConfigHash;
    const seq = ++pivotInsightSeqRef.current;
    setPivotKeyInsight((prev) => ({
      hash: requestHash,
      text: prev?.text ?? null,
      loading: true,
      error: null,
    }));
    const t = window.setTimeout(() => {
      lastPivotInsightHashRef.current = { hash: requestHash, outcome: 'pending' };
      void (async () => {
        try {
          const syntheticChart: ChartSpec = {
            type: 'bar',
            title: 'Pivot summary',
            x: xCol,
            y: primaryValue.field,
            data: dataRows,
          };
          const res = await withInflightLimit('chart-key-insight', () =>
            api.post<{ keyInsight: string }>(
              `/api/sessions/${sessionId}/chart-key-insight`,
              { chart: syntheticChart, userQuestion }
            )
          );
          if (seq !== pivotInsightSeqRef.current) return;
          const text = res.keyInsight ?? '';
          lastPivotInsightHashRef.current = {
            hash: requestHash,
            outcome: text.trim().length > 0 ? 'success' : 'empty',
          };
          setPivotKeyInsight((prev) => ({
            hash: requestHash,
            text: text.trim().length > 0 ? text : prev?.text ?? null,
            loading: false,
            error: null,
          }));
        } catch (e) {
          if (seq !== pivotInsightSeqRef.current) return;
          lastPivotInsightHashRef.current = { hash: requestHash, outcome: 'error' };
          setPivotKeyInsight((prev) => ({
            hash: requestHash,
            text: prev?.text ?? null,
            loading: false,
            error: e instanceof Error ? e.message : 'Insight unavailable',
          }));
        }
      })();
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pivotFlatRows, pivotInsightConfigHash, sessionId, variant, userQuestion]);

  const addChartToChat = useCallback(() => {
    if (!chartPreview || !onChartAdded) return;
    // PV3 · v2-only marks aren't supported by the chat ChartSpec contract yet;
    // the user can still preview them in the pivot card. "Add to chat" stays
    // disabled for v2 specs (handled at the button level).
    if (isChartSpecV2(chartPreview)) return;
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

  if (data.length === 0 && variant !== 'analysis') {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">No data to display</p>
      </Card>
    );
  }

  // Flat table column set should reflect exactly the preview payload we received.
  const columns = flatColumnKeys;

  const showPivotAnalysisView = variant === 'analysis' && analysisView === 'pivot';

  const showPivotExpandedPortal =
    pivotExpanded &&
    variant === 'analysis' &&
    Boolean(sessionId) &&
    canPivot &&
    normalizedPivotConfig.values.length > 0;

  // Live pivot-derived insight (Bug 1) wins over the message-frozen `pivotInsight`
  // so the Key Insight card matches the current pivot shape after the user has
  // added/changed fields. `analysisIntermediateInsight` still wins because it
  // narrates a specific tool step's result, which the live refetch cannot
  // reproduce. Frozen `pivotInsight` remains the boot-state fallback.
  const trimmedAnalysisInsight =
    (analysisIntermediateInsight ?? pivotKeyInsight?.text ?? pivotInsight)?.trim() ?? "";

  const chartPreviewForRender = useMemo<ChartSpec | null>(() => {
    if (!chartPreview) return null;
    // PV3 · v2 specs are rendered by PremiumChart (via ChartShim) and don't
    // share v1's `keyInsight` field. The legacy render prop never fires for
    // v2 specs, so this memo is only ever consumed for v1.
    if (isChartSpecV2(chartPreview)) return null;
    const text = chartInsight?.text?.trim();
    if (!text) return chartPreview;
    return { ...chartPreview, keyInsight: text };
  }, [chartPreview, chartInsight?.text]);
  const toolPreviewRowCount = data.length;
  const pivotResultRowCount = serverPivotMeta?.rowCount;
  const showPivotVersusToolRowClarification =
    variant === "analysis" &&
    Boolean(analysisIntermediateInsight?.trim()) &&
    analysisView === "pivot" &&
    Boolean(sessionId) &&
    !serverPivotLoading &&
    pivotResultRowCount != null &&
    pivotResultRowCount !== toolPreviewRowCount;

  const renderPivotDataWorkspace = (forExpandedView: boolean) => {
    if (forExpandedView && serverPivotLoading && !effectivePivotModel) {
      return (
        <div className="flex flex-1 min-h-[12rem] items-center justify-center text-muted-foreground gap-2">
          <Loader2 className="h-6 w-6 animate-spin" />
          <span className="text-sm">Computing pivot…</span>
        </div>
      );
    }
    if (
      forExpandedView &&
      serverPivotMeta?.rowCount === 0 &&
      !serverPivotLoading &&
      !serverPivotError
    ) {
      return (
        <div className="flex flex-col flex-1 min-h-0 min-w-0 justify-center px-4">
          <p className="text-sm text-muted-foreground text-center border rounded-lg border-dashed py-8">
            No rows match current filters (<code>no_rows_after_filters</code>).
          </p>
        </div>
      );
    }

    if (forExpandedView && !pivotModelForRender && !serverPivotLoading) {
      return (
        <div className="flex flex-1 min-h-[8rem] items-center justify-center px-4 text-center text-sm text-muted-foreground">
          {serverPivotError
            ? 'Pivot request failed. Change fields or filters to retry.'
            : 'No pivot result to display yet.'}
        </div>
      );
    }

    return (
    <div
      className="relative flex flex-col flex-1 min-h-0 min-w-0"
      onClick={handlePivotWorkspaceBgClick}
    >
      {forExpandedView && serverPivotError ? (
        <div
          className="mb-2 shrink-0 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          {serverPivotError}
        </div>
      ) : null}
      {forExpandedView && serverPivotLoading ? (
        <div
          className="pointer-events-none absolute right-3 top-2 z-20 flex items-center gap-1.5 rounded-md border bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm"
          aria-live="polite"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Updating…
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 mb-2 shrink-0">
        {forExpandedView ? (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8 shrink-0"
            title="Exit expanded view"
            aria-label="Exit expanded view"
            onClick={(e) => {
              e.stopPropagation();
              setPivotExpanded(false);
            }}
          >
            <Minimize2 className="h-4 w-4" />
          </Button>
        ) : null}
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

      <PivotFilterChips
        filterFields={normalizedPivotConfig.filters}
        filterSelections={filterSelections}
        distinctsByField={sessionFilterDistincts}
        temporalFacetColumns={temporalFacetColumns}
        onClearField={handleClearPivotFilterField}
        onClearAll={handleClearAllPivotFilters}
      />

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
        layout={forExpandedView ? 'expanded' : 'embedded'}
        sliceFilter={
          sessionId && pivotModelForRender
            ? {
                sessionId,
                rowField: normalizedPivotConfig.rows[0] ?? null,
                colField: normalizedPivotConfig.columns[0] ?? null,
                filterSelections,
                onSliceChange: handlePivotSliceFilterChange,
              }
            : undefined
        }
        onHideColumnMember={sessionId ? handlePivotHideColumnMember : undefined}
      />

      {drillthrough && (
        <div className="mt-3 rounded-lg border border-border/60 bg-background/70 p-3 shrink-0">
          <div className="flex items-center justify-between gap-2 mb-2">
            <div>
              <div className="text-xs text-muted-foreground">Drillthrough rows</div>
              <div className="text-sm font-semibold">
                {drillthrough.loading ? 'Loading...' : `${drillthrough.count ?? 0} rows`}
              </div>
              {drillthrough.error && (
                <div className="text-xs text-destructive mt-1">{drillthrough.error}</div>
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
                              {String((r as any)[c] ?? '')}
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
    </div>
    );
  };

  return (
    <Card className="p-4 mt-2 overflow-hidden border-border/60 shadow-sm bg-gradient-to-br from-card to-card/95">
      {variant === "analysis" && trimmedAnalysisInsight && (
        <div className="mb-3">
          <Card className="p-4 bg-primary/5 border-l-4 border-l-primary shadow-sm border-border/60">
            <div className="flex items-center gap-2 mb-2">
              <Lightbulb className="w-4 h-4 text-primary" />
              <h4 className="text-sm font-semibold text-foreground">Key insight</h4>
              {pivotKeyInsight?.loading && (
                <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Re-deriving insight…
                </span>
              )}
              {sessionId && feedbackTurnId && (
                <div className={pivotKeyInsight?.loading ? "ml-2" : "ml-auto"}>
                  <FeedbackButtons
                    sessionId={sessionId}
                    turnId={feedbackTurnId}
                    target={{ type: "pivot", id: "pivot" }}
                    layout="inline-right"
                    disabled={feedbackReadOnly}
                    initial={pivotFeedbackInitial?.feedback ?? "none"}
                    initialComment={pivotFeedbackInitial?.comment ?? ""}
                  />
                </div>
              )}
            </div>
            <div className="text-sm text-foreground">
              <MarkdownRenderer content={trimmedAnalysisInsight} />
            </div>
            {showPivotVersusToolRowClarification && (
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                {analysisIntermediateInsight && toolPreviewRowCount <= 1 ? (
                  <>
                    The pivot reflects the full session dataset ({pivotResultRowCount}{" "}
                    {pivotResultRowCount === 1 ? "row" : "rows"} for the current layout). The preview
                    table may show only a small slice from this step, so row counts can differ from
                    the pivot.
                  </>
                ) : (
                  <>
                    The pivot below is computed from the full session dataset ({pivotResultRowCount}{" "}
                    {pivotResultRowCount === 1 ? "row" : "rows"} for the current layout). The summary
                    above describes the analytical query result ({toolPreviewRowCount}{" "}
                    {toolPreviewRowCount === 1 ? "row" : "rows"}).
                  </>
                )}
              </p>
            )}
          </Card>
        </div>
      )}
      {(title || sessionId || variant === 'analysis') && (
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          {title && (
            <h4 className="text-sm font-semibold text-foreground">{title}</h4>
          )}
          <div className="flex items-center gap-2 ml-auto flex-wrap">
            {variant === 'analysis' && (
              <div className="flex rounded-lg border border-border/80 bg-muted/30 p-0.5">
                <Button
                  type="button"
                  variant={analysisView === 'chart' ? 'secondary' : 'ghost'}
                  size="sm"
                  className="text-xs h-8 px-3"
                  onClick={() => setAnalysisView('chart')}
                >
                  Chart
                </Button>
                <Button
                  type="button"
                  variant={analysisView === 'pivot' ? 'secondary' : 'ghost'}
                  size="sm"
                  className="text-xs h-8 px-3"
                  onClick={() => setAnalysisView('pivot')}
                >
                  Pivot
                </Button>
              </div>
            )}
            {sessionId && (
              <>
                {variant === 'analysis' && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    onClick={() => {
                      const cfg = normalizedPivotConfig;
                      if (!cfg || cfg.values.length === 0) {
                        toast({
                          title: 'Pivot is empty',
                          description: 'Add at least one value before saving to a dashboard.',
                          variant: 'destructive',
                        });
                        return;
                      }
                      const fs: Record<string, string[]> = {};
                      for (const [k, v] of Object.entries(filterSelections)) {
                        if (v instanceof Set) fs[k] = Array.from(v);
                      }
                      const titleParts: string[] = [];
                      if (cfg.values.length > 0) {
                        titleParts.push(
                          cfg.values.map((v) => `${v.field} (${v.agg})`).join(', ')
                        );
                      }
                      if (cfg.rows.length > 0) titleParts.push(`by ${cfg.rows.join(' × ')}`);
                      if (cfg.columns.length > 0)
                        titleParts.push(`across ${cfg.columns.join(' × ')}`);
                      const title = titleParts.join(' ').slice(0, 200) || 'Pivot view';
                      const built: DashboardPivotSpec = {
                        id: `pivot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                        title,
                        pivotConfig: {
                          rows: cfg.rows,
                          columns: cfg.columns,
                          values: cfg.values,
                          filters: cfg.filters,
                          unused: cfg.unused,
                          ...(cfg.rowSort ? { rowSort: cfg.rowSort } : {}),
                        },
                        ...(Object.keys(fs).length > 0 ? { filterSelections: fs } : {}),
                        analysisView: analysisView === 'flat' ? 'flat' : analysisView,
                        ...(analysisView === 'chart' && chartType && chartXCol && chartYCol
                          ? {
                              chart: {
                                type: chartType as
                                  | 'bar'
                                  | 'line'
                                  | 'area'
                                  | 'scatter'
                                  | 'pie'
                                  | 'heatmap',
                                xCol: chartXCol,
                                yCol: chartYCol,
                                ...(chartZCol ? { zCol: chartZCol } : {}),
                                seriesCol: chartSeriesCol,
                                barLayout: chartBarLayout as 'stacked' | 'grouped',
                              },
                            }
                          : {}),
                        sourceSessionId: sessionId,
                        createdAt: Date.now(),
                      };
                      setPivotAddDialogPivot(built);
                    }}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Add to Dashboard
                  </Button>
                )}
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
          variant === 'analysis'
            ? 'flex gap-0 items-stretch min-w-0 h-[min(70vh,40rem)]'
            : undefined
        }
      >
        <div
          className={
            variant === 'analysis'
              ? 'flex-1 min-w-0 min-h-0 flex flex-col pr-2'
              : undefined
          }
        >
            {variant === 'analysis' ? (
              <div className="flex justify-end mb-2 shrink-0">
                <Button
                  ref={pivotExpandButtonRef}
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  title="Expand pivot"
                  aria-label="Expand pivot"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPivotExpanded(true);
                  }}
                >
                  <Maximize2 className="h-4 w-4" />
                </Button>
              </div>
            ) : null}
            {analysisView === 'chart' ? (
              // G1-P1.a — chart card uses an EXPLICIT-pixel chart wrapper
              // (h-[480px]) instead of flex-1 + min-h. Recharts'
              // ResponsiveContainer with height="100%" needs a pixel-height
              // parent on first render; flex-1 sees 0 until the next
              // ResizeObserver tick, which is what produced the "chart
              // appears too high in the card / chart only renders in
              // fullscreen" symptom.
              <div className="flex flex-col flex-1 min-h-0 gap-3 rounded-lg border border-border/60 bg-muted/10 p-3 overflow-y-auto">
                <div className="flex flex-wrap items-end gap-3 shrink-0">
                  <Button
                    type="button"
                    size="sm"
                    className="text-xs"
                    onClick={addChartToChat}
                    disabled={
                      !chartPreview ||
                      !onChartAdded ||
                      (chartPreview != null && isChartSpecV2(chartPreview))
                    }
                    title={
                      chartPreview && isChartSpecV2(chartPreview)
                        ? 'Premium charts (donut/radar/bubble/waterfall) cannot be added to chat yet.'
                        : undefined
                    }
                  >
                    Add to chat
                  </Button>
                  {/* PV4 · Change Chart Type — lets the user override the
                      auto-recommended mark. Invalid options are disabled with
                      a tooltip explaining what's missing. Selecting a new mark
                      flips chartMappingManualRef so the auto-recommend effect
                      doesn't clobber the user's choice on the next pivot
                      change. */}
                  <div className="space-y-1.5 min-w-[10rem]">
                    <label
                      htmlFor="pivot-chart-type"
                      className="text-xs text-muted-foreground"
                    >
                      Chart type
                    </label>
                    <select
                      id="pivot-chart-type"
                      className="w-full rounded border border-border/60 bg-background px-2 py-1.5 text-xs"
                      value={chartType}
                      onChange={(e) => {
                        chartMappingManualRef.current = true;
                        chartTypeUserPickedRef.current = true;
                        setChartType(e.target.value as PivotChartKind);
                      }}
                    >
                      {CHART_KIND_DROPDOWN_ORDER.map((m) => {
                        const v = chartValidity?.[m];
                        const disabled = !!v && !v.valid;
                        return (
                          <option
                            key={m}
                            value={m}
                            disabled={disabled}
                            title={disabled ? v?.reason : undefined}
                          >
                            {CHART_KIND_LABEL[m]}
                            {disabled ? ' (n/a)' : ''}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                  {chartType === 'bar' && pivotChartSeriesOptions.length > 0 ? (
                    <div className="space-y-1.5 min-w-[9rem]">
                      <label className="text-xs text-muted-foreground">Bar layout</label>
                      <select
                        className="w-full rounded border border-border/60 bg-background px-2 py-1.5 text-xs"
                        value={chartBarLayout}
                        onChange={(e) => {
                          chartMappingManualRef.current = true;
                          setChartBarLayout(e.target.value as 'stacked' | 'grouped');
                        }}
                      >
                        <option value="stacked">Stacked</option>
                        <option value="grouped">Grouped</option>
                      </select>
                    </div>
                  ) : null}
                </div>
                {chartRecommendationReason ? (
                  <p className="text-[11px] text-muted-foreground leading-relaxed shrink-0">
                    {chartRecommendationReason}
                  </p>
                ) : null}
                {(chartConfigValidationError || chartPreviewError) && (
                  <p className="text-xs text-destructive shrink-0" role="alert">
                    {chartConfigValidationError ?? chartPreviewError}
                  </p>
                )}
                <div className="flex h-[480px] flex-col rounded-lg border border-border/60 bg-background p-2 relative">
                  {chartPreviewLoading && !chartPreview ? (
                    <div className="absolute inset-0 flex items-center justify-center text-muted-foreground gap-2 text-xs">
                      <Loader2 className="h-5 w-5 animate-spin" />
                      Generating chart…
                    </div>
                  ) : null}
                  {chartPreview ? (
                    <div className="flex flex-1 min-h-0 flex-col">
                      <ChartShim
                        spec={chartPreview}
                        legacy={() => (
                          <ChartRenderer
                            chart={chartPreviewForRender ?? (chartPreview as ChartSpec)}
                            index={0}
                            isSingleChart
                            showAddButton
                            enableFilters
                            fillParent
                            keyInsightSessionId={null}
                            onSuggestedQuestionClick={onSuggestedQuestionClick}
                          />
                        )}
                      />
                    </div>
                  ) : !chartPreviewLoading ? (
                    <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
                      Chart preview will appear automatically from your pivot layout.
                    </div>
                  ) : null}
                </div>
                {chartPreview ? <ChartKeyInsightCallout insight={chartInsight} /> : null}
              </div>
            ) : showPivotAnalysisView ? (
              !canPivot ? (
                <p className="text-sm text-muted-foreground py-6 text-center border rounded-lg border-dashed">
                  Drag fields into <strong>Rows</strong> and <strong>Values</strong> in Pivot fields to
                  build the pivot.
                </p>
              ) : sessionSampleError && !effectivePivotModel ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-6 text-sm text-destructive text-center">
                  Pivot unavailable: {sessionSampleError}
                </div>
              ) : pivotExpanded && canPivot ? (
                <p className="text-xs text-muted-foreground py-6 text-center border border-dashed rounded-lg leading-relaxed px-2">
                  Pivot is open in an expanded view. Press Escape, click the dimmed backdrop, or use
                  the close control in the overlay to return here.
                </p>
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
                renderPivotDataWorkspace(false)
              )
            ) : (
            <div
              className={
                variant === 'analysis'
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
          {variant === 'analysis' && !pivotExpanded && (
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
                      className="flex flex-1 min-w-0 min-h-0 flex-col p-2.5 overflow-hidden"
                    >
                      <PivotFieldPanel
                        fillAvailableHeight
                        config={normalizedPivotConfig}
                        onConfigChange={handlePivotConfigChange}
                        filterSelections={filterSelections}
                        onFilterSelectionsChange={setFilterSelections}
                        data={pivotRows as Record<string, unknown>[]}
                        numericColumns={numericColumns}
                        temporalFacetColumns={temporalFacetColumns}
                        filterDistinctsFromSession={sessionFilterDistincts}
                        filterDistinctsResolution={filterDistinctsResolution}
                        onRetryDistincts={handleRetryFilterDistincts}
                        variant={variant === 'analysis' ? 'analysis' : 'preview'}
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
        !(variant === 'analysis' && analysisView !== 'flat') && (
        <p className="text-xs text-muted-foreground mt-2">
          Showing {maxRows} of {data.length} rows
        </p>
      )}

      {showPivotExpandedPortal &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-40 bg-[hsl(240_6%_10%/0.35)] backdrop-blur-sm"
              aria-hidden
              onClick={() => setPivotExpanded(false)}
            />
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="pivot-expanded-title"
              className="fixed z-[41] flex flex-col rounded-xl border bg-background shadow-2xl overflow-hidden left-3 right-3 top-3 bottom-3 md:left-4 md:right-4 md:top-4 md:bottom-4 max-h-[calc(100dvh-1.5rem)] md:max-h-[calc(100dvh-2rem)]"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2 shrink-0 bg-background">
                <div className="flex flex-wrap items-center gap-2 min-w-0">
                  <h2 id="pivot-expanded-title" className="text-sm font-semibold shrink-0">
                    Pivot
                  </h2>
                  <div className="flex rounded-lg border border-border/80 bg-muted/30 p-0.5">
                    <Button
                      type="button"
                      variant={expandedWorkspaceTab === 'pivot' ? 'secondary' : 'ghost'}
                      size="sm"
                      className="text-xs h-8 px-2.5"
                      onClick={() => setExpandedWorkspaceTab('pivot')}
                    >
                      <Table2 className="h-3.5 w-3.5 mr-1" />
                      Table
                    </Button>
                    <Button
                      type="button"
                      variant={expandedWorkspaceTab === 'chart' ? 'secondary' : 'ghost'}
                      size="sm"
                      className="text-xs h-8 px-2.5"
                      onClick={() => setExpandedWorkspaceTab('chart')}
                    >
                      <BarChart3 className="h-3.5 w-3.5 mr-1" />
                      Chart
                    </Button>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {sessionId ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="text-xs h-8"
                      onClick={() => handleDownload('xlsx')}
                      disabled={downloadingFormat !== null}
                    >
                      {downloadingFormat === 'xlsx' ? (
                        <>
                          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          …
                        </>
                      ) : (
                        <>
                          <Download className="h-3 w-3 mr-1" />
                          Excel
                        </>
                      )}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => setPivotExpanded(false)}
                    aria-label="Close expanded pivot"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="flex flex-1 min-h-0 min-w-0 gap-0 items-stretch">
                <div className="flex-1 min-w-0 min-h-0 flex flex-col px-2 pb-2 pt-2 overflow-hidden">
                  {expandedWorkspaceTab === 'chart' ? (
                    <div className="flex flex-1 min-h-0 flex-col rounded-lg border border-border/60 bg-muted/10 p-3 gap-3 overflow-hidden">
                      <div className="flex flex-wrap items-end gap-3 shrink-0">
                        <Button
                          type="button"
                          size="sm"
                          className="text-xs"
                          onClick={addChartToChat}
                          disabled={
                            !chartPreview ||
                            !onChartAdded ||
                            (chartPreview != null && isChartSpecV2(chartPreview))
                          }
                          title={
                            chartPreview && isChartSpecV2(chartPreview)
                              ? 'Premium charts (donut/radar/bubble/waterfall) cannot be added to chat yet.'
                              : undefined
                          }
                        >
                          Add to chat
                        </Button>
                        <div className="space-y-1.5 min-w-[10rem]">
                          <label
                            htmlFor="pivot-chart-type-expanded"
                            className="text-xs text-muted-foreground"
                          >
                            Chart type
                          </label>
                          <select
                            id="pivot-chart-type-expanded"
                            className="w-full rounded border border-border/60 bg-background px-2 py-1.5 text-xs"
                            value={chartType}
                            onChange={(e) => {
                              chartMappingManualRef.current = true;
                              chartTypeUserPickedRef.current = true;
                              setChartType(e.target.value as PivotChartKind);
                            }}
                          >
                            {CHART_KIND_DROPDOWN_ORDER.map((m) => {
                              const v = chartValidity?.[m];
                              const disabled = !!v && !v.valid;
                              return (
                                <option
                                  key={m}
                                  value={m}
                                  disabled={disabled}
                                  title={disabled ? v?.reason : undefined}
                                >
                                  {CHART_KIND_LABEL[m]}
                                  {disabled ? ' (n/a)' : ''}
                                </option>
                              );
                            })}
                          </select>
                        </div>
                        {chartType === 'bar' && pivotChartSeriesOptions.length > 0 ? (
                          <div className="space-y-1.5 min-w-[9rem]">
                            <label className="text-xs text-muted-foreground">Bar layout</label>
                            <select
                              className="w-full rounded border border-border/60 bg-background px-2 py-1.5 text-xs"
                              value={chartBarLayout}
                              onChange={(e) => {
                                chartMappingManualRef.current = true;
                                setChartBarLayout(e.target.value as 'stacked' | 'grouped');
                              }}
                            >
                              <option value="stacked">Stacked</option>
                              <option value="grouped">Grouped</option>
                            </select>
                          </div>
                        ) : null}
                      </div>
                      {chartRecommendationReason ? (
                        <p className="text-[11px] text-muted-foreground leading-relaxed shrink-0">
                          {chartRecommendationReason}
                        </p>
                      ) : null}
                      {(chartConfigValidationError || chartPreviewError) && (
                        <p className="text-xs text-destructive shrink-0" role="alert">
                          {chartConfigValidationError ?? chartPreviewError}
                        </p>
                      )}
                      <div className="flex flex-1 min-h-[400px] flex-col rounded-lg border border-border/60 bg-background p-2 relative">
                        {chartPreviewLoading && !chartPreview ? (
                          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground gap-2 text-xs">
                            <Loader2 className="h-5 w-5 animate-spin" />
                            Generating chart…
                          </div>
                        ) : null}
                        {chartPreview ? (
                          <div className="flex flex-1 min-h-0 flex-col">
                            <ChartShim
                              spec={chartPreview}
                              legacy={() => (
                                <ChartRenderer
                                  chart={chartPreviewForRender ?? (chartPreview as ChartSpec)}
                                  index={0}
                                  isSingleChart
                                  showAddButton
                                  enableFilters
                                  fillParent
                                  keyInsightSessionId={null}
                                  onSuggestedQuestionClick={onSuggestedQuestionClick}
                                />
                              )}
                            />
                          </div>
                        ) : !chartPreviewLoading ? (
                          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground px-2 text-center">
                            Chart preview updates from your pivot layout and filters.
                          </div>
                        ) : null}
                      </div>
                      {chartPreview ? (
                        <ChartKeyInsightCallout insight={chartInsight} />
                      ) : null}
                    </div>
                  ) : (
                    renderPivotDataWorkspace(true)
                  )}
                </div>
                <motion.div
                  key="pivot-panel-expanded"
                  initial={false}
                  animate={{
                    width: pivotPanelOpen ? 300 : 44,
                    opacity: 1,
                  }}
                  transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                  className="shrink-0 flex h-full min-h-0 flex-col border-l border-border/60 bg-muted/10 overflow-hidden self-stretch"
                >
                  <div className="flex min-h-0 min-w-0 flex-1">
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
                          key="panel-inner-expanded"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.15 }}
                          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-2.5"
                        >
                          <PivotFieldPanel
                            fillAvailableHeight
                            maxAvailableVisible={10}
                            config={normalizedPivotConfig}
                            onConfigChange={handlePivotConfigChange}
                            filterSelections={filterSelections}
                            onFilterSelectionsChange={setFilterSelections}
                            data={pivotRows as Record<string, unknown>[]}
                            numericColumns={numericColumns}
                            temporalFacetColumns={temporalFacetColumns}
                            filterDistinctsFromSession={sessionFilterDistincts}
                            filterDistinctsResolution={filterDistinctsResolution}
                            onRetryDistincts={handleRetryFilterDistincts}
                            variant={variant === 'analysis' ? 'analysis' : 'preview'}
                          />
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </motion.div>
              </div>
            </div>
          </>,
          document.body
        )}
      {pivotAddDialogPivot && (
        <AddPivotToDashboardModal
          isOpen={Boolean(pivotAddDialogPivot)}
          onClose={() => setPivotAddDialogPivot(null)}
          pivot={pivotAddDialogPivot}
        />
      )}
    </Card>
  );
}

function ChartKeyInsightCallout({
  insight,
}: {
  insight: { text: string | null; loading: boolean; error: string | null } | null;
}) {
  if (!insight) return null;
  // No text yet and we're loading the first one — show a slim spinner.
  if (insight.loading && !insight.text) {
    return (
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/60 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Generating key insight…
      </div>
    );
  }
  // Error with no prior text to fall back on — show the error.
  if (insight.error && !insight.text) {
    return (
      <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        Key insight unavailable: {insight.error}
      </div>
    );
  }
  if (!insight.text) return null;
  return (
    <Card className="mt-3 p-3 bg-primary/5 border-l-4 border-l-primary shadow-sm border-border/60">
      <div className="flex items-center gap-2 mb-1.5">
        <Lightbulb className="w-4 h-4 text-primary" />
        <h4 className="text-xs font-semibold text-foreground uppercase tracking-wide">
          Key insight
        </h4>
        {insight.loading && (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Refreshing…
          </span>
        )}
      </div>
      <div className="text-sm text-foreground">
        <MarkdownRenderer content={insight.text} />
      </div>
      {insight.error && (
        <p className="mt-1.5 text-[11px] text-muted-foreground italic">
          Couldn't refresh: {insight.error}. Showing previous insight.
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
