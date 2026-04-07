import { forwardRef, useState, useMemo, memo, lazy, Suspense, useEffect } from 'react';
import {
  AgentWorkbenchEntry,
  Message,
  ThinkingStep,
  ChartSpec,
  TemporalDisplayGrain,
  type TemporalFacetColumnMeta,
} from '@/shared/schema';
import { User, Bot, Edit2, Check, X as XIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { InsightCard } from './InsightCard';
import { DataPreview } from './DataPreview';
import { DataPreviewTable, DataSummaryTable } from './DataPreviewTable';
import { ThinkingPanel } from './ThinkingPanel';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { getUserEmail } from '@/utils/userStorage';
import { MarkdownRenderer } from '@/components/ui/markdown-renderer';
import { FilterAppliedMessage } from '@/components/FilterAppliedMessage';
import { FilterCondition } from '@/components/ColumnFilterDialog';
import { Skeleton } from '@/components/ui/skeleton';
import { DatasetEnrichmentLoader } from './DatasetEnrichmentLoader';
import type { DatasetEnrichmentPollSnapshot } from '@/lib/api/uploadStatus';
import {
  DATASET_PREVIEW_MESSAGE_KEY,
  isDatasetEnrichmentSystemMessage,
  isDatasetPreviewSystemMessage,
} from '@/pages/Home/modules/uploadSystemMessages';
import { chatPivotAnchorId } from '@/pages/Home/lib/chatPivotNav';

// Lazy load ChartRenderer to reduce initial bundle size (includes heavy recharts dependency)
const ChartRenderer = lazy(() => import('./ChartRenderer').then(module => ({ default: module.ChartRenderer })));

const PREVIEW_SIGNATURE_SLICE = 3500;

/** Stable signature for preview/summary arrays so memo re-renders when row content or keys change, not only length. */
function tablePayloadSignature(payload: unknown[] | undefined): string {
  if (!payload?.length) return '0';
  const n = payload.length;
  const first = payload[0];
  const last = payload[n - 1];
  const firstBlob =
    first != null && typeof first === 'object'
      ? JSON.stringify(first).slice(0, PREVIEW_SIGNATURE_SLICE)
      : String(first);
  const lastBlob =
    last != null && typeof last === 'object'
      ? JSON.stringify(last).slice(0, PREVIEW_SIGNATURE_SLICE)
      : String(last);
  return `${n}:${firstBlob}:${lastBlob}`;
}

/**
 * Extract loading state for a correlation chart from thinking steps
 */
function extractCorrelationChartLoadingState(
  chart: ChartSpec,
  thinkingSteps: ThinkingStep[],
  chartIndex: number
): { isLoading: boolean; progress?: { processed: number; total: number; message?: string } } {
  // Look for correlation-related thinking steps
  const correlationSteps = thinkingSteps.filter(step => 
    step.step.toLowerCase().includes('correlation') || 
    step.step.toLowerCase().includes('computing') ||
    step.details?.toLowerCase().includes('rows')
  );

  if (correlationSteps.length === 0) {
    return { isLoading: false };
  }

  // Check if any correlation step is still active
  const activeStep = correlationSteps.find(step => step.status === 'active');
  if (!activeStep) {
    // Check if the last step is completed
    const lastStep = correlationSteps[correlationSteps.length - 1];
    if (lastStep?.status === 'completed') {
      return { isLoading: false };
    }
    return { isLoading: false };
  }

  // Extract progress from step details (format: "X/Y rows" or "X/Y rows processed")
  let progress: { processed: number; total: number; message?: string } | undefined;
  if (activeStep.details) {
    const match = activeStep.details.match(/(\d+(?:,\d+)*)\s*\/\s*(\d+(?:,\d+)*)\s*rows/i);
    if (match) {
      const processed = parseInt(match[1].replace(/,/g, ''), 10);
      const total = parseInt(match[2].replace(/,/g, ''), 10);
      if (!isNaN(processed) && !isNaN(total)) {
        progress = {
          processed,
          total,
          message: activeStep.step,
        };
      }
    }
  }

  // If chart has data, it's no longer loading
  if (chart.data && Array.isArray(chart.data) && chart.data.length > 0) {
    return { isLoading: false };
  }

  return {
    isLoading: true,
    progress: progress || { processed: 0, total: 0, message: activeStep.step },
  };
}

interface MessageBubbleProps {
  message: Message;
  sampleRows?: Record<string, any>[];
  columns?: string[];
  numericColumns?: string[];
  dateColumns?: string[];
  temporalDisplayGrainsByColumn?: Record<string, TemporalDisplayGrain>;
  temporalFacetColumns?: TemporalFacetColumnMeta[];
  totalRows?: number;
  totalColumns?: number;
  onEditMessage?: (messageIndex: number, newContent: string) => void;
  messageIndex?: number;
  isLastUserMessage?: boolean;
  thinkingSteps?: ThinkingStep[];
  /** Collapsible thinking + workbench (user message, active or persisted turn). */
  thinkingPanelSteps?: ThinkingStep[];
  thinkingPanelWorkbench?: AgentWorkbenchEntry[];
  thinkingPanelStreaming?: boolean;
  sessionId?: string | null; // Session ID for downloading modified datasets
  onSuggestedQuestionClick?: (question: string) => void;
  showDatasetEnrichmentLoader?: boolean;
  enrichmentPhase?: DatasetEnrichmentPollSnapshot['enrichmentPhase'];
  enrichmentStep?: DatasetEnrichmentPollSnapshot['enrichmentStep'];
  uploadProgress?: number;
  enrichmentStartedAtMs?: number | null;
  preEnrichmentPreviewSnapshot?: {
    capturedAt: number;
    rows: Record<string, any>[];
    columns: string[];
    numericColumns: string[];
    dateColumns: string[];
    totalRows: number;
    totalColumns: number;
  } | null;
  postEnrichmentPreviewSnapshot?: {
    capturedAt: number;
    rows: Record<string, any>[];
    columns: string[];
    numericColumns: string[];
    dateColumns: string[];
    totalRows: number;
    totalColumns: number;
  } | null;
  /** Show dataset columns/preview only when explicitly requested by the user. */
  allowDatasetPreviewInAnswer?: boolean;
  /** Auto-show pivot/table section for aggregated tabular assistant outputs. */
  allowPivotAutoShow?: boolean;
  onAppendAssistantChart?: (chart: ChartSpec) => void;
}

const MessageBubbleComponent = forwardRef<HTMLDivElement, MessageBubbleProps>(({
  message,
  sampleRows,
  columns,
  numericColumns,
  dateColumns,
  temporalDisplayGrainsByColumn,
  temporalFacetColumns,
  totalRows,
  totalColumns,
  onEditMessage,
  messageIndex,
  isLastUserMessage = false,
  thinkingSteps,
  thinkingPanelSteps,
  thinkingPanelWorkbench,
  thinkingPanelStreaming,
  sessionId,
  onSuggestedQuestionClick,
  showDatasetEnrichmentLoader = false,
  enrichmentPhase,
  enrichmentStep,
  uploadProgress,
  enrichmentStartedAtMs,
  preEnrichmentPreviewSnapshot,
  postEnrichmentPreviewSnapshot,
  allowDatasetPreviewInAnswer = false,
  allowPivotAutoShow = false,
  onAppendAssistantChart,
}, ref) => {
  const isUser = message.role === 'user';
  const isPreviewSystemMessage = isDatasetPreviewSystemMessage(message);
  const isEnrichmentSystemMessage = isDatasetEnrichmentSystemMessage(message);
  const displayContent = isPreviewSystemMessage
    ? message.content.replace(`${DATASET_PREVIEW_MESSAGE_KEY} `, '')
    : message.content;

  // Detect if this is a filter operation response
  const isFilterResponse = useMemo(() => {
    if (isUser) return false;
    const content = message.content?.toLowerCase() || '';
    return content.includes("i've filtered the dataset") || 
           content.includes('filtered the dataset') || 
           content.includes('filtered data') ||
           (content.includes('filter conditions:') && content.includes('rows before'));
  }, [message.content, isUser]);

  // Extract filter condition from message if it's a filter response
  const filterCondition = useMemo((): FilterCondition | null => {
    if (!isFilterResponse) return null;
    
    const content = message.content || '';
    
    // Try to extract from "Filter conditions:" line (backend format)
    const filterConditionsMatch = content.match(/\*\*Filter conditions:\*\*\s*(.+?)(?:\n|$)/i);
    if (filterConditionsMatch) {
      const conditionStr = filterConditionsMatch[1].trim();
      
      // Parse different operator patterns
      // Pattern: "column between value and value2"
      const betweenMatch = conditionStr.match(/([^\s]+)\s+between\s+(.+?)\s+and\s+(.+?)(?:\s|$)/i);
      if (betweenMatch) {
        return {
          column: betweenMatch[1],
          operator: 'between',
          value: betweenMatch[2].trim(),
          value2: betweenMatch[3].trim(),
        };
      }
      
      // Pattern: "column in [value1, value2, ...]"
      const inMatch = conditionStr.match(/([^\s]+)\s+in\s+\[(.+?)\]/i);
      if (inMatch) {
        const values = inMatch[2].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
        return {
          column: inMatch[1],
          operator: 'in',
          values,
        };
      }
      
      // Pattern: "column contains value"
      const containsMatch = conditionStr.match(/([^\s]+)\s+contains\s+"(.+?)"/i);
      if (containsMatch) {
        return {
          column: containsMatch[1],
          operator: 'contains',
          value: containsMatch[2],
        };
      }
      
      // Pattern: "column starts with value"
      const startsWithMatch = conditionStr.match(/([^\s]+)\s+starts\s+with\s+"(.+?)"/i);
      if (startsWithMatch) {
        return {
          column: startsWithMatch[1],
          operator: 'startsWith',
          value: startsWithMatch[2],
        };
      }
      
      // Pattern: "column ends with value"
      const endsWithMatch = conditionStr.match(/([^\s]+)\s+ends\s+with\s+"(.+?)"/i);
      if (endsWithMatch) {
        return {
          column: endsWithMatch[1],
          operator: 'endsWith',
          value: endsWithMatch[2],
        };
      }
      
      // Pattern: "column operator value" (for =, !=, >, >=, <, <=)
      const operatorMatch = conditionStr.match(/([^\s]+)\s+(>=|<=|!=|>|<|=)\s+(.+?)(?:\s|$)/);
      if (operatorMatch) {
        return {
          column: operatorMatch[1],
          operator: operatorMatch[2] as FilterCondition['operator'],
          value: operatorMatch[3].trim().replace(/^"|"$/g, ''),
        };
      }
    }
    
    return null;
  }, [isFilterResponse, message.content]);

  // Extract row counts from message
  const rowCounts = useMemo(() => {
    if (!isFilterResponse) return null;
    const content = message.content || '';
    const rowsBeforeMatch = content.match(/\*\*Rows before:\*\*\s*(\d+(?:,\d+)*)/i);
    const rowsAfterMatch = content.match(/\*\*Rows after:\*\*\s*(\d+(?:,\d+)*)/i);
    return {
      rowsBefore: rowsBeforeMatch ? parseInt(rowsBeforeMatch[1].replace(/,/g, ''), 10) : undefined,
      rowsAfter: rowsAfterMatch ? parseInt(rowsAfterMatch[1].replace(/,/g, ''), 10) : undefined,
    };
  }, [isFilterResponse, message.content]);
  
  // Memoize getUserEmail to avoid reading localStorage on every render
  const currentUserEmail = useMemo(() => getUserEmail()?.toLowerCase(), []);
  const messageUserEmail = message.userEmail?.toLowerCase();
  
  // Show name if it's a user message and has a different email (shared analysis)
  const showUserName = useMemo(() => 
    isUser && messageUserEmail && messageUserEmail !== currentUserEmail,
    [isUser, messageUserEmail, currentUserEmail]
  );
  const displayName = useMemo(() => 
    message.userEmail ? message.userEmail.split('@')[0] : 'You',
    [message.userEmail]
  );

  const hasAggPreview =
    !isUser &&
    (message as Message & { preview?: unknown[] }).preview &&
    Array.isArray((message as Message & { preview?: unknown[] }).preview) &&
    ((message as Message & { preview?: unknown[] }).preview as unknown[]).length > 0;
  const hasAggSummary =
    !isUser &&
    (message as Message & { summary?: unknown[] }).summary &&
    Array.isArray((message as Message & { summary?: unknown[] }).summary) &&
    ((message as Message & { summary?: unknown[] }).summary as unknown[]).length > 0;

  const showMarkdownBlock =
    !isUser &&
    !!displayContent &&
    !isEnrichmentSystemMessage &&
    !(
      message.isIntermediate &&
      (!String(displayContent).trim() || String(displayContent).trim() === "Preliminary results")
    );
  
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.content);
  const [showDatasetPreview, setShowDatasetPreview] = useState(false);
  const [previewManuallyHidden, setPreviewManuallyHidden] = useState(false);

  useEffect(() => {
    setPreviewManuallyHidden(false);
  }, [message.timestamp]);

  useEffect(() => {
    if (isUser || isEnrichmentSystemMessage || !columns?.length || previewManuallyHidden) return;
    setShowDatasetPreview(true);
  }, [isUser, isEnrichmentSystemMessage, columns, previewManuallyHidden]);

  const handleSaveEdit = () => {
    if (editValue.trim() && onEditMessage && messageIndex !== undefined) {
      onEditMessage(messageIndex, editValue.trim());
      setIsEditing(false);
    }
  };

  const handleCancelEdit = () => {
    setEditValue(message.content);
    setIsEditing(false);
  };

  return (
    <div
      ref={ref}
      className={`flex gap-3 ${isUser ? 'justify-end' : 'justify-start'} mb-4`}
      data-testid={`message-${message.role}`}
    >
      {!isUser && (
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-primary to-primary/80 flex items-center justify-center shadow-sm">
          <Bot className="w-4 h-4 text-primary-foreground" />
        </div>
      )}
      
      <div className={`flex-1 max-w-[90%] ${isUser ? 'ml-auto' : 'mr-0'}`}>
        {isUser && (
          <div className="relative group">
            {/* Display user name and edit button in a flex container to avoid overlap */}
            {(showUserName || (isLastUserMessage && onEditMessage)) && (
              <div className="flex items-center justify-end gap-2 mb-1 mr-2">
                {showUserName && (
                  <span className="text-xs text-muted-foreground">{displayName}</span>
                )}
                {isLastUserMessage && onEditMessage && !isEditing && (
                  <button
                    onClick={() => setIsEditing(true)}
                    className="flex items-center gap-1 rounded-md p-1.5 text-xs font-medium text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
                    title="Edit message"
                  >
                    <Edit2 className="h-3 w-3" />
                    <span>Edit</span>
                  </button>
                )}
              </div>
            )}
            {isEditing ? (
              <div className="rounded-xl px-4 py-3 shadow-sm bg-primary text-primary-foreground ml-auto">
                <Textarea
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  className="bg-transparent border-none text-primary-foreground resize-none min-h-[60px] max-h-[200px] focus-visible:ring-0 focus-visible:ring-offset-0 p-0"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSaveEdit();
                    } else if (e.key === 'Escape') {
                      handleCancelEdit();
                    }
                  }}
                />
                <div className="flex gap-2 mt-3">
                  <Button
                    size="sm"
                    onClick={handleSaveEdit}
                    className="h-7 text-xs bg-primary-foreground/20 hover:bg-primary-foreground/30 text-primary-foreground border border-primary-foreground/30"
                  >
                    <Check className="h-3 w-3 mr-1" />
                    Save & Submit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleCancelEdit}
                    className="h-7 text-xs text-primary-foreground/80 hover:text-primary-foreground hover:bg-primary-foreground/10"
                  >
                    <XIcon className="h-3 w-3 mr-1" />
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div
                className={`rounded-xl px-4 py-3 shadow-sm bg-primary text-primary-foreground ml-auto relative`}
                data-testid={`message-content-${message.role}`}
              >
                <p className="text-sm leading-relaxed whitespace-pre-wrap">
                  {message.content}
                </p>
              </div>
            )}
          </div>
        )}

        {isUser &&
          ((thinkingPanelSteps?.length ?? 0) > 0 ||
            (thinkingPanelWorkbench?.length ?? 0) > 0) && (
            <ThinkingPanel
              variant="archived"
              steps={thinkingPanelSteps ?? []}
              workbench={thinkingPanelWorkbench ?? []}
              isStreaming={!!thinkingPanelStreaming}
            />
          )}

        {!isUser &&
          message.thinkingBefore &&
          ((message.thinkingBefore.steps?.length ?? 0) > 0 ||
            (message.thinkingBefore.workbench?.length ?? 0) > 0) && (
            <ThinkingPanel
              variant="archived"
              steps={message.thinkingBefore.steps}
              workbench={message.thinkingBefore.workbench ?? []}
              isStreaming={false}
            />
          )}

        {/* Show Filter Applied Message for filter operations */}
        {!isUser && isFilterResponse && filterCondition && (
          <div className="mb-3">
            <FilterAppliedMessage
              condition={filterCondition}
              rowsBefore={rowCounts?.rowsBefore}
              rowsAfter={rowCounts?.rowsAfter}
            />
          </div>
        )}

        {!isUser && allowPivotAutoShow && hasAggPreview && (
          <div
            id={chatPivotAnchorId(message)}
            className="mt-1 mb-3 scroll-mt-4"
          >
            <DataPreviewTable
              data={(message as Message & { preview: Record<string, unknown>[] }).preview}
              sessionId={sessionId}
              variant="analysis"
              columns={columns}
              numericColumns={numericColumns}
              dateColumns={dateColumns}
              temporalDisplayGrainsByColumn={temporalDisplayGrainsByColumn}
              temporalFacetColumns={temporalFacetColumns}
              pivotDefaults={message.pivotDefaults}
              onChartAdded={onAppendAssistantChart}
              analysisIntermediateInsight={
                message.isIntermediate ? message.intermediateInsight : undefined
              }
            />
          </div>
        )}

        {!isUser && allowPivotAutoShow && hasAggSummary && (
          <div className="mb-3">
            <DataSummaryTable summary={(message as Message & { summary: unknown[] }).summary} />
          </div>
        )}

        {showMarkdownBlock && (
          <div
            className="rounded-xl border border-border/80 bg-card px-4 py-3 shadow-sm"
            data-testid={`message-content-${message.role}`}
          >
            <div className="text-sm leading-relaxed text-foreground whitespace-pre-wrap">
              <MarkdownRenderer content={displayContent} />
            </div>
            {message.suggestedQuestions &&
              message.suggestedQuestions.length > 0 &&
              onSuggestedQuestionClick && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {message.suggestedQuestions.map((q, i) => (
                    <Button
                      key={i}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="text-xs rounded-full h-auto py-1.5 px-3"
                      aria-label={`Add to message: ${q}`}
                      onClick={() => onSuggestedQuestionClick(q)}
                    >
                      {q}
                    </Button>
                  ))}
                </div>
              )}
          </div>
        )}

        {!isUser && allowDatasetPreviewInAnswer && columns && columns.length > 0 && !isEnrichmentSystemMessage && (
          <div className="mt-3">
            {!showDatasetPreview ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-xs px-2"
                  onClick={() => {
                    setPreviewManuallyHidden(false);
                    setShowDatasetPreview(true);
                  }}
              >
                Show data preview
              </Button>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-xs px-2"
                    onClick={() => {
                      setPreviewManuallyHidden(true);
                      setShowDatasetPreview(false);
                    }}
                  >
                    Hide data preview
                  </Button>
                </div>
                <DataPreview
                  data={sampleRows || []}
                  columns={columns}
                  numericColumns={numericColumns}
                  dateColumns={dateColumns}
                  temporalDisplayGrainsByColumn={temporalDisplayGrainsByColumn}
                  temporalFacetColumns={temporalFacetColumns}
                  totalRows={totalRows}
                  totalColumns={totalColumns}
                  defaultExpanded={!(hasAggPreview || hasAggSummary)}
                  preEnrichmentSnapshot={preEnrichmentPreviewSnapshot}
                  postEnrichmentSnapshot={postEnrichmentPreviewSnapshot}
                />
              </div>
            )}
          </div>
        )}

        {!isUser && showDatasetEnrichmentLoader && (
          <div className="mt-3">
            <DatasetEnrichmentLoader
              totalRows={totalRows ?? 0}
              totalColumns={totalColumns ?? 0}
              enrichmentPhase={enrichmentPhase}
              enrichmentStep={enrichmentStep}
              uploadProgress={uploadProgress}
              startedAtMs={enrichmentStartedAtMs ?? null}
              inline
            />
          </div>
        )}

        {!isUser && (
          <>
            {/* Show existing charts */}
            {message.charts && message.charts.length > 0 && (
              <div className={`mt-3 grid gap-4 ${
                message.charts.length === 1 
                  ? 'grid-cols-1' 
                  : 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'
              }`}>
                {message.charts.map((chart, idx) => {
                  // Check if this correlation chart is still loading based on thinking steps
                  const isCorrelationChart = chart.type === 'scatter' && (chart as any)._isCorrelationChart;
                  const chartLoadingState = isCorrelationChart && thinkingSteps 
                    ? extractCorrelationChartLoadingState(chart, thinkingSteps, idx)
                    : { isLoading: false };
                  
                  return (
                    <Suspense 
                      key={idx}
                      fallback={
                        <div className="flex h-[250px] w-full items-center justify-center rounded-lg border border-border/80 bg-muted/30">
                          <Skeleton className="h-full w-full" />
                        </div>
                      }
                    >
                      <ChartRenderer 
                        chart={chart} 
                        index={idx}
                        isSingleChart={message.charts!.length === 1}
                        enableFilters
                        isLoading={chartLoadingState.isLoading}
                        loadingProgress={chartLoadingState.progress}
                      />
                    </Suspense>
                  );
                })}
              </div>
            )}
            
            {/* Show loading placeholders for correlation charts being generated */}
            {thinkingSteps && thinkingSteps.some(step => 
              step.status === 'active' && 
              (step.step.toLowerCase().includes('correlation') || step.step.toLowerCase().includes('computing'))
            ) && (!message.charts || message.charts.length === 0) && (
              <div className="mt-3 grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
                {[0, 1, 2].map((idx) => {
                  const correlationSteps = thinkingSteps.filter(step => 
                    step.step.toLowerCase().includes('correlation') || 
                    step.step.toLowerCase().includes('computing')
                  );
                  const activeStep = correlationSteps.find(step => step.status === 'active');
                  
                  let progress: { processed: number; total: number; message?: string } | undefined;
                  if (activeStep?.details) {
                    const match = activeStep.details.match(/(\d+(?:,\d+)*)\s*\/\s*(\d+(?:,\d+)*)\s*rows/i);
                    if (match) {
                      const processed = parseInt(match[1].replace(/,/g, ''), 10);
                      const total = parseInt(match[2].replace(/,/g, ''), 10);
                      if (!isNaN(processed) && !isNaN(total)) {
                        progress = {
                          processed,
                          total,
                          message: activeStep.step,
                        };
                      }
                    }
                  }
                  
                  // Create placeholder chart for loading
                  const placeholderChart: ChartSpec = {
                    type: 'scatter',
                    title: `Correlation Chart ${idx + 1}`,
                    x: 'x',
                    y: 'y',
                    xLabel: 'x',
                    yLabel: 'y',
                    data: [],
                    _isCorrelationChart: true,
                  };
                  
                  return (
                    <Suspense 
                      key={`loading-${idx}`}
                      fallback={
                        <div className="flex h-[250px] w-full items-center justify-center rounded-lg border border-border/80 bg-muted/30">
                          <Skeleton className="h-full w-full" />
                        </div>
                      }
                    >
                      <ChartRenderer 
                        chart={placeholderChart}
                        index={idx}
                        enableFilters={false}
                        isLoading={true}
                        loadingProgress={progress || { processed: 0, total: 0, message: activeStep?.step }}
                      />
                    </Suspense>
                  );
                })}
              </div>
            )}
          </>
        )}

        {!isUser && message.insights && message.insights.length > 0 && (
          <div className="mt-3">
            <InsightCard insights={message.insights} />
          </div>
        )}
      </div>

      {isUser && (
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary flex items-center justify-center shadow-sm">
          <User className="w-4 h-4 text-primary-foreground" />
        </div>
      )}
    </div>
  );
});

