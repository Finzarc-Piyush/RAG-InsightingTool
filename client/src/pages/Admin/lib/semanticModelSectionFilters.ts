/**
 * W61-per-section-filter · Per-section filter override on top of the
 * W61-source-filter global chip row.
 *
 * Use case: the global filter (W61-source-filter) applies one chip
 * value across metrics + dimensions + hierarchies uniformly — the
 * common workflow "show me what I edited" benefits from this default.
 * But admins occasionally want a per-section scope: e.g. "show only
 * user-edited Metrics while leaving Dimensions and Hierarchies showing
 * all entries". Shift-click on any chip flips to that per-section
 * override; plain-click returns to the synced global mode.
 *
 * Model: one global filter + an `overrides: Record<Section, F | null>`
 * map. The effective filter for a section is `overrides[section] ??
 * global` — null means "inherit". Plain-click on any chip in any
 * section: set global, CLEAR all overrides (the "re-sync" intent).
 * Shift-click on a chip in section X: set `overrides[X]` to the
 * chip value (others unchanged). The "plain-click clears all" rule
 * gives admins a single, predictable exit path from override mode —
 * any non-shift click in any card returns the page to a fully synced
 * state, which means an admin can never accidentally leave a stale
 * override hidden by switching to another card.
 *
 * Pure module — no React, no DOM. Host owns the state slot and
 * routes the chip clicks through `applyChipClick`. URL persistence
 * (W61-filter-persist) intentionally only persists the global; per-
 * section overrides are session-local advanced state that doesn't
 * survive reload (a share-link reload reverts to the synced global,
 * which is what the recipient probably wanted anyway).
 */

import type { SemanticEntryFilter } from "./semanticModelSourceFilter.js";

/**
 * The three section names map 1-to-1 to the cards on the admin detail
 * page (`MetricsCard` / `DimensionsCard` / `HierarchiesCard`). Snake-
 * case-string discriminant rather than an enum so the values can be
 * passed as React keys and `data-testid` suffixes directly.
 */
export type SemanticModelSection = "metrics" | "dimensions" | "hierarchies";

export interface SemanticModelSectionFilters {
  readonly global: SemanticEntryFilter;
  readonly overrides: Readonly<
    Record<SemanticModelSection, SemanticEntryFilter | null>
  >;
}

/**
 * Sentinel "no overrides set" object — frozen for free identity stability
 * across renders (a fresh `{ metrics: null, dimensions: null, hierarchies:
 * null }` literal on every render would invalidate downstream `useMemo`
 * deps that depend on the overrides shape).
 */
const NO_OVERRIDES: Readonly<
  Record<SemanticModelSection, SemanticEntryFilter | null>
> = Object.freeze({
  metrics: null,
  dimensions: null,
  hierarchies: null,
});

export function makeSectionFilters(
  global: SemanticEntryFilter,
): SemanticModelSectionFilters {
  return { global, overrides: NO_OVERRIDES };
}

/**
 * Returns the effective filter for a section — override if set, else
 * the global filter. Pure read.
 */
export function getEffectiveFilter(
  filters: SemanticModelSectionFilters,
  section: SemanticModelSection,
): SemanticEntryFilter {
  return filters.overrides[section] ?? filters.global;
}

/**
 * Returns true when the section has an active override (i.e. is NOT
 * inheriting from `global`). The UI uses this to surface a small
 * visual hint on the chip row so the override state is discoverable
 * without comparing values manually.
 */
export function isSectionOverridden(
  filters: SemanticModelSectionFilters,
  section: SemanticModelSection,
): boolean {
  return filters.overrides[section] !== null;
}

/**
 * Pure reducer for a chip click. `modifier=true` is shift-click
 * (per-section override path); `modifier=false` is the plain-click
 * "re-sync" path that updates global + clears every override.
 *
 * Two behaviours folded into one reducer (rather than two named
 * functions) because the chip row's only branching axis is the
 * modifier flag — a single entry point keeps the call site simple
 * (`setFilters(prev => applyChipClick(prev, "metrics", "user", e.shiftKey))`).
 */
export function applyChipClick(
  filters: SemanticModelSectionFilters,
  section: SemanticModelSection,
  next: SemanticEntryFilter,
  modifier: boolean,
): SemanticModelSectionFilters {
  if (modifier) {
    return {
      global: filters.global,
      overrides: { ...filters.overrides, [section]: next },
    };
  }
  return { global: next, overrides: NO_OVERRIDES };
}

/**
 * Returns true when ANY section has an active override. Used by the
 * host's "active overrides" guard — e.g. if a future "Save view"
 * affordance lands, it can warn the admin that overrides won't be
 * captured in the share-link.
 */
export function hasAnyOverride(
  filters: SemanticModelSectionFilters,
): boolean {
  return (
    filters.overrides.metrics !== null ||
    filters.overrides.dimensions !== null ||
    filters.overrides.hierarchies !== null
  );
}
