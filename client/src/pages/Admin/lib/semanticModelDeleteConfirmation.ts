/**
 * Wave W61-delete-client · pure formatters for the per-entry delete
 * confirmation modal on the admin semantic-model viewer.
 *
 * Pure module — no React, no DOM, no `window`, no fetch. Every helper
 * is deterministic on its inputs so `node --test` can pin them without
 * a jsdom mount. The modal component consumes these helpers; the
 * round-trip to the W61-references-endpoint lives there, not here.
 *
 * Mirrors the `semanticModelAuditHistory.ts` precedent (pure helpers +
 * a sibling component / test file) so the W61 trail stays consistent:
 * formatting that bites if it drifts (singular / plural correctness,
 * the "X chart vs X charts" boundary, the "total occurrences" branch
 * that only fires when occurrences exceed chart count) is testable in
 * isolation.
 *
 * **Why a separate `total_occurrences` subhead**
 *
 * The W61-references-scan walker returns two distinct counts:
 *   - `chartCount`     = distinct charts that mention the entry name
 *                        anywhere on the spec.
 *   - `totalOccurrences` = total number of field-positions across
 *                          those charts where the name appears.
 *
 * The two diverge when one chart uses the same entry in multiple
 * encoding channels (e.g. an entry that's both the x-axis AND the
 * tooltip field counts as 1 chart but 2 occurrences). Showing both is
 * load-bearing for admin judgement: a metric used in 3 charts with 3
 * occurrences is "delete it cleanly to break 3 charts"; a metric used
 * in 1 chart with 5 occurrences is "delete it to break 1 chart that
 * uses it heavily." The two scenarios warrant different confidence
 * levels at the click-through.
 *
 * **Why we return structured data not raw JSX**
 *
 * The modal renders a multi-line body with different typography per
 * line (headline normal, subhead muted). Pre-splitting at the helper
 * boundary spares the JSX from doing string parsing per render and
 * lets the tests pin the exact strings rather than asserting against
 * DOM trees.
 */

import type { AdminSemanticModelEntryKind } from "@/lib/api/admin";

/**
 * Map an `AdminSemanticModelEntryKind` to its display noun. Lowercase
 * because the noun is consumed inline in sentences (`"Delete metric
 * <code>name</code>?"`) — title-case would read as a proper-noun
 * (the kind isn't a brand name).
 */
function kindNoun(kind: AdminSemanticModelEntryKind): string {
  switch (kind) {
    case "metric":
      return "metric";
    case "dimension":
      return "dimension";
    case "hierarchy":
      return "hierarchy";
  }
}

/**
 * Title for the confirmation `<AlertDialogTitle>`. The entry name is
 * quoted (not bolded with markup) so the helper returns a plain string
 * and the modal can render it without parsing.
 *
 * Always ends with a `?` — the title is a question to the admin. The
 * test file pins this trailing punctuation so a future refactor that
 * drops it (e.g. switching to an imperative `"Confirm delete"` form)
 * surfaces as a failing assertion rather than silent regression.
 */
export function buildDeleteHeadline(
  kind: AdminSemanticModelEntryKind,
  name: string,
): string {
  return `Delete ${kindNoun(kind)} "${name}"?`;
}

/**
 * Generic confirmation body when the references scan returns
 * `chartCount === 0` (no charts use the entry).
 *
 * The admin still gets a confirmation step (deletes are
 * destructive even when nothing references the entry — the entry
 * itself disappears) but the language reassures rather than warns.
 * The audit-log restore-via-revert mention is load-bearing copy: it
 * tells the admin the action is reversible so they don't anxiously
 * second-guess a routine cleanup.
 */
export function buildDeleteGenericConfirmation(
  kind: AdminSemanticModelEntryKind,
  name: string,
): string {
  return (
    `No charts reference ${kindNoun(kind)} "${name}". ` +
    `This action will be saved to the audit log so it can be undone via revert.`
  );
}

export interface DeleteReferencesWarning {
  /**
   * Headline string, e.g. `"Removing this metric will break 3 charts
   * that reference it."`. Singular / plural correctness encoded
   * inline; the noun follows the entry kind.
   */
  headline: string;
  /**
   * Subhead string with the total-occurrences context, or `undefined`
   * when `totalOccurrences === chartCount` (the subhead would be
   * redundant — every reference is in a distinct chart so the chart
   * count IS the occurrence count).
   */
  subhead: string | undefined;
}

/**
 * Build the "removing this <kind> will break N <chart(s)>" warning
 * when the references scan returned a positive count. Returns `null`
 * when the count is zero — the modal should show the generic
 * confirmation in that branch (see {@link buildDeleteGenericConfirmation}).
 *
 * Singular / plural rules:
 *   - `1 chart` (singular) vs `2+ charts` (plural).
 *   - `1 reference total` (singular) vs `2+ references total` (plural).
 *
 * The "<N> references total" subhead is suppressed when it equals the
 * chart count (every reference is in a distinct chart — no extra
 * information). It surfaces when one chart uses the entry multiple
 * times (e.g. the entry is bound to both `x` and `tooltip`), so the
 * admin sees the heavier-usage signal.
 */
export function buildDeleteReferencesWarning(
  kind: AdminSemanticModelEntryKind,
  chartCount: number,
  totalOccurrences: number,
): DeleteReferencesWarning | null {
  if (chartCount <= 0) return null;
  const chartNoun = chartCount === 1 ? "chart" : "charts";
  const refVerb = chartCount === 1 ? "references" : "reference";
  const headline =
    `Removing this ${kindNoun(kind)} will break ${chartCount} ${chartNoun} ` +
    `that ${refVerb} it.`;
  const subhead =
    totalOccurrences > chartCount
      ? `${totalOccurrences} ${
          totalOccurrences === 1 ? "reference" : "references"
        } total across the affected ${chartNoun}.`
      : undefined;
  return { headline, subhead };
}

/**
 * Static body line shown after the warning / generic confirmation —
 * the audit-log restore promise. Same string in both branches; lives
 * in one helper so the test can pin it byte-exact.
 */
export const DELETE_AUDIT_LOG_REASSURANCE =
  "This action will be saved to the audit log so it can be undone via revert.";
