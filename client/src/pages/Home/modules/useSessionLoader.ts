import { useEffect } from 'react';
import type { TemporalDisplayGrain } from '@/shared/schema';
import { temporalGrainsFromSummaryColumns } from '@/lib/dataSummaryGrains';

interface UseSessionLoaderProps {
  loadedSessionData?: any;
  setSessionId: (id: string | null) => void;
  setFileName: (fileName: string | null) => void;
  setInitialCharts: (charts: any[]) => void;
  setInitialInsights: (insights: any[]) => void;
  setSampleRows: (rows: Record<string, any>[]) => void;
  setColumns: (columns: string[]) => void;
  setNumericColumns: (columns: string[]) => void;
  setDateColumns: (columns: string[]) => void;
  setTemporalDisplayGrainsByColumn: (grains: Record<string, TemporalDisplayGrain>) => void;
  setTotalRows: (rows: number) => void;
  setTotalColumns: (columns: number) => void;
  setMessages: (messages: any[] | ((prev: any[]) => any[])) => void;
  setCollaborators?: (collaborators: string[]) => void;
}

/**
 * Custom hook for loading session data into the Home component
 * Handles populating state when a session is loaded from the Analysis page
 */
export const useSessionLoader = ({
  loadedSessionData,
  setSessionId,
  setFileName,
  setInitialCharts,
  setInitialInsights,
  setSampleRows,
  setColumns,
  setNumericColumns,
  setDateColumns,
  setTemporalDisplayGrainsByColumn,
  setTotalRows,
  setTotalColumns,
  setMessages,
  setCollaborators,
}: UseSessionLoaderProps) => {
  useEffect(() => {
    if (!loadedSessionData) return;
    console.log('🔄 Loading session data into Home component:', loadedSessionData);
    const session = loadedSessionData.session;
    if (!session) return;

    // Set session ID and fileName
    setSessionId(session.sessionId);
    setFileName(session.fileName || null);

    // Set collaborators if available
    if (setCollaborators && session.collaborators && Array.isArray(session.collaborators)) {
      setCollaborators(session.collaborators);
    }

    // Set initial charts and insights for the first assistant message context
    setInitialCharts(session.charts || []);
    setInitialInsights(session.insights || []);

    // Set data summary information
    if (session.dataSummary) {
      setSampleRows(session.sampleRows || []);
      setColumns(session.dataSummary.columns?.map((c: any) => c.name) || []);
      setNumericColumns(session.dataSummary.numericColumns || []);
      setDateColumns(session.dataSummary.dateColumns || []);
      setTemporalDisplayGrainsByColumn(temporalGrainsFromSummaryColumns(session.dataSummary.columns));
      setTotalRows(session.dataSummary.rowCount || 0);
      setTotalColumns(session.dataSummary.columnCount || 0);
    }

    if (Array.isArray(session.messages)) {
      setMessages(session.messages as any[]);
    } else {
      setMessages([]);
    }
  }, [
    loadedSessionData,
    setSessionId,
    setFileName,
    setInitialCharts,
    setInitialInsights,
    setSampleRows,
    setColumns,
    setNumericColumns,
    setDateColumns,
    setTemporalDisplayGrainsByColumn,
    setTotalRows,
    setTotalColumns,
    setMessages,
    setCollaborators,
  ]);
};

