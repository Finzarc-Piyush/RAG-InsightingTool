import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChartSpec } from '@/shared/schema';
import { applyChartSort } from '@/shared/chartSort';
import { ChartModal } from './ChartModal';
import { ChartOnlyModal } from '@/pages/Dashboard/Components/ChartOnlyModal';
import { DashboardModal } from './DashboardModal/DashboardModal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Slider } from '@/components/ui/slider';
import { Filter, Plus, X, Loader2, Settings2 } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useIntersectionObserver } from '@/hooks/useIntersectionObserver';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  ScatterChart,
  Scatter,
  ComposedChart,
  PieChart,
  Pie,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  Cell,
} from 'recharts';
import {
  ActiveChartFilters,
  applyChartFilters,
  deriveChartFilterDefinitions,
  hasActiveFilters,
  ChartFilterDefinition,
  visibleSeriesKeysFromFilters,
} from '@/lib/chartFilters';
import { parseDateLike } from '@/lib/parseDateLike';
import { compareTemporalOrLexicalLabels } from '@/lib/temporalAxisSort';
import { formatTemporalPeriodKeyForDisplay } from '@/lib/temporalPeriodDisplay';
import { DEFAULT_Y_TICKS } from '@/lib/charts/yAxisTickCount';
import { capScatterPoints } from '@/lib/charts/scatterDecimation';
import { makeAxisTickFormatter } from '@/lib/charts/format';
import {
  formatDateForDisplay,
  determineSliderStep,
  parseNumericValue,
  getNumericValues,
  getDynamicDomain,
  formatAxisLabelFieldBlind as formatAxisLabel,
} from '@/lib/charts/chartFilterHelpers';
import { KEY_SEP } from '@/lib/charts/compositeKey';
import {
  CHART_SERIES_COLORS as COLORS,
  evenlySpacedDataKeys,
  sortRowsForLineAreaChart,
} from '@/lib/chartRechartsShared';
import { maxXAxisLabels } from '@/lib/charts/xAxisLabelCap';
import { useContainerWidth } from '@/hooks/useContainerWidth';
import { formatChartTooltipValue, rechartsTooltipValueFormatter } from '@/lib/chartNumberFormat';
import { RechartsWideLegendContent } from '@/lib/rechartsWideLegend';

interface ChartRendererProps {
  chart: ChartSpec;
  index: number;
  isSingleChart?: boolean;
  showAddButton?: boolean;
  useChartOnlyModal?: boolean;
  fillParent?: boolean;
  enableFilters?: boolean;
  filters?: ActiveChartFilters;
  onFiltersChange?: (filters: ActiveChartFilters) => void;
  isLoading?: boolean; // Loading state for correlation charts
  loadingProgress?: { processed: number; total: number; message?: string }; // Progress info
  /** Enables on-demand Key Insight fetch in the modal when the chart has no insight. */
  keyInsightSessionId?: string | null;
  /** Forwarded to ChartModal so the trailing "Next, …" insight chip can pre-fill the composer. */
  onSuggestedQuestionClick?: (question: string) => void;
  /**
   * A1 · whether a click on the chart card opens this renderer's own
   * fullscreen modal. Default true (chat charts). The dashboard tile sets
   * this false so its OWN expand modal (ChartTileBody) owns click-to-expand
   * uniformly for both the v1 (ChartRenderer) and v2 (PremiumChart) paths —
   * otherwise a v1 tile would open two modals on one click.
   */
  expandOnClick?: boolean;
}

const MAX_COMPACT_X_TICKS = 6;
// Approx horizontal axis margin subtracted from the measured container width to
// estimate the usable x-axis plot width. MUST track the left+right `margin`
// props on the <BarChart>/<LineChart>/<AreaChart>/<ComposedChart> in
// renderChart(): left 50 + right 10 (+~4px buffer) for single-axis charts. If
// those margins change, update this. Dual-axis (y2) charts add the extra below.
const X_AXIS_MARGIN_PX = 64;
// Extra right-axis margin a dual-axis (y2) line/area chart adds (right 50 vs 10).
const DUAL_AXIS_EXTRA_MARGIN_PX = 40;
// Min horizontal slot per bar in a compact chat tile so bars stay legible.
const MIN_COMPACT_BAR_SLOT_PX = 14;

type FiltersUpdater = ActiveChartFilters | ((prev: ActiveChartFilters) => ActiveChartFilters);

const formatNumberForDisplay = (value: number) => {
  if (Number.isNaN(value)) return '';
  if (Number.isInteger(value)) return value.toString();
  const abs = Math.abs(value);
  if (abs >= 1000 || abs < 0.01) {
    return value.toPrecision(3);
  }
  return value.toFixed(2);
};

