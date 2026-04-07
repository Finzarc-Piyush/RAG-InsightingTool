import type { Message } from '@/shared/schema';
import {
  isDatasetEnrichmentSystemMessage,
  isDatasetPreviewSystemMessage,
} from '@/pages/Home/modules/uploadSystemMessages';

const PREVIEW_TRUNCATE = 48;

/** DOM id for the analysis pivot block in MessageBubble (must stay in sync). */
export function chatPivotAnchorId(message: Message): string {
  return `chat-pivot-${message.timestamp}-${message.role}`;
}

export function hasNonEmptyAnalysisPreview(message: Message): boolean {
  const preview = (message as Message & { preview?: unknown[] }).preview;
  return (
    Array.isArray(preview) &&
    preview.length > 0
  );
}

/** Mirrors ChatInterface allowPivotAutoShow for an assistant message. */
export function computeAllowPivotAutoShow(message: Message): boolean {
  if (message.role !== 'assistant') return false;
  if (
    isDatasetPreviewSystemMessage(message) ||
    isDatasetEnrichmentSystemMessage(message)
  ) {
    return false;
  }
  if (message.isIntermediate) {
    const hasIntermediatePivotDefaults =
      Boolean(message.pivotDefaults?.rows?.length) ||
      Boolean(message.pivotDefaults?.values?.length);
    return hasIntermediatePivotDefaults;
  }
  const serverHint = Boolean(
    (message as Message & { pivotAutoShow?: boolean }).pivotAutoShow
  );
  const hasPreviewRows =
    Array.isArray((message as Message & { preview?: unknown[] }).preview) &&
    ((message as Message & { preview?: unknown[] }).preview?.length ?? 0) > 0;
  const hasSummaryRows =
    Array.isArray((message as Message & { summary?: unknown[] }).summary) &&
    ((message as Message & { summary?: unknown[] }).summary?.length ?? 0) > 0;
  return serverHint || hasPreviewRows || hasSummaryRows;
}

/** Sidebar + scroll targets: same as visible analysis DataPreviewTable (preview rows + allowPivotAutoShow). */
export function messageHasNavigablePivotTable(message: Message): boolean {
  return (
    computeAllowPivotAutoShow(message) && hasNonEmptyAnalysisPreview(message)
  );
}

function pivotLabelForMessage(message: Message, ordinal: number): string {
  const t = message.content?.trim() ?? '';
  if (!t) return `Pivot ${ordinal}`;
  const oneLine = t.replace(/\s+/g, ' ');
  if (oneLine.length <= PREVIEW_TRUNCATE) return oneLine;
  return `${oneLine.slice(0, PREVIEW_TRUNCATE)}…`;
}

export function buildChatPivotNavEntries(messages: Message[]): {
  id: string;
  label: string;
}[] {
  const out: { id: string; label: string }[] = [];
  let ordinal = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!messageHasNavigablePivotTable(m)) continue;
    ordinal += 1;
    out.push({
      id: chatPivotAnchorId(m),
      label: pivotLabelForMessage(m, ordinal),
    });
  }
  return out;
}
