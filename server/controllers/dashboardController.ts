import { Request, Response } from "express";
import { requireUsername, AuthenticationError } from "../utils/auth.helper.js";
import {
  addChartToDashboardRequestSchema,
  createDashboardFromSpecRequestSchema,
  createDashboardRequestSchema,
  createReportDashboardRequestSchema,
  exportDashboardRequestSchema,
  patchDashboardRequestSchema,
  patchDashboardSheetRequestSchema,
  removeChartFromDashboardRequestSchema,
} from "../shared/schema.js";
import {
  addTableToDashboardRequestSchema,
  removeTableFromDashboardRequestSchema,
  updateTableCaptionRequestSchema,
} from "../shared/schema.js";
import {
  addChartToDashboard,
  addSheetToDashboard,
  createDashboard,
  deleteDashboard,
  getDashboardById,
  getUserDashboards,
  removeChartFromDashboard,
  removeSheetFromDashboard,
  renameSheet,
  renameDashboard,
  updateChartInsightOrRecommendation,
  addTableToDashboard,
  removeTableFromDashboard,
  updateTableCaption,
  createReportDashboardFromAnalysis,
  createDashboardFromSpec,
  patchDashboard,
  patchDashboardSheet,
} from "../models/dashboard.model.js";
import {
  buildDashboardPdf,
  buildDashboardPptx,
} from "../services/dashboardExport.service.js";

export const createDashboardController = async (req: Request, res: Response) => {
  try {
    const username = requireUsername(req);
    const parsed = createDashboardRequestSchema.parse(req.body);
    const dashboard = await createDashboard(username, parsed.name, parsed.charts || []);
    res.status(201).json(dashboard);
  } catch (error: any) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    // Check if it's a duplicate name error
    if (error?.message?.includes('already exists')) {
      res.status(409).json({ error: error.message });
    } else {
      res.status(400).json({ error: error?.message || 'Failed to create dashboard' });
    }
  }
};

export const listDashboardsController = async (req: Request, res: Response) => {
  try {
    const username = requireUsername(req);
    const dashboards = await getUserDashboards(username);
    
    // Also get shared dashboards that the user has accepted
    const { listSharedDashboardsForUser } = await import("../models/sharedDashboard.model.js");
    const { waitForDashboardsContainer } = await import("../models/database.config.js");
    const normalizedUsername = username.toLowerCase();
    const sharedInvites = await listSharedDashboardsForUser(normalizedUsername);
    
    // Get accepted shared dashboards
    const acceptedInvites = sharedInvites.filter(invite => invite.status === "accepted");
    const sharedDashboards = await Promise.all(
      acceptedInvites.map(async (invite) => {
        try {
          if (!invite.sourceDashboardId || !invite.ownerEmail) {
            console.warn("listDashboards: skipping invite with missing sourceDashboardId or ownerEmail", invite?.id);
            return null;
          }
          // Get dashboard using owner's username (partition key)
          const dashboardsContainer = await waitForDashboardsContainer();
          const ownerPk = invite.ownerEmail.trim().toLowerCase();
          const { resource } = await dashboardsContainer.item(invite.sourceDashboardId, ownerPk).read();
          const dashboard = resource as unknown as typeof dashboards[0];
          
          if (dashboard) {
            // Add permission and shared flag to the dashboard
            return {
              ...dashboard,
              isShared: true,
              sharedPermission: invite.permission,
              sharedBy: invite.ownerEmail,
            };
          }
          return null;
        } catch (error) {
          console.error(`Failed to fetch shared dashboard ${invite.sourceDashboardId}:`, error);
          return null;
        }
      })
    );
    
    // Filter out null values and merge with owned dashboards
    const validSharedDashboards = sharedDashboards.filter((d): d is NonNullable<typeof d> => d !== null);
    const allDashboards = [...dashboards, ...validSharedDashboards];
    
    res.json({ dashboards: allDashboards });
  } catch (error: any) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: error?.message || 'Failed to fetch dashboards' });
  }
};

export const getDashboardController = async (req: Request, res: Response) => {
  try {
    const username = requireUsername(req);
    const { dashboardId } = req.params as { dashboardId: string };
    const dashboard = await getDashboardById(dashboardId, username);
    if (!dashboard) {
      return res.status(404).json({ error: 'Dashboard not found' });
    }
    res.json(dashboard);
  } catch (error: any) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: error?.message || 'Failed to fetch dashboard' });
  }
};

export const deleteDashboardController = async (req: Request, res: Response) => {
  try {
    const username = requireUsername(req);
    const { dashboardId } = req.params as { dashboardId: string };
    const existing = await getDashboardById(dashboardId, username);
    if (!existing) return res.status(404).json({ error: 'Dashboard not found' });
    await deleteDashboard(dashboardId, username);
    res.json({ success: true });
  } catch (error: any) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: error?.message || 'Failed to delete dashboard' });
  }
};

