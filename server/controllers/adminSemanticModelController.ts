/**
 * Wave W61-list · admin endpoints for the W57-inferred semantic model.
 *
 *   GET   /api/admin/semantic-models           — list every session with a model
 *   GET   /api/admin/semantic-models/:sessionId — (W61-detail, future) the full payload
 *   PATCH /api/admin/semantic-models/:sessionId — (W61-save, future) replace the model
 *
 * All gated by `isAdminRequest()` (the consolidated SUPERADMIN_EMAILS
 * allowlist; see [admin.helper.ts](../utils/admin.helper.ts)).
 *
 * Why an injectable `_lister`: the underlying model helper
 * [`getAllSessionsWithSemanticModel`](../models/chat.model.ts) opens a
 * Cosmos connection and the test harness cannot stand up a real one. The
 * `__setSemanticModelListerForTesting` shim lets the route test verify
 * (i) the admin gate, (ii) the response envelope shape, and (iii) error
 * propagation without booting Cosmos — the actual query is exercised
 * separately via source-inspection on `ADMIN_SEMANTIC_MODEL_LIST_SELECT`.
 */

import type { Request, Response } from "express";
import {
  getAllSessionsWithSemanticModel,
  type AdminSemanticModelListEntry,
} from "../models/chat.model.js";
import { isAdminRequest } from "../utils/admin.helper.js";

export interface AdminSemanticModelListResponse {
  generatedAt: number;
  sessions: AdminSemanticModelListEntry[];
}

type SemanticModelLister = () => Promise<AdminSemanticModelListEntry[]>;

let _lister: SemanticModelLister = getAllSessionsWithSemanticModel;

/**
 * Test-only · swap the model lister for a deterministic fixture.
 * Pass `null` to restore the production Cosmos-backed helper.
 */
export function __setSemanticModelListerForTesting(
  fn: SemanticModelLister | null,
): void {
  _lister = fn ?? getAllSessionsWithSemanticModel;
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
