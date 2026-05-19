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
  type AdminSemanticModelListEntry,
  type ChatDocument,
} from "../models/chat.model.js";
import type { SemanticModel } from "../shared/schema.js";
import { isAdminRequest } from "../utils/admin.helper.js";

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

type SemanticModelLister = () => Promise<AdminSemanticModelListEntry[]>;
type SemanticModelDetailFetcher = (
  sessionId: string,
) => Promise<ChatDocument | null>;

let _lister: SemanticModelLister = getAllSessionsWithSemanticModel;
let _detailFetcher: SemanticModelDetailFetcher = getChatBySessionIdEfficient;

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
