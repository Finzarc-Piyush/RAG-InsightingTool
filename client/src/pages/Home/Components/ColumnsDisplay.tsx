import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Database, Hash, Calendar, Type, DollarSign } from 'lucide-react';
import type {
  ColumnCurrency,
  ColumnDuration,
  DateTimeColumnPair,
  DimensionHierarchy,
  TableDetection,
  WideFormatTransform,
} from '@/shared/schema';
import { WideFormatBanner } from '@/components/WideFormatBanner';
import { TableDetectionBanner } from '@/components/TableDetectionBanner';
import { DimensionHierarchiesBanner } from '@/components/DimensionHierarchiesBanner';
import { DateTimePairsBanner } from '@/components/DateTimePairsBanner';
import {
  IndicatorColumnsBanner,
  type IndicatorEntry,
} from '@/components/IndicatorColumnsBanner';

interface ColumnsDisplayProps {
  columns: string[];
  numericColumns?: string[];
  dateColumns?: string[];
  totalRows?: number;
  totalColumns?: number;
  /** WF9 — per-column currency tag for numeric columns. */
  currencyByColumn?: Record<string, ColumnCurrency>;
  /** DUR1 — per-column duration tag for elapsed-time numeric columns. */
  durationByColumn?: Record<string, ColumnDuration>;
  /** WF9 — banner above the column chips when the dataset was
   * auto-melted from wide format. */
  wideFormatTransform?: WideFormatTransform;
  /** Main-table detection — banner shown when detection did something
   * non-trivial (skipped a title row, ignored a side table, low confidence). */
  tableDetection?: TableDetection;
  /** Opens the raw-grid correction UI when the user clicks "Adjust". */
  onTableRegionAdjust?: () => void;
  /** True while a retable re-ingest is in flight. */
  isReingesting?: boolean;
  /** H6 — banner above the column chips when the user has declared
   * one or more dimension hierarchies (rollup values in a column). */
  dimensionHierarchies?: DimensionHierarchy[];
  /** SU-UX1 — banner showing detected (date, time-of-day) column pairs. */
  dateTimeColumnPairs?: DateTimeColumnPair[];
  /** SU-UX1 — banner showing detected pre-computed indicator columns. */
  indicators?: IndicatorEntry[];
  /** EU1 — when present, banner shows ✕ Remove buttons. */
  sessionId?: string;
  /** EU1 — called with the new hierarchies array after a successful remove. */
  onHierarchiesChange?: (next: DimensionHierarchy[]) => void;
  /** SU-UX1 — called with the new pairs array after a successful remove. */
  onDateTimePairsChange?: (next: DateTimeColumnPair[]) => void;
  /** SU-UX1 — called with the new indicators after a successful remove. */
  onIndicatorsChange?: (next: IndicatorEntry[]) => void;
}

export function ColumnsDisplay({
  columns,
  numericColumns = [],
  dateColumns = [],
  totalRows,
  totalColumns,
  currencyByColumn,
  durationByColumn,
  wideFormatTransform,
  tableDetection,
  onTableRegionAdjust,
  isReingesting,
  dimensionHierarchies,
  dateTimeColumnPairs,
  indicators,
  sessionId,
  onHierarchiesChange,
  onDateTimePairsChange,
  onIndicatorsChange,
}: ColumnsDisplayProps) {
  if (!columns || columns.length === 0) return null;

  // SU-UX1 · index pairings + indicators by column for inline annotations.
  const pairedDateByTime = new Map<string, string>();
  for (const p of dateTimeColumnPairs ?? []) {
    pairedDateByTime.set(p.timeColumn, p.dateColumn);
  }
  const indicatorByColumn = new Map<string, IndicatorEntry>();
  for (const i of indicators ?? []) {
    indicatorByColumn.set(i.column, i);
  }

  const getColumnIcon = (column: string) => {
    if (currencyByColumn?.[column]) {
      return <DollarSign className="h-3 w-3" />;
    }
    if (numericColumns.includes(column)) {
      return <Hash className="h-3 w-3" />;
    }
    if (dateColumns.includes(column)) {
      return <Calendar className="h-3 w-3" />;
    }
    return <Type className="h-3 w-3" />;
  };

  const getColumnType = (column: string) => {
    const c = currencyByColumn?.[column];
    let base: string;
    if (c) {
      base = `numeric · ${c.isoCode} (${c.symbol})`;
    } else if (durationByColumn?.[column]) {
      base = 'numeric · duration';
    } else if (numericColumns.includes(column)) {
      base = 'numeric';
    } else if (dateColumns.includes(column)) {
      base = 'date';
    } else {
      base = 'text';
    }
    // SU-UX1 inline annotations.
    const paired = pairedDateByTime.get(column);
    const indicator = indicatorByColumn.get(column);
    const extras: string[] = [];
    if (paired) extras.push(`paired with ${paired}`);
    if (indicator) extras.push('indicator');
    return extras.length ? `${base} · ${extras.join(' · ')}` : base;
  };

  const valueCurrency = wideFormatTransform
    ? currencyByColumn?.[wideFormatTransform.valueColumn]
    : undefined;

  return (
    <Card className="mb-4 border-l-4 border-l-primary/20">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Database className="h-5 w-5 text-primary" />
          Dataset Columns
          {totalRows && totalColumns && (
            <span className="text-sm font-normal text-muted-foreground">
              ({totalRows} rows × {totalColumns} columns)
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {tableDetection?.nonTrivial && (
          <TableDetectionBanner
            detection={tableDetection}
            onAdjust={onTableRegionAdjust}
            isReingesting={isReingesting}
          />
        )}
        {wideFormatTransform && (
          <WideFormatBanner transform={wideFormatTransform} valueCurrency={valueCurrency} />
        )}
        {dimensionHierarchies && dimensionHierarchies.length > 0 && (
          <DimensionHierarchiesBanner
            hierarchies={dimensionHierarchies}
            sessionId={sessionId}
            onChange={onHierarchiesChange}
          />
        )}
        {dateTimeColumnPairs && dateTimeColumnPairs.length > 0 && (
          <DateTimePairsBanner
            pairs={dateTimeColumnPairs}
            sessionId={sessionId}
            onChange={onDateTimePairsChange}
          />
        )}
        {indicators && indicators.length > 0 && (
          <IndicatorColumnsBanner
            indicators={indicators}
            sessionId={sessionId}
            onChange={onIndicatorsChange}
          />
        )}
        <div className="flex flex-wrap gap-2">
          {columns.map((column, index) => (
            <Badge
              key={index}
              variant="secondary"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium"
            >
              {getColumnIcon(column)}
              <span>{column}</span>
              <Badge
                variant="outline"
                className="ml-1 px-1.5 py-0.5 text-xs bg-background"
              >
                {getColumnType(column)}
              </Badge>
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
