import { Router } from "express";
import {
  listAutomationsController,
  getAutomationController,
  createAutomationController,
  updateAutomationController,
  deleteAutomationController,
  runAutomationController,
  runAutomationStreamController,
} from "../controllers/automationController.js";

const router = Router();

router.get("/automations", listAutomationsController);
router.get("/automations/:id", getAutomationController);
router.post("/automations", createAutomationController);
router.patch("/automations/:id", updateAutomationController);
router.delete("/automations/:id", deleteAutomationController);
router.post("/automations/:id/run", runAutomationController);
// Stream endpoint: POST /api/automations/run/stream (automationId + sessionId in body)
router.post("/automations/run/stream", runAutomationStreamController);

export default router;
