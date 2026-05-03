import { forwardRef, useState, useMemo, memo, lazy, Suspense, useEffect } from 'react';
import {
  AgentWorkbenchEntry,
  Message,
  ThinkingStep,
  ChartSpec,
  TemporalDisplayGrain,
  type TemporalFacetColumnMeta,
} from '@/shared/schema';
import { User, Bot, Edit2, Check, X as XIcon, Info } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { InsightCard } from './InsightCard';
import { DashboardDraftCard } from './DashboardDraftCard';
import { BuildDashboardCallout } from './BuildDashboardCallout';
import { FeedbackButtons } from './FeedbackButtons';
import { AnswerCard } from './AnswerCard';
import { MessageActionsBar } from './MessageActionsBar';
import { SourcePillRow } from './SourcePillRow';
import { StreamingIndicator } from './StreamingIndicator';
import { AnalyticalDashboardResponse } from './AnalyticalDashboardResponse';
import { MagnitudesRow, type MagnitudeItem } from './MagnitudesRow';
import { Settle } from '@/components/ui/motion';
import { DataPreview } from './DataPreview';
import { DataPreviewTable, DataSummaryTable } from './DataPreviewTable';
import { ThinkingPanel } from './ThinkingPanel';
import { StepByStepInsightsPanel } from './StepByStepInsightsPanel';
import { InvestigationSummaryCard } from './InvestigationSummaryCard';
import { PriorInvestigationsBanner } from './PriorInvestigationsBanner';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
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
import { splitAssistantFollowUpPrompts } from '@/lib/chat/splitAssistantFollowUpPrompts';
import { dashboardsApi } from '@/lib/api/dashboards';
import { useLocation } from 'wouter';
import { userMessageHasReportIntent } from '@/lib/reportIntent';

// Lazy load ChartRenderer to reduce initial bundle size (includes heavy recharts dependency)
const ChartRenderer = lazy(() => import('./ChartRenderer').then(module => ({ default: module.ChartRenderer })));
// WC9 · v1→v2 shim sits inside InteractiveChartCard; chat charts route through
// the toolbar wrapper so users can switch mark / stacked-grouped without a roundtrip.
import { InteractiveChartCard } from '@/components/charts/InteractiveChartCard';

const PREVIEW_SIGNATURE_SLICE = 3500;

/**
 * W6 · Detect a legacy server-side fallback dump that ever slips past the
 * server's W3 clean renderer. Server should never emit this; the client
 * guard exists purely to avoid a regression rendering raw observation
 * prefixes as primary answer prose.
 */
function isLegacySynthesisDump(content: string): boolean {
  if (!content) return false;
  const head = content.trimStart().slice(0, 30).toLowerCase();
  return head.startsWith('summary from tool output:');
}

interface SynthesisFallbackCalloutProps {
  content: string;
  messageId?: string;
}

function SynthesisFallbackCallout({
  content,
  messageId,
}: SynthesisFallbackCalloutProps) {
  useEffect(() => {
    // Surfacing this in console so client telemetry can pick it up; the
    // server-side W3 renderer is the real fix, this branch is a tripwire.
    console.warn(
      '[MessageBubble] Legacy synthesis dump reached client',
      { messageId }
    );
  }, [messageId]);
  return (
    <div
      className="rounded-md border border-border bg-muted/40 p-3 text-[14px] leading-[22px] text-muted-foreground"
      data-testid="synthesis-fallback-callout"
    >
      <div className="mb-1 flex items-center gap-1.5 text-[13px] font-medium text-foreground">
        <Info className="h-3.5 w-3.5" />
        <span>Synthesis fallback</span>
      </div>
      <div className="whitespace-pre-wrap">
        <MarkdownRenderer content={content} />
      </div>
    </div>
  );
}

