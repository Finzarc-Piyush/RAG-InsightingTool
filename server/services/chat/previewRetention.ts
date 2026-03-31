/**
 * Streaming chat flow sometimes emits intermediate assistant segments before
 * the final response is fully formed. In those cases, downstream UI expects
 * the final assistant message to still include `preview` (and `summary` when
 * present), otherwise it may render an empty preview (e.g. "0 rows").
 */
export function preserveFinalPreview(
  transformedResponse: any,
  pendingIntermediates: Array<{ preview?: any[] }>,
): void {
  if (!Array.isArray(pendingIntermediates) || pendingIntermediates.length === 0) return;
  if (transformedResponse == null) return;

  const last = pendingIntermediates[pendingIntermediates.length - 1];
  if (!last?.preview || last.preview.length === 0) return;

  // Only fill if the final response didn't already include preview.
  if (transformedResponse.preview === undefined || transformedResponse.preview === null) {
    transformedResponse.preview = last.preview;
  }
}

