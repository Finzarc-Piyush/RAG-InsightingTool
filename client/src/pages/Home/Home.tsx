import { useEffect, useState, useRef, useCallback } from 'react';
import type { DatasetEnrichmentPollSnapshot } from '@/lib/api/uploadStatus';
import { StartAnalysisView } from '@/pages/Home/Components/StartAnalysisView';
import { SnowflakeImportFlow } from '@/pages/Home/Components/SnowflakeImportFlow';
import { ChatInterface } from './Components/ChatInterface';
import { ContextModal } from './Components/ContextModal';
import { DataSummaryModal } from './Components/DataSummaryModal';
import { useHomeState, useHomeMutations, useHomeHandlers, useSessionLoader } from './modules';
import { sessionsApi } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { logger } from '@/lib/logger';
import { normalizeDatasetSystemMessages } from './modules/uploadSystemMessages';
import {
  inspectLocalWorkbookSheets,
  parseLocalPreview,
  type LocalPreviewResult,
} from '@/lib/localPreviewParser';
import { DATASET_PREVIEW_LOADING_CONTENT } from './modules/uploadSystemMessages';
import type { ChartSpec } from '@/shared/schema';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useChatSidebarNav } from '@/contexts/ChatSidebarNavContext';
import { buildChatPivotNavEntries } from '@/pages/Home/lib/chatPivotNav';

type PreviewSnapshot = {
  capturedAt: number;
  rows: Record<string, any>[];
  columns: string[];
  numericColumns: string[];
  dateColumns: string[];
  totalRows: number;
  totalColumns: number;
};

type PreviewSource = 'none' | 'local' | 'server';

interface HomeProps {
  resetTrigger?: number;
  loadedSessionData?: any;
  onSessionChange?: (sessionId: string | null, fileName: string | null) => void;
}

