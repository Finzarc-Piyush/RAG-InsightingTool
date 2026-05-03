import { useState, useCallback } from 'react';
import {
  Message,
  UploadResponse,
  TemporalDisplayGrain,
  type ColumnCurrency,
  type TemporalFacetColumnMeta,
  type WideFormatTransform,
} from '@/shared/schema';

export interface HomeState {
  sessionId: string | null;
  fileName: string | null;
  messages: Message[];
  initialCharts: UploadResponse['charts'];
  initialInsights: UploadResponse['insights'];
  sampleRows: Record<string, any>[];
  columns: string[];
  numericColumns: string[];
  dateColumns: string[];
  temporalDisplayGrainsByColumn: Record<string, TemporalDisplayGrain>;
  temporalFacetColumns: TemporalFacetColumnMeta[];
  totalRows: number;
  totalColumns: number;
  currencyByColumn: Record<string, ColumnCurrency>;
  wideFormatTransform?: WideFormatTransform;
}

export const useHomeState = () => {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [initialCharts, setInitialCharts] = useState<UploadResponse['charts']>([]);
  const [initialInsights, setInitialInsights] = useState<UploadResponse['insights']>([]);
  const [sampleRows, setSampleRows] = useState<Record<string, any>[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [numericColumns, setNumericColumns] = useState<string[]>([]);
  const [dateColumns, setDateColumns] = useState<string[]>([]);
  const [temporalDisplayGrainsByColumn, setTemporalDisplayGrainsByColumn] = useState<
    Record<string, TemporalDisplayGrain>
  >({});
  const [temporalFacetColumns, setTemporalFacetColumns] = useState<TemporalFacetColumnMeta[]>([]);
  const [totalRows, setTotalRows] = useState<number>(0);
  const [totalColumns, setTotalColumns] = useState<number>(0);
  const [currencyByColumn, setCurrencyByColumn] = useState<Record<string, ColumnCurrency>>({});
  const [wideFormatTransform, setWideFormatTransform] = useState<WideFormatTransform | undefined>(
    undefined
  );

  const resetState = useCallback(() => {
    setSessionId(null);
    setFileName(null);
    setMessages([]);
    setInitialCharts([]);
    setInitialInsights([]);
    setSampleRows([]);
    setColumns([]);
    setNumericColumns([]);
    setDateColumns([]);
    setTemporalDisplayGrainsByColumn({});
    setTemporalFacetColumns([]);
    setTotalRows(0);
    setTotalColumns(0);
    setCurrencyByColumn({});
    setWideFormatTransform(undefined);
  }, []);

  return {
    sessionId,
    fileName,
    messages,
    initialCharts,
    initialInsights,
    sampleRows,
    columns,
    numericColumns,
    dateColumns,
    temporalDisplayGrainsByColumn,
    temporalFacetColumns,
    totalRows,
    totalColumns,
    currencyByColumn,
    wideFormatTransform,

    setSessionId,
    setFileName,
    setMessages,
    setInitialCharts,
    setInitialInsights,
    setSampleRows,
    setColumns,
    setNumericColumns,
    setDateColumns,
    setTemporalDisplayGrainsByColumn,
    setTemporalFacetColumns,
    setTotalRows,
    setTotalColumns,
    setCurrencyByColumn,
    setWideFormatTransform,

    resetState,
  };
};
