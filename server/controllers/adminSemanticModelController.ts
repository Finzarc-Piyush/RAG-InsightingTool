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
