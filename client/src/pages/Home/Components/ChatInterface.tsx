import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  type AgentWorkbenchEntry,
  Message,
  ThinkingStep,
  TemporalDisplayGrain,
  type TemporalFacetColumnMeta,
} from '@/shared/schema';
import { MessageBubble } from '@/pages/Home/Components/MessageBubble';
import { ThinkingPanel } from '@/pages/Home/Components/ThinkingPanel';
import { ColumnSidebar } from '@/pages/Home/Components/ColumnSidebar';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Send, Upload as UploadIcon, Square, Filter, Loader2, ChevronUp, ChevronDown, FileText } from 'lucide-react';
import { Card } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getUserEmail } from '@/utils/userStorage';
import { useToast } from '@/hooks/use-toast';
import { ChartBuilderDialog } from '@/components/ChartBuilderDialog';
import type { ChartSpec } from '@/shared/schema';
import { FilterDataModal } from '@/components/FilterDataModal';
import { FilterCondition } from '@/components/ColumnFilterDialog';
import { debounce } from '@/lib/debounce';
import type { DatasetEnrichmentPollSnapshot } from '@/lib/api/uploadStatus';
import {
  isDatasetEnrichmentSystemMessage,
  isDatasetPreviewSystemMessage,
} from '@/pages/Home/modules/uploadSystemMessages';
import { useChatSidebarNav } from '@/contexts/ChatSidebarNavContext';
import { computeAllowPivotAutoShow } from '@/pages/Home/lib/chatPivotNav';

type PreviewSnapshot = {
  capturedAt: number;
  rows: Record<string, any>[];
  columns: string[];
  numericColumns: string[];
  dateColumns: string[];
  totalRows: number;
  totalColumns: number;
};

interface ChatInterfaceProps {
  messages: Message[];
  onSendMessage: (message: string) => void;
  onUploadNew: () => void;
  isLoading: boolean;
  onLoadHistory?: () => void;
  canLoadHistory?: boolean;
  loadingHistory?: boolean;
  sampleRows?: Record<string, any>[];
  columns?: string[];
  numericColumns?: string[];
  dateColumns?: string[];
  temporalDisplayGrainsByColumn?: Record<string, TemporalDisplayGrain>;
  temporalFacetColumns?: TemporalFacetColumnMeta[];
  totalRows?: number;
  totalColumns?: number;
  onStopGeneration?: () => void;
  onEditMessage?: (messageIndex: number, newContent: string) => void;
  thinkingSteps?: ThinkingStep[];
  agentWorkbenchLive?: AgentWorkbenchEntry[];
  /** W12: sub-questions spawned during deep investigation (streamed live). */
  spawnedSubQuestions?: string[];
  thinkingTargetTimestamp?: number | null;
  /** Message timestamp after which the live thinking strip is rendered while streaming. */
  thinkingLiveAnchorTimestamp?: number | null;
  aiSuggestions?: string[]; // AI-generated suggestions
  collaborators?: string[]; // List of all collaborators in the session
  sessionId?: string | null; // Session ID for downloading modified datasets
  isReplacingAnalysis?: boolean; // Whether we're replacing the current analysis
  /** Full-screen until first preview rows + summary are available */
  isDatasetPreviewLoading?: boolean;
  /** Non-blocking: LLM enrichment running after preview */
  isDatasetEnriching?: boolean;
  enrichmentPoll?: DatasetEnrichmentPollSnapshot | null;
  enrichmentStartedAtMs?: number | null;
  onOpenDataSummary?: () => void; // Callback to open data summary modal
  /** Seed the composer from outside (e.g. Data Summary modal); bump id for each new draft */
  externalComposerDraft?: { text: string; id: number } | null;
  onExternalComposerDraftConsumed?: () => void;
  preEnrichmentPreviewSnapshot?: PreviewSnapshot | null;
  postEnrichmentPreviewSnapshot?: PreviewSnapshot | null;
  previewSource?: 'none' | 'local' | 'server';
  localPreviewParseStatus?: 'full' | 'headers_only' | 'failed';
  uploadStartError?: string | null;
  /** Append an assistant message that only adds a chart (Chart Builder). */
  onAppendAssistantChart?: (chart: ChartSpec) => void;
}

// Suggested questions are server-derived only (no hardcoded fallbacks).
const getSuggestions = (messages: Message[], aiSuggestions?: string[]) => {
  const first = messages[0];
  if (first?.role === 'assistant' && first.suggestedQuestions && first.suggestedQuestions.length > 0) {
    return first.suggestedQuestions;
  }
  if (aiSuggestions && aiSuggestions.length > 0) {
    return aiSuggestions;
  }
  return [];
};

