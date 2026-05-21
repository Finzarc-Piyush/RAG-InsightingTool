/**
 * Wave W61-list / W61-detail · admin endpoints for the W57-inferred
 * semantic model.
 *
 *   GET   /api/admin/semantic-models             — list every session with a model (W61-list)
 *   GET   /api/admin/semantic-models/:sessionId  — full payload for one session (W61-detail)
 *   PATCH /api/admin/semantic-models/:sessionId  — (W61-save, future) replace the model
 *
 * All gated by `isAdminRequest()` (the consolidated SUPERADMIN_EMAILS
 * allowlist; see [admin.helper.ts](../utils/admin.helper.ts)).
 *
 * Why injectable `_lister` / `_detailFetcher`: the underlying model
 * helpers ([`getAllSessionsWithSemanticModel`](../models/chat.model.ts),
 * [`getChatBySessionIdEfficient`](../models/chat.model.ts)) open Cosmos
 * connections and the test harness cannot stand up a real one. The
 * `__set*ForTesting` shims let the route tests verify the admin gate,
 * response envelope shapes, and error / 404 propagation without booting
 * Cosmos — the actual Cosmos query strings are exercised separately
 * via source-inspection on `ADMIN_SEMANTIC_MODEL_LIST_SELECT`.
 */

import type { Request, Response } from "express";
import { z } from "zod";
import {
  getAllSessionsWithSemanticModel,
  getChatBySessionIdEfficient,
  updateChatDocument,
  type AdminSemanticModelListEntry,
  type ChatDocument,
} from "../models/chat.model.js";
import { getUserDashboards } from "../models/dashboard.model.js";
import {
  semanticDimensionSchema,
  semanticHierarchySchema,
  semanticMetricSchema,
  semanticModelSchema,
  type SemanticDimension,
  type SemanticHierarchy,
  type SemanticMetric,
  type SemanticModel,
} from "../shared/schema.js";
import { isAdminRequest } from "../utils/admin.helper.js";
import { getAuthenticatedEmail } from "../utils/auth.helper.js";
import { withSessionWriteLock } from "../lib/sessionWriteLock.js";
import {
  bumpDimensionsSource,
  bumpHierarchiesSource,
  bumpMetricsSource,
} from "../lib/semantic/semanticModelSourceBump.js";
import {
  appendSemanticModelAuditEntry,
  type SemanticModelAuditEntry,
} from "../lib/semantic/semanticModelAuditLog.js";
import { countSemanticModelReferences } from "../lib/semantic/semanticModelReferences.js";
import { countDashboardReferences } from "../lib/semantic/semanticModelDashboardReferences.js";
import { onSemanticModelVersionBumped } from "../lib/semantic/semanticModelInvalidate.js";

export interface AdminSemanticModelListResponse {
  generatedAt: number;
  sessions: AdminSemanticModelListEntry[];
}

/**
 * Wave W61-detail-schema · projected column shape sent to the admin
 * detail viewer. A deliberate subset of [`DataSummary.columns[]`](../shared/schema.ts)
 * — only `name` + `type` so the wire payload stays small (a 60-column
 * dataset's full `DataSummary.column` shape with `sampleValues` /
 * `topValues` / `dateRange` / etc. is ~50 KB; the projection is ~2 KB).
 * The future W61-edit-column column-picker and W61-edit-references
 * tag-input only need the (name, type) tuple to populate the dropdown
 * and (optionally) filter the candidate list by type.
 */
export interface AdminSemanticModelDatasetColumn {
  name: string;
  type: string;
}

/**
 * Wave W61-detail-schema · the dataset's column inventory at admin
 * read time. Wrapper object rather than a bare array so future
 * dataset-wide signals (e.g., wide-format-transform flags) can land
 * here without re-widening the envelope.
 */
export interface AdminSemanticModelDatasetSchema {
  columns: AdminSemanticModelDatasetColumn[];
}

export interface AdminSemanticModelDetailResponse {
  sessionId: string;
  fileName: string;
  username: string;
  lastUpdatedAt: number;
  model: SemanticModel;
  /**
   * Wave W61-detail-schema · the session's live dataset column list,
   * projected from `doc.dataSummary?.columns`. `null` when the doc has
   * no `dataSummary` (pre-W57 docs were guarded out at the model
   * not-inferred branch, but legacy docs without a populated dataSummary
   * still exist) OR when `dataSummary.columns` is empty. The client's
   * upcoming column-picker / references tag-input UIs should fall back
   * to free-text edit when this is null so legacy sessions remain
   * editable.
   */
  datasetSchema: AdminSemanticModelDatasetSchema | null;
}

/**
 * Wave W61-detail-schema · pure projection of a ChatDocument's
 * `dataSummary.columns` into the wire-projection shape. Exported so
 * tests can drive it directly and so future endpoints (a hypothetical
 * `/admin/sessions/:id/columns` lightweight surface) can reuse it
 * without duplicating the field selection.
 *
 * Returns `null` when the doc has no `dataSummary` field OR when its
 * `columns` array is empty, so the consumer has a single null check
 * rather than two (`?.columns?.length > 0` is the only positive case).
 */
export function projectDatasetSchema(
  doc: Pick<ChatDocument, "dataSummary">,
): AdminSemanticModelDatasetSchema | null {
  const cols = doc.dataSummary?.columns;
  if (!cols || cols.length === 0) return null;
  return {
    columns: cols.map((c) => ({ name: c.name, type: c.type })),
  };
}

/**
 * Wave W61-audit-history-api · response envelope for the dedicated
 * audit-log GET endpoint. Shipped as a sibling endpoint rather than a
 * field on `AdminSemanticModelDetailResponse` because each entry carries
 * a full `SemanticModel` snapshot (~5–50 KB × 10 entries = up to ~500 KB)
 * and bloating every detail-fetch with audit history would 50× the
 * common-case payload for a feature admins only consult occasionally.
 */
