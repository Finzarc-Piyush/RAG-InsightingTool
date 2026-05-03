import { useEffect } from 'react';
import type {
  TemporalDisplayGrain,
  TemporalFacetColumnMeta,
  SessionAnalysisContext,
  ColumnCurrency,
  WideFormatTransform,
} from '@/shared/schema';
import { temporalGrainsFromSummaryColumns } from '@/lib/dataSummaryGrains';
import { suggestedFollowUpsFromSession } from '@/lib/initialAnalysisMessage';
import {
  DATASET_ENRICHMENT_LOADING_CONTENT,
  DATASET_PREVIEW_LOADING_CONTENT,
  normalizeDatasetSystemMessages,
} from './uploadSystemMessages';

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
  setTemporalFacetColumns: (cols: TemporalFacetColumnMeta[]) => void;
  setTotalRows: (rows: number) => void;
  setTotalColumns: (columns: number) => void;
  setMessages: (messages: any[] | ((prev: any[]) => any[])) => void;
  setSuggestions?: (suggestions: string[]) => void;
  setCollaborators?: (collaborators: string[]) => void;
  /**
   * W26 · lifts the loaded `sessionAnalysisContext` into Home so the
   * `PriorInvestigationsBanner` can render its `priorInvestigations`
   * digest above the chat. Optional — when absent the wave's UI hides
   * itself silently.
   */
  setSessionAnalysisContext?: (sac: SessionAnalysisContext | undefined) => void;
  /**
   * Wave SR2 · parity with `applySessionHydration` (post-upload path) —
   * populate the wide-format banner and per-column currency map so the
   * WF9 banner / đồng badges survive a browser refresh, not just an upload.
   */
  setWideFormatTransform?: (transform: WideFormatTransform | undefined) => void;
  setCurrencyByColumn?: (map: Record<string, ColumnCurrency>) => void;
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
  setTemporalFacetColumns,
  setTotalRows,
  setTotalColumns,
  setMessages,
  setSuggestions,
  setCollaborators,
  setSessionAnalysisContext,
  setWideFormatTransform,
  setCurrencyByColumn,
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
    const persistedFollowUps = suggestedFollowUpsFromSession({
      sessionAnalysisContext: session.sessionAnalysisContext,
      datasetProfile: session.datasetProfile,
    });
    if (setSuggestions) {
      setSuggestions(persistedFollowUps ?? []);
    }
    // W26 · publish the loaded sessionAnalysisContext upward so the
    // PriorInvestigationsBanner can render its digest of prior turns.
    if (setSessionAnalysisContext) {
      setSessionAnalysisContext(session.sessionAnalysisContext ?? undefined);
    }

    // Set data summary information
    if (session.dataSummary) {
      setSampleRows(session.sampleRows || []);
      setColumns(session.dataSummary.columns?.map((c: any) => c.name) || []);
      setNumericColumns(session.dataSummary.numericColumns || []);
      setDateColumns(session.dataSummary.dateColumns || []);
      setTemporalDisplayGrainsByColumn(temporalGrainsFromSummaryColumns(session.dataSummary.columns));
      setTemporalFacetColumns(session.dataSummary.temporalFacetColumns ?? []);
      setTotalRows(session.dataSummary.rowCount || 0);
      setTotalColumns(session.dataSummary.columnCount || 0);
      // Wave SR2 — wide-format banner + per-column currency map. Mirrors
      // the post-upload `applyPreviewState` path so refresh and upload
      // produce identical UI state.
      if (setWideFormatTransform) {
        setWideFormatTransform(session.dataSummary.wideFormatTransform);
      }
      if (setCurrencyByColumn && Array.isArray(session.dataSummary.columns)) {
        const map: Record<string, ColumnCurrency> = {};
        for (const col of session.dataSummary.columns) {
          if (col?.currency) map[col.name] = col.currency;
        }
        setCurrencyByColumn(map);
      }
    }

    if (Array.isArray(session.messages) && session.messages.length > 0) {
      const hasPreview = !!session.dataSummary?.columns?.length || !!session.dataSummary?.rowCount;
      const isEnriching =
        session.enrichmentStatus === 'pending' || session.enrichmentStatus === 'in_progress';
      setMessages(
        normalizeDatasetSystemMessages(session.messages as any[], {
          hasPreview,
          isEnriching,
        })
      );
    } else {
      if (session.dataSummary) {
        const previewMsg = {
          role: 'assistant' as const,
          content: DATASET_PREVIEW_LOADING_CONTENT,
          charts: [],
          insights: [],
          timestamp: Date.now(),
        };
        const enriching =
          session.enrichmentStatus === 'pending' || session.enrichmentStatus === 'in_progress';
        const enrichmentMsg = enriching
          ? [
              {
                role: 'assistant' as const,
                content: DATASET_ENRICHMENT_LOADING_CONTENT,
                charts: [],
                insights: [],
                timestamp: Date.now() + 1,
              },
            ]
          : [];
        setMessages([previewMsg, ...enrichmentMsg]);
      } else {
        setMessages([]);
      }
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
    setTemporalFacetColumns,
    setTotalRows,
    setTotalColumns,
    setMessages,
    setSuggestions,
    setCollaborators,
  ]);
};

