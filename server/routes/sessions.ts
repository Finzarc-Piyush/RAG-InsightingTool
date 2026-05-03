import { Router } from "express";
import {
  getAllSessionsEndpoint,
  getSessionsPaginatedEndpoint,
  getSessionsFilteredEndpoint,
  getSessionStatisticsEndpoint,
  getSessionDetailsEndpoint,
  getSessionsByUserEndpoint,
  updateSessionNameEndpoint,
  updateSessionContextEndpoint,
  updateMessagePivotStateEndpoint,
  deleteSessionEndpoint,
  getDataSummaryEndpoint,
  getSessionAnalysisContextEndpoint,
  postChartPreviewEndpoint,
  postChartKeyInsightEndpoint,
  putSessionHierarchiesEndpoint,
} from "../controllers/sessionController.js";
import {
  getMemoryEntriesEndpoint,
  searchMemoryEndpoint,
  exportMemoryEndpoint,
} from "../controllers/analysisMemoryController.js";
import {
  getActiveFilterEndpoint,
  putActiveFilterEndpoint,
  deleteActiveFilterEndpoint,
} from "../controllers/activeFilterController.js";

const router = Router();

// Get all sessions
router.get('/sessions', getAllSessionsEndpoint);

// Get sessions with pagination
router.get('/sessions/paginated', getSessionsPaginatedEndpoint);

// Get sessions with filters
router.get('/sessions/filtered', getSessionsFilteredEndpoint);

// Get session statistics
router.get('/sessions/statistics', getSessionStatisticsEndpoint);

// Get detailed session by session ID
router.get('/sessions/details/:sessionId', getSessionDetailsEndpoint);

// Get sessions by user
router.get('/sessions/user/:username', getSessionsByUserEndpoint);

// Get data summary for a session (must come before /sessions/:sessionId routes)
router.get('/sessions/:sessionId/data-summary', getDataSummaryEndpoint);

// Get the rolling session analysis context (lightweight)
router.get('/sessions/:sessionId/analysis-context', getSessionAnalysisContextEndpoint);

// W61 · Analysis Memory journal — paginated list, semantic search, export.
// More-specific paths first so they don't fall into the bare `:sessionId` route.
router.get('/sessions/:sessionId/memory/search', searchMemoryEndpoint);
router.get('/sessions/:sessionId/memory/export', exportMemoryEndpoint);
router.get('/sessions/:sessionId/memory', getMemoryEntriesEndpoint);
router.post('/sessions/:sessionId/chart-preview', postChartPreviewEndpoint);
router.post('/sessions/:sessionId/chart-key-insight', postChartKeyInsightEndpoint);

// Wave-FA3 · Active filter overlay (Excel-style, non-destructive). The filter
// spec lives on the session document and is applied at read time — the
// canonical dataset is never mutated.
router.get('/sessions/:sessionId/active-filter', getActiveFilterEndpoint);
router.put('/sessions/:sessionId/active-filter', putActiveFilterEndpoint);
router.delete('/sessions/:sessionId/active-filter', deleteActiveFilterEndpoint);

// Update session name by session ID
router.patch('/sessions/:sessionId', updateSessionNameEndpoint);

// Update session permanent context by session ID
router.patch('/sessions/:sessionId/context', updateSessionContextEndpoint);

// EU1 · Replace the dimensionHierarchies array on a session.
// Body: { hierarchies: DimensionHierarchy[] }. Returns the new array.
router.put('/sessions/:sessionId/hierarchies', putSessionHierarchiesEndpoint);

// W-PivotState · update one assistant message's pivot/chart UI state. Body:
// `{ pivotState: PivotState | null }`. The `messageTimestamp` path param is the
// assistant message's `timestamp` field (numeric ms epoch).
router.patch(
  '/sessions/:sessionId/messages/:messageTimestamp/pivot-state',
  updateMessagePivotStateEndpoint
);

// Delete session by session ID
router.delete('/sessions/:sessionId', deleteSessionEndpoint);

export default router;
