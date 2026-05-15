/**
 * Wave A4 · /api/automations route module.
 *
 * Capture-direction endpoints (POST, GET list, GET one, DELETE).
 * Replay-direction endpoints (POST :id/dry-run, POST :id/run, POST
 * :id/run/resume) land in Wave A8.
 */

import { Router } from "express";
import {
  createAutomationController,
  deleteAutomationController,
  dryRunAutomationController,
  getAutomationController,
  listAutomationsController,
  runAutomationController,
} from "../controllers/automationController.js";

const router = Router();

router.post("/automations", createAutomationController);
router.get("/automations", listAutomationsController);
router.get("/automations/:id", getAutomationController);
router.delete("/automations/:id", deleteAutomationController);
router.post("/automations/:id/dry-run", dryRunAutomationController);
// Run + resume share the same controller; resume passes
// `resumeFromOrdinal` in the body (no separate route needed).
router.post("/automations/:id/run", runAutomationController);
router.post("/automations/:id/run/resume", runAutomationController);

export default router;