export interface AdminSemanticModelAuditLogResponse {
  sessionId: string;
  entries: SemanticModelAuditEntry[];
}

/**
 * Wave W61-references-endpoint (W61-references-dashboards) · response
 * envelope for the downstream chart-reference scan. Returns the entry
 * name verbatim alongside the in-chat `{ chartCount, totalOccurrences }`
 * counts and the cross-dashboard `{ dashboardCount, dashboardTileCount }`
 * counts so the client doesn't need to track which entry it queried
 * against (matters when the UI fires multiple counts in parallel for an
 * "is anything safe to delete?" audit view). `entry` is the trimmed
 * value the server saw, not the raw query-string — protects the client
 * from `?entry=%20foo` disagreements.
 *
 * The W61-references-dashboards wave widened the envelope with the two
 * dashboard counters so the W61-delete-client modal can surface both the
 * in-chat chart impact and the dashboard-tile impact in a single round-
 * trip. Dashboards live in a separate Cosmos container partitioned by
 * username; the handler fetches them via the `_dashboardListerForUser`
 * injectable. A session with no `username` (defensive shape) yields zero
 * dashboard counts without a Cosmos call.
 */
export interface AdminSemanticModelReferencesResponse {
  sessionId: string;
  entry: string;
  chartCount: number;
  totalOccurrences: number;
  dashboardCount: number;
  dashboardTileCount: number;
}

type SemanticModelLister = () => Promise<AdminSemanticModelListEntry[]>;
type SemanticModelDetailFetcher = (
  sessionId: string,
) => Promise<ChatDocument | null>;
type SemanticModelUpdater = (doc: ChatDocument) => Promise<ChatDocument>;
/**
 * Wave W61-references-dashboards · per-username dashboard lister. Distinct
 * injectable from `_detailFetcher` because dashboards live in a different
 * Cosmos container (the "dashboards" container partitioned by username,
 * not the chat document container partitioned by sessionId). The "one
 * injectable per Cosmos container" precedent established here is what
 * any future W61 wave touching dashboards / shared dashboards / past
 * analyses should follow.
 *
 * Returns `ReadonlyArray<unknown>` (not `Dashboard[]`) so the scanner's
 * defensive guards apply uniformly — a malformed Cosmos row that fails
 * to match the runtime shape is silently skipped by the scanner rather
 * than parsed eagerly here. The production `getUserDashboards` already
 * returns `[]` on Cosmos errors so an outage doesn't propagate as a
 * references-endpoint 500.
 */
type DashboardListerForUser = (
  username: string,
) => Promise<ReadonlyArray<unknown>>;

let _lister: SemanticModelLister = getAllSessionsWithSemanticModel;
let _detailFetcher: SemanticModelDetailFetcher = getChatBySessionIdEfficient;
let _updater: SemanticModelUpdater = updateChatDocument;
const _defaultDashboardListerForUser: DashboardListerForUser = async (
  username,
) => {
  if (!username) return [];
  return getUserDashboards(username);
};
let _dashboardListerForUser: DashboardListerForUser =
  _defaultDashboardListerForUser;

/**
 * Test-only · swap the model lister for a deterministic fixture.
 * Pass `null` to restore the production Cosmos-backed helper.
 */
export function __setSemanticModelListerForTesting(
  fn: SemanticModelLister | null,
): void {
  _lister = fn ?? getAllSessionsWithSemanticModel;
}

/**
 * Test-only · swap the detail fetcher for a deterministic fixture.
 * Pass `null` to restore the production Cosmos-backed helper.
 */
export function __setSemanticModelDetailFetcherForTesting(
  fn: SemanticModelDetailFetcher | null,
): void {
  _detailFetcher = fn ?? getChatBySessionIdEfficient;
}

/**
 * Test-only · swap the document updater for a deterministic fixture.
 * Pass `null` to restore the production Cosmos-backed helper.
 */
export function __setSemanticModelUpdaterForTesting(
  fn: SemanticModelUpdater | null,
): void {
  _updater = fn ?? updateChatDocument;
}

/**
 * Wave W61-references-dashboards · test-only · swap the per-username
 * dashboard lister for a deterministic fixture. Pass `null` to restore
 * the production Cosmos-backed helper. Same shape as the existing
 * `__set*ForTesting` shims so harnesses pin every external dependency
 * before driving the handler.
 */
export function __setDashboardListerForUserForTesting(
  fn: DashboardListerForUser | null,
): void {
  _dashboardListerForUser = fn ?? _defaultDashboardListerForUser;
}

export async function listSemanticModels(
  req: Request,
  res: Response,
): Promise<void> {
  if (!isAdminRequest(req)) {
    res.status(403).json({ error: "admin_required" });
    return;
  }
  try {
    const sessions = await _lister();
    const body: AdminSemanticModelListResponse = {
      generatedAt: Date.now(),
      sessions,
    };
    res.json(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`adminSemanticModel list failed: ${msg}`);
    res.status(500).json({ error: "admin_semantic_model_list_failed" });
  }
}

/**
 * Wave W61-save · sentinel for the patch lock result that the outer
 * handler maps to an HTTP status code. Distinguishes the four
 * inside-the-lock outcomes (success / session-not-found /
 * model-not-inferred / update-failed) without throwing — throwing
 * from inside the lock would mark prior callers' chained work as
 * failed and surface as 500 to them.
 */
type PatchResult =
  | { kind: "ok"; model: SemanticModel; lastUpdatedAt: number }
  | { kind: "session_not_found" }
  | { kind: "semantic_model_not_inferred" };