MessageBubbleComponent.displayName = 'MessageBubble';

// Memoize the component to prevent unnecessary re-renders
// Only re-render if props actually change
export const MessageBubble = memo(MessageBubbleComponent, (prevProps, nextProps) => {
  // Custom comparison function for better performance
  return (
    prevProps.message.timestamp === nextProps.message.timestamp &&
    prevProps.message.content === nextProps.message.content &&
    prevProps.message.role === nextProps.message.role &&
    prevProps.message.userEmail === nextProps.message.userEmail &&
    prevProps.isLastUserMessage === nextProps.isLastUserMessage &&
    prevProps.messageIndex === nextProps.messageIndex &&
    prevProps.sessionId === nextProps.sessionId &&
    prevProps.onEditMessage === nextProps.onEditMessage &&
    // Compare thinking steps by length and content
    (prevProps.thinkingSteps?.length ?? 0) === (nextProps.thinkingSteps?.length ?? 0) &&
    (prevProps.thinkingPanelSteps?.length ?? 0) ===
      (nextProps.thinkingPanelSteps?.length ?? 0) &&
    (prevProps.thinkingPanelWorkbench?.length ?? 0) ===
      (nextProps.thinkingPanelWorkbench?.length ?? 0) &&
    prevProps.thinkingPanelStreaming === nextProps.thinkingPanelStreaming &&
    // Compare charts by length
    (prevProps.message.charts?.length ?? 0) === (nextProps.message.charts?.length ?? 0) &&
    (prevProps.message.insights?.length ?? 0) === (nextProps.message.insights?.length ?? 0) &&
    tablePayloadSignature(
      (prevProps.message as Message & { preview?: unknown[] }).preview
    ) ===
      tablePayloadSignature(
        (nextProps.message as Message & { preview?: unknown[] }).preview
      ) &&
    tablePayloadSignature(
      (prevProps.message as Message & { summary?: unknown[] }).summary
    ) ===
      tablePayloadSignature(
        (nextProps.message as Message & { summary?: unknown[] }).summary
      ) &&
    JSON.stringify(prevProps.message.pivotDefaults ?? null) ===
      JSON.stringify(nextProps.message.pivotDefaults ?? null) &&
    (prevProps.message.thinkingBefore?.steps?.length ?? 0) ===
      (nextProps.message.thinkingBefore?.steps?.length ?? 0) &&
    (prevProps.message.thinkingBefore?.workbench?.length ?? 0) ===
      (nextProps.message.thinkingBefore?.workbench?.length ?? 0) &&
    prevProps.message.isIntermediate === nextProps.message.isIntermediate &&
    prevProps.message.intermediateInsight === nextProps.message.intermediateInsight &&
    (prevProps.message.suggestedQuestions?.length ?? 0) ===
      (nextProps.message.suggestedQuestions?.length ?? 0) &&
    prevProps.onSuggestedQuestionClick === nextProps.onSuggestedQuestionClick &&
    prevProps.preEnrichmentPreviewSnapshot === nextProps.preEnrichmentPreviewSnapshot &&
    prevProps.postEnrichmentPreviewSnapshot === nextProps.postEnrichmentPreviewSnapshot &&
    prevProps.sampleRows === nextProps.sampleRows &&
    prevProps.columns === nextProps.columns &&
    prevProps.temporalFacetColumns === nextProps.temporalFacetColumns &&
    prevProps.onAppendAssistantChart === nextProps.onAppendAssistantChart
  );
});
