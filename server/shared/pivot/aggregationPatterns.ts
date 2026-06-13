/**
 * Single source of truth for the aggregation-suffix regexes shared across the
 * pivot/chart code paths. Previously duplicated byte-for-byte in
 * `lib/pivotDefaultsFromPreview.ts`, `lib/chartSpecCompiler.ts`, and
 * `shared/pivot/chartRecommendation.ts`.
 *
 * Pure leaf module: no imports, no client-only deps. Lives under
 * `server/shared/` so both the server and the mirrored client paths can import it.
 */

/** Non-capture test variant: does a column name end in an aggregation suffix? */
export const AGG_SUFFIX = /_(sum|avg|mean|min|max|count)$/i;

/** Capture variant: splits `<base>_<agg>` so callers can recover the base name. */
export const AGG_SUFFIX_CAPTURE = /^(.*)_(sum|avg|mean|min|max|count)$/i;