export async function getSemanticModel(
  req: Request,
  res: Response,
): Promise<void> {
  if (!isAdminRequest(req)) {
    res.status(403).json({ error: "admin_required" });
    return;
  }
  const sessionId = String(req.params.sessionId ?? "").trim();
  if (!sessionId) {
    res.status(400).json({ error: "missing_session_id" });
    return;
  }
  try {
    const doc = await _detailFetcher(sessionId);
    if (!doc) {
      res.status(404).json({ error: "session_not_found", sessionId });
      return;
    }
    if (!doc.semanticModel) {
      // 404 not 200-with-null — the admin index only lists sessions whose
      // semanticModel is defined, so reaching this endpoint with a session
      // that lacks one usually means a stale URL or a pre-W57 session.
      res.status(404).json({
        error: "semantic_model_not_inferred",
        sessionId,
      });
      return;
    }
    const body: AdminSemanticModelDetailResponse = {
      sessionId: doc.sessionId,
      fileName: doc.fileName ?? "",
      username: doc.username ?? "",
      lastUpdatedAt: doc.lastUpdatedAt ?? 0,
      model: doc.semanticModel,
      // W61-detail-schema · project the dataset's column inventory
      // into the envelope so the upcoming W61-edit-column +
      // W61-edit-references UIs can populate a column-picker /
      // tag-input from authoritative server state rather than guessing.
      datasetSchema: projectDatasetSchema(doc),
    };
    res.json(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`adminSemanticModel detail failed: ${msg}`);
    res.status(500).json({ error: "admin_semantic_model_detail_failed" });
  }
}

/**
 * Wave W61-save · replace a session's semantic model.
 *
 * Body: a full `SemanticModel` payload. The server overwrites the
 * model wholesale rather than supporting partial patches — admin
 * edits are small and the client already holds the prior model in
 * memory; sending the whole thing keeps the diff logic out of the
 * server. `semanticModelSchema.parse` validates the payload; the
 * server then stamps `version` (incremented from the prior model's
 * version), `updatedAt` (server-side ISO), and `updatedBy` (the
 * authenticated admin's email). The read-modify-write goes through
 * [`withSessionWriteLock`](../lib/sessionWriteLock.ts) per invariant
 * #9 so a concurrent chat-turn-end persist on the same session can't
 * race-corrupt `messages[]`.
 */
export async function patchSemanticModel(
  req: Request,
  res: Response,
): Promise<void> {
  if (!isAdminRequest(req)) {
    res.status(403).json({ error: "admin_required" });
    return;
  }
  const sessionId = String(req.params.sessionId ?? "").trim();
  if (!sessionId) {
    res.status(400).json({ error: "missing_session_id" });
    return;
  }
  const parsed = semanticModelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_semantic_model",
      issues: parsed.error.issues.slice(0, 10).map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }
  const updatedBy = getAuthenticatedEmail(req) ?? "unknown";
  try {
    const result = await withSessionWriteLock<PatchResult>(
      sessionId,
      async () => {
        const doc = await _detailFetcher(sessionId);
        if (!doc) return { kind: "session_not_found" };
        if (!doc.semanticModel) {
          return { kind: "semantic_model_not_inferred" };
        }
        const nextVersion = (doc.semanticModel.version ?? 0) + 1;
        // W61-source-bump · per-entry content-hash diff against the
        // prior model. Unchanged entries preserve their prior source
        // ("auto" stays "auto", "domain" stays "domain"); changed and
        // new entries get `source: "user"` so the planner's prompt
        // block can weight manually-corrected entries higher.
        const nextMetrics = bumpMetricsSource(
          parsed.data.metrics,
          doc.semanticModel.metrics,
        );
        const nextDimensions = bumpDimensionsSource(
          parsed.data.dimensions,
          doc.semanticModel.dimensions,
        );
        const nextHierarchies = bumpHierarchiesSource(
          parsed.data.hierarchies,
          doc.semanticModel.hierarchies,
        );
        const nextModel: SemanticModel = {
          ...parsed.data,
          metrics: nextMetrics,
          dimensions: nextDimensions,
          hierarchies: nextHierarchies,
          version: nextVersion,
          updatedAt: new Date().toISOString(),
          updatedBy,
        };
        // W61-audit-log · snap the prior model into the doc's audit
        // ring buffer BEFORE the overwrite. The entry timestamp uses
        // the same `Date.now()` as `lastUpdatedAt` so a future history
        // UI can correlate the two without clock-skew confusion.
        const savedAt = Date.now();
        doc.semanticModelAuditLog = appendSemanticModelAuditEntry(
          doc.semanticModelAuditLog,
          {
            savedAt,
            savedBy: updatedBy,
            priorVersion: doc.semanticModel.version ?? 0,
            priorModel: doc.semanticModel,
          },
        );
        doc.semanticModel = nextModel;
        doc.lastUpdatedAt = savedAt;
        const saved = await _updater(doc);
        // W61-cache-invalidate · fire the version-bump observability
        // hook AFTER the persist completes but still inside the write
        // lock — future invalidators (cache.clear()) are serialized
        // with the write they invalidate against. Listeners that
        // throw are caught upstream so a buggy invalidator can't
        // break this path.
        onSemanticModelVersionBumped({
          sessionId,
          priorVersion: nextVersion - 1,
          nextVersion,
        });
        return {
          kind: "ok",
          model: saved.semanticModel ?? nextModel,
          lastUpdatedAt: saved.lastUpdatedAt ?? doc.lastUpdatedAt,
        };
      },
    );
    if (result.kind === "session_not_found") {
      res.status(404).json({ error: "session_not_found", sessionId });
      return;
    }
    if (result.kind === "semantic_model_not_inferred") {
      res
        .status(404)
        .json({ error: "semantic_model_not_inferred", sessionId });
      return;
    }
    res.json({
      sessionId,
      lastUpdatedAt: result.lastUpdatedAt,
      model: result.model,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`adminSemanticModel patch failed: ${msg}`);
    res.status(500).json({ error: "admin_semantic_model_patch_failed" });
  }
}