function userExplicitlyAskedForColumnsOrPreview(text: string): boolean {
  const q = String(text || '').toLowerCase();
  return (
    /\b(columns?|column names?|schema|field list|show fields)\b/.test(q) ||
    /\b(preview|sample rows?|show rows?|show data|data preview)\b/.test(q)
  );
}

export function ChatInterface({ 
  messages, 
  onSendMessage, 
  onUploadNew, 
  isLoading, 
  onLoadHistory,
  canLoadHistory = false,
  loadingHistory = false,
  sampleRows, 
  columns,
  numericColumns,
  dateColumns,
  temporalDisplayGrainsByColumn = {},
  temporalFacetColumns = [],
  totalRows,
  totalColumns,
  onStopGeneration,
  onEditMessage,
  thinkingSteps,
  agentWorkbenchLive = [],
  spawnedSubQuestions = [],
  thinkingTargetTimestamp,
  thinkingLiveAnchorTimestamp = null,
  aiSuggestions,
  collaborators: propCollaborators,
  sessionId,
  isReplacingAnalysis = false,
  isDatasetPreviewLoading = false,
  isDatasetEnriching = false,
  enrichmentPoll = null,
  enrichmentStartedAtMs = null,
  onOpenDataSummary,
  externalComposerDraft = null,
  onExternalComposerDraftConsumed,
  preEnrichmentPreviewSnapshot = null,
  postEnrichmentPreviewSnapshot = null,
  previewSource = 'none',
  localPreviewParseStatus = 'full',
  uploadStartError = null,
  onAppendAssistantChart,
}: ChatInterfaceProps) {
  const { scrollRequest, clearPivotScrollRequest } = useChatSidebarNav();
  const [filterModalOpen, setFilterModalOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [selectedCollaborator, setSelectedCollaborator] = useState<string>('all');
  const [showScrollToTop, setShowScrollToTop] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const { toast } = useToast();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingComposerCaretRef = useRef<number | null>(null);
  const lastExternalComposerDraftIdRef = useRef<number | null>(null);
  const lastMessageRef = useRef<HTMLDivElement | null>(null);
  const previousLastTimestampRef = useRef<number | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [mentionState, setMentionState] = useState<{
    active: boolean;
    query: string;
    start: number | null;
    options: string[];
    selectedIndex: number;
  }>({
    active: false,
    query: '',
    start: null,
    options: [],
    selectedIndex: 0
  });

  const currentUserEmail = getUserEmail()?.toLowerCase();

  // Get all collaborators: from prop, or extract from messages, and always include current user
  const collaborators = useMemo(() => {
    const collaboratorSet = new Set<string>();
    
    // Add collaborators from prop (session data)
    if (propCollaborators && propCollaborators.length > 0) {
      propCollaborators.forEach((email) => {
        if (email) collaboratorSet.add(email.toLowerCase());
      });
    }
    
    // Also extract from messages (in case some collaborators haven't sent messages yet)
    messages.forEach((message) => {
      if (message.role === 'user' && message.userEmail) {
        collaboratorSet.add(message.userEmail.toLowerCase());
      }
    });
    
    // Always include current user
    if (currentUserEmail) {
      collaboratorSet.add(currentUserEmail);
    }
    
    return Array.from(collaboratorSet).sort();
  }, [propCollaborators, messages, currentUserEmail]);

  // Handle filter change with toast notification
  const handleFilterChange = (value: string) => {
    setSelectedCollaborator(value);
    const displayName = value === 'all' 
      ? 'All Messages' 
      : collaborators.find(c => c.toLowerCase() === value.toLowerCase())?.split('@')[0] || value.split('@')[0];
    
    toast({
      title: "Filter applied",
      description: `Showing messages from ${displayName}`,
    });
  };

  // Filter messages based on selected collaborator
  const filteredMessages = useMemo(() => {
    if (selectedCollaborator === 'all') {
      return messages;
    }
    return messages.filter((message) => {
      // Always show assistant messages
      if (message.role === 'assistant') {
        return true;
      }
      // For user messages, filter by selected collaborator
      return message.userEmail?.toLowerCase() === selectedCollaborator.toLowerCase();
    });
  }, [messages, selectedCollaborator]);

  // Create a map for quick lookup of original indices
  const messageIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    messages.forEach((message, index) => {
      const key = `${message.timestamp}-${message.role}`;
      map.set(key, index);
    });
    return map;
  }, [messages]);

  const previewAnchorKey = useMemo(() => {
    const previewMsg = filteredMessages.find(isDatasetPreviewSystemMessage);
    if (previewMsg) return `${previewMsg.timestamp}-${previewMsg.role}`;
    const firstAssistant = filteredMessages.find(
      (m) => m.role === 'assistant' && !isDatasetEnrichmentSystemMessage(m)
    );
    if (firstAssistant) return `${firstAssistant.timestamp}-${firstAssistant.role}`;
    return null;
  }, [filteredMessages]);

  // Memoize suggestions to avoid recalculating on every render
  const suggestions = useMemo(() => {
    return getSuggestions(messages, aiSuggestions);
  }, [messages, aiSuggestions]);
  const canShowStarterSuggestions =
    !isDatasetPreviewLoading &&
    !isDatasetEnriching &&
    suggestions.length > 0 &&
    (messages.length === 0 || (messages.length === 1 && messages[0].role === 'assistant'));

  useEffect(() => {
    if (!filteredMessages.length || !lastMessageRef.current) return;

    const lastMessage = filteredMessages[filteredMessages.length - 1];
    if (!lastMessage) return;

    if (previousLastTimestampRef.current === lastMessage.timestamp) {
      return;
    }

    const behavior: ScrollBehavior =
      previousLastTimestampRef.current === null ? 'auto' : 'smooth';

    lastMessageRef.current.scrollIntoView({
      behavior,
      block: lastMessage.role === 'assistant' ? 'start' : 'end'
    });

    previousLastTimestampRef.current = lastMessage.timestamp;
  }, [filteredMessages]);

  useEffect(() => {
    if (isLoading && thinkingSteps && thinkingSteps.length > 0 && lastMessageRef.current) {
      lastMessageRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    }
  }, [thinkingSteps, isLoading]);

  // Handle scroll position tracking
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const isNearTop = scrollTop < 100;
      const isNearBottom = scrollTop + clientHeight >= scrollHeight - 100;
      
      setShowScrollToTop(!isNearTop && scrollHeight > clientHeight);
      setShowScrollToBottom(!isNearBottom && scrollHeight > clientHeight);
    };

    container.addEventListener('scroll', handleScroll);
    // Check initial state
    handleScroll();

    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [filteredMessages]);

  useEffect(() => {
    if (!scrollRequest) return;
    const { id } = scrollRequest;
    const frame = requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      clearPivotScrollRequest();
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollRequest, clearPivotScrollRequest]);

  const scrollToTop = () => {
    messagesContainerRef.current?.scrollTo({
      top: 0,
      behavior: 'smooth',
    });
  };

  const scrollToBottom = () => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTo({
        top: messagesContainerRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  };

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue.trim() && !isLoading) {
      onSendMessage(inputValue.trim());
      setInputValue('');
      inputRef.current?.focus();
    }
  }, [inputValue, isLoading, onSendMessage]);

  const handleFilterApply = useCallback((condition: FilterCondition) => {
    // Build filter message
    let filterMessage = 'filter data where ';
    
    if (condition.operator === 'between') {
      filterMessage += `${condition.column} is between ${condition.value} and ${condition.value2}`;
    } else if (condition.operator === 'in') {
      const valuesStr = condition.values?.map(v => `"${v}"`).join(', ') || '';
      filterMessage += `${condition.column} is in [${valuesStr}]`;
    } else if (condition.operator === 'contains') {
      filterMessage += `${condition.column} contains "${condition.value}"`;
    } else if (condition.operator === 'startsWith') {
      filterMessage += `${condition.column} starts with "${condition.value}"`;
    } else if (condition.operator === 'endsWith') {
      filterMessage += `${condition.column} ends with "${condition.value}"`;
    } else {
      filterMessage += `${condition.column} ${condition.operator} ${condition.value}`;
    }

    // Close modal and send filter message
    setFilterModalOpen(false);
    onSendMessage(filterMessage);
  }, [onSendMessage]);

  // Debounced mention state update function
  const updateMentionStateInternal = useCallback(
    (value: string, selectionStart: number | null) => {
      if (selectionStart === null) {
        setMentionState(prev => ({
          ...prev,
          active: false,
          query: '',
          start: null,
          options: [],
          selectedIndex: 0
        }));
        return;
      }

      const textUntilCaret = value.slice(0, selectionStart);
      const mentionMatch = textUntilCaret.match(/@([A-Za-z0-9 _().%-]*)$/);
      const availableColumns = columns ?? [];

      if (mentionMatch && availableColumns.length > 0) {
        const query = mentionMatch[1];
        const start = selectionStart - mentionMatch[0].length;
        const normalizedQuery = query.trim().toLowerCase();
        
        // Use a more efficient filter - only filter if query is not empty
        const options = normalizedQuery === '' 
          ? availableColumns 
          : availableColumns.filter(column =>
              column.toLowerCase().includes(normalizedQuery)
            );

        setMentionState(prev => ({
          active: options.length > 0,
          query,
          start,
          options,
          selectedIndex: options.length > 0 ? Math.min(prev.selectedIndex, options.length - 1) : 0
        }));
      } else {
        setMentionState(prev => ({
          ...prev,
          active: false,
          query: '',
          start: null,
          options: [],
          selectedIndex: 0
        }));
      }
    },
    [columns]
  );

  // Create debounced version (50ms delay for better performance)
  const updateMentionState = useMemo(
    () => debounce(updateMentionStateInternal, 50),
    [updateMentionStateInternal]
  );

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const { value, selectionStart } = e.target;
    setInputValue(value);
    // Update mention state with debouncing
    updateMentionState(value, selectionStart);
  }, [updateMentionState]);

  const selectMention = useCallback(
    (column: string) => {
      const textarea = inputRef.current;
      if (!textarea) return;

      const selectionStart = textarea.selectionStart ?? inputValue.length;
      const selectionEnd = textarea.selectionEnd ?? selectionStart;
      const mentionStart = mentionState.start ?? selectionStart;
      const currentValue = textarea.value;
      const before = currentValue.slice(0, mentionStart);
      const after = currentValue.slice(selectionEnd);
      // Keep @ prefix so the server treats composer mentions as explicit column picks.
      const insertion = `@${column} `;
      const nextValue = `${before}${insertion}${after}`;
      const nextCaretPosition = before.length + insertion.length;

      setInputValue(nextValue);
      setMentionState({
        active: false,
        query: '',
        start: null,
        options: [],
        selectedIndex: 0
      });

      // Use setTimeout instead of requestAnimationFrame for better performance
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(nextCaretPosition, nextCaretPosition);
        updateMentionState(nextValue, nextCaretPosition);
      }, 0);
    },
    [inputValue.length, mentionState.start, updateMentionState]
  );

  const applySuggestionToComposer = useCallback(
    (suggestion: string) => {
      const trimmed = suggestion.trim();
      if (!trimmed) return;

      setInputValue(() => {
        pendingComposerCaretRef.current = trimmed.length;
        return trimmed;
      });

      setTimeout(() => {
        const len = pendingComposerCaretRef.current;
        pendingComposerCaretRef.current = null;
        if (len == null) return;
        const el = inputRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(len, len);
          updateMentionState(el.value, len);
        }
      }, 0);
    },
    [updateMentionState]
  );

  useEffect(() => {
    const draft = externalComposerDraft;
    if (!draft) return;
    if (lastExternalComposerDraftIdRef.current === draft.id) {
      onExternalComposerDraftConsumed?.();
      return;
    }
    lastExternalComposerDraftIdRef.current = draft.id;
    applySuggestionToComposer(draft.text);
    onExternalComposerDraftConsumed?.();
  }, [externalComposerDraft, applySuggestionToComposer, onExternalComposerDraftConsumed]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionState.active && mentionState.options.length > 0) {
      if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault();
        setMentionState(prev => ({
          ...prev,
          selectedIndex: (prev.selectedIndex + 1) % prev.options.length
        }));
        return;
      }

      if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
        e.preventDefault();
        setMentionState(prev => ({
          ...prev,
          selectedIndex: (prev.selectedIndex - 1 + prev.options.length) % prev.options.length
        }));
        return;
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const selectedColumn =
          mentionState.options[mentionState.selectedIndex] ?? mentionState.options[0];
        if (selectedColumn) {
          selectMention(selectedColumn);
        }
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionState(prev => ({
          ...prev,
          active: false,
          query: '',
          start: null,
          options: [],
          selectedIndex: 0
        }));
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (inputValue.trim() && !isLoading) {
        onSendMessage(inputValue.trim());
        setInputValue('');
        // Use setTimeout instead of requestAnimationFrame for better performance
        setTimeout(() => inputRef.current?.focus(), 0);
      }
      return;
    }

    // Only update mention state if not already handled above
    // Remove the requestAnimationFrame as it's unnecessary and can cause lag
    const textarea = inputRef.current;
    if (textarea && !mentionState.active) {
      updateMentionState(textarea.value, textarea.selectionStart);
    }
  }, [mentionState.active, mentionState.options, mentionState.selectedIndex, inputValue, isLoading, onSendMessage, selectMention, updateMentionState]);

  const handleTextareaBlur = useCallback(() => {
    setMentionState(prev => ({
      ...prev,
      active: false,
      query: '',
      start: null,
      options: [],
      selectedIndex: 0
    }));
  }, []);

  // Sidebar hover state
  const [isColumnSidebarOpen, setIsColumnSidebarOpen] = useState(false);

  // Handle column click - insert column name into input
  const handleColumnClick = useCallback((column: string) => {
    const textarea = inputRef.current;
    if (textarea) {
      const currentValue = textarea.value;
      const selectionStart = textarea.selectionStart ?? currentValue.length;
      const selectionEnd = textarea.selectionEnd ?? selectionStart;
      
      const before = currentValue.slice(0, selectionStart);
      const after = currentValue.slice(selectionEnd);
      const insertion = `@${column} `;
      const nextValue = `${before}${insertion}${after}`;
      const nextCaretPosition = before.length + insertion.length;

      setInputValue(nextValue);
      
      // Focus and set cursor position
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(nextCaretPosition, nextCaretPosition);
      }, 0);
    }
  }, []);

  return (
    <div className="relative flex h-[calc(100vh-4.25rem)] bg-gradient-to-b from-muted/30 via-background to-background">
      {/* Data Summary Button - Left Side */}
      {sessionId && onOpenDataSummary && (
        <div
          className={`absolute left-4 top-4 ${isDatasetEnriching && !isDatasetPreviewLoading ? 'z-50' : 'z-30'}`}
        >
          <Button
            onClick={onOpenDataSummary}
            variant="outline"
            size="sm"
            className="border-border/80 bg-card/95 shadow-md backdrop-blur-sm transition-all hover:border-primary hover:shadow-lg"
            title="View Data Summary"
          >
            <FileText className="h-4 w-4 mr-2" />
            <span className="hidden sm:inline">Data Summary</span>
          </Button>
        </div>
      )}
      
      {/* Loading Overlay when replacing analysis */}
      {isReplacingAnalysis && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-sm">
          <div className="text-center">
            <div className="relative mb-4">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
                <Loader2 className="h-8 w-8 animate-spin text-primary motion-reduce:animate-none" />
              </div>
            </div>
            <h3 className="mb-1 text-lg font-semibold text-foreground">Replacing analysis…</h3>
            <p className="text-sm text-muted-foreground">Uploading and analyzing your new data file</p>
            <p className="mt-2 text-xs text-muted-foreground">This may take a moment</p>
          </div>
        </div>
      )}
      {previewSource === 'local' && (
        <div className="absolute left-0 right-0 top-16 z-30 px-4">
          <div className="mx-auto max-w-6xl rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-xs text-foreground">
            Local preview ({localPreviewParseStatus === 'full' ? 'first 100 rows' : 'headers only'}) is shown for speed. It will be replaced by server preview once ready.
          </div>
        </div>
      )}
      {uploadStartError && (
        <div className="absolute left-0 right-0 top-24 z-30 px-4">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <span>{uploadStartError}</span>
            <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={onUploadNew}>
              Retry upload
            </Button>
          </div>
        </div>
      )}
      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Messages Area */}
        <div
          ref={messagesContainerRef}
          className="flex-1 overflow-y-auto"
        >
        {/*
          W10 · expose the conversation as an aria-live region so screen
          readers announce new assistant messages as they stream in.
          `polite` (not `assertive`) lets the user finish reading the
          previous message before being interrupted.
        */}
        <div
          className="max-w-6xl mx-auto px-4 py-4 space-y-4"
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
          aria-label="Conversation messages"
        >
          {/* Header with Filter dropdown */}
          {(sessionId || messages.length > 0) && collaborators.length > 0 && (
            <div className="flex justify-end items-center mb-2">
              {/* Filter Messages Dropdown - Right side */}
              <div className="inline-flex items-center gap-2 rounded-full border border-border/80 bg-card px-3 py-1.5 shadow-sm transition-all duration-200 hover:shadow-md">
                <Filter className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium text-foreground">Filter messages</span>
                <Select value={selectedCollaborator} onValueChange={handleFilterChange}>
                  <SelectTrigger className="h-6 min-w-[120px] border-none bg-transparent px-2 text-xs font-semibold text-foreground shadow-none hover:bg-transparent focus:ring-0 focus:ring-offset-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Messages</SelectItem>
                    {collaborators.map((email) => {
                      const displayName = email.split('@')[0];
                      const isCurrentUser = email.toLowerCase() === currentUserEmail;
                      return (
                        <SelectItem key={email} value={email}>
                          {isCurrentUser ? `${displayName} (You)` : displayName}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          {filteredMessages.map((message, idx) => {
            // Use the pre-computed map for O(1) lookup instead of O(n) findIndex
            const key = `${message.timestamp}-${message.role}`;
            const originalIndex = messageIndexMap.get(key) ?? idx;
            const isLastMessage = idx === filteredMessages.length - 1;
            // Check if this is the last user message (for edit button and thinking steps)
            const isLastUserMessage = message.role === 'user' && 
              (idx === filteredMessages.length - 1 || 
               (idx < filteredMessages.length - 1 && filteredMessages[idx + 1].role === 'assistant'));
            const isThinkingTarget =
              thinkingTargetTimestamp != null && message.timestamp === thinkingTargetTimestamp;
            const isUserMsg = message.role === 'user';
            /** Persisted thinking on the user message (survives after stream ends). Do not gate on isThinkingTarget — onDone clears thinkingTargetTimestamp before onSuccess merges trace onto the message. */
            const userHasPersistedThinking =
              isUserMsg &&
              !isLoading &&
              ((message.thinkingSteps?.length ?? 0) > 0 ||
                (message.agentWorkbench?.length ?? 0) > 0);
            const panelSteps = userHasPersistedThinking ? (message.thinkingSteps ?? []) : [];
            const panelWorkbench = userHasPersistedThinking
              ? (message.agentWorkbench ?? [])
              : [];
            const showThinkingPanel = userHasPersistedThinking;
            const showThinkingStepsForCharts =
              isThinkingTarget && isLoading && thinkingSteps && thinkingSteps.length > 0;
            const showLiveThinkingStrip =
              isLoading &&
              thinkingLiveAnchorTimestamp != null &&
              message.timestamp === thinkingLiveAnchorTimestamp &&
              ((thinkingSteps?.length ?? 0) > 0 || (agentWorkbenchLive?.length ?? 0) > 0);
            const isEnrichmentMessage = isDatasetEnrichmentSystemMessage(message);
            const hasDatasetSchema = !!columns && columns.length > 0;
            const carriesDatasetPreview =
              previewAnchorKey === `${message.timestamp}-${message.role}` &&
              hasDatasetSchema;
            const allowDatasetPreviewInAnswer = (() => {
              if (message.role !== 'assistant') return false;
              if (isDatasetPreviewSystemMessage(message) || isDatasetEnrichmentSystemMessage(message)) {
                return true;
              }
              const scanFrom = originalIndex >= 0 ? originalIndex - 1 : idx - 1;
              for (let i = scanFrom; i >= 0; i--) {
                const m = messages[i];
                if (!m) continue;
                if (m.role === 'user') {
                  return userExplicitlyAskedForColumnsOrPreview(m.content);
                }
              }
              return false;
            })();
            const allowPivotAutoShow = computeAllowPivotAutoShow(message);
            const uploadPreviewThinking =
              isDatasetPreviewLoading &&
              isDatasetPreviewSystemMessage(message) &&
              carriesDatasetPreview
                ? {
                    active: true as const,
                    title:
                      enrichmentPoll?.phase === 'queued'
                        ? 'Upload accepted, waiting to start'
                        : 'Preparing your dataset preview',
                    details:
                      previewSource === 'local'
                        ? 'Showing local preview now. Server-backed preview will replace it automatically.'
                        : enrichmentPoll?.phaseMessage ||
                          'Building preview rows and column summary in the background.',
                  }
                : undefined;
            let precedingUserQuestion: string | undefined;
            if (message.role === "assistant") {
              const start = originalIndex >= 0 ? originalIndex : idx;
              for (let i = start - 1; i >= 0; i--) {
                const m = messages[i];
                if (m?.role === "user") {
                  precedingUserQuestion = m.content;
                  break;
                }
              }
            }
            return (
              <div key={`${message.timestamp}-${message.role}-${idx}-wrap`}>
                <MessageBubble
                  message={message}
                  sampleRows={carriesDatasetPreview ? sampleRows : undefined}
                  columns={hasDatasetSchema ? columns : undefined}
                  numericColumns={hasDatasetSchema ? numericColumns : undefined}
                  dateColumns={hasDatasetSchema ? dateColumns : undefined}
                  temporalDisplayGrainsByColumn={hasDatasetSchema ? temporalDisplayGrainsByColumn : undefined}
                  temporalFacetColumns={hasDatasetSchema ? temporalFacetColumns : undefined}
                  totalRows={carriesDatasetPreview ? totalRows : undefined}
                  totalColumns={carriesDatasetPreview ? totalColumns : undefined}
                  onEditMessage={onEditMessage}
                  messageIndex={originalIndex >= 0 ? originalIndex : idx}
                  sessionId={sessionId}
                  isLastUserMessage={isLastUserMessage}
                  thinkingSteps={showThinkingStepsForCharts ? thinkingSteps : undefined}
                  thinkingPanelSteps={showThinkingPanel ? panelSteps : undefined}
                  thinkingPanelWorkbench={showThinkingPanel ? panelWorkbench : undefined}
                  thinkingPanelStreaming={false}
                  onSuggestedQuestionClick={applySuggestionToComposer}
                  showDatasetEnrichmentLoader={
                    (isEnrichmentMessage || isDatasetPreviewSystemMessage(message)) &&
                    isDatasetEnriching &&
                    !isDatasetPreviewLoading
                  }
                  enrichmentPhase={enrichmentPoll?.enrichmentPhase}
                  enrichmentStep={enrichmentPoll?.enrichmentStep}
                  uploadProgress={enrichmentPoll?.uploadProgress}
                  enrichmentStartedAtMs={enrichmentStartedAtMs}
                  preEnrichmentPreviewSnapshot={preEnrichmentPreviewSnapshot}
                  postEnrichmentPreviewSnapshot={postEnrichmentPreviewSnapshot}
                  allowDatasetPreviewInAnswer={allowDatasetPreviewInAnswer}
                  allowPivotAutoShow={allowPivotAutoShow}
                  onAppendAssistantChart={onAppendAssistantChart}
                  precedingUserQuestion={precedingUserQuestion}
                  uploadPreviewThinking={uploadPreviewThinking}
                  ref={isLastMessage ? lastMessageRef : undefined}
                />
                {showLiveThinkingStrip && (
                  <div className="max-w-[90%] mr-auto ml-11 mt-1 mb-1">
                    <ThinkingPanel
                      variant="live"
                      steps={thinkingSteps ?? []}
                      workbench={agentWorkbenchLive}
                      spawnedSubQuestions={spawnedSubQuestions}
                      isStreaming
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Input Area */}
      <div className="sticky bottom-0 border-t border-border/80 bg-card/95 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-4 py-4">
          {filteredMessages.length === 0 && messages.length > 0 && (
            <div className="mb-4">
              <h3 className="mb-3 text-center text-base font-semibold text-foreground">
                No messages from selected collaborator
              </h3>
            </div>
          )}
          {/* Show suggestions when no messages OR when there's only the initial assistant message from upload */}
          {canShowStarterSuggestions && (
            <div className="mb-4">
              <h3 className="mb-3 text-center text-base font-semibold text-foreground">Try asking:</h3>
              <div className="flex flex-wrap gap-2 justify-center" data-testid="suggestion-chips">
                {suggestions.map((suggestion, idx) => (
                  <Button
                    key={idx}
                    variant="outline"
                    size="sm"
                    type="button"
                    onClick={() => applySuggestionToComposer(suggestion)}
                    aria-label={`Add to message: ${suggestion}`}
                    data-testid={`suggestion-${idx}`}
                    className="rounded-full border-border/80 px-3 py-1.5 text-xs transition-colors hover:border-primary hover:bg-primary/5"
                  >
                    {suggestion}
                  </Button>
                ))}
              </div>
            </div>
          )}
          
          {/* Show follow-up suggestions after assistant messages (when there are multiple messages) */}
          {suggestions.length > 0 &&
            filteredMessages.length > 1 &&
            filteredMessages[filteredMessages.length - 1].role === 'assistant' && (
            <div className="mb-4 mt-2">
              <div className="flex flex-wrap gap-2 justify-center">
                {suggestions.slice(0, 3).map((suggestion, idx) => (
                  <Button
                    key={idx}
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={() => applySuggestionToComposer(suggestion)}
                    aria-label={`Add to message: ${suggestion}`}
                    className="rounded-full px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-primary/5 hover:text-primary"
                  >
                    {suggestion}
                  </Button>
                ))}
              </div>
            </div>
          )}
          
          <form onSubmit={handleSubmit} className="flex items-end gap-2">
            {columns && columns.length > 0 && (
              <div className="flex-shrink-0">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-11 rounded-xl border-2 border-border/80 bg-card px-4 text-sm font-medium shadow-sm hover:bg-muted/50 focus:border-primary focus:ring-2 focus:ring-primary/40"
                    >
                      <Filter className="mr-2 h-4 w-4 text-muted-foreground" />
                      <span>Filter Data</span>
                      <ChevronDown className="ml-2 h-4 w-4 text-muted-foreground" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="start" className="w-56">
                    <DropdownMenuItem onClick={() => setFilterModalOpen(true)}>
                      <Filter className="w-4 h-4 mr-2" />
                      <span>Filter Data</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
            <div className="flex-shrink-0">
              {columns && columns.length > 0 && onAppendAssistantChart ? (
                <ChartBuilderDialog
                  sessionId={sessionId}
                  columns={columns}
                  numericColumns={numericColumns ?? []}
                  dateColumns={dateColumns ?? []}
                  onChartAdded={onAppendAssistantChart}
                />
              ) : null}
            </div>
            <div className="relative flex-1">
              <Textarea
                ref={inputRef}
                value={inputValue}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onBlur={handleTextareaBlur}
                placeholder="Ask a question about your data..."
                disabled={isLoading}
                data-testid="input-message"
                rows={1}
                className="min-h-[44px] max-h-40 flex-1 resize-none rounded-xl border-2 border-border/80 bg-card pr-8 text-sm shadow-sm focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/40"
              />
              {mentionState.active && mentionState.options.length > 0 && (
                <div className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-60 overflow-y-auto rounded-xl border border-border/80 bg-popover py-2 shadow-lg">
                  {mentionState.options.map((column, idx) => {
                    const isActive = idx === mentionState.selectedIndex;
                    return (
                      <button
                        type="button"
                        key={column}
                        className={`flex w-full items-center justify-between px-3 py-2 text-sm transition-colors ${
                          isActive ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted'
                        }`}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          selectMention(column);
                        }}
                      >
                        <span className="truncate">{column}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {isLoading && onStopGeneration ? (
              <Button
                type="button"
                onClick={onStopGeneration}
                data-testid="button-stop"
                size="icon"
                className="h-10 w-10 rounded-xl bg-destructive text-destructive-foreground shadow-sm transition-all hover:bg-destructive/90 hover:shadow-md"
                title="Stop generating"
              >
                <Square className="w-4 h-4 fill-current" />
              </Button>
            ) : (
              <Button
                type="submit"
                disabled={!inputValue.trim() || isLoading}
                data-testid="button-send"
                size="icon"
                className="h-10 w-10 rounded-xl shadow-sm hover:shadow-md transition-all"
              >
                <Send className="w-4 h-4" />
              </Button>
            )}
          </form>
        </div>
      </div>
      </div>

      {/* Fixed Scroll Buttons - Right Center (adjusted for sidebar) */}
      {(showScrollToTop || showScrollToBottom) && (
        <div 
          className="fixed top-1/2 -translate-y-1/2 z-40 flex flex-col gap-2"
          style={{ right: columns && columns.length > 0 && isColumnSidebarOpen ? '280px' : '32px' }}
        >
          {showScrollToTop && (
            <Button
              onClick={scrollToTop}
              size="icon"
              className="h-10 w-10 rounded-full border border-border/80 bg-card shadow-lg transition-all hover:bg-muted hover:shadow-xl"
              title="Scroll to top"
            >
              <ChevronUp className="h-5 w-5 text-foreground" />
            </Button>
          )}
          {showScrollToBottom && (
            <Button
              onClick={scrollToBottom}
              size="icon"
              className="h-10 w-10 rounded-full border border-border/80 bg-card shadow-lg transition-all hover:bg-muted hover:shadow-xl"
              title="Scroll to bottom"
            >
              <ChevronDown className="h-5 w-5 text-foreground" />
            </Button>
          )}
        </div>
      )}
      
      {/* Right Sidebar - Column Navigator (hover to expand) */}
      {columns && columns.length > 0 && (
        <div
          className={`h-full flex-shrink-0 border-l border-border/80 bg-card/80 backdrop-blur-sm transition-[width] duration-200 ease-out ${
            isColumnSidebarOpen ? 'w-64 shadow-sm' : 'w-3'
          }`}
          onMouseEnter={() => setIsColumnSidebarOpen(true)}
          onMouseLeave={() => setIsColumnSidebarOpen(false)}
        >
          <ColumnSidebar
            columns={columns}
            numericColumns={numericColumns}
            dateColumns={dateColumns}
            onColumnClick={handleColumnClick}
            collapsed={!isColumnSidebarOpen}
            className="w-full h-full border-0 shadow-none bg-transparent"
          />
        </div>
      )}

      {/* Filter Data Modal */}
      {columns && columns.length > 0 && (
        <FilterDataModal
          open={filterModalOpen}
          onOpenChange={setFilterModalOpen}
          columns={columns}
          numericColumns={numericColumns}
          dateColumns={dateColumns}
          data={sampleRows}
          onApply={handleFilterApply}
        />
      )}
    </div>
  );
}
