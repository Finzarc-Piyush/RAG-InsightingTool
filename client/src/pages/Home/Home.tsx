import { useEffect, useState, useRef } from 'react';
import { FileUpload } from '@/pages/Home/Components/FileUpload';
import { StartAnalysisView } from '@/pages/Home/Components/StartAnalysisView';
import { SnowflakeImportFlow } from '@/pages/Home/Components/SnowflakeImportFlow';
import { ChatInterface } from './Components/ChatInterface';
import { ContextModal } from './Components/ContextModal';
import { DataSummaryModal } from './Components/DataSummaryModal';
import { useHomeState, useHomeMutations, useHomeHandlers, useSessionLoader } from './modules';
import { sessionsApi } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { logger } from '@/lib/logger';

interface HomeProps {
  resetTrigger?: number;
  loadedSessionData?: any;
  initialMode?: 'general' | 'analysis' | 'dataOps' | 'modeling';
  onModeChange?: (mode: 'general' | 'analysis' | 'dataOps' | 'modeling') => void;
  onSessionChange?: (sessionId: string | null, fileName: string | null) => void;
}

export default function Home({ resetTrigger = 0, loadedSessionData, initialMode, onModeChange, onSessionChange }: HomeProps) {
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [collaborators, setCollaborators] = useState<string[]>([]);
  const [isDatasetPreviewLoading, setIsDatasetPreviewLoading] = useState(false);
  const [isDatasetEnriching, setIsDatasetEnriching] = useState(false);
  const [showContextModal, setShowContextModal] = useState(false);
  const [contextModalSessionId, setContextModalSessionId] = useState<string | null>(null);
  const [isSavingContext, setIsSavingContext] = useState(false);
  const [showDataSummaryModal, setShowDataSummaryModal] = useState(false);
  const [startMode, setStartMode] = useState<'choice' | 'upload' | 'snowflake'>('choice');
  const contextModalShownRef = useRef<Set<string>>(new Set());
  const { toast } = useToast();
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
    totalRows,
    totalColumns,
    mode,
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
    setTotalRows,
    setTotalColumns,
    setMode,
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
  } = useHomeMutations({
    sessionId,
    messages,
    mode,
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
    setSuggestions,
    setIsDatasetPreviewLoading,
    setIsDatasetEnriching,
  });

  const { handleFileSelect, handleSendMessage, handleUploadNew, handleEditMessage } = useHomeHandlers({
    sessionId,
    messages,
    setMessages,
    uploadMutation,
    chatMutation,
    resetState,
  });

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
            setMessages(data.session.messages as any);
          }
          if (data.session.collaborators && Array.isArray(data.session.collaborators)) {
            setCollaborators(data.session.collaborators);
          }
        } else {
          // Handle direct response
          if (Array.isArray(data.messages)) {
            setMessages(data.messages as any);
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

  // Sync mode with initialMode prop (from URL) - only when initialMode changes
  useEffect(() => {
    if (initialMode && initialMode !== mode && initialMode !== 'general') {
      setMode(initialMode);
    }
  }, [initialMode]);

  // Reset state only when resetTrigger changes (upload new file)
  useEffect(() => {
    if (resetTrigger > 0 && !loadedSessionData) {
      resetState();
      setSuggestions([]);
      setIsDatasetPreviewLoading(false);
      setIsDatasetEnriching(false);
    }
  }, [resetTrigger, resetState, loadedSessionData]);

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
    setTotalRows,
    setTotalColumns,
    setMessages,
    setCollaborators,
  });

  // Notify parent when sessionId or fileName changes
  useEffect(() => {
    if (onSessionChange) {
      onSessionChange(sessionId, fileName);
    }
  }, [sessionId, fileName, onSessionChange]);

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

  // When "Upload new" is clicked, show upload view and open file dialog
  useEffect(() => {
    if (resetTrigger > 0 && !sessionId && !loadedSessionData) {
      setStartMode('upload');
    }
  }, [resetTrigger, sessionId, loadedSessionData]);

  // Don't show start/upload/snowflake if we're loading a session (even if sessionId isn't set yet)
  // Only show when there's no session data being loaded AND no sessionId
  if (!sessionId && !loadedSessionData) {
    if (startMode === 'choice') {
      return (
        <StartAnalysisView
          onSelectUpload={() => setStartMode('upload')}
          onSelectSnowflake={() => setStartMode('snowflake')}
        />
      );
    }
    if (startMode === 'snowflake') {
      return (
        <SnowflakeImportFlow
          onBack={() => setStartMode('upload')}
          onImport={({ database, schema, tableName }) => snowflakeImportMutation.mutate({ database, schema, tableName })}
          isImporting={snowflakeImportMutation.isPending}
        />
      );
    }
    return (
      <FileUpload
        onFileSelect={handleFileSelect}
        isUploading={uploadMutation.isPending}
        autoOpenTrigger={resetTrigger > 0 ? resetTrigger : 0}
        onBack={() => setStartMode('choice')}
      />
    );
  }

  // If we're loading a session but sessionId isn't set yet, show loading state
  if (!sessionId && loadedSessionData) {
    return (
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
    );
  }

  return (
    <>
      <ChatInterface
        messages={messages}
        onSendMessage={handleSendMessage}
        onUploadNew={handleUploadNew}
        isLoading={chatMutation.isPending}
        onLoadHistory={handleLoadHistory}
        canLoadHistory={!!sessionId}
        loadingHistory={isLoadingHistory}
        sampleRows={sampleRows}
        columns={columns}
        numericColumns={numericColumns}
        dateColumns={dateColumns}
        temporalDisplayGrainsByColumn={temporalDisplayGrainsByColumn}
        totalRows={totalRows}
        totalColumns={totalColumns}
        onStopGeneration={handleStopGeneration}
        onEditMessage={handleEditMessage}
        thinkingSteps={thinkingSteps}
        agentWorkbenchLive={agentWorkbenchLive}
        thinkingTargetTimestamp={thinkingTargetTimestamp}
        aiSuggestions={suggestions}
        collaborators={collaborators}
        mode={mode}
        sessionId={sessionId}
        isDatasetPreviewLoading={isDatasetPreviewLoading}
        isDatasetEnriching={isDatasetEnriching}
        onModeChange={(newMode) => {
          setMode(newMode);
          // onModeChange will update the URL, which will update initialMode prop
          if (onModeChange) {
            onModeChange(newMode);
          }
        }}
        onOpenDataSummary={() => setShowDataSummaryModal(true)}
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
      />
    </>
  );
}
