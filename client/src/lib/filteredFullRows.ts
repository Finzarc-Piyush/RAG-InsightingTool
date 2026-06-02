/**
 * Wave-FA · Full-mode ("entire dataset") row fetch for the preview pane.
 *
 * The default preview rides on the active-filter PUT/GET responses (200 rows).
 * The opt-in "Entire dataset" toggle needs the full filter-aware set, fetched
 * on demand via `GET …/active-filter?full=1` (bounded by the server cap).
 *
 * The fetch + response-mapping live here as pure functions so they're unit-
 * testable by mocking `sessionsApi` (the React lifecycle lives in
 * `useFilteredFullRows`). Mirrors the `activeFilterRetry` pattern.
 */
import { sessionsApi, type ActiveFilterResponse } from "@/lib/api/sessions";

export interface FilteredFullRowsResult {
  rows: Record<string, unknown>[];
  /** True when the server capped the full set at its limit. */
  truncated: boolean;
}

/** Map a full-mode active-filter response into preview-pane state. */
export function mapFullRowsResponse(
  out: ActiveFilterResponse
): FilteredFullRowsResult {
  return {
    rows: Array.isArray(out.preview) ? out.preview : [],
    truncated: Boolean(out.previewTruncated),
  };
}

/** Fetch the entire-dataset (filter-aware, capped) preview for a session. */
export async function fetchFilteredFullRows(
  sessionId: string
): Promise<FilteredFullRowsResult> {
  const out = (await sessionsApi.getActiveFilterFull(
    sessionId
  )) as ActiveFilterResponse;
  return mapFullRowsResponse(out);
}
