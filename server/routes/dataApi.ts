/**
 * Data API Routes
 * Exposes APIs for aggregated and sampled data retrieval
 */

import { Router, Request, Response } from 'express';
import { ColumnarStorageService } from '../lib/columnarStorage.js';
import { metadataService } from '../lib/metadataService.js';
import { getChatBySessionIdForUser } from '../models/chat.model.js';
import { getAuthenticatedEmail } from '../utils/auth.helper.js';
import { sendError, sendValidationError } from '../utils/responseFormatter.js';

const router = Router();

async function assertDataApiAccess(
  req: Request,
  res: Response,
  sessionId: string
): Promise<boolean> {
  const email = getAuthenticatedEmail(req);
  if (!email) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  try {
    const chat = await getChatBySessionIdForUser(sessionId, email);
    if (!chat) {
      res.status(404).json({ error: 'Session not found' });
      return false;
    }
    return true;
  } catch (e: unknown) {
    const code = (e as { statusCode?: number })?.statusCode;
    if (code === 403) {
      res.status(403).json({ error: 'Forbidden' });
      return false;
    }
    throw e;
  }
}

/**
 * Get sampled rows from dataset
 * GET /api/data/:sessionId/sample?limit=50&random=false
 */
router.get('/:sessionId/sample', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;
    const random = req.query.random === 'true';

    if (!sessionId) {
      return sendValidationError(res, 'Session ID is required');
    }

    if (!(await assertDataApiAccess(req, res, sessionId))) {
      return;
    }

    const storage = new ColumnarStorageService({ sessionId });
    await storage.initialize();

    try {
      const sampleRows = await storage.getSampleRows(limit);
      res.json({
        sessionId,
        rows: sampleRows,
        count: sampleRows.length,
        limit,
        random,
      });
    } finally {
      await storage.close();
    }
  } catch (error) {
    console.error('Error getting sample rows:', error);
    sendError(res, error instanceof Error ? error.message : 'Failed to get sample rows');
  }
});

/**
 * Get dataset metadata
 * GET /api/data/:sessionId/metadata
 */
router.get('/:sessionId/metadata', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      return sendValidationError(res, 'Session ID is required');
    }

    if (!(await assertDataApiAccess(req, res, sessionId))) {
      return;
    }

    // Check cache first
    const cached = metadataService.getCachedMetadata(sessionId);
    if (cached) {
      return res.json({
        sessionId,
        metadata: cached.metadata,
        summary: cached.summary,
        cached: true,
      });
    }

    // Compute metadata
    const storage = new ColumnarStorageService({ sessionId });
    await storage.initialize();

    try {
      const metadata = await storage.computeMetadata();
      const sampleRows = await storage.getSampleRows(50);
      const summary = metadataService.convertToDataSummary(metadata, sampleRows);
      
      // Cache the result
      metadataService.cacheMetadata(sessionId, metadata, summary);

      res.json({
        sessionId,
        metadata,
        summary,
        cached: false,
      });
    } finally {
      await storage.close();
    }
  } catch (error) {
    console.error('Error getting metadata:', error);
    sendError(res, error instanceof Error ? error.message : 'Failed to get metadata');
  }
});

/**
 * Execute aggregation query
 * POST /api/data/:sessionId/query
 * Body: { query: "SELECT COUNT(*) as count FROM data WHERE column = 'value'" }
 */
router.post('/:sessionId/query', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { query } = req.body;

    if (!sessionId) {
      return sendValidationError(res, 'Session ID is required');
    }

    if (!query || typeof query !== 'string') {
      return sendValidationError(res, 'Query is required and must be a string');
    }

    // Basic SQL injection prevention - only allow SELECT queries
    const normalizedQuery = query.trim().toUpperCase();
    if (!normalizedQuery.startsWith('SELECT')) {
      return sendValidationError(res, 'Only SELECT queries are allowed');
    }

    if (!(await assertDataApiAccess(req, res, sessionId))) {
      return;
    }

    const storage = new ColumnarStorageService({ sessionId });
    await storage.initialize();

    try {
      const results = await storage.executeQuery(query);
      res.json({
        sessionId,
        results,
        count: results.length,
      });
    } finally {
      await storage.close();
    }
  } catch (error) {
    console.error('Error executing query:', error);
    sendError(res, error instanceof Error ? error.message : 'Failed to execute query');
  }
});

/**
 * Get aggregated statistics for numeric columns
 * GET /api/data/:sessionId/stats?columns=col1,col2,col3
 */
router.get('/:sessionId/stats', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const columnsParam = req.query.columns as string;

    if (!sessionId) {
      return sendValidationError(res, 'Session ID is required');
    }

    if (!columnsParam) {
      return sendValidationError(res, 'Columns parameter is required');
    }

    const columns = columnsParam.split(',').map(c => c.trim()).filter(c => c.length > 0);

    if (columns.length === 0) {
      return sendValidationError(res, 'At least one column must be specified');
    }

    if (!(await assertDataApiAccess(req, res, sessionId))) {
      return;
    }

    const storage = new ColumnarStorageService({ sessionId });
    await storage.initialize();

    try {
      const stats = await storage.getNumericStats(columns);
      res.json({
        sessionId,
        columns,
        stats,
      });
    } finally {
      await storage.close();
    }
  } catch (error) {
    console.error('Error getting stats:', error);
    sendError(res, error instanceof Error ? error.message : 'Failed to get stats');
  }
});

export default router;