/**
 * Wave W61-audit-history-api · expose the W61-audit-log ring buffer over
 * a dedicated read-only endpoint. Returns the buffer newest-first (the
 * append helper's invariant) so a future history-tab UI renders entry
 * `[0]` as "most recent" without inverting.
 *
 * Why a separate endpoint rather than widening
 * `AdminSemanticModelDetailResponse` — see
 * {@link AdminSemanticModelAuditLogResponse} doc.
 *
 * Why we still 404 when the session has no `semanticModel`: a session
 * that never had a model inferred cannot have an audit log either
 * (W61-audit-log only writes entries on PATCH, and PATCH 404s on
 * missing model). Returning a different error code for the audit-log
 * endpoint would force the UI to handle two "pre-W57" branches; the
 * 404 here mirrors `getSemanticModel`'s 404 for the same condition.
 *
 * Why we re-use `_detailFetcher` rather than a new injectable — the
 * read path is the same Cosmos call (fetch the full doc by sessionId);
 * a separate fetcher would just be the same function under a different
 * name and would double the surface for test fakes.
 */
export async function getSemanticModelAuditLog(
  req: Request,
  res: Response,
): Promise<void> {
  if (!isAdminRequest(req)) {
    res.status(403).json({ error: "admin_required" });
    return;
  }
  const sessionId = String(req.params.sessionId ?? "").trim();
  if (!sessionId) {
    res.status(400).json({ error: "missing_session_id" });
    return;
  }
  try {
    const doc = await _detailFetcher(sessionId);
    if (!doc) {
      res.status(404).json({ error: "session_not_found", sessionId });
      return;
    }
    if (!doc.semanticModel) {
      res.status(404).json({
        error: "semantic_model_not_inferred",
        sessionId,
      });
      return;
    }
    const body: AdminSemanticModelAuditLogResponse = {
      sessionId: doc.sessionId,
      entries: doc.semanticModelAuditLog ?? [],
    };
    res.json(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`adminSemanticModel audit-log fetch failed: ${msg}`);
    res
      .status(500)
      .json({ error: "admin_semantic_model_audit_log_failed" });
  }
}

/**
 * Wave W61-audit-revert · body schema for the revert endpoint.
 *
 * `auditEntryIndex` is 0-indexed against the newest-first
 * `doc.semanticModelAuditLog` buffer (so `0` = revert to the most
 * recent prior, i.e. "undo my last save"). `nonnegative` + `int`
 * rejects floats and negatives at the schema boundary so the handler
 * doesn't need a separate range check; the upper-bound check against
 * the actual buffer length happens inside the lock so it sees the
 * authoritative server-side state, not a stale client view.
 */
const revertBodySchema = z.object({
  auditEntryIndex: z.number().int().nonnegative(),
});

/**
 * Wave W61-audit-revert · server-side one-call revert that consumes
 * the W61-audit-log ring buffer and the W61-audit-history-api read
 * surface. Saves the future history-tab UI from doing a separate
 * fetch-then-PATCH dance.
 *
 * The chosen entry's `priorModel` becomes the new live model with
 * `version` bumped (monotonic — reverting to "the state of version 3"
 * makes the live model `current+1` with the contents of v3; the
 * version field stays monotonic because W64's compiled-query cache
 * keys on it). `updatedAt` / `updatedBy` are stamped fresh so the
 * model itself records the reverting admin's identity. The
 * about-to-be-overwritten model is appended to the audit log as the
 * new newest entry so "undo this revert" works without losing the
 * intermediate state.
 *
 * **Why we skip W61-source-bump's per-entry diff on revert.** The
 * bumper's semantic is "admin edited this entry → bump to user". A
 * revert's semantic is "restore as-was" — every entry should keep its
 * snapshot-time `source` field. Running the bumper would stamp every
 * entry that differs between the snapshot and the current as `"user"`
 * (wrong: those entries should restore to their snapshot source,
 * which may have been `"auto"` or `"domain"`). The model-level
 * `updatedBy` still records the reverting admin (preserves
 * attribution at the model level) but the per-entry source comes
 * verbatim from the snapshot.
 *
 * **Why bound-check inside the lock.** A multi-admin race could have
 * one admin add a save (growing the buffer) while another is mid-
 * revert; reading the buffer before the lock would let the revert
 * target a now-stale index. Inside the lock the buffer length is
 * authoritative.
 *
 * **Why the audit-log write happens unconditionally.** Reverting IS
 * a state change; preserving the just-overwritten model in the
 * buffer is required for "undo this revert" to work. If the buffer
 * is at cap (10 entries), the prepend grows it to 11 then trims to
 * 10 — the entry we just consumed (the user's chosen `auditEntryIndex`)
 * might be the one dropped if it was at index 9, but that's fine
 * because we already used it. Subsequent reverts target indices in
 * the new buffer, which always includes the just-overwritten state.
 */
type RevertResult =
  | { kind: "ok"; model: SemanticModel; lastUpdatedAt: number }
  | { kind: "session_not_found" }
  | { kind: "semantic_model_not_inferred" }
  | { kind: "audit_entry_not_found" };

