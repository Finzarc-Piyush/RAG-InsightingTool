import type { Message } from '@/shared/schema';
import {
  isDatasetEnrichmentSystemMessage,
  isDatasetPreviewSystemMessage,
} from '@/pages/Home/modules/uploadSystemMessages';
import { pivotAutoName } from '@/pages/Home/lib/pivotAutoName';

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
  const pivotAutoShowField = (message as Message & { pivotAutoShow?: boolean })
    .pivotAutoShow;
  // Scalar agent answers: server explicitly set pivotAutoShow=false AND emitted
  // no pivotDefaults. Honor that suppression — preview rows alone are not enough
  // to render a meaningful pivot when the agent's analytical step had no row
  // dimensions (otherwise the grid auto-recommends a misleading view).
  const hasPivotDefaults =
    Boolean(message.pivotDefaults?.rows?.length) ||
    Boolean(message.pivotDefaults?.values?.length);
  if (pivotAutoShowField === false && !hasPivotDefaults) {
    return false;
  }
  const serverHint = Boolean(pivotAutoShowField);
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

export type ChatPivotNavEntry = {
  /** DOM anchor id (for click-to-scroll). */
  id: string;
  /** Resolved display label: customName ?? auto-name ?? "Pivot N". */
  label: string;
  /** True when the user has pinned this pivot — sorts to the top. */
  pinned: boolean;
  /** ms-epoch timestamp of the source message; handlers use this to PATCH. */
  messageTimestamp: number;
  /** False for legacy messages with no pivotState — pin/rename icons hidden. */
  hasPivotState: boolean;
  /** User's persisted override, if set. Lets the input prefill on rename. */
  customName: string | null;
};

export function buildChatPivotNavEntries(
  messages: Message[]
): ChatPivotNavEntry[] {
  const out: ChatPivotNavEntry[] = [];
  let ordinal = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!messageHasNavigablePivotTable(m)) continue;
    ordinal += 1;
    const pivotState = (m as Message & { pivotState?: { config?: unknown; pinned?: boolean; customName?: string } })
      .pivotState;
    const customName = pivotState?.customName?.trim() || null;
    const auto = pivotState?.config
      ? pivotAutoName(pivotState.config as Parameters<typeof pivotAutoName>[0])
      : null;
    const label = customName ?? auto ?? `Pivot ${ordinal}`;
    out.push({
      id: chatPivotAnchorId(m),
      label,
      pinned: Boolean(pivotState?.pinned),
      messageTimestamp: m.timestamp,
      hasPivotState: Boolean(pivotState),
      customName,
    });
  }
  // Stable partition: pinned-first, message-order within each group.
  const pinned: ChatPivotNavEntry[] = [];
  const rest: ChatPivotNavEntry[] = [];
  for (const e of out) (e.pinned ? pinned : rest).push(e);
  return [...pinned, ...rest];
}
