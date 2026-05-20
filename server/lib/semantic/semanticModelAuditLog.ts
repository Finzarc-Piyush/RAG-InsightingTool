/**
 * Wave W61-audit-log · prior-model audit trail for admin PATCH.
 *
 * On every successful PATCH to a session's semantic model, we snap the
 * **prior** model (the one the admin's edit is about to overwrite) into
 * a capped newest-first ring buffer on the parent ChatDocument. Use
 * cases: rollback, forensics ("who changed this metric and from what
 * to what?"), and the future W61-audit-revert wave's revert UI which
 * walks the buffer and re-PATCHes a chosen prior entry.
 *
 * Why **prior** model not next: at the moment the audit entry is
 * written, the canonical "current" model on the doc is the new one we
 * just computed; the entry's role is to remember what was just lost.
 * Storing the next model would be redundant with `doc.semanticModel`
 * itself.
 *
 * Why a capped buffer: SemanticModel snapshots are moderate-sized
 * (~5–50 KB depending on dataset width); 10 of them is well under the
 * 2 MB Cosmos document limit and gives an admin enough history to walk
 * back recent edits without producing unbounded doc growth across
 * months of saves.
 *
 * Why newest-first: matches the MRU convention used elsewhere in the
 * repo (WI6 insightHistory, sidebar Recent Sessions), so a future
 * history-tab UI can render `[0]` as "most recent" without inverting.
 *
 * Why no reference-identity optimization (cf.
 * [semanticModelSourceFilter.ts](../../../client/src/pages/Admin/lib/semanticModelSourceFilter.ts)
 * which preserves identity at "all"): every call here is a state
 * change (append), so there is no "default-case-is-no-op" path to
 * preserve. The function always returns a fresh array.
 */

import type { SemanticModel } from "../../shared/schema.js";

export interface SemanticModelAuditEntry {
  /** ms-epoch when the PATCH that produced this entry committed. */
  savedAt: number;
  /** Authenticated admin email, or `"unknown"` if `getAuthenticatedEmail` returned null. */
  savedBy: string;
  /** The prior model's `version` at the moment of save (the version this entry can revert to). */
  priorVersion: number;
  /** Full snapshot of the prior model — sufficient to revert via a subsequent PATCH. */
  priorModel: SemanticModel;
}

/**
 * Cap on the audit-log ring buffer.
 *
 * 10 is a tradeoff: each entry carries a full SemanticModel snapshot
 * (estimated 5–50 KB on real datasets); 10 entries × 50 KB worst-case
 * = 500 KB of audit overhead per doc, well under the 2 MB Cosmos
 * document limit. An admin who has made >10 saves has almost certainly
 * settled on a stable model — the deep-history use case is rare enough
 * to not pay for unbounded growth.
 */
export const SEMANTIC_MODEL_AUDIT_LOG_MAX_ENTRIES = 10;

/**
 * Prepend an audit entry to a (possibly absent) prior log and cap at
 * `max` entries newest-first. Always returns a fresh array; the input
 * is treated as `readonly` and never mutated. Accepts `undefined` for
 * `prior` to handle the first-save-ever case where the field doesn't
 * exist on the doc yet.
 *
 * @param prior  Existing log (newest-first) or undefined.
 * @param entry  Audit entry to prepend.
 * @param max    Cap (defaults to {@link SEMANTIC_MODEL_AUDIT_LOG_MAX_ENTRIES}).
 *               Tests pass a smaller value to exercise the cap without
 *               constructing dozens of entries.
 */
export function appendSemanticModelAuditEntry(
  prior: ReadonlyArray<SemanticModelAuditEntry> | undefined,
  entry: SemanticModelAuditEntry,
  max: number = SEMANTIC_MODEL_AUDIT_LOG_MAX_ENTRIES,
): SemanticModelAuditEntry[] {
  const next = [entry, ...(prior ?? [])];
  return next.length > max ? next.slice(0, max) : next;
}