export async function revertSemanticModel(
  req: Request,
  res: Response,
): Promise<void> {
  if (!isAdminRequest(req)) {
    res.status(403).json({ error: "admin_required" });
    return;
  }
  const sessionId = String(req.params.sessionId ?? "").trim();
  if (!sessionId) {
    res.status(400).json({ error: "missing_session_id" });
    return;
  }
  const parsed = revertBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_audit_entry_index",
      issues: parsed.error.issues.slice(0, 10).map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }
  const updatedBy = getAuthenticatedEmail(req) ?? "unknown";
  try {
    const result = await withSessionWriteLock<RevertResult>(
      sessionId,
      async () => {
        const doc = await _detailFetcher(sessionId);
        if (!doc) return { kind: "session_not_found" };
        if (!doc.semanticModel) {
          return { kind: "semantic_model_not_inferred" };
        }
        const log = doc.semanticModelAuditLog ?? [];
        if (parsed.data.auditEntryIndex >= log.length) {
          return { kind: "audit_entry_not_found" };
        }
        const entry = log[parsed.data.auditEntryIndex];
        const nextVersion = (doc.semanticModel.version ?? 0) + 1;
        const nextModel: SemanticModel = {
          ...entry.priorModel,
          version: nextVersion,
          updatedAt: new Date().toISOString(),
          updatedBy,
        };
        const savedAt = Date.now();
        doc.semanticModelAuditLog = appendSemanticModelAuditEntry(log, {
          savedAt,
          savedBy: updatedBy,
          priorVersion: doc.semanticModel.version ?? 0,
          priorModel: doc.semanticModel,
        });
        doc.semanticModel = nextModel;
        doc.lastUpdatedAt = savedAt;
        const saved = await _updater(doc);
        // W61-cache-invalidate · fire the version-bump hook (see
        // patchSemanticModel for the contract). Revert is a real
        // mutation — version bumps monotonically even when the
        // "restored" model is byte-identical to the prior — so the
        // hook fires.
        onSemanticModelVersionBumped({
          sessionId,
          priorVersion: nextVersion - 1,
          nextVersion,
        });
        return {
          kind: "ok",
          model: saved.semanticModel ?? nextModel,
          lastUpdatedAt: saved.lastUpdatedAt ?? doc.lastUpdatedAt,
        };
      },
    );
    if (result.kind === "session_not_found") {
      res.status(404).json({ error: "session_not_found", sessionId });
      return;
    }
    if (result.kind === "semantic_model_not_inferred") {
      res
        .status(404)
        .json({ error: "semantic_model_not_inferred", sessionId });
      return;
    }
    if (result.kind === "audit_entry_not_found") {
      res.status(404).json({
        error: "audit_entry_not_found",
        sessionId,
        auditEntryIndex: parsed.data.auditEntryIndex,
      });
      return;
    }
    res.json({
      sessionId,
      lastUpdatedAt: result.lastUpdatedAt,
      model: result.model,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`adminSemanticModel revert failed: ${msg}`);
    res.status(500).json({ error: "admin_semantic_model_revert_failed" });
  }
}

/**
 * Wave W61-references-endpoint · count how many persisted charts on a
 * session reference a given semantic-model entry name (metric /
 * dimension / hierarchy). Foundation for the upcoming W61-delete-entry
 * confirmation prompt that warns admins before destructively removing
 * an entry that downstream charts depend on.
 *
 *   GET /admin/semantic-models/:sessionId/references?entry=<name>
 *
 * Returns 404 on a missing session OR a session that has no
 * semanticModel — same shape as `getSemanticModel` so the UI handles
 * one not-found branch, not two. Returns 400 on a missing `entry`
 * query param (empty / whitespace / non-string).
 *
 * Why a GET endpoint, not POST: this is an idempotent read. A GET
 * lets the UI cache the count via standard HTTP semantics + lets the
 * admin paste the URL to share a "this metric is used N places"
 * link without crafting a body.
 *
 * Why we walk `doc.charts ?? []` (not `doc.messages[].charts[]`):
 * `doc.charts[]` is the dedup-merged authoritative list per the
 * chat-model save path (see [chat.model.ts:55](../models/chat.model.ts)).
 * Per-message `charts[]` arrays are merged into the top-level list
 * by the same save path; walking both would double-count. Blob-stored
 * charts via `doc.chartReferences[]` are NOT scanned (the blob fetch
 * would turn a free count into a multi-second request) — a future
 * enhancement could load blob charts on-demand for sessions that
 * exceeded the in-doc threshold.
 *
 * Why we re-use `_detailFetcher` rather than a new injectable: same
 * Cosmos call as `getSemanticModel` / `getSemanticModelAuditLog`;
 * sharing the injectable halves the test-fake surface.
 *
 * Why we return `entry` (the server-trimmed value) in the envelope:
 * `?entry=%20foo` would arrive as `" foo"` and trim to `"foo"`; the
 * client can compare the response's `entry` against its own state
 * without re-implementing the trim rule.
 */
