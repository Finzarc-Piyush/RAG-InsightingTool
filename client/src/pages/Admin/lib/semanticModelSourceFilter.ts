/**
 * W61-source-filter · "Show only X" filtering for the admin semantic-model
 * viewer, layered on top of the W61-source-badge chip taxonomy.
 *
 * Use case: an admin who has corrected 20 entries out of 100 wants to
 * scroll back through just their corrections to verify nothing slipped
 * through. With the source-badge wave the chips are now visible; this
 * wave makes them clickable as a filter.
 *
 * Pure module — no React, no DOM. The chip-row UI lives in
 * `AdminSemanticModelDetail.tsx` next to the SourceBadge so the visual
 * vocabulary stays consistent (same Badge variants).
 *
 * The filter type widens `SemanticEntrySource` from
 * [`./semanticModelSourceBadge.js`](./semanticModelSourceBadge.ts) with
 * an `"all"` sentinel — Radix would let us model "no filter active" as
 * `null`, but a single-string enum lets `filter === "all"` be a
 * load-bearing default that the chip row can also visually highlight
 * (same chip vocabulary as the row badges, with `"all"` getting its
 * own muted-outline variant to read as "no filter, everything shown").
 */

import type { SemanticEntrySource } from "./semanticModelSourceBadge.js";

/**
 * The "all" sentinel is intentionally part of the same union rather
 * than `SemanticEntrySource | "all"` at every call site — keeps the
 * union flat and the chip vocabulary closed.
 */
export type SemanticEntryFilter = "all" | SemanticEntrySource;

export const SOURCE_FILTER_ALL: SemanticEntryFilter = "all";

/**
 * Returns the subset of `entries` whose `source` matches the filter.
 * `"all"` returns the entries as-is (no copy — caller still gets the
 * original array reference so a downstream `.sort()` doesn't have to
 * pay an extra allocation when no filter is active). For specific
 * filters the result is a new array (shallow copy via `.filter`).
 *
 * Pure function — input array is never mutated.
 */
export function filterEntriesBySource<
  T extends { source: SemanticEntrySource },
>(entries: ReadonlyArray<T>, filter: SemanticEntryFilter): ReadonlyArray<T> {
  if (filter === "all") return entries;
  return entries.filter((e) => e.source === filter);
}

/**
 * Returns the per-source count for each possible filter value. The
 * `"all"` slot always equals `entries.length` so the chip-row can
 * render `All (N)` without a separate length read.
 *
 * Used by the chip row to render counts as `User (12)` / `Auto (88)`
 * / `Domain (0)` / `All (100)`. A future drift check could pin
 * `counts.all === counts.auto + counts.user + counts.domain`.
 */
export function countEntriesBySource<
  T extends { source: SemanticEntrySource },
>(entries: ReadonlyArray<T>): Readonly<Record<SemanticEntryFilter, number>> {
  let auto = 0;
  let user = 0;
  let domain = 0;
  for (const e of entries) {
    if (e.source === "auto") auto++;
    else if (e.source === "user") user++;
    else if (e.source === "domain") domain++;
  }
  return {
    all: entries.length,
    auto,
    user,
    domain,
  };
}

/**
 * Display label for each filter slot. Mirrors the W61-source-badge
 * capitalisation (Auto / User / Domain) plus the "All" sentinel label.
 * Centralised here so a future re-label lands in one place.
 */
const FILTER_LABELS: Readonly<Record<SemanticEntryFilter, string>> = {
  all: "All",
  auto: "Auto",
  user: "User",
  domain: "Domain",
};

export function getFilterLabel(filter: SemanticEntryFilter): string {
  return FILTER_LABELS[filter];
}

/**
 * The four filter values in display order — chips render left-to-right
 * as `All / User / Auto / Domain`. "User" leads the source filters
 * (over alphabetical Auto / Domain / User) because the most common
 * admin workflow is "show me what I've edited" — putting User first
 * minimises the scan distance from the leftmost chip.
 */
export const SOURCE_FILTER_ORDER: ReadonlyArray<SemanticEntryFilter> = [
  "all",
  "user",
  "auto",
  "domain",
] as const;
