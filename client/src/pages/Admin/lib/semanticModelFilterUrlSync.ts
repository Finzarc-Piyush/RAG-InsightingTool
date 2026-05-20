/**
 * W61-filter-persist · URL-state persistence of the W61-source-filter
 * active chip via `?filter=X` query param.
 *
 * Use case: an admin shares a link to "the metrics I edited on this
 * session" by copy-pasting the URL after clicking the User chip; a
 * teammate opens the link and lands on the same filtered view. Also
 * survives accidental reloads — the prior wave's filter state was
 * `useState`-only, so a reload reset to the `"all"` default.
 *
 * Pure module — no React, no DOM. Two string-in / string-out
 * functions: `readFilterFromSearch(search)` parses the param from a
 * `window.location.search` string, validates against the allowed
 * filter values, and falls back to `"all"` for missing / invalid /
 * empty. `writeFilterToSearch(search, filter)` returns the updated
 * search string with the filter param set (or removed for the `"all"`
 * default so the URL stays clean at the default state).
 *
 * The page component wires these into `useState`'s lazy initializer
 * + a `useEffect` that calls `window.history.replaceState` on every
 * filter change. `replaceState` rather than `pushState` so the browser
 * back button doesn't accumulate one history entry per chip click.
 */

import type { SemanticEntryFilter } from "./semanticModelSourceFilter.js";

/**
 * The param name is intentionally short (5 chars vs. e.g.
 * "source_filter") so the URL stays terse — admins frequently copy
 * URLs into chat / docs and a verbose param name reads as noise.
 */
export const FILTER_PARAM_NAME = "filter";

/**
 * Allowed filter values mirror `SOURCE_FILTER_ORDER` from
 * [`./semanticModelSourceFilter.js`](./semanticModelSourceFilter.ts).
 * Declared as a `Set` for O(1) validation; the test suite pins this
 * is byte-stable against the source-filter module so a future widening
 * lands as a typecheck error rather than silently allowing an
 * unknown query param.
 */
const VALID_FILTERS: ReadonlySet<SemanticEntryFilter> = new Set<SemanticEntryFilter>([
  "all",
  "user",
  "auto",
  "domain",
]);

/**
 * Parse the `?filter=X` query param from a `window.location.search`
 * string (with or without the leading `?`). Returns `"all"` for any
 * of: missing param, invalid value, empty value. Case-sensitive —
 * URL params are byte-stable so `?filter=USER` does NOT match
 * `"user"`; admins copy URLs from the browser which preserves case.
 *
 * Pure function — does NOT read `window.location` directly; the
 * caller passes the search string in so the function stays testable
 * in node:test without a jsdom mount.
 */
export function readFilterFromSearch(search: string): SemanticEntryFilter {
  if (!search) return "all";
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const raw = params.get(FILTER_PARAM_NAME);
  if (raw === null || raw === "") return "all";
  if (VALID_FILTERS.has(raw as SemanticEntryFilter)) {
    return raw as SemanticEntryFilter;
  }
  return "all";
}

/**
 * Return an updated search string with the filter param set. For the
 * `"all"` default the param is REMOVED so the URL stays clean —
 * `?filter=all` would be byte-noise; the absence of the param means
 * the same thing. Other query params (e.g. a future `?sort=X`) are
 * preserved through the rewrite.
 *
 * Returns the search string WITHOUT a leading `?` — the caller
 * decides whether to prepend it (most callers want `"?" + search`
 * for `history.replaceState`, or empty string for "no query params").
 * An empty result string means "no params at all".
 */
export function writeFilterToSearch(
  search: string,
  filter: SemanticEntryFilter,
): string {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  if (filter === "all") {
    params.delete(FILTER_PARAM_NAME);
  } else {
    params.set(FILTER_PARAM_NAME, filter);
  }
  return params.toString();
}
