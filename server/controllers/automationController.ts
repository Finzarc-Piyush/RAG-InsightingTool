import { Request, Response } from "express";
import {
  createAutomationRequestSchema,
  updateAutomationRequestSchema,
  runAutomationRequestSchema,
} from "../shared/schema.js";
import {
  createAutomation,
  getAutomationById,
  getAutomationsByUser,
  updateAutomation,
  deleteAutomation,
} from "../models/automation.model.js";
import { runAutomation, runAutomationStream } from "../services/automation/runAutomation.service.js";

function getUsername(req: Request): string {
  return (req.body?.username || req.query?.username || req.headers["x-user-email"] || "anonymous@example.com") as string;
}

export const listAutomationsController = async (req: Request, res: Response) => {
  try {
    const username = getUsername(req);
    const automations = await getAutomationsByUser(username);
    res.json({ automations });
  } catch (error: any) {
    // When CosmosDB isn't configured or automations container isn't ready, return empty list
    // so the app can load; avoid 500 on first page load.
    console.warn("List automations failed (returning empty list):", error?.message);
    res.json({ automations: [] });
  }
};

export const getAutomationController = async (req: Request, res: Response) => {
  try {
    const username = getUsername(req);
    const { id } = req.params;
    const automation = await getAutomationById(id, username);
    if (!automation) {
      return res.status(404).json({ error: "Automation not found" });
    }
    res.json(automation);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to get automation" });
  }
};

export const createAutomationController = async (req: Request, res: Response) => {
  try {
    const username = getUsername(req);
    const parsed = createAutomationRequestSchema.parse(req.body);
    const automation = await createAutomation({
      username,
      name: parsed.name,
      description: parsed.description,
      steps: parsed.steps,
    });
    res.status(201).json(automation);
  } catch (error: any) {
    res.status(400).json({ error: error?.message || "Failed to create automation" });
  }
};

export const updateAutomationController = async (req: Request, res: Response) => {
  try {
    const username = getUsername(req);
    const { id } = req.params;
    const parsed = updateAutomationRequestSchema.partial().parse(req.body);
    const automation = await updateAutomation(id, username, parsed);
    if (!automation) {
      return res.status(404).json({ error: "Automation not found" });
    }
    res.json(automation);
  } catch (error: any) {
    res.status(400).json({ error: error?.message || "Failed to update automation" });
  }
};

export const deleteAutomationController = async (req: Request, res: Response) => {
  try {
    const username = getUsername(req);
    const { id } = req.params;
    const deleted = await deleteAutomation(id, username);
    if (!deleted) {
      return res.status(404).json({ error: "Automation not found" });
    }
    res.status(204).send();
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "Failed to delete automation" });
  }
};

export const runAutomationController = async (req: Request, res: Response) => {
  try {
    const username = getUsername(req);
    const parsed = runAutomationRequestSchema.parse({
      sessionId: req.body?.sessionId ?? req.query?.sessionId,
      automationId: req.params?.id ?? req.body?.automationId ?? req.query?.automationId,
    });
    const result = await runAutomation(username, parsed.sessionId, parsed.automationId);
    if (result.error && !result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (error: any) {
    res.status(400).json({
      success: false,
      automationName: "",
      stepsRun: 0,
      stepsTotal: 0,
      results: [],
      error: error?.message || "Failed to run automation",
    });
  }
};

/** Run automation with SSE: one step at a time, each step shown in chat */
export const runAutomationStreamController = async (req: Request, res: Response) => {
  try {
    const username = getUsername(req);
    const parsed = runAutomationRequestSchema.parse({
      sessionId: req.body?.sessionId ?? req.query?.sessionId,
      automationId: req.params?.id ?? req.body?.automationId ?? req.query?.automationId,
      newDashboardName: req.body?.newDashboardName ?? req.query?.newDashboardName,
    });
    await runAutomationStream(username, parsed.sessionId, parsed.automationId, res, {
      newDashboardName: parsed.newDashboardName,
    });
  } catch (error: any) {
    if (!res.headersSent) {
      res.status(400).json({
        success: false,
        error: error?.message || "Failed to run automation stream",
      });
    }
  }
};
