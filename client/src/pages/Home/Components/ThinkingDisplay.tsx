/**
 * Single tokenized thinking display.
 * Shows one stream of thinking from the AI (intro, steps, code, plan) as it arrives — no separate sections.
 */
import React from 'react';
import { ThinkingStep } from '@/shared/schema';
import { Loader2 } from 'lucide-react';
import { MarkdownRenderer } from '@/components/ui/markdown-renderer';

interface ExecutionMetricsType {
  rows_scanned?: number;
  rows_returned: number;
  execution_time_ms: number;
  columns_used: string[];
}

interface ThinkingDisplayProps {
  steps?: ThinkingStep[];
  executionPlan?: { steps: string[] };
  executionMetrics?: ExecutionMetricsType;
  streamingCode?: string;
  streamingCodeLanguage?: string;
  isStreamingCode?: boolean;
  /** Single tokenized thinking stream (AI intro + steps + code + plan) */
  streamingThinkingLog?: string;
  isStreamingThinkingLog?: boolean;
  isThinkingComplete?: boolean;
  defaultCollapsed?: boolean;
  /** When true, show "Preparing…" when no chunks yet (streaming bubble visible) */
  showWhenEmpty?: boolean;
}

function ThinkingMarkdown({ content }: { content: string }) {
  const segments: React.ReactNode[] = [];
  const codeBlockRegex = /```([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const before = content.slice(lastIndex, match.index);
      if (before.trim().length > 0) {
        segments.push(<MarkdownRenderer key={`md-${key++}`} content={before} />);
      }
    }

    const rawBlock = match[1] ?? '';
    const [maybeLang, ...rest] = rawBlock.split('\n');
    const hasLanguage = rest.length > 0;
    const language = hasLanguage ? maybeLang.trim() : undefined;
    const codeText = hasLanguage ? rest.join('\n') : rawBlock;

    segments.push(
      <div
        key={`code-${key++}`}
        className="my-1 rounded-md bg-transparent text-[11px] font-mono overflow-x-auto"
      >
        {language && (
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-amber-800/80">
            {language}
          </div>
        )}
        <pre className="whitespace-pre-wrap font-mono leading-snug text-gray-900">
          <code>{codeText}</code>
        </pre>
      </div>
    );

    lastIndex = codeBlockRegex.lastIndex;
  }

  if (lastIndex < content.length) {
    const remaining = content.slice(lastIndex);
    if (remaining.trim().length > 0) {
      segments.push(<MarkdownRenderer key={`md-${key++}`} content={remaining} />);
    }
  }

  return <>{segments}</>;
}

export function ThinkingDisplay({
  streamingThinkingLog,
  isStreamingThinkingLog,
  isThinkingComplete = false,
  showWhenEmpty = false,
}: ThinkingDisplayProps) {
  const hasContent = (streamingThinkingLog?.length ?? 0) > 0;

  if (!hasContent && !isStreamingThinkingLog && !showWhenEmpty) {
    return null;
  }

  return (
    <div className="mt-3 ml-11">
      <div className="rounded-xl border border-gray-200 bg-gradient-to-b from-amber-50/80 to-white shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 bg-amber-50/40">
          {isStreamingThinkingLog ? (
            <Loader2 className="w-3.5 h-3.5 text-amber-600 animate-spin flex-shrink-0" aria-hidden />
          ) : null}
          <span className="text-xs font-semibold text-amber-800/90">
            {hasContent ? 'Thinking' : 'Thinking…'}
          </span>
        </div>
        <div className="px-3 py-3 min-h-[2.5rem]">
          {hasContent ? (
            <div className="text-sm text-gray-800 leading-tight whitespace-pre-wrap break-words font-[inherit] prose prose-sm max-w-none prose-p:my-1 prose-ul:my-1 prose-li:my-0 prose-code:bg-gray-100 prose-code:px-1 prose-code:rounded prose-code:text-xs">
              {streamingThinkingLog && <ThinkingMarkdown content={streamingThinkingLog} />}
              {isStreamingThinkingLog && (
                <span
                  className="inline-block w-2 h-4 ml-0.5 bg-amber-500 animate-pulse align-middle rounded-sm"
                  aria-hidden
                />
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" aria-hidden />
              <span>Preparing…</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
