/**
 * Wave-FA · Preview-row selection for the active-filter endpoints.
 *
 * The active-filter response carries a slice of the filter-aware working
 * dataset (`loadLatestData(doc)`) so the client can render a live preview as
 * the user edits filters. Two depths:
 *  - default ("200 mode"): the first `PREVIEW_ROWS` rows — cheap to ship on
 *    every debounced PUT.
 *  - `full` ("entire-dataset mode", opt-in): up to `FULL_PREVIEW_CAP` rows,
 *    fetched on demand by `GET …/active-filter?full=1`. The cap bounds the
 *    JSON payload / browser render for very large filtered sets.
 *
 * Pure helper so the slicing contract is unit-testable without Cosmos/Express.
 */

/** Default preview depth (live "200 rows" mode). */
export const PREVIEW_ROWS = 200;

/** Upper bound for the opt-in "entire dataset" preview. */
export const FULL_PREVIEW_CAP = 50_000;

export interface PreviewSelection<T> {
  preview: T[];
  /** True when more rows survive the filter than are included in `preview`. */
  previewTruncated: boolean;
}

/**
 * Slice the full filtered set down to the preview depth for the requested
 * mode. `previewTruncated` reports whether rows were dropped — the client uses
 * it (in full mode) to surface a "capped" note.
 */
export function selectPreviewRows<T>(
  filteredAll: T[],
  full: boolean
): PreviewSelection<T> {
  const cap = full ? FULL_PREVIEW_CAP : PREVIEW_ROWS;
  const preview = filteredAll.slice(0, cap);
  return { preview, previewTruncated: filteredAll.length > preview.length };
}
