import { Router } from "express";
import { pastAnalysisRecallPivotController } from "../controllers/pastAnalysisRecallController.js";

const router = Router();

// AMR3c · Fetch the aggregated row data for a recalled past-analysis pivot
// artifact. Used by the client when a cache-hit message renders an
// offloaded (blob-stored) pivot and the user opens its tab.
router.get(
  "/past-analyses/:sessionId/:turnId/pivot/:artifactId",
  pastAnalysisRecallPivotController
);

export default router;
