import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { parseDateLike } from '@/lib/parseDateLike';

type SortDirection = 'asc' | 'desc' | null;

export type UsePreviewTableSortOptions = {
  data: Record<string, unknown>[];
  /** Visible column keys in display order */
  columns: string[];
  numericColumns: string[];
  dateColumns: string[];
  variant: 'dataset' | 'analysis';
};

/**
 * Shared sort state for tabular previews (dataset + analytical results).
 * Analysis variant: default ascending by the first column when it is a declared date column.
 */
export function usePreviewTableSort({
  data,
  columns,
  numericColumns,
  dateColumns,
  variant,
}: UsePreviewTableSortOptions) {
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>(null);

  const defaultSortColumn = useMemo(() => {
    if (variant !== 'analysis' || columns.length === 0) return null;
    const first = columns[0];
    return dateColumns.includes(first) ? first : null;
  }, [variant, columns, dateColumns]);

  useEffect(() => {
    if (variant !== 'analysis') {
      setSortColumn(null);
      setSortDirection(null);
      return;
    }
    if (defaultSortColumn) {
      setSortColumn(defaultSortColumn);
      setSortDirection('asc');
    } else {
      setSortColumn(null);
      setSortDirection(null);
    }
  }, [variant, defaultSortColumn, data]);

  const sortedData = useMemo(() => {
    if (!sortColumn || !sortDirection) {
      return data;
    }

    const isNumeric = numericColumns.includes(sortColumn);
    const isDate = dateColumns.includes(sortColumn);

    return [...data].sort((a, b) => {
      const aVal = a[sortColumn];
      const bVal = b[sortColumn];

      if (aVal === null || aVal === undefined) return 1;
      if (bVal === null || bVal === undefined) return -1;

      let comparison = 0;

      if (isDate) {
        const aTs = parseDateLike(aVal);
        const bTs = parseDateLike(bVal);
        if (aTs === null && bTs === null) {
          comparison = 0;
        } else if (aTs === null) {
          comparison = 1;
        } else if (bTs === null) {
          comparison = -1;
        } else {
          comparison = aTs - bTs;
        }
      } else if (isNumeric) {
        const aNum = typeof aVal === 'number' ? aVal : parseFloat(String(aVal));
        const bNum = typeof bVal === 'number' ? bVal : parseFloat(String(bVal));
        comparison = (isNaN(aNum) ? 0 : aNum) - (isNaN(bNum) ? 0 : bNum);
      } else {
        comparison = String(aVal).localeCompare(String(bVal));
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [data, sortColumn, sortDirection, numericColumns, dateColumns]);

  const handleSort = useCallback((column: string) => {
    if (sortColumn === column) {
      if (sortDirection === 'asc') {
        setSortDirection('desc');
      } else if (sortDirection === 'desc') {
        setSortColumn(null);
        setSortDirection(null);
      }
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  }, [sortColumn, sortDirection]);

  const getSortIcon = useCallback(
    (column: string): ReactNode => {
      if (sortColumn !== column) {
        return <ArrowUpDown className="h-3 w-3 ml-1 opacity-40" />;
      }
      if (sortDirection === 'asc') {
        return <ArrowUp className="h-3 w-3 ml-1" />;
      }
      if (sortDirection === 'desc') {
        return <ArrowDown className="h-3 w-3 ml-1" />;
      }
      return <ArrowUpDown className="h-3 w-3 ml-1 opacity-40" />;
    },
    [sortColumn, sortDirection]
  );

  return {
    sortedData,
    sortColumn,
    sortDirection,
    handleSort,
    getSortIcon,
  };
}
