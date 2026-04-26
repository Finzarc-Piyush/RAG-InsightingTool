/**
 * W6.4 · GET /api/admin/costs
 *
 * Returns today's cost rollup. Gated by the `ADMIN_EMAILS` allow-list. Read-only.
 */

import type { Request, Response } from "express";
import { isAdminRequest } from "../utils/admin.helper.js";
import { getAdminCostsSnapshot } from "../lib/admin/costRollups.js";

export async function adminCostsController(req: Request, res: Response): Promise<void> {
  if (!isAdminRequest(req)) {
    res.status(403).json({ error: "admin_required" });
    return;
  }
  try {
    const snapshot = await getAdminCostsSnapshot();
    res.json(snapshot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`adminCosts failed: ${msg}`);
    res.status(500).json({ error: "admin_costs_failed" });
  }
}