export function ChartRenderer({
  chart,
  index,
  isSingleChart = false,
  showAddButton = true,
  useChartOnlyModal = false,
  fillParent = false,
  enableFilters = false,
  filters,
  onFiltersChange,
  isLoading = false,
  loadingProgress,
  keyInsightSessionId = null,
  onSuggestedQuestionClick,
  expandOnClick = true,
}: ChartRendererProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDashboardModalOpen, setIsDashboardModalOpen] = useState(false);
  const [internalFilters, setInternalFilters] = useState<ActiveChartFilters>({});
  const [showDots, setShowDots] = useState(false); // State for showing/hiding dots on line charts
  const [hideOutliers, setHideOutliers] = useState(false); // Hide outliers for scatter plots
  // Point visibility controls for scatter plots
  const [pointSize, setPointSize] = useState<'small' | 'medium' | 'large'>('medium');
  const [pointOpacity, setPointOpacity] = useState<'low' | 'medium' | 'high'>('medium');
  const [pointDensity, setPointDensity] = useState<'low' | 'medium' | 'high' | 'all'>('medium');
  const {
    type,
    title,
    data: chartDataSource = [],
    x,
    y,
    xDomain,
    yDomain,
    trendLine,
    xLabel,
    yLabel,
    z: zKey,
    seriesKeys: specSeriesKeys,
    barLayout,
  } = chart;
  const chartColor = COLORS[index % COLORS.length];

  // Wave F2 · field-aware axis tick formatters. The legacy `formatAxisLabel`
  // is field-blind, so a rate measure like `pjp_adherence_rate` (0–1) rendered
  // as raw decimals ("0.28") instead of percentages ("28%"). These bind the
  // shared `makeAxisTickFormatter` (inferFormatHint → percent/currency/KMB) to
  // the measure fields. String category ticks pass through unchanged, so this
  // is safe to use on any value axis. Fixes chat AND dashboard (shared
  // renderer).
  const yTickFormatter = useMemo(() => makeAxisTickFormatter(y), [y]);
  const y2TickFormatter = useMemo(
    () => makeAxisTickFormatter(chart.y2),
    [chart.y2],
  );
  // Scatter plots put a numeric measure on the X axis too.
  const xTickFormatter = useMemo(() => makeAxisTickFormatter(x), [x]);

  // Use IntersectionObserver to lazy load charts (only render when visible)
  // Disable lazy loading for single charts or when fillParent is true (dashboard tiles)
  const [containerRef, isVisible] = useIntersectionObserver({
    threshold: 0.1,
    rootMargin: '100px', // Start loading 100px before chart enters viewport
    enabled: !isSingleChart && !fillParent, // Always load single charts and dashboard tiles immediately
  });

  const originalData = useMemo(() => {
    if (!Array.isArray(chartDataSource)) {
      return [];
    }
    return chartDataSource as Record<string, unknown>[];
  }, [chartDataSource]);

  const filterDefinitions: ChartFilterDefinition[] = useMemo(() => {
    if (!enableFilters) return [];
    const forceCategoricalKeys: string[] = [];
    const forceNumericKeys: string[] = [];
    const forceDateKeys: string[] = [];
    const excludeKeys: string[] = [];

    const rowKeys = originalData[0] ? Object.keys(originalData[0]) : [];
    if (
      (type === 'line' || type === 'bar' || type === 'area') &&
      typeof y === 'string' &&
      rowKeys.includes(y)
    ) {
      forceNumericKeys.push(y);
    }
    if (specSeriesKeys?.length) {
      for (const sk of specSeriesKeys) {
        // Exclude series keys from filter UI — legend handles series visibility
        if (!excludeKeys.includes(sk)) {
          excludeKeys.push(sk);
        }
      }
    }

    // Check if X-axis is a date column (for time-based charts)
    if (typeof x === 'string') {
      // Check if column name suggests it's a date column
      const xLower = x.toLowerCase();
      const nameSuggestsDate = /\b(date|month|week|year|time|period)\b/i.test(xLower);
      
      // Check if sample values look like dates
      if (originalData.length > 0) {
        const sampleValues = originalData.slice(0, Math.min(5, originalData.length))
          .map(row => String(row[x] || ''));
        const allLookLikeDates = sampleValues.length > 0 && 
          sampleValues.every(v => {
            if (!v || v.length < 4) return false;
            // Check for month-year format like "Apr-22", "May-22"
            if (/^[A-Za-z]{3}[-/]?\d{2,4}$/i.test(v.trim())) return true;
            // Check for standard date formats
            const parsed = new Date(v);
            return !isNaN(parsed.getTime());
          });
        
        if (nameSuggestsDate || allLookLikeDates) {
          forceDateKeys.push(x);
        } else {
          forceCategoricalKeys.push(x);
        }
      } else {
        forceCategoricalKeys.push(x);
      }
    }

    const base = deriveChartFilterDefinitions(originalData, {
      excludeKeys,
      forceCategoricalKeys,
      forceNumericKeys,
      forceDateKeys,
    });

    return base;
  }, [enableFilters, originalData, x, y, specSeriesKeys, type]);

  const isControlled = filters !== undefined;

  const updateFilters = useCallback(
    (updater: FiltersUpdater) => {
      if (isControlled) {
        if (!onFiltersChange) return;
        const base = filters ?? {};
        const next = typeof updater === 'function' ? (updater as (prev: ActiveChartFilters) => ActiveChartFilters)(base) : updater;
        onFiltersChange(next);
      } else {
        setInternalFilters((prev) => {
          const next = typeof updater === 'function' ? (updater as (prev: ActiveChartFilters) => ActiveChartFilters)(prev) : updater;
          onFiltersChange?.(next);
          return next;
        });
      }
    },
    [filters, isControlled, onFiltersChange]
  );

  const baseFilters = useMemo(
    () => (isControlled ? (filters ?? {}) : internalFilters),
    [isControlled, filters, internalFilters],
  );

  const effectiveFilters: ActiveChartFilters = useMemo(() => {
    if (!enableFilters) {
      return {};
    }
    if (!filterDefinitions.length) {
      return {};
    }

    const allowedKeys = new Set(filterDefinitions.map((definition) => definition.key));
    const sanitized: ActiveChartFilters = {};

    Object.entries(baseFilters).forEach(([key, selection]) => {
      if (!selection) return;
      if (!allowedKeys.has(key)) return;

      if (selection.type === 'categorical') {
        if (!selection.values || selection.values.length === 0) return;
        sanitized[key] = {
          type: 'categorical',
          values: Array.from(new Set(selection.values)),
        };
        return;
      }

      if (selection.type === 'date') {
        if (!selection.start && !selection.end) return;
        sanitized[key] = {
          type: 'date',
          start: selection.start,
          end: selection.end,
        };
        return;
      }

      if (selection.type === 'numeric') {
        if (selection.min === undefined && selection.max === undefined) return;
        sanitized[key] = {
          type: 'numeric',
          min: selection.min,
          max: selection.max,
        };
      }
    });

    return sanitized;
  }, [baseFilters, enableFilters, filterDefinitions]);

  const filteredSeriesKeys = useMemo(
    () => visibleSeriesKeysFromFilters(specSeriesKeys, effectiveFilters),
    [specSeriesKeys, effectiveFilters]
  );

  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());
  const specSeriesKeysSig = specSeriesKeys?.join(',');
  useEffect(() => { setHiddenSeries(new Set()); }, [specSeriesKeysSig]); // reset on chart change

  const filteredData = useMemo(() => {
    if (!enableFilters) return originalData;
    return applyChartFilters(originalData, effectiveFilters);
  }, [enableFilters, effectiveFilters, originalData]);

  const filtersApplied = enableFilters && hasActiveFilters(effectiveFilters);
  const baseChartData = enableFilters ? filteredData : originalData;
  
  const chartData = baseChartData;

  const lineAreaSortedData = useMemo(
    () =>
      sortRowsForLineAreaChart(
        type,
        chartData as Record<string, unknown>[],
        typeof x === 'string' ? x : undefined
      ) as typeof chartData,
    [type, chartData, x]
  );
  
  // Process scatter plot data for display (only outlier filtering) - show ALL data points
  const processedScatterData = useMemo(() => {
    if (type !== 'scatter') return chartData;
    
    let displayData = [...chartData];
    
    // Filter out outliers if enabled (user choice)
    if (hideOutliers && displayData.length > 0) {
      const validData = displayData.filter((d: any) => {
        const xVal = typeof d[x] === 'number' ? d[x] : Number(d[x]);
        const yVal = typeof d[y] === 'number' ? d[y] : Number(d[y]);
        return !isNaN(xVal) && !isNaN(yVal);
      });
      
      if (validData.length > 0) {
        const xValues = validData.map((d: any) => (typeof d[x] === 'number' ? d[x] : Number(d[x])));
        const yValues = validData.map((d: any) => (typeof d[y] === 'number' ? d[y] : Number(d[y])));
        
        // Calculate IQR for outlier detection
        const sortedX = [...xValues].sort((a, b) => a - b);
        const sortedY = [...yValues].sort((a, b) => a - b);
        
        const q1X = sortedX[Math.floor(sortedX.length * 0.25)];
        const q3X = sortedX[Math.floor(sortedX.length * 0.75)];
        const iqrX = q3X - q1X;
        const lowerBoundX = q1X - 1.5 * iqrX;
        const upperBoundX = q3X + 1.5 * iqrX;
        
        const q1Y = sortedY[Math.floor(sortedY.length * 0.25)];
        const q3Y = sortedY[Math.floor(sortedY.length * 0.75)];
        const iqrY = q3Y - q1Y;
        const lowerBoundY = q1Y - 1.5 * iqrY;
        const upperBoundY = q3Y + 1.5 * iqrY;
        
        displayData = validData.filter((d: any) => {
          const xVal = typeof d[x] === 'number' ? d[x] : Number(d[x]);
          const yVal = typeof d[y] === 'number' ? d[y] : Number(d[y]);
          return xVal >= lowerBoundX && xVal <= upperBoundX && 
                 yVal >= lowerBoundY && yVal <= upperBoundY;
        });
      }
    }
    
    // Always show all data points - no sampling
    return displayData;
  }, [type, chartData, hideOutliers, x, y]);

  // Optimize scatter data for rendering performance based on point density preference
  // This must be at the top level to follow Rules of Hooks
  const optimizedScatterData = useMemo(() => {
    if (type !== 'scatter') return processedScatterData;
    return capScatterPoints(processedScatterData, pointDensity);
  }, [type, processedScatterData, pointDensity]);

  // Measure the rendered chart width so the x-axis label budget tracks the
  // actual pixel width (recharts renders inside a width="100%" container).
  const [chartWidthRef, chartWidth] = useContainerWidth<HTMLDivElement>();

  // Width-aware x-axis label budget — fit as many rotated (-45°, fontSize 10)
  // labels as the measured plot width allows instead of a fixed 10/11. Before
  // the container is measured (first paint) it falls back to the default budget.
  const maxXLabels = useMemo(() => {
    // Dual-axis (y2) line/area charts use a wider right margin (50 vs 10), so
    // the usable plot width is narrower — account for it or labels over-pack.
    const marginPx = X_AXIS_MARGIN_PX + (chart.y2 ? DUAL_AXIS_EXTRA_MARGIN_PX : 0);
    return maxXAxisLabels({
      axisWidthPx: chartWidth > 0 ? chartWidth - marginPx : undefined,
      fontSizePx: 10,
      rotationDeg: -45,
    });
  }, [chartWidth, chart.y2]);

  // In a small chat tile, a bar chart with many categories is reduced to its
  // largest categories so each bar stays legible. The count is width-derived
  // (never below the historical floor of MAX_COMPACT_X_TICKS), not a fixed 6 —
  // a wider tile keeps more bars. Labels are still thinned by `maxXLabels`.
  const compactBarLimit = useMemo(() => {
    if (chartWidth <= 0) return MAX_COMPACT_X_TICKS;
    const axisW = chartWidth - X_AXIS_MARGIN_PX;
    const fit = Math.floor(axisW / MIN_COMPACT_BAR_SLOT_PX);
    // No magic upper cap: a wider tile keeps as many bars as fit at the legible
    // 14px slot, floored at MAX_COMPACT_X_TICKS. Labels are then thinned to the
    // width-aware budget by `maxXLabels` (the shared authority), so this only
    // governs how many BARS render, not how many labels.
    return Math.max(MAX_COMPACT_X_TICKS, fit);
  }, [chartWidth]);

  const shouldCompactView = type === 'bar' && !fillParent && !isSingleChart && chartData.length > compactBarLimit;
  const compactBarData = useMemo(() => {
    if (!shouldCompactView) return chartData;
    if (typeof x !== 'string') return chartData.slice(0, compactBarLimit);
    // Wave S6 · when the user explicitly sorted by the CATEGORY axis, the data
    // is axis-ordered, so a plain head-slice would drop the biggest bars and
    // keep the smallest categories. Pick the top-N BY VALUE, then restore the
    // chosen axis order for display (applyChartSort owns both steps).
    if (chart.sort?.by === "category" && typeof y === "string") {
      return applyChartSort(
        chartData as Array<Record<string, unknown>>,
        chart.sort,
        { xCol: x, yCol: y, seriesKeys: specSeriesKeys, maxRows: compactBarLimit },
      ) as typeof chartData;
    }
    const xLower = x.toLowerCase();
    const nameSuggestsDate = /\b(date|month|week|year|time|period)\b/i.test(xLower);
    const sample = chartData
      .slice(0, Math.min(5, chartData.length))
      .map((row) => String((row as Record<string, unknown>)[x] ?? ''));
    const allLookLikeDates =
      sample.length > 0 &&
      sample.every((v) => {
        if (!v || v.length < 4) return false;
        if (/^[A-Za-z]{3}[-/]?\d{2,4}$/i.test(v.trim())) return true;
        return !Number.isNaN(new Date(v).getTime());
      });
    const temporal = nameSuggestsDate || allLookLikeDates;
    if (!temporal) {
      return chartData.slice(0, compactBarLimit);
    }
    const sorted = [...chartData].sort((a, b) => {
      const av = parseDateLike((a as Record<string, unknown>)[x]);
      const bv = parseDateLike((b as Record<string, unknown>)[x]);
      if (av !== null && bv !== null) return av - bv;
      return String((a as Record<string, unknown>)[x]).localeCompare(
        String((b as Record<string, unknown>)[x])
      );
    });
    return sorted.slice(0, compactBarLimit);
  }, [chartData, shouldCompactView, x, y, specSeriesKeys, chart.sort, compactBarLimit]);
  const visibleBarData = shouldCompactView ? compactBarData : chartData;

  const lineAreaXTicks = useMemo(() => {
    if (type !== 'line' && type !== 'area') return undefined;
    if (typeof x !== 'string') return undefined;
    return evenlySpacedDataKeys(
      lineAreaSortedData as Record<string, unknown>[],
      x,
      maxXLabels
    );
  }, [type, lineAreaSortedData, x, maxXLabels]);

  // Bar x-axis labels: thin the visible bars to the width-aware budget so a
  // 50-SKU breakdown doesn't render 50 overlapping labels. The bars still
  // render — only their labels are thinned.
  const barXTicks = useMemo(() => {
    if (type !== 'bar') return undefined;
    if (typeof x !== 'string') return undefined;
    return evenlySpacedDataKeys(
      visibleBarData as Record<string, unknown>[],
      x,
      maxXLabels
    );
  }, [type, visibleBarData, x, maxXLabels]);

  const showNoDataState = chartData.length === 0;

  const activeFilterChips = useMemo(() => {
    if (!enableFilters) return [];
    return filterDefinitions
      .map((definition) => {
        const selection = effectiveFilters[definition.key];
        if (!selection) return null;

        if (selection.type === 'categorical') {
          if (!selection.values || selection.values.length === 0) return null;
          return {
            key: definition.key,
            label: `${definition.label}: ${selection.values.join(', ')}`,
          };
        }

        if (selection.type === 'date') {
          const segments: string[] = [];
          if (selection.start) {
            const formatted = formatDateForDisplay(selection.start) ?? selection.start;
            segments.push(`from ${formatted}`);
          }
          if (selection.end) {
            const formatted = formatDateForDisplay(selection.end) ?? selection.end;
            segments.push(`to ${formatted}`);
          }
          if (segments.length === 0) return null;
          return {
            key: definition.key,
            label: `${definition.label}: ${segments.join(' ')}`,
          };
        }

        if (selection.type === 'numeric') {
          const parts: string[] = [];
          if (selection.min !== undefined) {
            parts.push(`≥ ${formatNumberForDisplay(selection.min)}`);
          }
          if (selection.max !== undefined) {
            parts.push(`≤ ${formatNumberForDisplay(selection.max)}`);
          }
          if (parts.length === 0) return null;
          return {
            key: definition.key,
            label: `${definition.label}: ${parts.join(' & ')}`,
          };
        }

        return null;
      })
      .filter(Boolean) as { key: string; label: string }[];
  }, [enableFilters, effectiveFilters, filterDefinitions]);

  const handleResetFilters = useCallback(() => {
    updateFilters({});
  }, [updateFilters]);

  const handleClearFilterKey = useCallback(
    (key: string) => {
      updateFilters((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    [updateFilters]
  );

  const handleToggleSeriesLegend = useCallback((key: string) => {
    setHiddenSeries((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const handleToggleAllSeriesLegend = useCallback((showAll: boolean) => {
    setHiddenSeries(showAll ? new Set() : new Set(specSeriesKeys ?? []));
  }, [specSeriesKeys]);

  const handleToggleCategoricalOption = useCallback(
    (key: string, option: string, checked: boolean) => {
      updateFilters((prev) => {
        const next: ActiveChartFilters = { ...prev };
        const existing = next[key];
        if (!checked) {
          if (existing?.type === 'categorical') {
            const remaining = existing.values.filter((value) => value !== option);
            if (remaining.length > 0) {
              next[key] = { type: 'categorical', values: remaining };
            } else {
              delete next[key];
            }
          }
          return next;
        }

        const values = existing?.type === 'categorical' ? new Set(existing.values) : new Set<string>();
        values.add(option);
        next[key] = { type: 'categorical', values: Array.from(values) };
        return next;
      });
    },
    [updateFilters]
  );

  const handleDateChange = useCallback(
    (key: string, boundary: 'start' | 'end', value?: string) => {
      updateFilters((prev) => {
        const next: ActiveChartFilters = { ...prev };
        const existing = next[key];
        const definition = filterDefinitions.find(
          (candidate): candidate is ChartFilterDefinition & { type: 'date' } =>
            candidate.key === key && candidate.type === 'date'
        );

        let start = boundary === 'start' ? value : existing?.type === 'date' ? existing.start : undefined;
        let end = boundary === 'end' ? value : existing?.type === 'date' ? existing.end : undefined;

        if (definition) {
          if (start) {
            if (definition.min && start < definition.min) start = definition.min;
            if (definition.max && start > definition.max) start = definition.max;
          }
          if (end) {
            if (definition.min && end < definition.min) end = definition.min;
            if (definition.max && end > definition.max) end = definition.max;
          }

          if (start && end && start > end) {
            if (boundary === 'start') {
              end = start;
            } else {
              start = end;
            }
          }
        }

        if (!start && !end) {
          delete next[key];
        } else {
          next[key] = { type: 'date', start, end };
        }

        return next;
      });
    },
    [filterDefinitions, updateFilters]
  );

  const handleNumericBoundsChange = useCallback(
    (definition: ChartFilterDefinition, boundary: 'min' | 'max', value?: number) => {
      if (definition.type !== 'numeric') {
        return;
      }

      updateFilters((prev) => {
        const next: ActiveChartFilters = { ...prev };
        const existing = next[definition.key];
        const currentMin = existing?.type === 'numeric' ? existing.min : undefined;
        const currentMax = existing?.type === 'numeric' ? existing.max : undefined;

        let min = boundary === 'min' ? value : currentMin;
        let max = boundary === 'max' ? value : currentMax;

        if (min !== undefined) {
          min = Math.max(definition.min, Math.min(min, definition.max));
        }
        if (max !== undefined) {
          max = Math.max(definition.min, Math.min(max, definition.max));
        }

        if (min !== undefined && max !== undefined && min > max) {
          if (boundary === 'min') {
            max = min;
          } else {
            min = max;
          }
        }

        const tolerance = determineSliderStep(definition.min, definition.max) / 2;
        const isDefaultMin =
          min === undefined || Math.abs(min - definition.min) <= tolerance;
        const isDefaultMax =
          max === undefined || Math.abs(max - definition.max) <= tolerance;

        if (isDefaultMin && isDefaultMax) {
          delete next[definition.key];
        } else {
          next[definition.key] = {
            type: 'numeric',
            min,
            max,
          };
        }

        return next;
      });
    },
    [updateFilters]
  );

  const handleNumericSliderChange = useCallback(
    (definition: ChartFilterDefinition, values: number[]) => {
      if (definition.type !== 'numeric') {
        return;
      }

      const [rawMin, rawMax] = values;
      let min = Math.max(definition.min, Math.min(rawMin, definition.max));
      let max = Math.max(definition.min, Math.min(rawMax, definition.max));

      if (min > max) {
        const midpoint = (min + max) / 2;
        min = midpoint;
        max = midpoint;
      }

      const tolerance = determineSliderStep(definition.min, definition.max) / 2;

      updateFilters((prev) => {
        const next: ActiveChartFilters = { ...prev };
        if (
          Math.abs(min - definition.min) <= tolerance &&
          Math.abs(max - definition.max) <= tolerance
        ) {
          delete next[definition.key];
        } else {
          next[definition.key] = {
            type: 'numeric',
            min,
            max,
          };
        }
        return next;
      });
    },
    [updateFilters]
  );

  const handleCardClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!expandOnClick) return;
      const target = event.target as HTMLElement;
      if (target.closest('[data-chart-filter-control="true"]')) {
        return;
      }
      setIsModalOpen(true);
    },
    [expandOnClick]
  );

  const renderChart = () => {
    if (showNoDataState) {
      return (
        <div className="flex h-full min-h-[200px] w-full items-center justify-center rounded-md border border-dashed border-border/60 bg-muted/30 px-4 text-sm text-muted-foreground">
          {filtersApplied ? 'No data matches the current filters.' : 'No data available for this chart.'}
        </div>
      );
    }

    switch (type) {
      case 'line': {
        const lineRows = lineAreaSortedData as Record<string, any>[];
        const lineMultiKeys =
          specSeriesKeys && specSeriesKeys.length > 0 ? filteredSeriesKeys : [];

        if (lineMultiKeys.length > 0) {
          const lineEffectiveKeys = lineMultiKeys.filter((k) => !hiddenSeries.has(k));
          const combinedVals = lineEffectiveKeys.flatMap((k) =>
            getNumericValues(lineRows, k)
          );
          const unifiedDomain = yDomain || getDynamicDomain(combinedVals);
          return (
            <>
            <ResponsiveContainer
              width="100%"
              height={fillParent ? '100%' : isSingleChart ? 400 : 250}
            >
              <LineChart accessibilityLayer
                data={lineAreaSortedData}
                margin={{ left: 50, right: 10, top: 10, bottom: 52 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey={x}
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                  angle={-45}
                  textAnchor="end"
                  tickFormatter={(v) => formatTemporalPeriodKeyForDisplay(v)}
                  ticks={lineAreaXTicks}
                  label={{
                    value: xLabel || x,
                    position: 'insideBottom',
                    offset: 2,
                    style: {
                      textAnchor: 'middle',
                      fill: 'hsl(var(--foreground))',
                      fontSize: 12,
                      fontWeight: 600,
                    },
                  }}
                  height={50}
                />
                <YAxis
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10, fontWeight: 500 }}
                  width={60}
                  tickFormatter={yTickFormatter}
                  label={{
                    value: yLabel || y,
                    angle: -90,
                    position: 'left',
                    style: {
                      textAnchor: 'middle',
                      fill: 'hsl(var(--foreground))',
                      fontSize: 12,
                      fontWeight: 600,
                    },
                  }}
                  stroke="hsl(var(--foreground))"
                  domain={unifiedDomain}
                  tickCount={DEFAULT_Y_TICKS}
                />
                <Tooltip formatter={rechartsTooltipValueFormatter} labelFormatter={(v) => formatTemporalPeriodKeyForDisplay(v)} />
                {(specSeriesKeys ?? [])
                  .map((k, i) => ({ k, i }))
                  .filter(({ k }) => !hiddenSeries.has(k))
                  .map(({ k, i }) => {
                    const c = COLORS[i % COLORS.length];
                    return (
                      <Line
                        key={k}
                        type="monotone"
                        dataKey={k}
                        name={k}
                        stroke={c}
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4 }}
                        isAnimationActive
                        animationDuration={350}
                        animationEasing="ease-out"
                      />
                    );
                  })}
              </LineChart>
            </ResponsiveContainer>
            <div className="max-h-[100px] overflow-y-auto border-t border-border/30 pt-1 mt-1">
              <RechartsWideLegendContent
                payload={(specSeriesKeys ?? []).map((k, i) => ({ value: k, color: COLORS[i % COLORS.length], type: 'line' as const }))}
                iconType="line"
                hiddenSeries={hiddenSeries}
                onToggleSeries={handleToggleSeriesLegend}
                onToggleAll={handleToggleAllSeriesLegend}
              />
            </div>
          </>
        );
        }

        // Dual-axis (y2) or single-series line
        const leftAxisColor = chart.y2 ? 'hsl(var(--chart-1))' : chartColor;
        const rightAxisColor = 'hsl(var(--chart-4))';
        const leftValues = getNumericValues(lineRows, y);
        const leftDomain = yDomain || getDynamicDomain(leftValues);
        const rightValues = chart.y2
          ? getNumericValues(lineRows, chart.y2 as string)
          : [];
        const rightDomain = chart.y2 ? getDynamicDomain(rightValues) : undefined;

        return (
          <ResponsiveContainer
            width="100%"
            height={fillParent ? '100%' : isSingleChart ? 400 : 250}
          >
            <LineChart accessibilityLayer
              data={lineAreaSortedData}
              margin={{ left: 50, right: chart.y2 ? 50 : 10, top: 10, bottom: 52 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey={x}
                tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                angle={-45}
                textAnchor="end"
                ticks={lineAreaXTicks}
                label={{
                  value: xLabel || x,
                  position: 'insideBottom',
                  offset: 2,
                  style: {
                    textAnchor: 'middle',
                    fill: 'hsl(var(--foreground))',
                    fontSize: 12,
                    fontWeight: 600,
                  },
                }}
                height={50}
              />
              {chart.y2 ? (
                <>
                  <YAxis
                    tick={{ fill: leftAxisColor, fontSize: 10, fontWeight: 500 }}
                    width={60}
                    tickFormatter={yTickFormatter}
                    label={{
                      value: yLabel || y,
                      angle: -90,
                      position: 'left',
                      style: {
                        textAnchor: 'middle',
                        fill: leftAxisColor,
                        fontSize: 12,
                        fontWeight: 600,
                      },
                    }}
                    yAxisId="left"
                    stroke={leftAxisColor}
                    domain={leftDomain}
                    tickCount={DEFAULT_Y_TICKS}
                  />
                  <YAxis
                    orientation="right"
                    yAxisId="right"
                    tick={{ fill: rightAxisColor, fontSize: 10, fontWeight: 500 }}
                    width={60}
                    tickFormatter={y2TickFormatter}
                    label={{
                      value: chart.y2Label || chart.y2,
                      angle: 90,
                      position: 'right',
                      style: {
                        textAnchor: 'middle',
                        fill: rightAxisColor,
                        fontSize: 12,
                        fontWeight: 600,
                      },
                    }}
                    stroke={rightAxisColor}
                    domain={rightDomain}
                    tickCount={DEFAULT_Y_TICKS}
                  />
                </>
              ) : (
                <YAxis
                  tick={{ fill: leftAxisColor, fontSize: 10, fontWeight: 500 }}
                  width={60}
                  tickFormatter={yTickFormatter}
                  label={{
                    value: yLabel || y,
                    angle: -90,
                    position: 'left',
                    style: {
                      textAnchor: 'middle',
                      fill: leftAxisColor,
                      fontSize: 12,
                      fontWeight: 600,
                    },
                  }}
                  stroke={leftAxisColor}
                  domain={leftDomain}
                  tickCount={DEFAULT_Y_TICKS}
                />
              )}
              <Tooltip formatter={rechartsTooltipValueFormatter} labelFormatter={(v) => formatTemporalPeriodKeyForDisplay(v)} />
              {chart.y2 && (
                <Legend
                  wrapperStyle={{ paddingTop: 4 }}
                  iconType="line"
                  content={(props) => <RechartsWideLegendContent {...props} iconType="line" />}
                />
              )}
              <Line
                type="monotone"
                dataKey={y}
                name={chart.y2 ? yLabel || y : undefined}
                stroke={leftAxisColor}
                strokeWidth={2}
                dot={showDots ? { r: 4, fill: leftAxisColor } : false}
                activeDot={{ r: 4 }}
                {...(chart.y2 ? { yAxisId: 'left' } : {})}
              />
              {chart.y2 && (
                <>
                  {!chart.y2Series && (
                    <Line
                      type="monotone"
                      dataKey={chart.y2 as string}
                      name={chart.y2Label || chart.y2}
                      stroke={rightAxisColor}
                      strokeWidth={2}
                      dot={showDots ? { r: 4, fill: rightAxisColor } : false}
                      activeDot={{ r: 4 }}
                      yAxisId="right"
                    />
                  )}
                  {chart.y2Series &&
                    chart.y2Series.map((series, idx) => {
                      const c = COLORS[(idx + 2) % COLORS.length];
                      return (
                        <Line
                          key={series}
                          type="monotone"
                          dataKey={series}
                          name={series}
                          stroke={c}
                          strokeWidth={2}
                          dot={showDots ? { r: 4, fill: c } : false}
                          activeDot={{ r: 4 }}
                          yAxisId="right"
                        />
                      );
                    })}
                </>
              )}
            </LineChart>
          </ResponsiveContainer>
        );
      }

      case 'bar': {
        const multiKeys =
          specSeriesKeys && specSeriesKeys.length > 0
            ? filteredSeriesKeys
            : [];
        const stacked = barLayout !== 'grouped';
        // G1-P1.d — when fillParent (chart card uses 100% height), the
        // ResponsiveContainer and the multi-series legend below it must
        // share vertical space cleanly. The wrapper uses `h-full` (not
        // flex-1) because its parent (chart container at line 1754) is a
        // `flex-1` flex *item*, not a flex *container* — so flex-1 here
        // would resolve to 0 height and the chart would render invisible
        // until a re-paint. `h-full` inherits the parent's computed
        // height directly and ResponsiveContainer's `height="100%"`
        // resolves on first render.
        return (
          <div className={fillParent ? "flex h-full w-full flex-col" : "w-full"}>
          <div className={fillParent ? "flex-1 min-h-0" : ""}>
          <ResponsiveContainer width="100%" height={fillParent ? '100%' : isSingleChart ? 400 : 250}>
            <BarChart accessibilityLayer data={visibleBarData} margin={{ left: 50, right: 10, top: 10, bottom: fillParent ? 90 : isSingleChart ? 100 : 80 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey={x}
                tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                angle={-45}
                textAnchor="end"
                interval={0}
                tickFormatter={(v) => formatTemporalPeriodKeyForDisplay(v)}
                ticks={barXTicks}
                label={{ value: xLabel || x, position: 'bottom', offset: 10, style: { textAnchor: 'middle', fill: 'hsl(var(--foreground))', fontSize: 12, fontWeight: 600 } }}
                height={fillParent ? 80 : isSingleChart ? 90 : 70}
              />
              <YAxis
                tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                width={60}
                tickFormatter={yTickFormatter}
                label={{
                  value: multiKeys.length ? (yLabel || y) : yLabel || y,
                  angle: -90,
                  position: 'left',
                  style: { textAnchor: 'middle', fill: 'hsl(var(--foreground))', fontSize: 12, fontWeight: 600 },
                }}
                tickCount={DEFAULT_Y_TICKS}
              />
              <Tooltip
                formatter={rechartsTooltipValueFormatter}
                labelFormatter={(v) => formatTemporalPeriodKeyForDisplay(v)}
                /* W-ORD1 · list stacked series highest→lowest for the hovered
                   bar. itemSorter ranks ascending by the returned key, so negate
                   the value to sort descending — matching the value-ordered stack
                   (largest segment at the bottom). */
                itemSorter={(item) => -(Number(item.value) || 0)}
              />
              {multiKeys.length > 0 ? (
                <>
                  {(specSeriesKeys ?? [])
                    .map((k, i) => ({ k, i }))
                    .filter(({ k }) => !hiddenSeries.has(k))
                    .map(({ k, i }) => (
                      <Bar
                        key={k}
                        dataKey={k}
                        stackId={stacked ? 'stack' : undefined}
                        fill={COLORS[i % COLORS.length]}
                        radius={stacked ? [0, 0, 0, 0] : [4, 4, 0, 0]}
                        isAnimationActive
                        animationDuration={350}
                        animationEasing="ease-out"
                      />
                    ))}
                </>
              ) : (
                <Bar dataKey={y} fill={chartColor} radius={[4, 4, 0, 0]} />
              )}
            </BarChart>
          </ResponsiveContainer>
          </div>
          {multiKeys.length > 0 && (
            <div className="shrink-0 max-h-[100px] overflow-y-auto border-t border-border/30 pt-1 mt-1">
              <RechartsWideLegendContent
                payload={(specSeriesKeys ?? []).map((k, i) => ({ value: k, color: COLORS[i % COLORS.length], type: 'rect' as const }))}
                hiddenSeries={hiddenSeries}
                onToggleSeries={handleToggleSeriesLegend}
                onToggleAll={handleToggleAllSeriesLegend}
              />
            </div>
          )}
          </div>
        );
      }

      case 'heatmap': {
        const vk = zKey || 'value';
        const rows = chartData as Record<string, unknown>[];
        const rowSet = new Set<string>();
        const colSet = new Set<string>();
        for (const row of rows) {
          const rv = row[x];
          const cv = row[y];
          if (rv !== undefined && rv !== null && String(rv) !== '') rowSet.add(String(rv));
          if (cv !== undefined && cv !== null && String(cv) !== '') colSet.add(String(cv));
        }
        const rowLabels = Array.from(rowSet).sort(compareTemporalOrLexicalLabels);
        const colLabels = Array.from(colSet).sort(compareTemporalOrLexicalLabels);
        const cellMap = new Map<string, number>();
        let vmin = Infinity;
        let vmax = -Infinity;
        for (const row of rows) {
          const rk = String(row[x] ?? '');
          const ck = String(row[y] ?? '');
          const raw = row[vk];
          const n = typeof raw === 'number' ? raw : Number(raw);
          if (Number.isFinite(n)) {
            cellMap.set(`${rk}${KEY_SEP}${ck}`, n);
            vmin = Math.min(vmin, n);
            vmax = Math.max(vmax, n);
          }
        }
        if (!Number.isFinite(vmin) || !Number.isFinite(vmax)) {
          return (
            <div className="flex h-full min-h-[200px] w-full items-center justify-center rounded-md border border-dashed border-border/60 bg-muted/30 px-4 text-sm text-muted-foreground">
              No numeric values for heatmap.
            </div>
          );
        }
        if (vmin === vmax) {
          vmax = vmin + 1;
        }
        const colorAt = (t: number) => {
          const a = Math.max(0, Math.min(1, t));
          const h = 210 - a * 110;
          const s = 70;
          const l = 28 + a * 42;
          return `hsl(${h}, ${s}%, ${l}%)`;
        };
        const cw = colLabels.length || 1;
        return (
          <div className="w-full overflow-auto" style={{ maxHeight: fillParent ? '100%' : isSingleChart ? 420 : 280 }}>
            <div
              className="inline-grid gap-px bg-border p-px text-xs"
              style={{
                gridTemplateColumns: `minmax(72px,auto) repeat(${cw}, minmax(48px,1fr))`,
              }}
            >
              <div className="bg-muted/40 p-2 font-medium text-muted-foreground" />
              {colLabels.map((c) => (
                <div
                  key={`h-${c}`}
                  className="bg-muted/40 p-2 text-center font-medium text-muted-foreground"
                  title={c}
                >
                  <span className="line-clamp-2">{c}</span>
                </div>
              ))}
              {rowLabels.map((r) => (
                <React.Fragment key={`row-${r}`}>
                  <div className="bg-muted/30 p-2 font-medium text-foreground" title={r}>
                    <span className="line-clamp-3">{r}</span>
                  </div>
                  {colLabels.map((c) => {
                    const val = cellMap.get(`${r}${KEY_SEP}${c}`);
                    const t =
                      val !== undefined && Number.isFinite(val)
                        ? (val - vmin) / (vmax - vmin)
                        : 0;
                    const bg =
                      val !== undefined && Number.isFinite(val) ? colorAt(t) : 'hsl(var(--muted))';
                    return (
                      <div
                        key={`${r}-${c}`}
                        className="flex min-h-[36px] items-center justify-center p-1 text-[10px] font-medium text-white shadow-sm"
                        style={{ background: bg }}
                        title={`${r} × ${c}: ${val !== undefined ? formatAxisLabel(val) : '—'}`}
                      >
                        {val !== undefined && Number.isFinite(val) ? formatAxisLabel(val) : '—'}
                      </div>
                    );
                  })}
                </React.Fragment>
              ))}
            </div>
            <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
              <span>
                {xLabel || x} × {yLabel || y}
              </span>
              <span>
                Low {formatAxisLabel(vmin)} → High {formatAxisLabel(vmax)}
              </span>
            </div>
          </div>
        );
      }

      case 'scatter': {
        const getTickCount = (domain: [number, number] | undefined): number => {
          if (!domain) return 6;
          const range = domain[1] - domain[0];
          if (range <= 10) return 6;
          if (range <= 50) return 6;
          if (range <= 100) return 6;
          return 6;
        };

        // Use pre-computed optimizedScatterData (computed at top level to follow Rules of Hooks)
        const isLargeDataset = optimizedScatterData.length > 5000;
        
        // Calculate point size and opacity based on user preferences
        const getPointSize = () => {
          switch (pointSize) {
            case 'small': return 1;
            case 'medium': return isLargeDataset ? 2 : 3;
            case 'large': return isLargeDataset ? 3 : 5;
            default: return 3;
          }
        };
        
        const getPointOpacity = () => {
          switch (pointOpacity) {
            case 'low': return 0.15;
            case 'medium': return isLargeDataset ? 0.3 : 0.6;
            case 'high': return isLargeDataset ? 0.5 : 0.9;
            default: return 0.6;
          }
        };

        // Use processed scatter data for display (trend line calculated from all data below)
        let trendlineData = trendLine;
        if (!trendlineData && chartData.length > 0) {
          // Calculate linear regression from ALL data points
          const validData = chartData.filter((d: any) => {
            const xVal = typeof d[x] === 'number' ? d[x] : Number(d[x]);
            const yVal = typeof d[y] === 'number' ? d[y] : Number(d[y]);
            return !isNaN(xVal) && !isNaN(yVal);
          });

          if (validData.length > 1) {
              const xValues = validData.map((d: any) => (typeof d[x] === 'number' ? d[x] : Number(d[x])));
              const yValues = validData.map((d: any) => (typeof d[y] === 'number' ? d[y] : Number(d[y])));
            
            // Calculate linear regression
            const n = xValues.length;
            const sumX = xValues.reduce((a, b) => a + b, 0);
            const sumY = yValues.reduce((a, b) => a + b, 0);
            const sumXY = xValues.reduce((sum, xi, i) => sum + xi * yValues[i], 0);
            const sumX2 = xValues.reduce((sum, xi) => sum + xi * xi, 0);
            
            const denominator = n * sumX2 - sumX * sumX;
            if (denominator !== 0) {
              const slope = (n * sumXY - sumX * sumY) / denominator;
              const intercept = (sumY - slope * sumX) / n;
              
              // Calculate domain boundaries from data if not provided
              let xMin: number, xMax: number;
              if (xDomain && typeof xDomain[0] === 'number' && typeof xDomain[1] === 'number') {
                xMin = xDomain[0];
                xMax = xDomain[1];
              } else {
                // Calculate from actual data
                xMin = Math.min(...xValues);
                xMax = Math.max(...xValues);
                // Add a small padding (5% on each side)
                const xPadding = (xMax - xMin) * 0.05;
                xMin = xMin - xPadding;
                xMax = xMax + xPadding;
              }
              
              // Calculate Y values for trendline at domain boundaries
              const yAtMin = slope * xMin + intercept;
              const yAtMax = slope * xMax + intercept;
              
              trendlineData = [
                { [x]: xMin, [y]: yAtMin },
                { [x]: xMax, [y]: yAtMax },
              ];
            }
          }
        }

        // Custom tooltip for scatter to show exact X, Y values
        const formatAxisTooltipMaybe = (v: unknown) => {
          if (typeof v === 'number' && Number.isFinite(v)) return formatChartTooltipValue(v);
          if (typeof v === 'string') {
            const n = parseNumericValue(v);
            if (Number.isFinite(n)) return formatChartTooltipValue(n);
          }
          return String(v ?? '');
        };

        const renderScatterTooltip = ({ active, payload }: { active?: boolean; payload?: any[] }) => {
          // Some environments don't set `active` reliably; rely on payload presence
          if (!payload || payload.length === 0) return null;
          const p = payload[0]?.payload as any;
          if (!p) return null;
          const xVal = p[x];
          const yVal = p[y];
          return (
            <div style={{ background: 'white', border: '1px solid hsl(var(--border))', borderRadius: 6, padding: '6px 8px', boxShadow: '0 2px 6px rgba(0,0,0,0.08)' }}>
              <div style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))', marginBottom: 4 }}>{xLabel || x}</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'hsl(var(--foreground))' }}>{formatAxisTooltipMaybe(xVal)}</div>
              <div style={{ fontSize: 12, color: 'hsl(var(--muted-foreground))', marginTop: 6 }}>{yLabel || y}</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'hsl(var(--foreground))' }}>{formatAxisTooltipMaybe(yVal)}</div>
            </div>
          );
        };

        // Use ComposedChart to render scatter with trendline
        return (
          <ResponsiveContainer width="100%" height={fillParent ? '100%' : isSingleChart ? 400 : 250}>
            <ComposedChart accessibilityLayer data={optimizedScatterData} margin={{ left: 50, right: 10, top: 10, bottom: 30 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey={x}
                type="number"
                tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                domain={xDomain || ['auto', 'auto']}
                tickFormatter={xTickFormatter}
                tickCount={getTickCount(xDomain)}
                label={{ value: xLabel || x, position: 'insideBottom', offset: -5, style: { textAnchor: 'middle', fill: 'hsl(var(--foreground))', fontSize: 12, fontWeight: 600 } }}
              />
              <YAxis
                dataKey={y}
                type="number"
                tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                domain={yDomain || ['auto', 'auto']}
                tickFormatter={yTickFormatter}
                tickCount={getTickCount(yDomain)}
                width={60}
                label={{ value: yLabel || y, angle: -90, position: 'left', style: { textAnchor: 'middle', fill: 'hsl(var(--foreground))', fontSize: 12, fontWeight: 600 } }}
              />
              <Tooltip
                cursor={!isLargeDataset ? { strokeDasharray: '3 3' } : false}
                formatter={(_value: any, _name: any, props: any) => {
                  const p = (props && props.payload) || {};
                  const yVal = p[y];
                  return [formatChartTooltipValue(yVal), yLabel || y];
                }}
                labelFormatter={(_label: any, payload: any[]) => {
                  const p = payload && payload[0] && payload[0].payload;
                  const xVal = p ? p[x] : '';
                  const xDisp =
                    typeof xVal === 'number' && Number.isFinite(xVal)
                      ? formatChartTooltipValue(xVal)
                      : typeof xVal === 'string'
                        ? (() => {
                            const n = parseNumericValue(xVal);
                            return Number.isFinite(n) ? formatChartTooltipValue(n) : xVal;
                          })()
                        : String(xVal ?? '');
                  return `${xLabel || x}: ${xDisp}`;
                }}
                content={!isLargeDataset ? renderScatterTooltip as any : undefined}
              />
              <Scatter 
                name={`${y}`} 
                data={optimizedScatterData} 
                dataKey={y} 
                fill={chartColor} 
                fillOpacity={getPointOpacity()} 
                isAnimationActive={false}
                shape={(props: any) => {
                  const radius = getPointSize();
                  return <circle {...props} r={radius} />;
                }}
              />
              {trendlineData && trendlineData.length === 2 && (
                <Line
                  type="linear"
                  dataKey={y}
                  data={trendlineData}
                  stroke="hsl(var(--chart-1))"
                  strokeWidth={2}
                  strokeDasharray="5 5"
                  dot={false}
                  activeDot={false}
                  legendType="none"
                  connectNulls={false}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        );
      }

      case 'pie':
        return (
          <ResponsiveContainer width="100%" height={fillParent ? '100%' : isSingleChart ? 400 : 250}>
            <PieChart>
              <Pie
                data={chartData}
                dataKey={y}
                nameKey={x}
                cx="50%"
                cy="50%"
                innerRadius={isSingleChart ? 60 : 40}
                outerRadius={isSingleChart ? 120 : 80}
                label={({ percent }) => `${(percent * 100).toFixed(0)}%`}
              >
                {chartData.map((_: unknown, idx: number) => (
                  <Cell key={`cell-${idx}`} fill={COLORS[idx % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip formatter={rechartsTooltipValueFormatter} labelFormatter={(v) => formatTemporalPeriodKeyForDisplay(v)} />
              <Legend
                verticalAlign="bottom"
                height={40}
                iconType="circle"
                wrapperStyle={{ fontSize: '12px' }}
                content={(props) => <RechartsWideLegendContent {...props} iconType="circle" />}
              />
            </PieChart>
          </ResponsiveContainer>
        );

      case 'area': {
        const areaRows = lineAreaSortedData as Record<string, any>[];
        const areaMultiKeys =
          specSeriesKeys && specSeriesKeys.length > 0 ? filteredSeriesKeys : [];
        const stackedArea = barLayout !== 'grouped';

        if (areaMultiKeys.length > 0) {
          const areaEffectiveKeys = areaMultiKeys.filter((k) => !hiddenSeries.has(k));
          const combinedVals = areaEffectiveKeys.flatMap((k) =>
            getNumericValues(areaRows, k)
          );
          const unifiedDomain = yDomain || getDynamicDomain(combinedVals);
          return (
            <>
            <ResponsiveContainer
              width="100%"
              height={fillParent ? '100%' : isSingleChart ? 400 : 250}
            >
              <AreaChart accessibilityLayer
                data={lineAreaSortedData}
                margin={{ left: 50, right: 10, top: 10, bottom: 52 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey={x}
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                  angle={-45}
                  textAnchor="end"
                  tickFormatter={(v) => formatTemporalPeriodKeyForDisplay(v)}
                  ticks={lineAreaXTicks}
                  label={{
                    value: xLabel || x,
                    position: 'insideBottom',
                    offset: 2,
                    style: {
                      textAnchor: 'middle',
                      fill: 'hsl(var(--foreground))',
                      fontSize: 12,
                      fontWeight: 600,
                    },
                  }}
                  height={50}
                />
                <YAxis
                  tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                  width={60}
                  tickFormatter={yTickFormatter}
                  label={{
                    value: yLabel || y,
                    angle: -90,
                    position: 'left',
                    style: {
                      textAnchor: 'middle',
                      fill: 'hsl(var(--foreground))',
                      fontSize: 12,
                      fontWeight: 600,
                    },
                  }}
                  domain={unifiedDomain}
                  tickCount={DEFAULT_Y_TICKS}
                />
                <Tooltip formatter={rechartsTooltipValueFormatter} labelFormatter={(v) => formatTemporalPeriodKeyForDisplay(v)} />
                {(specSeriesKeys ?? [])
                  .map((k, i) => ({ k, i }))
                  .filter(({ k }) => !hiddenSeries.has(k))
                  .map(({ k, i }) => {
                    const c = COLORS[i % COLORS.length];
                    return (
                      <Area
                        key={k}
                        type="monotone"
                        dataKey={k}
                        name={k}
                        stackId={stackedArea ? 'areaStack' : undefined}
                        stroke={c}
                        fill={c}
                        fillOpacity={stackedArea ? 0.55 : 0.3}
                        strokeWidth={2}
                        isAnimationActive
                        animationDuration={350}
                        animationEasing="ease-out"
                      />
                    );
                  })}
              </AreaChart>
            </ResponsiveContainer>
            <div className="max-h-[100px] overflow-y-auto border-t border-border/30 pt-1 mt-1">
              <RechartsWideLegendContent
                payload={(specSeriesKeys ?? []).map((k, i) => ({ value: k, color: COLORS[i % COLORS.length], type: 'line' as const }))}
                iconType="line"
                hiddenSeries={hiddenSeries}
                onToggleSeries={handleToggleSeriesLegend}
                onToggleAll={handleToggleAllSeriesLegend}
              />
            </div>
            </>
          );
        }

        return (
          <ResponsiveContainer
            width="100%"
            height={fillParent ? '100%' : isSingleChart ? 400 : 250}
          >
            <AreaChart accessibilityLayer
              data={lineAreaSortedData}
              margin={{ left: 50, right: 10, top: 10, bottom: 52 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey={x}
                tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                angle={-45}
                textAnchor="end"
                ticks={lineAreaXTicks}
                label={{
                  value: xLabel || x,
                  position: 'insideBottom',
                  offset: 2,
                  style: {
                    textAnchor: 'middle',
                    fill: 'hsl(var(--foreground))',
                    fontSize: 12,
                    fontWeight: 600,
                  },
                }}
                height={50}
              />
              <YAxis
                tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                width={60}
                tickFormatter={yTickFormatter}
                label={{
                  value: yLabel || y,
                  angle: -90,
                  position: 'left',
                  style: {
                    textAnchor: 'middle',
                    fill: 'hsl(var(--foreground))',
                    fontSize: 12,
                    fontWeight: 600,
                  },
                }}
                tickCount={DEFAULT_Y_TICKS}
              />
              <Tooltip formatter={rechartsTooltipValueFormatter} labelFormatter={(v) => formatTemporalPeriodKeyForDisplay(v)} />
              <Area
                type="monotone"
                dataKey={y}
                stroke={chartColor}
                fill={chartColor}
                fillOpacity={0.3}
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        );
      }

      default:
        return <p className="text-muted-foreground text-center py-8">Unsupported chart type</p>;
    }
  };

  // Determine if chart should be rendered (always render if visible, single chart, or fillParent)
  const shouldRenderChart = isVisible || isSingleChart || fillParent || isLoading;

  return (
    <>
      <div
        ref={containerRef}
        className={`group relative flex h-full flex-col rounded-lg border border-border bg-card p-4 shadow-sm transition-shadow hover:shadow-md ${expandOnClick ? 'cursor-pointer' : ''}`}
        onClick={handleCardClick}
      >
        <div
          className={`flex flex-col gap-3 ${fillParent ? 'h-full' : ''}`}
        >
          {!fillParent && (
            <div className="mb-2 flex items-start justify-between gap-2">
              <div className="flex flex-col gap-0.5 min-w-0">
                <h3 className="line-clamp-2 text-sm font-semibold text-foreground">{title}</h3>
                {type === 'scatter' && (
                  <div className="text-[11px] text-muted-foreground">
                    <p>{processedScatterData.length.toLocaleString()} visualization points</p>
                    {(chart as any)._correlationMetadata && (
                      <p className="text-[10px] mt-0.5">
                        Total: {(chart as any)._correlationMetadata.totalDataPoints?.toLocaleString() || 'N/A'} pairs
                        {typeof (chart as any)._correlationMetadata.correlation === 'number' && (
                          <span className="ml-2">
                            (r = {(chart as any)._correlationMetadata.correlation.toFixed(2)})
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
                {type === 'line' && (
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={`show-dots-${index}`}
                      checked={showDots}
                      onCheckedChange={(checked) => setShowDots(checked === true)}
                    />
                    <Label
                      htmlFor={`show-dots-${index}`}
                      className="text-xs text-muted-foreground cursor-pointer whitespace-nowrap"
                    >
                      Show dots
                    </Label>
                  </div>
                )}
                {type === 'scatter' && (
                  <>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id={`hide-outliers-${index}`}
                        checked={hideOutliers}
                        onCheckedChange={(checked) => setHideOutliers(checked === true)}
                      />
                      <Label
                        htmlFor={`hide-outliers-${index}`}
                        className="text-xs text-muted-foreground cursor-pointer whitespace-nowrap"
                      >
                        Hide outliers
                      </Label>
                    </div>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={(e) => e.stopPropagation()}
                          title="Point Display Settings"
                        >
                          <Settings2 className="h-3.5 w-3.5" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-64" onClick={(e) => e.stopPropagation()}>
                        <div className="space-y-4">
                          <div className="space-y-2">
                            <Label className="text-xs font-semibold">Point Size</Label>
                            <Select value={pointSize} onValueChange={(value: 'small' | 'medium' | 'large') => setPointSize(value)}>
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="small">Small (1px)</SelectItem>
                                <SelectItem value="medium">Medium (2-3px)</SelectItem>
                                <SelectItem value="large">Large (3-5px)</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs font-semibold">Point Opacity</Label>
                            <Select value={pointOpacity} onValueChange={(value: 'low' | 'medium' | 'high') => setPointOpacity(value)}>
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="low">Low (15%)</SelectItem>
                                <SelectItem value="medium">Medium (30-60%)</SelectItem>
                                <SelectItem value="high">High (50-90%)</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <Label className="text-xs font-semibold">Point Density</Label>
                            <Select value={pointDensity} onValueChange={(value: 'low' | 'medium' | 'high' | 'all') => setPointDensity(value)}>
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="low">Low (2k points)</SelectItem>
                                <SelectItem value="medium">Medium (10k points)</SelectItem>
                                <SelectItem value="high">High (20k points)</SelectItem>
                                <SelectItem value="all">All Points {processedScatterData.length > 20000 && '(may lag)'}</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          {pointDensity === 'all' && processedScatterData.length > 20000 && (
                            <p className="text-xs text-muted-foreground">
                              ⚠️ Showing all {processedScatterData.length.toLocaleString()} points may cause performance issues
                            </p>
                          )}
                        </div>
                      </PopoverContent>
                    </Popover>
                  </>
                )}
              </div>
            </div>
          )}

          {enableFilters && activeFilterChips.length > 0 && (
            <div
              className="mb-3 flex flex-wrap gap-2"
              data-chart-filter-control="true"
              onClick={(event) => event.stopPropagation()}
            >
              {activeFilterChips.map((chip) => (
                <Badge
                  key={chip.key}
                  variant="secondary"
                  className="flex items-center gap-2 rounded-full px-2.5 py-1 text-xs"
                >
                  <span className="max-w-[200px] truncate">{chip.label}</span>
                  <button
                    type="button"
                    className="text-muted-foreground/80 transition hover:text-destructive"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleClearFilterKey(chip.key);
                    }}
                    aria-label={`Remove filter ${chip.label}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}

          {/* Loading state for correlation charts */}
          {isLoading && type === 'scatter' && (chart as any)._isCorrelationChart ? (
            <div className={`w-full flex-1 flex flex-col items-center justify-center ${fillParent ? 'min-h-0' : 'min-h-[400px]'}`}>
              <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
              <p className="text-sm text-muted-foreground mb-2">
                {loadingProgress?.message || 'Computing correlation...'}
              </p>
              {loadingProgress && loadingProgress.total > 0 && (
                <div className="w-full max-w-md space-y-2">
                  <Progress 
                    value={(loadingProgress.processed / loadingProgress.total) * 100} 
                    className="h-2"
                  />
                  <p className="text-xs text-muted-foreground text-center">
                    {loadingProgress.processed.toLocaleString()} / {loadingProgress.total.toLocaleString()} rows processed
                  </p>
                </div>
              )}
            </div>
          ) : shouldRenderChart ? (
            <div ref={chartWidthRef} className={`w-full flex-1 ${fillParent ? 'min-h-0' : ''}`}>{renderChart()}</div>
          ) : (
            <div className={`w-full flex-1 flex items-center justify-center ${fillParent ? 'min-h-0' : 'min-h-[250px]'}`}>
              <Skeleton className="h-full w-full" />
            </div>
          )}
        </div>
        {showAddButton && (
          <div className="mt-3 flex justify-end">
            <Button
              variant="outline"
              size="sm"
              className="shadow-sm"
              onClick={(e) => {
                e.stopPropagation();
                setIsDashboardModalOpen(true);
              }}
            >
              <Plus className="h-4 w-4 mr-1" />
              Add to Dashboard
            </Button>
          </div>
        )}
      </div>
      {useChartOnlyModal ? (
        <ChartOnlyModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          chart={chart}
          enableFilters={enableFilters}
          filterDefinitions={filterDefinitions}
          effectiveFilters={effectiveFilters}
          filtersApplied={filtersApplied}
          chartData={chartData}
          onFiltersChange={updateFilters}
          handleClearFilterKey={handleClearFilterKey}
          handleToggleCategoricalOption={handleToggleCategoricalOption}
          handleDateChange={handleDateChange}
          handleNumericSliderChange={handleNumericSliderChange}
          handleNumericBoundsChange={handleNumericBoundsChange}
        handleResetFilters={handleResetFilters}
        formatDateForDisplay={formatDateForDisplay}
        determineSliderStep={determineSliderStep}
        />
      ) : (
      <ChartModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        chart={chart}
        index={index}
        enableFilters={enableFilters}
        filterDefinitions={filterDefinitions}
        effectiveFilters={effectiveFilters}
        filtersApplied={filtersApplied}
        chartData={chartData}
        onFiltersChange={updateFilters}
        handleClearFilterKey={handleClearFilterKey}
        handleToggleCategoricalOption={handleToggleCategoricalOption}
        handleDateChange={handleDateChange}
        handleNumericSliderChange={handleNumericSliderChange}
        handleNumericBoundsChange={handleNumericBoundsChange}
        handleResetFilters={handleResetFilters}
        formatDateForDisplay={formatDateForDisplay}
        determineSliderStep={determineSliderStep}
        keyInsightSessionId={keyInsightSessionId}
        onSuggestedQuestionClick={onSuggestedQuestionClick}
      />
      )}
      <DashboardModal
        isOpen={isDashboardModalOpen}
        onClose={() => setIsDashboardModalOpen(false)}
        chart={chart}
      />
    </>
  );
}

