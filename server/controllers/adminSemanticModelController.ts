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
import { semanticModelSchema, type SemanticModel } from "../shared/schema.js";
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

export interface AdminSemanticModelListResponse {
  generatedAt: number;
  sessions: AdminSemanticModelListEntry[];
}

export interface AdminSemanticModelDetailResponse {
  sessionId: string;
  fileName: string;
  username: string;
  lastUpdatedAt: number;
  model: SemanticModel;
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
 * Wave W61-references-endpoint · response envelope for the downstream
 * chart-reference scan. Returns the entry name verbatim alongside the
 * `{ chartCount, totalOccurrences }` counts so the client doesn't need
 * to track which entry it queried against (matters when the UI fires
 * multiple counts in parallel for a "is anything safe to delete?"
 * audit view). `entry` is the trimmed value the server saw, not the
 * raw query-string — protects the client from `?entry=%20foo`
 * disagreements.
 */
export interface AdminSemanticModelReferencesResponse {
  sessionId: string;
  entry: string;
  chartCount: number;
  totalOccurrences: number;
}

type SemanticModelLister = () => Promise<AdminSemanticModelListEntry[]>;
type SemanticModelDetailFetcher = (
  sessionId: string,
) => Promise<ChatDocument | null>;
type SemanticModelUpdater = (doc: ChatDocument) => Promise<ChatDocument>;

let _lister: SemanticModelLister = getAllSessionsWithSemanticModel;
let _detailFetcher: SemanticModelDetailFetcher = getChatBySessionIdEfficient;
let _updater: SemanticModelUpdater = updateChatDocument;

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
    const body: AdminSemanticModelReferencesResponse = {
      sessionId: doc.sessionId,
      entry,
      chartCount: counts.chartCount,
      totalOccurrences: counts.totalOccurrences,
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
