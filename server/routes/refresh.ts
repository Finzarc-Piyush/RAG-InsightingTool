/**
 * Wave WR3 (incremental refresh) · /api/sessions/:sessionId/refresh* routes.
 *
 * Reuses the same in-memory multer config + file-type filter as the upload
 * route — the refresh file is the same class of CSV/Excel dataset.
 */

import { Router } from "express";
import multer from "multer";
import express from "express";
import {
  cronRefreshController,
  refreshCompareController,
  refreshController,
  refreshHistoryController,
  refreshPreflightController,
  refreshRollbackController,
  refreshSnowflakeController,
  setRefreshScheduleController,
} from "../controllers/refreshController.js";
import { uploadLimits } from "../config/uploadLimits.js";

const UPLOAD_MAX_BYTES = uploadLimits.maxUploadBytes;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_MAX_BYTES },
  fileFilter: (
    _req: express.Request,
    file: Express.Multer.File,
    cb: multer.FileFilterCallback
  ) => {
    const allowedTypes = [
      "text/csv",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ];
    if (
      allowedTypes.includes(file.mimetype) ||
      file.originalname.match(/\.(csv|xls|xlsx)$/i)
    ) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Please upload CSV or Excel files."));
    }
  },
});

const router = Router();

// Multipart file is optional on these routes (Snowflake refresh, WR6, carries
// no file) — `upload.single` tolerates a missing file part.
router.post(
  "/sessions/:sessionId/refresh/preflight",
  upload.single("file"),
  refreshPreflightController
);
router.post(
  "/sessions/:sessionId/refresh",
  upload.single("file"),
  refreshController
);
// One-click Snowflake re-query (no file part).
router.post("/sessions/:sessionId/refresh/snowflake", refreshSnowflakeController);
// WR10 · version badge + rollback (no file part).
router.get("/sessions/:sessionId/refresh/history", refreshHistoryController);
router.post("/sessions/:sessionId/refresh/rollback", refreshRollbackController);
// WR12 · April-vs-May compare (no file part).
router.get("/sessions/:sessionId/refresh/compare", refreshCompareController);
// WR13 · scheduled Snowflake auto-refresh.
router.put("/sessions/:sessionId/refresh/schedule", setRefreshScheduleController);
router.post("/cron/refresh", cronRefreshController); // → /api/cron/refresh (CRON_SECRET)

export default router;
