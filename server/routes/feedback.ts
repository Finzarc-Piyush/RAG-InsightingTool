import { Router } from "express";
import { feedbackController } from "../controllers/feedbackController.js";

const router = Router();

// W5.5 · POST /api/feedback — thumbs up/down on a past analysis (used to
// invalidate cache hits and seed the few-shot golden corpus).
router.post("/feedback", feedbackController);

export default router;