export async function getSemanticModelReferences(
  req: Request,
  res: Response,
): Promise<void> {
  if (!isAdminRequest(req)) {
    res.status(403).json({ error: "admin_required" });
    return;
  }
  const sessionId = String(req.params.sessionId ?? "").trim();
  if (!sessionId) {
    res.status(400).json({ error: "missing_session_id" });
    return;
  }
  const entryRaw = req.query.entry;
  const entry = typeof entryRaw === "string" ? entryRaw.trim() : "";
  if (!entry) {
    res.status(400).json({ error: "missing_entry" });
    return;
  }
  try {
    const doc = await _detailFetcher(sessionId);
    if (!doc) {
      res.status(404).json({ error: "session_not_found", sessionId });
      return;
    }
    if (!doc.semanticModel) {
      res.status(404).json({
        error: "semantic_model_not_inferred",
        sessionId,
      });
      return;
    }
    const counts = countSemanticModelReferences(entry, doc.charts ?? []);
    // W61-references-dashboards · widen to count tiles across the
    // session-owner's dashboards. Dashboards live in a separate Cosmos
    // container partitioned by username (not sessionId), so we cannot
    // re-use `_detailFetcher`; the dedicated `_dashboardListerForUser`
    // injectable matches the "one injectable per Cosmos container"
    // precedent. An empty / missing `doc.username` short-circuits the
    // fetch to an empty array (the chat doc was created without a user,
    // which has happened historically for system-test sessions).
    const username = doc.username ?? "";
    const dashboards = username
      ? await _dashboardListerForUser(username)
      : [];
    const dashboardCounts = countDashboardReferences(entry, dashboards);
    const body: AdminSemanticModelReferencesResponse = {
      sessionId: doc.sessionId,
      entry,
      chartCount: counts.chartCount,
      totalOccurrences: counts.totalOccurrences,
      dashboardCount: dashboardCounts.dashboardCount,
      dashboardTileCount: dashboardCounts.dashboardTileCount,
    };
    res.json(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`adminSemanticModel references failed: ${msg}`);
    res
      .status(500)
      .json({ error: "admin_semantic_model_references_failed" });
  }
}

/**
 * Wave W61-delete-server · path-param literal-union schema for the
 * delete endpoint's `:kind` segment. Rejects anything that isn't
 * `metric` / `dimension` / `hierarchy` at the schema boundary so the
 * handler doesn't need a separate validation branch and the 400 error
 * surface includes the zod issue with the path-param name.
 */
const deleteEntryKindSchema = z.enum(["metric", "dimension", "hierarchy"]);
export type AdminSemanticModelEntryKind = z.infer<typeof deleteEntryKindSchema>;

/**
 * Wave W61-delete-server · sentinel for the delete lock result that
 * the outer handler maps to an HTTP status code. Distinguishes the
 * four inside-the-lock outcomes (success / session-not-found /
 * model-not-inferred / entry-not-found) without throwing — throwing
 * from inside the lock would mark prior callers' chained work as
 * failed and surface as 500 to them.
 */
type DeleteResult =
  | { kind: "ok"; model: SemanticModel; lastUpdatedAt: number }
  | { kind: "session_not_found" }
  | { kind: "semantic_model_not_inferred" }
  | { kind: "entry_not_found" };

/**
 * Wave W61-delete-server · remove a single metric / dimension /
 * hierarchy from a session's semantic model. Mirrors the
 * W61-audit-revert shape: writes the prior model to the audit log
 * inside the existing `withSessionWriteLock` before the destructive
 * op, bumps `version` monotonically, returns the same `{ sessionId,
 * lastUpdatedAt, model }` envelope as W61-save / W61-audit-revert
 * so the client mutation reuses the existing success handler.
 *
 *   DELETE /admin/semantic-models/:sessionId/entries/:kind/:name
 *
 * Where `:kind ∈ { "metric" | "dimension" | "hierarchy" }` and
 * `:name` is the entry's `name` field (URL-decoded by Express).
 *
 * Why a three-segment path with explicit `:kind`: a metric named
 * `"revenue"` and a dimension named `"revenue"` are different
 * resources, and the semantic model doesn't forbid name collisions
 * across kinds. Requiring `:kind` in the URL makes the operation
 * unambiguous and prevents accidental cross-kind deletes (a fuzzy
 * "find this name in any collection and delete it" would silently
 * delete the wrong thing when a collision exists).
 *
 * Why audit-write before delete (not after): the buffer's role is
 * to remember what was just lost. If the audit-write happened after
 * the delete, a crash between the two would lose forensics. Inside
 * `withSessionWriteLock` the pair is atomic at the per-session
 * level (per invariant #9).
 *
 * Why we bump `version` even though we removed something: the
 * version is W64's compiled-query cache key. Removing a metric
 * invalidates any cached compilation that referenced it; bumping
 * makes the cache miss explicit.
 *
 * Why we do NOT run `bumpMetricsSource` / `bumpDimensionsSource` /
 * `bumpHierarchiesSource` on the survivors: the surviving entries
 * are unchanged by this operation (their `name` / `label` /
 * `expression` / etc. are byte-identical to their prior selves).
 * Running the bumper would be a no-op for unchanged entries (the
 * bumper's content-hash diff would match), so skipping is
 * semantically equivalent. Mirrors the W61-audit-revert "skip
 * source-bump because the entries aren't being edited" precedent.
 *
 * Why the audit-log write happens unconditionally on success: a
 * delete IS a state change; preserving the just-deleted entry in
 * the buffer is required for "undo this delete via revert" to work.
 * If the buffer is at cap (10 entries), the prepend grows to 11
 * then trims to 10 — same cap behaviour as W61-audit-log.
 */
