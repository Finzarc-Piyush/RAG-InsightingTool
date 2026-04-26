/**
 * W7.3 / W7.4 · Dashboard export endpoints.
 *
 *   GET /api/dashboards/:id/export/xlsx   → workbook with one tab per chart
 *   GET /api/dashboards/:id/export/pptx   → slides per dashboard sheet
 *
 * Both gated by the same auth as the rest of the dashboard routes — only the
 * owning user can export. The flag `DASHBOARD_PPT_EXPORT_ENABLED` /
 * `DASHBOARD_XLSX_EXPORT_ENABLED` lets ops disable an export endpoint without
 * a redeploy if it ever misbehaves (default: both on).
 */

import type { Request, Response } from "express";
import { getAuthenticatedEmail } from "../utils/auth.helper.js";
import { getDashboardById } from "../models/dashboard.model.js";
import { buildDashboardXlsxBuffer } from "../services/dashboardExport/xlsxExport.service.js";
import { buildDashboardPptxBuffer } from "../services/dashboardExport/pptxExport.service.js";

function exportEnabled(envName: string): boolean {
  return process.env[envName] !== "false"; // default ON
}

function safeFilename(name: string, ext: string): string {
  const base = (name || "dashboard").replace(/[^a-zA-Z0-9_\-]+/g, "_").slice(0, 80);
  const date = new Date().toISOString().slice(0, 10);
  return `${base}_${date}.${ext}`;
}

export async function exportDashboardXlsxController(req: Request, res: Response): Promise<void> {
  if (!exportEnabled("DASHBOARD_XLSX_EXPORT_ENABLED")) {
    res.status(404).json({ error: "xlsx_export_disabled" });
    return;
  }
  const userEmail = getAuthenticatedEmail(req);
  if (!userEmail) {
    res.status(401).json({ error: "auth_required" });
    return;
  }
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "missing_dashboard_id" });
    return;
  }
  try {
    const dashboard = await getDashboardById(id, userEmail);
    if (!dashboard) {
      res.status(404).json({ error: "dashboard_not_found" });
      return;
    }
    const buf = await buildDashboardXlsxBuffer(dashboard);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeFilename(dashboard.name, "xlsx")}"`
    );
    res.setHeader("Content-Length", buf.length);
    res.send(buf);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`xlsx export failed for ${id}: ${msg}`);
    res.status(500).json({ error: "xlsx_export_failed" });
  }
}

export async function exportDashboardPptxController(req: Request, res: Response): Promise<void> {
  if (!exportEnabled("DASHBOARD_PPT_EXPORT_ENABLED")) {
    res.status(404).json({ error: "pptx_export_disabled" });
    return;
  }
  const userEmail = getAuthenticatedEmail(req);
  if (!userEmail) {
    res.status(401).json({ error: "auth_required" });
    return;
  }
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "missing_dashboard_id" });
    return;
  }
  try {
    const dashboard = await getDashboardById(id, userEmail);
    if (!dashboard) {
      res.status(404).json({ error: "dashboard_not_found" });
      return;
    }
    const buf = await buildDashboardPptxBuffer(dashboard);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeFilename(dashboard.name, "pptx")}"`
    );
    res.setHeader("Content-Length", buf.length);
    res.send(buf);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`pptx export failed for ${id}: ${msg}`);
    res.status(500).json({ error: "pptx_export_failed" });
  }
}
