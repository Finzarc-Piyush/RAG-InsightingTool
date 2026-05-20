/**
 * Wave W61-audit-history-client · pure formatters + summary builders
 * for the upcoming W61-audit-history-tab UI on the admin semantic-model
 * viewer.
 *
 * Pure module — no React, no DOM, no `window`. Every function is
 * deterministic on its inputs so node:test can pin them without a
 * jsdom mount. The tab UI consumes these helpers to render each audit
 * entry as a compact two-line row with a revert button; the revert
 * affordance uses `window.confirm(buildRevertConfirmation(...))`
 * before POSTing to the W61-audit-revert endpoint.
 *
 * **Why UTC timestamp formatting** — audit-log forensics involve
 * admins in multiple timezones reconciling what happened when.
 * `2026-05-20 14:23 UTC` reads identically for everyone; locale-aware
 * formatting would let alice in NYC and bob in Bangalore both see
 * "14:23" but disagree on what wall-clock moment that was.
 *
 * **Why a two-field `{ headline, subhead }` instead of one string** —
 * the tab UI renders the headline larger and the subhead muted, so
 * pre-splitting at the helper boundary spares the JSX from doing
 * string-split-and-style at every render.
 *
 * **Why `priorVersion` in the subhead** — two adjacent audit entries
 * can share `savedBy` (alice edited twice in a row); the version
 * differentiates them and matches the revert mental model ("revert
 * to the state of version 2"). The version is also the W64 compiled-
 * query cache key, so seeing `was v2` in the audit log corresponds
 * directly to the cache entry that revert would restore.
 */

import type { AdminSemanticModelAuditEntry } from "@/lib/api/admin";

/**
 * Format a ms-epoch as a locale-independent `YYYY-MM-DD HH:MM` string
 * in UTC. The audit log is a forensic surface — stable serialisation
 * matters more than localised time-of-day.
 */
export function formatAuditTimestamp(savedAt: number): string {
  const d = new Date(savedAt);
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mi = d.getUTCMinutes().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi} UTC`;
}

export interface AuditEntrySummary {
  /** Large-text headline, e.g. `"Save 3 of 5"`. */
  headline: string;
  /** Muted subhead, e.g. `"alice@example.com · 2026-05-20 14:23 UTC · was v2"`. */
  subhead: string;
}

/**
 * Build the two-line display summary for a single audit entry.
 *
 * @param entry            The audit entry to summarise.
 * @param indexFromNewest  0-based position in the newest-first buffer
 *                         (so `0` is the most recent prior, which the
 *                         summary labels as `"Save 1 of M"`).
 * @param total            Total entries in the buffer (the `M` in the
 *                         headline — `"of 5"` shows context to the
 *                         admin about how far back the buffer reaches).
 */
export function buildAuditEntrySummary(
  entry: AdminSemanticModelAuditEntry,
  indexFromNewest: number,
  total: number,
): AuditEntrySummary {
  const saveNumber = total - indexFromNewest;
  return {
    headline: `Save ${saveNumber} of ${total}`,
    subhead: `${entry.savedBy} · ${formatAuditTimestamp(entry.savedAt)} · was v${entry.priorVersion}`,
  };
}

/**
 * Build the `window.confirm()` prompt for the revert affordance.
 *
 * Spells out (a) which entry the admin is about to restore, (b) that
 * the current model will itself be saved to the audit log first (so
 * "undo this revert" remains possible), and (c) the version-number
 * mapping so the admin can sanity-check before clicking through.
 *
 * Uses the same `saveNumber` derivation as
 * {@link buildAuditEntrySummary} so the prompt's `Save N of M` matches
 * the row the admin just clicked.
 */
export function buildRevertConfirmation(
  entry: AdminSemanticModelAuditEntry,
  indexFromNewest: number,
  total: number,
): string {
  const saveNumber = total - indexFromNewest;
  return `Revert to Save ${saveNumber} of ${total} (v${entry.priorVersion} by ${entry.savedBy})?\n\nThe current model will be saved to the audit log first, so this revert can itself be undone.`;
}