export const addChartToDashboardController = async (req: Request, res: Response) => {
  try {
    const username = requireUsername(req);
    const { dashboardId } = req.params as { dashboardId: string };
    const parsed = addChartToDashboardRequestSchema.parse(req.body);
    
    console.log(`[addChartToDashboard] Attempting to add chart to dashboard ${dashboardId} for user ${username}`);
    
    const updated = await addChartToDashboard(dashboardId, username, parsed.chart, parsed.sheetId);
    res.json(updated);
  } catch (error: any) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    console.error(`[addChartToDashboard] Error:`, error);
    res.status(400).json({ error: error?.message || 'Failed to add chart' });
  }
};

export const addTableToDashboardController = async (req: Request, res: Response) => {
  try {
    const username = requireUsername(req);
    const { dashboardId } = req.params as { dashboardId: string };
    const parsed = addTableToDashboardRequestSchema.parse(req.body);

    const updated = await addTableToDashboard(dashboardId, username, parsed.table, parsed.sheetId);
    res.json(updated);
  } catch (error: any) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    res.status(400).json({ error: error?.message || 'Failed to add table' });
  }
};

export const addSheetToDashboardController = async (req: Request, res: Response) => {
  try {
    const username = requireUsername(req);
    const { dashboardId } = req.params as { dashboardId: string };
    const { name } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Sheet name is required' });
    }
    const updated = await addSheetToDashboard(dashboardId, username, name.trim());
    res.json(updated);
  } catch (error: any) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    // Check if it's a duplicate name error
    if (error?.message?.includes('already exists')) {
      res.status(409).json({ error: error.message });
    } else {
      res.status(400).json({ error: error?.message || 'Failed to add sheet' });
    }
  }
};

export const removeSheetFromDashboardController = async (req: Request, res: Response) => {
  try {
    const username = requireUsername(req);
    const { dashboardId, sheetId } = req.params as { dashboardId: string; sheetId: string };
    const updated = await removeSheetFromDashboard(dashboardId, username, sheetId);
    res.json(updated);
  } catch (error: any) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    res.status(400).json({ error: error?.message || 'Failed to remove sheet' });
  }
};

export const renameSheetController = async (req: Request, res: Response) => {
  try {
    const username = requireUsername(req);
    const { dashboardId, sheetId } = req.params as { dashboardId: string; sheetId: string };
    const { name } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Sheet name is required' });
    }
    const updated = await renameSheet(dashboardId, username, sheetId, name.trim());
    res.json(updated);
  } catch (error: any) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    // Check if it's a duplicate name error
    if (error?.message?.includes('already exists')) {
      res.status(409).json({ error: error.message });
    } else {
      res.status(400).json({ error: error?.message || 'Failed to rename sheet' });
    }
  }
};

export const renameDashboardController = async (req: Request, res: Response) => {
  try {
    const username = requireUsername(req);
    const { dashboardId } = req.params as { dashboardId: string };
    const { name } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Dashboard name is required' });
    }
    const updated = await renameDashboard(dashboardId, username, name.trim());
    res.json(updated);
  } catch (error: any) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    // Check if it's a duplicate name error
    if (error?.message?.includes('already exists')) {
      res.status(409).json({ error: error.message });
    } else {
      res.status(400).json({ error: error?.message || 'Failed to rename dashboard' });
    }
  }
};

export const removeChartFromDashboardController = async (req: Request, res: Response) => {
  try {
    const username = requireUsername(req);
    const { dashboardId } = req.params as { dashboardId: string };
    const parsed = removeChartFromDashboardRequestSchema.parse(req.body);
    const updated = await removeChartFromDashboard(dashboardId, username, parsed);
    res.json(updated);
  } catch (error: any) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    res.status(400).json({ error: error?.message || 'Failed to remove chart' });
  }
};

export const removeTableFromDashboardController = async (req: Request, res: Response) => {
  try {
    const username = requireUsername(req);
    const { dashboardId } = req.params as { dashboardId: string };
    const parsed = removeTableFromDashboardRequestSchema.parse(req.body);
    const updated = await removeTableFromDashboard(dashboardId, username, parsed);
    res.json(updated);
  } catch (error: any) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    res.status(400).json({ error: error?.message || 'Failed to remove table' });
  }
};