export default function Home({ resetTrigger = 0, loadedSessionData, onSessionChange }: HomeProps) {
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [collaborators, setCollaborators] = useState<string[]>([]);
  const [isDatasetPreviewLoading, setIsDatasetPreviewLoading] = useState(false);
  const [isDatasetEnriching, setIsDatasetEnriching] = useState(false);
  const [enrichmentPoll, setEnrichmentPoll] = useState<DatasetEnrichmentPollSnapshot | null>(null);
  const [enrichmentStartedAtMs, setEnrichmentStartedAtMs] = useState<number | null>(null);
  const [showContextModal, setShowContextModal] = useState(false);
  const [contextModalSessionId, setContextModalSessionId] = useState<string | null>(null);
  const [isSavingContext, setIsSavingContext] = useState(false);
  const [showDataSummaryModal, setShowDataSummaryModal] = useState(false);
  const [preEnrichmentPreviewSnapshot, setPreEnrichmentPreviewSnapshot] =
    useState<PreviewSnapshot | null>(null);
  const [postEnrichmentPreviewSnapshot, setPostEnrichmentPreviewSnapshot] =
    useState<PreviewSnapshot | null>(null);
  const [externalComposerDraft, setExternalComposerDraft] = useState<{
    text: string;
    id: number;
  } | null>(null);
  const [isUploadStarting, setIsUploadStarting] = useState(false);
  const [previewSource, setPreviewSource] = useState<PreviewSource>('none');
  const [localPreview, setLocalPreview] = useState<LocalPreviewResult | null>(null);
  const [uploadStartError, setUploadStartError] = useState<string | null>(null);
  const [pendingSheetFile, setPendingSheetFile] = useState<File | null>(null);
  const [sheetChoices, setSheetChoices] = useState<string[]>([]);
  const [selectedSheetName, setSelectedSheetName] = useState<string>('');
  const localPreviewRequestIdRef = useRef(0);
  const composerDraftIdRef = useRef(0);
  const [startMode, setStartMode] = useState<'choice' | 'snowflake'>('choice');
  const contextModalShownRef = useRef<Set<string>>(new Set());

  const handleComposerDraftConsumed = useCallback(() => {
    setExternalComposerDraft(null);
  }, []);

  const handleDraftMessageFromModal = useCallback((text: string) => {
    composerDraftIdRef.current += 1;
    setExternalComposerDraft({ text, id: composerDraftIdRef.current });
  }, []);
  const { toast } = useToast();
  const { setPivotEntries } = useChatSidebarNav();
  const {
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
    resetState,
  } = useHomeState();

  const {
    uploadMutation,
    snowflakeImportMutation,
    chatMutation,
    cancelChatRequest,
    thinkingSteps,
    agentWorkbenchLive,
    thinkingTargetTimestamp,
    thinkingLiveAnchorTimestamp,
  } = useHomeMutations({
    sessionId,
    messages,
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
    setIsDatasetPreviewLoading,
    setIsDatasetEnriching,
    setEnrichmentPollSnapshot: setEnrichmentPoll,
    onUploadProcessingStarted: () => {
      setIsUploadStarting(false);
      setUploadStartError(null);
    },
    onUploadError: (message) => {
      setIsUploadStarting(false);
      setUploadStartError(message || 'Upload failed before server preview became available.');
    },
  });

  const { handleFileSelect, handleSendMessage, handleUploadNew, handleEditMessage } = useHomeHandlers({
    sessionId,
    messages,
    setMessages,
    uploadMutation,
    chatMutation,
    resetState,
  });

  const handleAppendAssistantChart = useCallback(
    (chart: ChartSpec) => {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: 'Chart added from Chart Builder.',
          charts: [chart],
          timestamp: Date.now(),
        },
      ]);
    },
    [setMessages]
  );

  const handleStartUploadFromChoice = async (file: File) => {
      const lowerFileName = file.name.toLowerCase();
      if (lowerFileName.endsWith('.xlsx') || lowerFileName.endsWith('.xls')) {
        try {
          const workbookInfo = await inspectLocalWorkbookSheets(file);
          if (workbookInfo.requiresSelection) {
            setPendingSheetFile(file);
            setSheetChoices(workbookInfo.sheetNames);
            setSelectedSheetName(workbookInfo.selectedSheetName || workbookInfo.sheetNames[0] || '');
            return;
          }
        } catch (e) {
          logger.warn('Workbook inspection failed; continuing upload with server-side checks', e);
        }
      }
      await beginUploadWithSheetSelection(file);
    };

  async function beginUploadWithSheetSelection(file: File, sheetName?: string) {
    const requestId = Date.now();
    localPreviewRequestIdRef.current = requestId;
    setIsUploadStarting(true);
    setPreviewSource('local');
    setUploadStartError(null);
    setIsDatasetPreviewLoading(true);
    setMessages([
      {
        role: 'assistant',
        content: `${DATASET_PREVIEW_LOADING_CONTENT} (Local preview shown while server prepares authoritative preview.)`,
        charts: [],
        insights: [],
        timestamp: Date.now(),
      },
    ]);
    setFileName(file.name);
    setSampleRows([]);
    setColumns([]);
    setNumericColumns([]);
    setDateColumns([]);
    setTemporalFacetColumns([]);
    setTotalRows(0);
    setTotalColumns(0);
    try {
      const parsed = await parseLocalPreview(file, { sheetName });
      if (localPreviewRequestIdRef.current !== requestId) return;
      setLocalPreview(parsed);
      setSampleRows(parsed.rows);
      setColumns(parsed.columns);
      setNumericColumns(parsed.numericColumns);
      setDateColumns(parsed.dateColumns);
      setTotalRows(parsed.rowCountEstimate || parsed.rows.length);
      setTotalColumns(parsed.columns.length);
    } catch (e) {
      logger.warn('Local preview parse failed; continuing with upload', e);
    }
    handleFileSelect(file, { sheetName });
  }

  useEffect(() => {
    if (!pendingSheetFile) return;
    if (!selectedSheetName && sheetChoices.length > 0) {
      setSelectedSheetName(sheetChoices[0]);
    }
  }, [pendingSheetFile, selectedSheetName, sheetChoices]);

  const handleUploadNewWithLocalReset = useCallback(() => {
    localPreviewRequestIdRef.current += 1;
    setPreviewSource('none');
    setLocalPreview(null);
    setUploadStartError(null);
    setIsUploadStarting(false);
    setStartMode('choice');
    handleUploadNew();
  }, [handleUploadNew]);

  const handleStopGeneration = () => {
    cancelChatRequest();
  };

  const handleLoadHistory = async () => {
    if (!sessionId || isLoadingHistory) return;
    setIsLoadingHistory(true);
    try {
      const data = await sessionsApi.getSessionDetails(sessionId);
      if (data) {
        if (data.session) {
          // Handle response with session object
          if (Array.isArray(data.session.messages)) {
            const hasPreview =
              !!data.session.dataSummary?.columns?.length || !!data.session.dataSummary?.rowCount;
            const isEnriching =
              data.session.enrichmentStatus === 'pending' ||
              data.session.enrichmentStatus === 'in_progress';
            setMessages(
              normalizeDatasetSystemMessages(data.session.messages as any, {
                hasPreview,
                isEnriching,
              }) as any
            );
          }
          if (data.session.collaborators && Array.isArray(data.session.collaborators)) {
            setCollaborators(data.session.collaborators);
          }
        } else {
          // Handle direct response
          if (Array.isArray(data.messages)) {
            const hasPreview = !!data.dataSummary?.columns?.length || !!data.dataSummary?.rowCount;
            const isEnriching =
              data.enrichmentStatus === 'pending' || data.enrichmentStatus === 'in_progress';
            setMessages(
              normalizeDatasetSystemMessages(data.messages as any, {
                hasPreview,
                isEnriching,
              }) as any
            );
          }
          if (data.collaborators && Array.isArray(data.collaborators)) {
            setCollaborators(data.collaborators);
          }
        }
      }
    } catch (e) {
      logger.error('Failed to load chat history', e);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  useEffect(() => {
    if (isDatasetEnriching) {
      setEnrichmentStartedAtMs((prev) => prev ?? Date.now());
    } else {
      setEnrichmentStartedAtMs(null);
    }
  }, [isDatasetEnriching]);

  // Reset state only when resetTrigger changes (upload new file)
  useEffect(() => {
    if (resetTrigger > 0 && !loadedSessionData) {
      resetState();
      setSuggestions([]);
      setIsDatasetPreviewLoading(false);
      setIsDatasetEnriching(false);
      setIsUploadStarting(false);
      setPreEnrichmentPreviewSnapshot(null);
      setPostEnrichmentPreviewSnapshot(null);
    }
  }, [resetTrigger, resetState, loadedSessionData]);

  useEffect(() => {
    if (sessionId) {
      setIsUploadStarting(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (
      previewSource === 'local' &&
      sessionId &&
      columns.length > 0 &&
      !isDatasetPreviewLoading &&
      enrichmentPoll?.phase !== 'failed'
    ) {
      setPreviewSource('server');
      setUploadStartError(null);
    }
  }, [previewSource, sessionId, columns.length, isDatasetPreviewLoading, enrichmentPoll?.phase]);

  useEffect(() => {
    if (!sessionId) {
      setPreEnrichmentPreviewSnapshot(null);
      setPostEnrichmentPreviewSnapshot(null);
    }
  }, [sessionId]);

  useEffect(() => {
    if (previewSource === 'local' && localPreview?.parseStatus === 'failed') {
      setUploadStartError('Local preview could not be parsed. Upload is continuing; server preview will appear when ready.');
    }
  }, [previewSource, localPreview?.parseStatus]);

  useEffect(() => {
    if (!columns.length) return;
    const snapshot: PreviewSnapshot = {
      capturedAt: Date.now(),
      rows: sampleRows || [],
      columns: [...columns],
      numericColumns: [...numericColumns],
      dateColumns: [...dateColumns],
      totalRows: totalRows || 0,
      totalColumns: totalColumns || 0,
    };
    if (isDatasetEnriching && !preEnrichmentPreviewSnapshot) {
      setPreEnrichmentPreviewSnapshot(snapshot);
      setPostEnrichmentPreviewSnapshot(null);
      return;
    }
    if (!isDatasetEnriching && preEnrichmentPreviewSnapshot) {
      setPostEnrichmentPreviewSnapshot(snapshot);
    }
  }, [
    isDatasetEnriching,
    preEnrichmentPreviewSnapshot,
    columns,
    sampleRows,
    numericColumns,
    dateColumns,
    totalRows,
    totalColumns,
  ]);

  // Load session data when provided (and populate existing chat history)
  useSessionLoader({
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
  });

  // Notify parent when sessionId or fileName changes
  useEffect(() => {
    if (onSessionChange) {
      onSessionChange(sessionId, fileName);
    }
  }, [sessionId, fileName, onSessionChange]);

  useEffect(() => {
    setPivotEntries(buildChatPivotNavEntries(messages));
    return () => setPivotEntries([]);
  }, [messages, setPivotEntries]);

  // Fetch collaborators when sessionId is available
  useEffect(() => {
    const fetchCollaborators = async () => {
      if (!sessionId) return;
      try {
        const data = await sessionsApi.getSessionDetails(sessionId);
        if (data) {
          const sessionData = data.session || data;
          if (sessionData.collaborators && Array.isArray(sessionData.collaborators)) {
            setCollaborators(sessionData.collaborators);
          }
        }
      } catch (e) {
        logger.error('Failed to fetch collaborators', e);
      }
    };
    fetchCollaborators();
  }, [sessionId]);

  // Show context modal after preview is available (not during full-screen preview loading).
  useEffect(() => {
    const sessionReadyForContext =
      !isDatasetPreviewLoading && (messages.length > 0 || !isDatasetEnriching);
    if (!sessionId || !sessionReadyForContext || contextModalShownRef.current.has(sessionId)) {
      return;
    }
    const checkAndShowModal = async () => {
      try {
        const data = await sessionsApi.getSessionDetails(sessionId);
        const sessionData = data.session || data;
        if (!sessionData.permanentContext) {
          setContextModalSessionId(sessionId);
          setShowContextModal(true);
          contextModalShownRef.current.add(sessionId);
        }
      } catch (e) {
        logger.error('Failed to check session context:', e);
        setContextModalSessionId(sessionId);
        setShowContextModal(true);
        contextModalShownRef.current.add(sessionId);
      }
    };
    checkAndShowModal();
  }, [sessionId, isDatasetPreviewLoading, isDatasetEnriching, messages.length]);

  // Handle saving context
  const handleSaveContext = async (context: string) => {
    if (!contextModalSessionId) return;
    
    setIsSavingContext(true);
    try {
      await sessionsApi.updateSessionContext(contextModalSessionId, context);
      setShowContextModal(false);
      setContextModalSessionId(null);
      toast({
        title: 'Context Saved',
        description: 'Your context has been saved and will be included with each message.',
      });
    } catch (error) {
      logger.error('Failed to save context:', error);
      toast({
        title: 'Error',
        description: 'Failed to save context. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setIsSavingContext(false);
    }
  };

  // Handle closing context modal
  const handleCloseContextModal = () => {
    setShowContextModal(false);
    setContextModalSessionId(null);
  };

  // When "Upload new" is clicked, stay on start view and auto-open the picker.
  useEffect(() => {
    if (resetTrigger > 0 && !sessionId && !loadedSessionData) {
      setStartMode('choice');
      setPreviewSource('none');
      setLocalPreview(null);
      setUploadStartError(null);
    }
  }, [resetTrigger, sessionId, loadedSessionData]);

  const sheetSelectorDialog = (
    <Dialog
      open={!!pendingSheetFile}
      onOpenChange={(open) => {
        if (!open) {
          setPendingSheetFile(null);
          setSheetChoices([]);
          setSelectedSheetName('');
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Select worksheet</DialogTitle>
          <DialogDescription>
            This workbook has multiple sheets. Choose the sheet to preview and ingest.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {sheetChoices.map((sheet) => (
            <Button
              key={sheet}
              type="button"
              variant={selectedSheetName === sheet ? 'default' : 'outline'}
              onClick={() => setSelectedSheetName(sheet)}
              className="justify-start"
            >
              {sheet}
            </Button>
          ))}
        </div>
        {!selectedSheetName && pendingSheetFile ? (
          <p className="text-sm text-muted-foreground">Please select a worksheet to continue.</p>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setPendingSheetFile(null);
              setSheetChoices([]);
              setSelectedSheetName('');
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={!selectedSheetName}
            onClick={() => {
              if (!pendingSheetFile || !selectedSheetName) return;
              const file = pendingSheetFile;
              const chosenSheet = selectedSheetName;
              setPendingSheetFile(null);
              setSheetChoices([]);
              setSelectedSheetName('');
              void beginUploadWithSheetSelection(file, chosenSheet);
            }}
          >
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  // Don't show start/upload/snowflake if we're loading a session (even if sessionId isn't set yet)
  // Only show when there's no session data being loaded AND no sessionId
  if (!sessionId && !loadedSessionData && previewSource !== 'local') {
    if (startMode === 'choice') {
      return (
        <>
          <StartAnalysisView
            onSelectUpload={handleStartUploadFromChoice}
            onSelectSnowflake={() => setStartMode('snowflake')}
            uploadDialogTrigger={resetTrigger > 0 ? resetTrigger : 0}
            isUploadStarting={isUploadStarting}
          />
          {sheetSelectorDialog}
        </>
      );
    }
    if (startMode === 'snowflake') {
      return (
        <>
          <SnowflakeImportFlow
            onBack={() => setStartMode('choice')}
            onImport={({ database, schema, tableName }) => snowflakeImportMutation.mutate({ database, schema, tableName })}
            isImporting={snowflakeImportMutation.isPending}
          />
          {sheetSelectorDialog}
        </>
      );
    }
  }

  // If we're loading a session but sessionId isn't set yet, show loading state
  if (!sessionId && loadedSessionData) {
    return (
      <>
        <div className="h-[calc(100vh-80px)] bg-gradient-to-br from-slate-50 to-white flex items-center justify-center">
          <div className="text-center max-w-md px-6">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Loading analysis</h3>
            <p className="text-sm text-gray-600 mb-4">Preparing your data and insights...</p>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div className="bg-primary h-2 rounded-full animate-pulse" style={{ width: '40%' }}></div>
            </div>
          </div>
        </div>
        {sheetSelectorDialog}
      </>
    );
  }

  return (
    <>
      <ChatInterface
        messages={messages}
        onSendMessage={handleSendMessage}
        onUploadNew={handleUploadNewWithLocalReset}
        isLoading={chatMutation.isPending}
        onLoadHistory={handleLoadHistory}
        canLoadHistory={!!sessionId}
        loadingHistory={isLoadingHistory}
        sampleRows={sampleRows}
        columns={columns}
        numericColumns={numericColumns}
        dateColumns={dateColumns}
        temporalDisplayGrainsByColumn={temporalDisplayGrainsByColumn}
        temporalFacetColumns={temporalFacetColumns}
        totalRows={totalRows}
        totalColumns={totalColumns}
        onStopGeneration={handleStopGeneration}
        onEditMessage={handleEditMessage}
        thinkingSteps={thinkingSteps}
        agentWorkbenchLive={agentWorkbenchLive}
        thinkingTargetTimestamp={thinkingTargetTimestamp}
        thinkingLiveAnchorTimestamp={thinkingLiveAnchorTimestamp}
        aiSuggestions={suggestions}
        collaborators={collaborators}
        sessionId={sessionId}
        isDatasetPreviewLoading={isDatasetPreviewLoading}
        isDatasetEnriching={isDatasetEnriching}
        enrichmentPoll={enrichmentPoll}
        enrichmentStartedAtMs={enrichmentStartedAtMs}
        onOpenDataSummary={() => setShowDataSummaryModal(true)}
        externalComposerDraft={externalComposerDraft}
        onExternalComposerDraftConsumed={handleComposerDraftConsumed}
        preEnrichmentPreviewSnapshot={preEnrichmentPreviewSnapshot}
        postEnrichmentPreviewSnapshot={postEnrichmentPreviewSnapshot}
        previewSource={previewSource}
        localPreviewParseStatus={localPreview?.parseStatus}
        uploadStartError={uploadStartError}
        onAppendAssistantChart={handleAppendAssistantChart}
      />
      <ContextModal
        isOpen={showContextModal}
        onClose={handleCloseContextModal}
        onSave={handleSaveContext}
        isLoading={isSavingContext}
      />
      <DataSummaryModal
        isOpen={showDataSummaryModal}
        onClose={() => setShowDataSummaryModal(false)}
        sessionId={sessionId}
        onSendMessage={handleSendMessage}
        onDraftMessage={handleDraftMessageFromModal}
      />
      {sheetSelectorDialog}
    </>
  );
}