export async function deleteSemanticModelEntry(
  req: Request,
  res: Response,
): Promise<void> {
  if (!isAdminRequest(req)) {
    res.status(403).json({ error: "admin_required" });
    return;
  }
  const sessionId = String(req.params.sessionId ?? "").trim();
  if (!sessionId) {
    res.status(400).json({ error: "missing_session_id" });
    return;
  }
  const parsedKind = deleteEntryKindSchema.safeParse(req.params.kind);
  if (!parsedKind.success) {
    res.status(400).json({
      error: "invalid_kind",
      kind: req.params.kind,
      allowed: deleteEntryKindSchema.options,
    });
    return;
  }
  const entryName = String(req.params.name ?? "").trim();
  if (!entryName) {
    res.status(400).json({ error: "missing_entry_name" });
    return;
  }
  const updatedBy = getAuthenticatedEmail(req) ?? "unknown";
  try {
    const result = await withSessionWriteLock<DeleteResult>(
      sessionId,
      async () => {
        const doc = await _detailFetcher(sessionId);
        if (!doc) return { kind: "session_not_found" };
        if (!doc.semanticModel) {
          return { kind: "semantic_model_not_inferred" };
        }
        const model = doc.semanticModel;
        let nextMetrics = model.metrics;
        let nextDimensions = model.dimensions;
        let nextHierarchies = model.hierarchies;
        let removed = false;
        if (parsedKind.data === "metric") {
          const filtered = model.metrics.filter((m) => m.name !== entryName);
          if (filtered.length === model.metrics.length) {
            return { kind: "entry_not_found" };
          }
          nextMetrics = filtered;
          removed = true;
        } else if (parsedKind.data === "dimension") {
          const filtered = model.dimensions.filter(
            (d) => d.name !== entryName,
          );
          if (filtered.length === model.dimensions.length) {
            return { kind: "entry_not_found" };
          }
          nextDimensions = filtered;
          removed = true;
        } else {
          const filtered = model.hierarchies.filter(
            (h) => h.name !== entryName,
          );
          if (filtered.length === model.hierarchies.length) {
            return { kind: "entry_not_found" };
          }
          nextHierarchies = filtered;
          removed = true;
        }
        // Safety pin: the early returns above guarantee `removed` is
        // true on every success path. Asserting it here would be
        // dead code; the variable lives so a future refactor that
        // adds a fourth kind reads as "set `removed` in the new branch
        // too".
        void removed;
        const nextVersion = (model.version ?? 0) + 1;
        const nextModel: SemanticModel = {
          ...model,
          metrics: nextMetrics,
          dimensions: nextDimensions,
          hierarchies: nextHierarchies,
          version: nextVersion,
          updatedAt: new Date().toISOString(),
          updatedBy,
        };
        const savedAt = Date.now();
        doc.semanticModelAuditLog = appendSemanticModelAuditEntry(
          doc.semanticModelAuditLog,
          {
            savedAt,
            savedBy: updatedBy,
            priorVersion: model.version ?? 0,
            priorModel: model,
          },
        );
        doc.semanticModel = nextModel;
        doc.lastUpdatedAt = savedAt;
        const saved = await _updater(doc);
        // W61-cache-invalidate · fire the version-bump hook (see
        // patchSemanticModel for the contract). Delete is a real
        // mutation — survivors are byte-identical but the model's
        // entry-set narrowed, so the planner's catalog block changes
        // and downstream caches keyed on version must invalidate.
        onSemanticModelVersionBumped({
          sessionId,
          priorVersion: nextVersion - 1,
          nextVersion,
        });
        return {
          kind: "ok",
          model: saved.semanticModel ?? nextModel,
          lastUpdatedAt: saved.lastUpdatedAt ?? doc.lastUpdatedAt,
        };
      },
    );
    if (result.kind === "session_not_found") {
      res.status(404).json({ error: "session_not_found", sessionId });
      return;
    }
    if (result.kind === "semantic_model_not_inferred") {
      res
        .status(404)
        .json({ error: "semantic_model_not_inferred", sessionId });
      return;
    }
    if (result.kind === "entry_not_found") {
      res.status(404).json({
        error: "entry_not_found",
        sessionId,
        kind: parsedKind.data,
        name: entryName,
      });
      return;
    }
    res.json({
      sessionId,
      lastUpdatedAt: result.lastUpdatedAt,
      model: result.model,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`adminSemanticModel delete failed: ${msg}`);
    res.status(500).json({ error: "admin_semantic_model_delete_failed" });
  }
}

/**
 * Wave W61-add-server · sentinel for the add lock result that the outer
 * handler maps to an HTTP status code. Distinguishes the four
 * inside-the-lock outcomes (success / session-not-found /
 * model-not-inferred / name-already-exists) without throwing — mirrors
 * the PatchResult / RevertResult / DeleteResult precedent.
 */
type AddResult =
  | { kind: "ok"; model: SemanticModel; lastUpdatedAt: number }
  | { kind: "session_not_found" }
  | { kind: "semantic_model_not_inferred" }
  | { kind: "name_already_exists" };

/**
 * Wave W61-add-server · append a single metric / dimension / hierarchy
 * to a session's semantic model. Mirrors W61-delete-server's shape:
 * writes the prior model to the audit log inside the existing
 * `withSessionWriteLock` BEFORE the additive op, bumps `version`
 * monotonically, returns the same `{ sessionId, lastUpdatedAt, model }`
 * envelope as W61-save / W61-audit-revert / W61-delete-server so the
 * client mutation reuses the existing success handler.
 *
 *   POST /admin/semantic-models/:sessionId/entries/:kind
 *   Body: a single entry matching the kind-appropriate zod schema
 *         (semanticMetricSchema / semanticDimensionSchema /
 *          semanticHierarchySchema)
 *
 * Where `:kind ∈ { "metric" | "dimension" | "hierarchy" }`.
 *
 * Why a dedicated POST rather than re-using W61-save's PATCH: the
 * PATCH path replaces the wholesale model, which forces the client to
 * (a) round-trip the entire model and (b) re-implement name-uniqueness
 * validation locally. A typed POST takes just the new entry, validates
 * uniqueness server-side, and returns the same envelope.
 *
 * Why we reject same-kind name collisions with 409 rather than
 * silently overwriting: admins use PATCH for "edit an existing entry";
 * POST is unambiguously "add new". Overwrite semantics on POST would
 * confuse the audit log (the "prior" snapshot would not include the
 * entry being replaced) and would defeat the safety net of the
 * cross-kind name check.
 *
 * Why cross-kind name collisions are allowed: a metric named "revenue"
 * and a dimension named "revenue" are different resources — the
 * planner addresses them via {kind, name} not {name} alone. The
 * uniqueness check is scoped to the kind's own collection.
 *
 * Why we skip the source-bumper: same reasoning as W61-delete-server.
 * Survivors are byte-identical (we're appending, not editing), and
 * the new entry has no prior version to content-diff against. The
 * schema's `.default("user")` populates the new entry's source if
 * the client doesn't send one; if the client sends `"domain"` (e.g.,
 * importing from a pack) it's preserved verbatim.
 *
 * Why audit-write before append: same precedent as W61-save / revert /
 * delete. The buffer's role is to remember what was just changed; the
 * pair is atomic inside `withSessionWriteLock` per invariant #9.
 *
 * Why bump `version` on add: same as delete. W64's compiled-query
 * cache keys on version; adding a new metric can affect compilation
 * of queries that reference it (lint warnings, etc.); bumping makes
 * the cache miss explicit.
 */
export async function addSemanticModelEntry(
  req: Request,
  res: Response,
): Promise<void> {
  if (!isAdminRequest(req)) {
    res.status(403).json({ error: "admin_required" });
    return;
  }
  const sessionId = String(req.params.sessionId ?? "").trim();
  if (!sessionId) {
    res.status(400).json({ error: "missing_session_id" });
    return;
  }
  const parsedKind = deleteEntryKindSchema.safeParse(req.params.kind);
  if (!parsedKind.success) {
    res.status(400).json({
      error: "invalid_kind",
      kind: req.params.kind,
      allowed: deleteEntryKindSchema.options,
    });
    return;
  }
  // Pick the kind-appropriate body schema. Each returns a fully-defaulted
  // entry on success (source defaults to "user", exposed to true, etc.),
  // so the handler doesn't need to fill in any fields post-parse.
  const bodySchema =
    parsedKind.data === "metric"
      ? semanticMetricSchema
      : parsedKind.data === "dimension"
        ? semanticDimensionSchema
        : semanticHierarchySchema;
  const parsedBody = bodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    res.status(400).json({
      error: "invalid_entry",
      kind: parsedKind.data,
      issues: parsedBody.error.issues.slice(0, 10).map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }
  const updatedBy = getAuthenticatedEmail(req) ?? "unknown";
  try {
    const result = await withSessionWriteLock<AddResult>(
      sessionId,
      async () => {
        const doc = await _detailFetcher(sessionId);
        if (!doc) return { kind: "session_not_found" };
        if (!doc.semanticModel) {
          return { kind: "semantic_model_not_inferred" };
        }
        const model = doc.semanticModel;
        let nextMetrics = model.metrics;
        let nextDimensions = model.dimensions;
        let nextHierarchies = model.hierarchies;
        if (parsedKind.data === "metric") {
          const entry = parsedBody.data as SemanticMetric;
          if (model.metrics.some((m) => m.name === entry.name)) {
            return { kind: "name_already_exists" };
          }
          nextMetrics = [...model.metrics, entry];
        } else if (parsedKind.data === "dimension") {
          const entry = parsedBody.data as SemanticDimension;
          if (model.dimensions.some((d) => d.name === entry.name)) {
            return { kind: "name_already_exists" };
          }
          nextDimensions = [...model.dimensions, entry];
        } else {
          const entry = parsedBody.data as SemanticHierarchy;
          if (model.hierarchies.some((h) => h.name === entry.name)) {
            return { kind: "name_already_exists" };
          }
          nextHierarchies = [...model.hierarchies, entry];
        }
        const nextVersion = (model.version ?? 0) + 1;
        const nextModel: SemanticModel = {
          ...model,
          metrics: nextMetrics,
          dimensions: nextDimensions,
          hierarchies: nextHierarchies,
          version: nextVersion,
          updatedAt: new Date().toISOString(),
          updatedBy,
        };
        const savedAt = Date.now();
        doc.semanticModelAuditLog = appendSemanticModelAuditEntry(
          doc.semanticModelAuditLog,
          {
            savedAt,
            savedBy: updatedBy,
            priorVersion: model.version ?? 0,
            priorModel: model,
          },
        );
        doc.semanticModel = nextModel;
        doc.lastUpdatedAt = savedAt;
        const saved = await _updater(doc);
        // W61-cache-invalidate · fire the version-bump hook (see
        // patchSemanticModel for the contract). Add appends one
        // entry; survivors are byte-identical but the model's
        // entry-set widened, so the planner's catalog block changes
        // and downstream caches keyed on version must invalidate.
        onSemanticModelVersionBumped({
          sessionId,
          priorVersion: nextVersion - 1,
          nextVersion,
        });
        return {
          kind: "ok",
          model: saved.semanticModel ?? nextModel,
          lastUpdatedAt: saved.lastUpdatedAt ?? doc.lastUpdatedAt,
        };
      },
    );
    if (result.kind === "session_not_found") {
      res.status(404).json({ error: "session_not_found", sessionId });
      return;
    }
    if (result.kind === "semantic_model_not_inferred") {
      res
        .status(404)
        .json({ error: "semantic_model_not_inferred", sessionId });
      return;
    }
    if (result.kind === "name_already_exists") {
      // 409 Conflict per HTTP semantics — the request conflicts with the
      // current state of the resource (an entry of this kind+name
      // already exists). Distinct from 404 (resource missing) which the
      // W61-revert / W61-delete endpoints use for *_not_found outcomes.
      res.status(409).json({
        error: "name_already_exists",
        sessionId,
        kind: parsedKind.data,
        name: parsedBody.data.name,
      });
      return;
    }
    res.json({
      sessionId,
      lastUpdatedAt: result.lastUpdatedAt,
      model: result.model,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`adminSemanticModel add failed: ${msg}`);
    res.status(500).json({ error: "admin_semantic_model_add_failed" });
  }
}