export const updateChartInsightOrRecommendationController = async (req: Request, res: Response) => {
  try {
    const username = requireUsername(req);
    const { dashboardId, chartIndex: chartIndexParam } = req.params as { dashboardId: string; chartIndex: string };
    const { sheetId, keyInsight } = req.body;
    const chartIndex = parseInt(chartIndexParam, 10);

    if (isNaN(chartIndex) || chartIndex < 0) {
      return res.status(400).json({ error: 'Valid chartIndex is required' });
    }

    if (keyInsight === undefined) {
      return res.status(400).json({ error: 'keyInsight must be provided' });
    }

    const updates: { keyInsight?: string } = {};
    if (keyInsight !== undefined) {
      updates.keyInsight = typeof keyInsight === 'string' ? keyInsight : undefined;
    }

    const updated = await updateChartInsightOrRecommendation(
      dashboardId,
      username,
      chartIndex,
      sheetId,
      updates
    );
    res.json(updated);
  } catch (error: any) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    res.status(400).json({ error: error?.message || 'Failed to update chart insight or recommendation' });
  }
};

export const updateTableCaptionController = async (req: Request, res: Response) => {
  try {
    const username = requireUsername(req);
    const { dashboardId, tableIndex: tableIndexParam } = req.params as { dashboardId: string; tableIndex: string };
    const { sheetId, caption } = updateTableCaptionRequestSchema.parse(req.body);
    const tableIndex = parseInt(tableIndexParam, 10);

    if (isNaN(tableIndex) || tableIndex < 0) {
      return res.status(400).json({ error: 'Valid tableIndex is required' });
    }

    const updated = await updateTableCaption(dashboardId, username, tableIndex, sheetId, { caption });
    res.json(updated);
  } catch (error: any) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    res.status(400).json({ error: error?.message || 'Failed to update table caption' });
  }
};

export const createReportDashboardController = async (req: Request, res: Response) => {
  try {
    const username = requireUsername(req);
    const parsed = createReportDashboardRequestSchema.parse(req.body);
    const dashboard = await createReportDashboardFromAnalysis(username, parsed);
    res.status(201).json(dashboard);
  } catch (error: any) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    res.status(400).json({ error: error?.message || "Failed to create report dashboard" });
  }
};

/**
 * Phase 2 — atomic commit of an agent-emitted DashboardSpec.
 * The chat preview card calls this when the user clicks "Create".
 */
export const createDashboardFromSpecController = async (
  req: Request,
  res: Response
) => {
  try {
    const username = requireUsername(req);
    const parsed = createDashboardFromSpecRequestSchema.parse(req.body);
    const dashboard = await createDashboardFromSpec(username, parsed.spec);
    // Phase 2.E · Best-effort remember the dashboard so future agent
    // turns can call patch_dashboard without the user restating the id.
    if (parsed.sessionId) {
      const { setLastCreatedDashboardForSession } = await import(
        "../models/chat.model.js"
      );
      void setLastCreatedDashboardForSession(
        parsed.sessionId,
        username,
        dashboard.id
      );
    }
    res.status(201).json(dashboard);
  } catch (error: any) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    res.status(400).json({
      error: error?.message || "Failed to create dashboard from spec",
    });
  }
};

/**
 * Phase 2.E — atomic follow-up edits to an existing dashboard.
 * Chat "add a margin chart to the dashboard we just built" calls this.
 */
export const patchDashboardController = async (req: Request, res: Response) => {
  try {
    const username = requireUsername(req);
    const { dashboardId } = req.params as { dashboardId: string };
    const parsed = patchDashboardRequestSchema.parse(req.body);
    const dashboard = await patchDashboard(dashboardId, username, parsed.patch);
    res.json(dashboard);
  } catch (error: any) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    res.status(400).json({
      error: error?.message || "Failed to patch dashboard",
    });
  }
};

export const patchDashboardSheetController = async (req: Request, res: Response) => {
  try {
    const username = requireUsername(req);
    const { dashboardId, sheetId } = req.params as { dashboardId: string; sheetId: string };
    const parsed = patchDashboardSheetRequestSchema.parse(req.body);
    const updated = await patchDashboardSheet(dashboardId, username, sheetId, parsed);
    res.json(updated);
  } catch (error: any) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    res.status(400).json({ error: error?.message || "Failed to update sheet" });
  }
};

export const exportDashboardController = async (req: Request, res: Response) => {
  try {
    const username = requireUsername(req);
    const { dashboardId } = req.params as { dashboardId: string };
    const parsed = exportDashboardRequestSchema.parse(req.body);
    const dashboard = await getDashboardById(dashboardId, username);
    if (!dashboard) {
      res.status(404).json({ error: "Dashboard not found" });
      return;
    }
    const safeName = dashboard.name.replace(/[^\w\-]+/g, "_").slice(0, 80);
    if (parsed.format === "pdf") {
      const buf = await buildDashboardPdf(dashboard);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeName}.pdf"`
      );
      res.send(buf);
      return;
    }
    const buf = await buildDashboardPptx(dashboard);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeName}.pptx"`
    );
    res.send(buf);
  } catch (error: any) {
    if (error instanceof AuthenticationError) {
      res.status(401).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: error?.message || "Export failed" });
  }
};


