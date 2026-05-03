import { Router } from "express";
import {
  addChartToDashboardController,
  addTableToDashboardController,
  addPivotToDashboardController,
  removePivotFromDashboardController,
  addSheetToDashboardController,
  createDashboardController,
  createDashboardFromSpecController,
  createReportDashboardController,
  deleteDashboardController,
  patchDashboardController,
  exportDashboardController,
  getDashboardController,
  listDashboardsController,
  patchDashboardSheetController,
  removeChartFromDashboardController,
  removeTableFromDashboardController,
  removeSheetFromDashboardController,
  renameSheetController,
  renameDashboardController,
  updateTableCaptionController,
  updateChartInsightOrRecommendationController,
} from "../controllers/index.js";

const router = Router();

// Dashboards
router.post('/dashboards', createDashboardController);
router.post('/dashboards/from-analysis', createReportDashboardController);
// Phase 2 — atomic commit of an agent-emitted DashboardSpec preview.
router.post('/dashboards/from-spec', createDashboardFromSpecController);
// Phase 2.E — atomic follow-up edits (add/remove charts, rename sheet).
router.post('/dashboards/:dashboardId/patch', patchDashboardController);
router.get('/dashboards', listDashboardsController);
router.get('/dashboards/:dashboardId', getDashboardController);
router.patch('/dashboards/:dashboardId', renameDashboardController);
router.delete('/dashboards/:dashboardId', deleteDashboardController);

// Charts in a dashboard
router.post('/dashboards/:dashboardId/charts', addChartToDashboardController);
router.delete('/dashboards/:dashboardId/charts', removeChartFromDashboardController);
router.patch('/dashboards/:dashboardId/charts/:chartIndex', updateChartInsightOrRecommendationController);

// Tables in a dashboard
router.post('/dashboards/:dashboardId/tables', addTableToDashboardController);
router.delete('/dashboards/:dashboardId/tables', removeTableFromDashboardController);
router.patch('/dashboards/:dashboardId/tables/:tableIndex', updateTableCaptionController);

// Pivots in a dashboard
router.post('/dashboards/:dashboardId/pivots', addPivotToDashboardController);
router.delete('/dashboards/:dashboardId/pivots', removePivotFromDashboardController);

// Sheets in a dashboard
router.post('/dashboards/:dashboardId/sheets', addSheetToDashboardController);
router.delete('/dashboards/:dashboardId/sheets/:sheetId', removeSheetFromDashboardController);
router.patch('/dashboards/:dashboardId/sheets/:sheetId', renameSheetController);
router.patch(
  '/dashboards/:dashboardId/sheets/:sheetId/content',
  patchDashboardSheetController
);
router.post('/dashboards/:dashboardId/export', exportDashboardController);

// W7.3 / W7.4 — XLSX + PPTX downloadable exports of a saved dashboard.
import {
  exportDashboardXlsxController,
  exportDashboardPptxController,
} from "../controllers/dashboardExportController.js";
router.get('/dashboards/:id/export/xlsx', exportDashboardXlsxController);
router.get('/dashboards/:id/export/pptx', exportDashboardPptxController);

export default router;