function stripAgentChartMeta(chart: ChartSpec): ChartSpec {
  const c = chart as ChartSpec & {
    _agentEvidenceRef?: string;
    _agentTurnId?: string;
  };
  const { _agentEvidenceRef: _e, _agentTurnId: _t, ...rest } = c;
  return rest as ChartSpec;
}

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
  /** WF9 — per-column currency tag (from dataSummary.columns[].currency). */
  currencyByColumn?: Record<string, import('@/shared/schema').ColumnCurrency>;
  /** WF9 — wide-format transform metadata (from dataSummary.wideFormatTransform). */
  wideFormatTransform?: import('@/shared/schema').WideFormatTransform;
  /** H6 — declared dimension hierarchies (from sessionAnalysisContext.dataset.dimensionHierarchies). */
  dimensionHierarchies?: import('@/shared/schema').DimensionHierarchy[];
  /** EU1 — when present, hierarchies banner shows ✕ Remove buttons. */
  hierarchyEditSessionId?: string;
  /** EU1 — callback after a successful hierarchy remove. */
  onHierarchiesChange?: (
    next: import('@/shared/schema').DimensionHierarchy[],
  ) => void;
  /** Show dataset columns/preview only when explicitly requested by the user. */
  allowDatasetPreviewInAnswer?: boolean;
  /** Auto-show pivot/table section for aggregated tabular assistant outputs. */
  allowPivotAutoShow?: boolean;
  onAppendAssistantChart?: (chart: ChartSpec) => void;
  /** Last user message in this turn (for “save report dashboard”). */
  precedingUserQuestion?: string;
  /** Upload job: show live Thinking under data preview while server preview is loading. */
  uploadPreviewThinking?: {
    active: true;
    title: string;
    details?: string;
  };
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
  currencyByColumn,
  wideFormatTransform,
  dimensionHierarchies,
  hierarchyEditSessionId,
  onHierarchiesChange,
  allowDatasetPreviewInAnswer = false,
  allowPivotAutoShow = false,
  onAppendAssistantChart,
  precedingUserQuestion,
  uploadPreviewThinking,
}, ref) => {
  // Derive per-sub-question feedback state from the hydrated feedbackDetails
  // so each spawned-question row in the (archived) ThinkingPanel can show the
  // persisted thumbs state on reload. Cheap to recompute on render — the array
  // is at most 16 entries (messageSchema.spawnedQuestions cap).
  const spawnedQuestionFeedbackMap = useMemo(() => {
    const details = (
      message as Message & {
        feedbackDetails?: Array<{
          target: { type: "answer" | "subanswer" | "pivot"; id: string };
          feedback: "up" | "down" | "none";
          comment?: string | null;
        }>;
      }
    ).feedbackDetails;
    if (!details?.length) return undefined;
    const map: Record<string, { feedback: "up" | "down" | "none"; comment?: string }> = {};
    for (const d of details) {
      if (d.target.type !== "subanswer") continue;
      map[d.target.id] = {
        feedback: d.feedback,
        comment: d.comment ?? undefined,
      };
    }
    return Object.keys(map).length ? map : undefined;
  }, [message]);

  // Same derivation for the pivot target, used by DataPreviewTable's thumbs row.
  const pivotFeedback = useMemo(() => {
    const details = (
      message as Message & {
        feedbackDetails?: Array<{
          target: { type: "answer" | "subanswer" | "pivot"; id: string };
          feedback: "up" | "down" | "none";
          comment?: string | null;
        }>;
      }
    ).feedbackDetails;
    if (!details?.length) return undefined;
    const hit = details.find((d) => d.target.type === "pivot");
    if (!hit) return undefined;
    return { feedback: hit.feedback, comment: hit.comment ?? undefined };
  }, [message]);

  const [savingReport, setSavingReport] = useState(false);
  const { toast } = useToast();
  const [, setLocation] = useLocation();

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
    !isPreviewSystemMessage &&
    !(
      message.isIntermediate &&
      (!String(displayContent).trim() || String(displayContent).trim() === "Preliminary results")
    );

  const isDashboardMode =
    !isUser &&
    !message.isIntermediate &&
    (message.charts?.length ?? 0) >= 1 &&
    !isPreviewSystemMessage &&
    !isEnrichmentSystemMessage;

  // Phase-2 "offer" surface: server emitted a dashboardDraft but did NOT
  // auto-persist it (multi-chart turn without an explicit ask). When
  // `createdDashboardId` is set, the explicit-ask path already created the
  // dashboard server-side — render `DashboardDraftCard` (post-create state)
  // instead of the offer button.
  const showBuildDashboardOffer =
    !isUser &&
    !message.isIntermediate &&
    Boolean((message as Message & { dashboardDraft?: unknown }).dashboardDraft) &&
    !(message as Message & { createdDashboardId?: string }).createdDashboardId;

  const assistantMarkdownParts = useMemo(() => {
    if (isUser || !displayContent) {
      return { markdownBody: displayContent, followUpChips: [] as string[] };
    }
    const split = splitAssistantFollowUpPrompts(displayContent);
    const structured = (message.followUpPrompts ?? []).map((s) => s.trim()).filter(Boolean);
    const followUpChips = (structured.length > 0 ? structured : split.extractedPrompts).slice(0, 3);
    const markdownBody = split.hadYouMightTrySection ? split.mainMarkdown : displayContent.trimEnd();
    return { markdownBody, followUpChips };
  }, [isUser, displayContent, message.followUpPrompts]);
  
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
            <>
              {/* W10 · elapsed-time chip during live streaming so the user
                  can tell long correlation runs from a stuck request. */}
              {thinkingPanelStreaming && (
                <div className="mt-2">
                  <StreamingIndicator
                    running
                    label={
                      thinkingPanelSteps?.find((s) => s.status === "active")?.step
                    }
                  />
                </div>
              )}
              <ThinkingPanel
                variant="archived"
                steps={thinkingPanelSteps ?? []}
                workbench={thinkingPanelWorkbench ?? []}
                isStreaming={!!thinkingPanelStreaming}
                spawnedSubQuestions={
                  (message as Message & { spawnedQuestions?: { id: string; question: string }[] }).spawnedQuestions
                }
                sessionId={sessionId ?? null}
                turnId={(message.agentTrace as { turnId?: string } | undefined)?.turnId ?? null}
                spawnedQuestionFeedback={spawnedQuestionFeedbackMap}
              />
            </>
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
              spawnedSubQuestions={
                (message as Message & { spawnedQuestions?: { id: string; question: string }[] }).spawnedQuestions
              }
              sessionId={sessionId ?? null}
              turnId={(message.agentTrace as { turnId?: string } | undefined)?.turnId ?? null}
              spawnedQuestionFeedback={spawnedQuestionFeedbackMap}
            />
          )}

        {/* Phase-2 · "Build Dashboard" offer below the Thinking bubble.
            Slot A — paired with the bottom-of-answer slot at L820+. Renders
            only on the offer track (no `createdDashboardId`). */}
        {showBuildDashboardOffer && (
          <BuildDashboardCallout
            draft={(message as Message & { dashboardDraft?: unknown }).dashboardDraft}
            sessionId={sessionId ?? undefined}
            variant="above-answer"
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
              pivotInsight={
                !message.isIntermediate ? message.insights?.[0]?.text : undefined
              }
              userQuestion={precedingUserQuestion}
              initialPivotState={message.pivotState}
              messageTimestamp={message.timestamp}
              streamingActive={message.isIntermediate}
              onSuggestedQuestionClick={onSuggestedQuestionClick}
              feedbackTurnId={(message.agentTrace as { turnId?: string } | undefined)?.turnId ?? null}
              pivotFeedbackInitial={pivotFeedback}
            />
          </div>
        )}

        {!isUser && allowPivotAutoShow && hasAggSummary && (
          <div className="mb-3">
            <DataSummaryTable summary={(message as Message & { summary: unknown[] }).summary} />
          </div>
        )}

        {/* W13 · Investigation summary card. Surfaces hypotheses tested
            (with status), headline findings, and unresolved open questions.
            Default-open so the user immediately sees the analysis was real
            investigation, not a query log. Hidden on intermediate messages
            and when the blackboard digest is empty (descriptive turns). */}
        {!isUser && !message.isIntermediate && (
          <InvestigationSummaryCard summary={message.investigationSummary} />
        )}

        {/* W37 · per-message PriorInvestigationsBanner. Renders the W30
            `priorInvestigationsSnapshot` field — what the agent knew BEFORE
            this turn ran. Only mounts on analytical messages (those with
            an investigationSummary AND at least one snapshot entry) so it
            stays visually subordinate to W13 and avoids noise on chatty
            turns. Default-collapsed; reuses the W26 banner component in
            its W37 mode (per-message snapshot, header label adapts). */}
        {!isUser &&
          !message.isIntermediate &&
          message.investigationSummary &&
          (message.priorInvestigationsSnapshot?.length ?? 0) > 0 && (
            <PriorInvestigationsBanner
              priorInvestigations={message.priorInvestigationsSnapshot}
            />
          )}

        {/* W11 · post-pivot "Step-by-step interpretation" panel. Renders only
            when this message has workbench entries with W10 insight lines.
            Default-collapsed so the answer card stays the primary focus, but
            the user can expand to see what each phase actually contributed. */}
        {!isUser && !message.isIntermediate && (
          <StepByStepInsightsPanel workbench={message.agentWorkbench} />
        )}

        {isDashboardMode ? (
          <AnalyticalDashboardResponse
            message={message}
            sessionId={sessionId}
            precedingUserQuestion={precedingUserQuestion}
            onSuggestedQuestionClick={onSuggestedQuestionClick}
            sampleRows={sampleRows}
            columns={columns}
            numericColumns={numericColumns}
            dateColumns={dateColumns}
            temporalDisplayGrainsByColumn={temporalDisplayGrainsByColumn}
            temporalFacetColumns={temporalFacetColumns}
            thinkingSteps={thinkingSteps}
          />
        ) : showMarkdownBlock ? (
          <Settle
            className="rounded-brand-lg border border-border/60 border-l-4 border-l-primary bg-primary/5 p-6 shadow-elev-1"
            data-testid={`message-content-${message.role}`}
          >
            {/*
              W7 · render structured AnswerCard when the narrator emitted an
              `answerEnvelope`; fall back to the legacy markdown-only block
              otherwise. The supplementaryMarkdown prop carries any narrator
              prose that shouldn't be lost when the envelope provides headlines.
            */}
            {(message as Message & { answerEnvelope?: NonNullable<Message['answerEnvelope']> }).answerEnvelope ? (
              <AnswerCard
                message={message as Message}
                onSuggestedQuestionClick={onSuggestedQuestionClick}
                supplementaryMarkdown={assistantMarkdownParts.markdownBody}
              />
            ) : isLegacySynthesisDump(assistantMarkdownParts.markdownBody) ? (
              // W6 · Defence in depth: server-side W3 replaces the legacy
              // `Summary from tool output:` dump with a clean rendered table,
              // but if a future regression ever lets that prefix slip through
              // we render it as a muted "Synthesis fallback" callout rather
              // than as primary answer prose. Logs a console.warn so it shows
              // up in client telemetry.
              <SynthesisFallbackCallout
                content={assistantMarkdownParts.markdownBody}
                messageId={(message as Message & { id?: string }).id}
              />
            ) : (
              <div className="text-[15px] leading-[24px] text-foreground whitespace-pre-wrap">
                <MarkdownRenderer content={assistantMarkdownParts.markdownBody} />
              </div>
            )}
            {/* UX-3 · Phase-1 magnitudes row — renders nothing when the field is empty. */}
            <MagnitudesRow
              items={
                (message as Message & { magnitudes?: MagnitudeItem[] }).magnitudes
              }
            />
            {assistantMarkdownParts.followUpChips.length > 0 && onSuggestedQuestionClick && (
              <div className="mt-4">
                <p className="text-sm font-semibold text-foreground mb-2">You might try:</p>
                <div className="flex flex-wrap gap-2">
                  {assistantMarkdownParts.followUpChips.map((q, i) => (
                    <Button
                      key={`followup-${i}`}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="text-xs rounded-full h-auto py-1.5 px-3"
                      aria-label={`Use suggestion: ${q}`}
                      onClick={() => onSuggestedQuestionClick(q)}
                    >
                      {q}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            {/* Phase-2 · Slot B (bottom of key insights / answer card). The
                offer button (multi-chart, no explicit ask) and the post-create
                surface (explicit ask path) are mutually exclusive. */}
            {showBuildDashboardOffer ? (
              <BuildDashboardCallout
                draft={(message as Message & { dashboardDraft?: unknown }).dashboardDraft}
                sessionId={sessionId ?? undefined}
                variant="below-answer"
              />
            ) : (message as Message & { createdDashboardId?: string })
                .createdDashboardId ? (
              <DashboardDraftCard
                draft={(message as Message & { dashboardDraft?: unknown }).dashboardDraft}
                sessionId={sessionId ?? undefined}
                createdDashboardId={
                  (message as Message & { createdDashboardId?: string })
                    .createdDashboardId
                }
              />
            ) : null}
            {/* W7 · message-level actions (Copy now; Regenerate added in W9). */}
            <MessageActionsBar
              message={message}
              precedingUserQuestion={precedingUserQuestion ?? undefined}
            />
            {/* W5.5b · thumbs up/down feeds the cache invalidation + golden corpus.
                Only rendered when we have the turnId from the agent trace.
                Feedback `target={{type:"answer",id:"answer"}}` is implicit (omitted)
                so the legacy answer-level top-level fields stay populated. */}
            {sessionId &&
              (message.agentTrace as { turnId?: string } | undefined)?.turnId && (
                <FeedbackButtons
                  sessionId={sessionId}
                  turnId={(message.agentTrace as { turnId: string }).turnId}
                  initial={
                    (message as Message & { feedback?: "up" | "down" | "none" }).feedback ?? "none"
                  }
                  initialComment={
                    (message as Message & { feedbackComment?: string }).feedbackComment ?? ""
                  }
                  target={{ type: "answer", id: "answer" }}
                />
              )}
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
                      aria-label={`Use suggestion: ${q}`}
                      onClick={() => onSuggestedQuestionClick(q)}
                    >
                      {q}
                    </Button>
                  ))}
                </div>
              )}
          </Settle>
        ) : null}

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
                  currencyByColumn={currencyByColumn}
                  wideFormatTransform={wideFormatTransform}
                  dimensionHierarchies={dimensionHierarchies}
                  sessionIdForHierarchyEdit={hierarchyEditSessionId}
                  onHierarchiesChange={onHierarchiesChange}
                />
                {uploadPreviewThinking?.active && (
                  <div className="mt-2">
                    <ThinkingPanel
                      variant="live"
                      isStreaming
                      steps={[
                        {
                          step: uploadPreviewThinking.title,
                          status: 'active',
                          timestamp: message.timestamp,
                          ...(uploadPreviewThinking.details
                            ? { details: uploadPreviewThinking.details }
                            : {}),
                        },
                      ]}
                      workbench={[]}
                    />
                  </div>
                )}
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

        {!isUser && !isDashboardMode && (
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
                    <div key={idx} className="flex flex-col gap-1.5">
                      <Suspense
                        fallback={
                          <div className="flex h-[250px] w-full items-center justify-center rounded-lg border border-border/80 bg-muted/30">
                            <Skeleton className="h-full w-full" />
                          </div>
                        }
                      >
                        <InteractiveChartCard
                          chart={chart}
                          keyInsightSessionId={sessionId ?? null}
                          renderLegacy={(localSpec) => (
                            <ChartRenderer
                              chart={localSpec}
                              index={idx}
                              isSingleChart={message.charts!.length === 1}
                              enableFilters
                              isLoading={chartLoadingState.isLoading}
                              loadingProgress={chartLoadingState.progress}
                              keyInsightSessionId={sessionId ?? null}
                              onSuggestedQuestionClick={onSuggestedQuestionClick}
                            />
                          )}
                        />
                      </Suspense>
                      {/* W12 · per-chart business commentary — 1–2 sentences
                          framing the chart's metric against the FMCG/Marico
                          domain context. Renders only when the server-side
                          insight generator produced one (gated on enabled
                          domain packs + relevant metric). */}
                      {(chart as { businessCommentary?: string }).businessCommentary && (
                        <p
                          className="rounded-brand-md border border-border/40 bg-muted/30 px-3 py-2 text-[12px] italic leading-snug text-foreground/80"
                          aria-label="Business commentary"
                        >
                          <span className="not-italic font-semibold text-muted-foreground mr-1">
                            Business context:
                          </span>
                          {(chart as { businessCommentary?: string }).businessCommentary}
                        </p>
                      )}
                      {/* W8 · Perplexity-style provenance pill (rows / cols / tools).
                          Renders nothing when the agent didn't emit _agentProvenance. */}
                      <SourcePillRow chart={chart} />
                    </div>
                  );
                })}
              </div>
            )}

            {!isUser &&
              precedingUserQuestion &&
              sessionId &&
              userMessageHasReportIntent(precedingUserQuestion) &&
              (message.charts?.length || (message.content && message.content.length > 80)) && (
                <div className="mt-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={savingReport}
                    onClick={async () => {
                      setSavingReport(true);
                      try {
                        const baseName =
                          precedingUserQuestion.slice(0, 72).trim() || "Analysis report";
                        const charts = (message.charts ?? []).map(stripAgentChartMeta);
                        const d = await dashboardsApi.createFromAnalysis({
                          name: baseName,
                          question: precedingUserQuestion,
                          summaryBody: message.content || "",
                          limitationsBody:
                            "Observational session data only. Segment movements show association, not proven causation. Validate material decisions with additional evidence or experiments.",
                          recommendationsBody: (message.followUpPrompts ?? [])
                            .slice(0, 6)
                            .map((p) => `• ${p}`)
                            .join("\n"),
                          charts,
                        });
                        setLocation(`/dashboard?open=${encodeURIComponent(d.id)}`);
                        toast({
                          title: "Report dashboard created",
                          description: `Opening “${d.name}” on the Dashboard page.`,
                        });
                      } catch (e: any) {
                        toast({
                          title: "Could not create report",
                          description: e?.message || "Try again.",
                          variant: "destructive",
                        });
                      } finally {
                        setSavingReport(false);
                      }
                    }}
                  >
                    {savingReport ? "Saving…" : "Save as report dashboard"}
                  </Button>
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

        {!isUser && !isDashboardMode && !hasAggPreview && message.insights && message.insights.length > 0 && (
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
    JSON.stringify(prevProps.message.followUpPrompts ?? []) ===
      JSON.stringify(nextProps.message.followUpPrompts ?? []) &&
    // Phase 2: re-render when the inline dashboard draft appears/changes.
    Boolean((prevProps.message as { dashboardDraft?: unknown }).dashboardDraft) ===
      Boolean((nextProps.message as { dashboardDraft?: unknown }).dashboardDraft) &&
    // Phase-2 offer → post-create transition: id presence flips
    // showBuildDashboardOffer → false and swaps callout for DashboardDraftCard.
    ((prevProps.message as { createdDashboardId?: string }).createdDashboardId ?? '') ===
      ((nextProps.message as { createdDashboardId?: string }).createdDashboardId ?? '') &&
    // UX-3: re-render when magnitudes arrive (Phase-1 rich envelope).
    JSON.stringify((prevProps.message as { magnitudes?: unknown }).magnitudes ?? null) ===
      JSON.stringify((nextProps.message as { magnitudes?: unknown }).magnitudes ?? null) &&
    prevProps.onSuggestedQuestionClick === nextProps.onSuggestedQuestionClick &&
    prevProps.preEnrichmentPreviewSnapshot === nextProps.preEnrichmentPreviewSnapshot &&
    prevProps.postEnrichmentPreviewSnapshot === nextProps.postEnrichmentPreviewSnapshot &&
    prevProps.sampleRows === nextProps.sampleRows &&
    prevProps.columns === nextProps.columns &&
    prevProps.temporalFacetColumns === nextProps.temporalFacetColumns &&
    prevProps.onAppendAssistantChart === nextProps.onAppendAssistantChart &&
    prevProps.precedingUserQuestion === nextProps.precedingUserQuestion &&
    prevProps.uploadPreviewThinking?.active === nextProps.uploadPreviewThinking?.active &&
    prevProps.uploadPreviewThinking?.title === nextProps.uploadPreviewThinking?.title &&
    prevProps.uploadPreviewThinking?.details === nextProps.uploadPreviewThinking?.details
  );
});
