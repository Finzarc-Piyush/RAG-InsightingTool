/**
 * Single source of truth for heatmap cardinality limits shared across the
 * pivot/chart code paths. Previously duplicated byte-for-byte in
 * `lib/chartSpecCompiler.ts`, `shared/pivot/chartRecommendation.ts`, and
 * `shared/pivot/chartTypeValidity.ts`.
 *
 * Pure leaf module: no imports, no client-only deps. Lives under
 * `server/shared/` so both the server and the mirrored client paths can import it.
 */

/** Max distinct column keys before a heatmap is considered too wide. */
export const HEATMAP_MAX_COL_KEYS = 24;

/** Max distinct row keys before a heatmap is considered too tall. */
export const HEATMAP_MAX_ROW_KEYS = 40;

/** Max categories before a pie/donut becomes unreadable. */
export const PIE_MAX_CATEGORIES = 8;

/** Max spokes before a radar chart becomes unreadable. */
export const RADAR_MAX_SPOKES = 8;
