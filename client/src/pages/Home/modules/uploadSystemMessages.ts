import type { Message } from '@/shared/schema';

export const DATASET_PREVIEW_MESSAGE_KEY = '__dataset_preview__';
export const DATASET_ENRICHMENT_MESSAGE_KEY = '__dataset_enrichment__';

export const DATASET_PREVIEW_LOADING_CONTENT =
  `${DATASET_PREVIEW_MESSAGE_KEY} Preparing your dataset preview...`;
export const DATASET_ENRICHMENT_LOADING_CONTENT =
  `${DATASET_ENRICHMENT_MESSAGE_KEY} Enriching our understanding of your data...`;

export function isDatasetPreviewSystemMessage(message: Message): boolean {
  return (
    message.role === 'assistant' &&
    typeof message.content === 'string' &&
    message.content.startsWith(DATASET_PREVIEW_MESSAGE_KEY)
  );
}

export function isDatasetEnrichmentSystemMessage(message: Message): boolean {
  return (
    message.role === 'assistant' &&
    typeof message.content === 'string' &&
    message.content.startsWith(DATASET_ENRICHMENT_MESSAGE_KEY)
  );
}

export function normalizeDatasetSystemMessages(
  messages: Message[],
  opts: { hasPreview: boolean; isEnriching: boolean }
): Message[] {
  const base = messages.filter(
    (m) => !isDatasetPreviewSystemMessage(m) && !isDatasetEnrichmentSystemMessage(m)
  );

  if (!opts.hasPreview) return base;

  const previewExisting = messages.find(isDatasetPreviewSystemMessage);
  const enrichmentExisting = messages.find(isDatasetEnrichmentSystemMessage);

  const previewMessage: Message =
    previewExisting ??
    ({
      role: 'assistant',
      content: DATASET_PREVIEW_LOADING_CONTENT,
      charts: [],
      insights: [],
      timestamp: Date.now(),
    } as Message);

  const result: Message[] = [previewMessage, ...base];
  if (opts.isEnriching) {
    result.splice(1, 0, {
      role: 'assistant',
      content: DATASET_ENRICHMENT_LOADING_CONTENT,
      charts: [],
      insights: [],
      timestamp: enrichmentExisting?.timestamp ?? Date.now() + 1,
    } as Message);
  }
  return result;
}
