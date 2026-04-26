/**
 * WD8 · Admin endpoints for domain context packs.
 *
 *   GET   /api/admin/domain-context/packs
 *   PATCH /api/admin/domain-context/packs/:packId    body: { enabled: boolean }
 *
 * Both gated by `isAdminRequest()` (ADMIN_EMAILS env allow-list). PATCH
 * invalidates the loader cache so the next chat turn reflects the new state.
 */

import type { Request, Response } from "express";
import { isAdminRequest } from "../utils/admin.helper.js";
import { getAuthenticatedEmail } from "../utils/auth.helper.js";
import {
  loadEnabledDomainContext,
  invalidateDomainContextCache,
} from "../lib/domainContext/loadEnabledDomainContext.js";
import { setPackEnabled } from "../models/domainContextToggles.model.js";

export interface AdminDomainContextPacksResponse {
  generatedAt: number;
  totalEnabledTokens: number;
  packs: Array<{
    id: string;
    title: string;
    category: string;
    priority: number;
    version: string;
    approxTokens: number;
    enabled: boolean;
    defaultEnabled: boolean;
  }>;
}

export async function listDomainContextPacks(req: Request, res: Response): Promise<void> {
  if (!isAdminRequest(req)) {
    res.status(403).json({ error: "admin_required" });
    return;
  }
  try {
    const { packs, totalEnabledTokens } = await loadEnabledDomainContext();
    const body: AdminDomainContextPacksResponse = {
      generatedAt: Date.now(),
      totalEnabledTokens,
      packs,
    };
    res.json(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`adminDomainContext list failed: ${msg}`);
    res.status(500).json({ error: "admin_domain_context_list_failed" });
  }
}

export async function setDomainContextPackEnabled(
  req: Request,
  res: Response
): Promise<void> {
  if (!isAdminRequest(req)) {
    res.status(403).json({ error: "admin_required" });
    return;
  }
  const packId = String(req.params.packId || "").trim();
  if (!packId) {
    res.status(400).json({ error: "missing_pack_id" });
    return;
  }
  const body = (req.body ?? {}) as { enabled?: unknown };
  if (typeof body.enabled !== "boolean") {
    res.status(400).json({ error: "enabled_must_be_boolean" });
    return;
  }
  try {
    const { packs } = await loadEnabledDomainContext();
    const pack = packs.find((p) => p.id === packId);
    if (!pack) {
      res.status(404).json({ error: "unknown_pack_id", packId });
      return;
    }
    const by = getAuthenticatedEmail(req) ?? "unknown";
    await setPackEnabled(packId, body.enabled, by);
    invalidateDomainContextCache();
    const refreshed = await loadEnabledDomainContext();
    const updated = refreshed.packs.find((p) => p.id === packId);
    res.json({ pack: updated, totalEnabledTokens: refreshed.totalEnabledTokens });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`adminDomainContext PATCH ${packId} failed: ${msg}`);
    res.status(500).json({ error: "admin_domain_context_patch_failed", message: msg });
  }
}
