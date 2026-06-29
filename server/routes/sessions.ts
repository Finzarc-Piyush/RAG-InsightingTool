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
  updateMessageChartSortEndpoint,
  deleteSessionEndpoint,
  getDataSummaryEndpoint,
  getSessionAnalysisContextEndpoint,
  postChartPreviewEndpoint,
  postChartKeyInsightEndpoint,
  putSessionHierarchiesEndpoint,
  putSessionSchemaAnnotationsEndpoint,
  getSessionDirectivesEndpoint,
  revokeSessionDirectiveEndpoint,
} from "../controllers/sessionController.js";
import { retableSessionEndpoint } from "../controllers/retableController.js";
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

// Get all sessions.
// API-9 · CANONICAL session-list route. The same entity is also reachable via
// the legacy paths /chats/user/:username, /data/user/:username/sessions, and
// /sessions/user/:username (all retained for back-compat). Prefer this route
// with `?owner=me` for the current user's sessions, e.g. GET /api/sessions?owner=me.
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

// Re-table: re-parse the original file with a user-chosen header/table region
// and regenerate the analysis (main-table detection correction).
router.post('/sessions/:sessionId/retable', retableSessionEndpoint);

// EU1 · Replace the dimensionHierarchies array on a session.
// Body: { hierarchies: DimensionHierarchy[] }. Returns the new array.
router.put('/sessions/:sessionId/hierarchies', putSessionHierarchiesEndpoint);

// SU-UX1 · Replace dataSummary schema annotations (date×time pairs +
// per-column indicator metadata). Body: { dateTimeColumnPairs?, indicators? }.
// Either field is optional; clients patch independently. Empty arrays clear.
router.put(
  '/sessions/:sessionId/schema-annotations',
  putSessionSchemaAnnotationsEndpoint,
);

// W-PivotState · update one assistant message's pivot/chart UI state. Body:
// `{ pivotState: PivotState | null }`. The `messageTimestamp` path param is the
// assistant message's `timestamp` field (numeric ms epoch).
router.patch(
  '/sessions/:sessionId/messages/:messageTimestamp/pivot-state',
  updateMessagePivotStateEndpoint
);

// Wave S5 · persist a chart's "Sort by" choice. Body: `{ sort: { by, direction } }`.
// `chartIndex` is the chart's position in the assistant message's `charts` array.
router.patch(
  '/sessions/:sessionId/messages/:messageTimestamp/charts/:chartIndex/sort',
  updateMessageChartSortEndpoint
);

// Wave W-UD9 · per-dataset user directives. List + revoke. The directives
// doc lives keyed on `(username, datasetFingerprint)`; we look up the
// fingerprint via the session doc so the path keeps the `:sessionId`
// shape consistent with the rest of this router.
router.get('/sessions/:sessionId/directives', getSessionDirectivesEndpoint);
router.delete(
  '/sessions/:sessionId/directives/:directiveId',
  revokeSessionDirectiveEndpoint
);

// Delete session by session ID
router.delete('/sessions/:sessionId', deleteSessionEndpoint);

export default router;
