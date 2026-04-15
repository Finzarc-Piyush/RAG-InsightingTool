/**
 * Data API Routes
 * Exposes APIs for aggregated and sampled data retrieval
 */

import { Router, Request, Response } from 'express';
import { ColumnarStorageService, SessionDataNotMaterializedError } from '../lib/columnarStorage.js';
import { ensureAuthoritativeDataTable } from '../lib/ensureSessionDuckdbMaterialized.js';
import { metadataService } from '../lib/metadataService.js';
import { getChatBySessionIdForUser, type ChatDocument } from '../models/chat.model.js';
import { getAuthenticatedEmail } from '../utils/auth.helper.js';
import { sendError, sendValidationError } from '../utils/responseFormatter.js';
import { executePivotQuery } from '../lib/pivotQueryService.js';
import { z } from 'zod';

const router = Router();

function handleDataApiError(res: Response, error: unknown, fallback: string): void {
  if (error instanceof SessionDataNotMaterializedError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return;
  }
  sendError(res, error instanceof Error ? error.message : fallback);
}

function quoteIdent(col: string): string {
  return `"${col.replace(/"/g, '""')}"`;
}

function escapeSqlStringLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

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

async function loadChatForDataSession(req: Request, sessionId: string): Promise<ChatDocument> {
  const email = getAuthenticatedEmail(req);
  if (!email) {
    throw new Error('Unauthorized');
  }
  const chat = await getChatBySessionIdForUser(sessionId, email);
  if (!chat) {
    throw new Error('Session not found');
  }
  return chat;
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
      const chat = await loadChatForDataSession(req, sessionId);
      await ensureAuthoritativeDataTable(storage, chat);
      await storage.assertTableExists('data');
      // No-downsampling policy: return full table rows for analytical preview consumers.
      // Keep route contract unchanged (limit/random fields remain for compatibility only).
      const sampleRows = await storage.getAllRows('data');
      res.json({
        sessionId,
        rows: sampleRows,
        count: sampleRows.length,
        limit: sampleRows.length,
        random,
      });
    } finally {
      await storage.close();
    }
  } catch (error) {
    console.error('Error getting sample rows:', error);
    handleDataApiError(res, error, 'Failed to get sample rows');
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
      const chat = await loadChatForDataSession(req, sessionId);
      await ensureAuthoritativeDataTable(storage, chat);
      await storage.assertTableExists('data');
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
    handleDataApiError(res, error, 'Failed to get metadata');
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
      const chat = await loadChatForDataSession(req, sessionId);
      await ensureAuthoritativeDataTable(storage, chat);
      await storage.assertTableExists('data');
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
    handleDataApiError(res, error, 'Failed to execute query');
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
      const chat = await loadChatForDataSession(req, sessionId);
      await ensureAuthoritativeDataTable(storage, chat);
      await storage.assertTableExists('data');
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
    handleDataApiError(res, error, 'Failed to get stats');
  }
});

/**
 * Execute pivot query (Excel-like pivot core)
 * POST /api/data/:sessionId/pivot/query
 */
router.post('/:sessionId/pivot/query', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    if (!sessionId) {
      return sendValidationError(res, 'Session ID is required');
    }
    if (!(await assertDataApiAccess(req, res, sessionId))) {
      return;
    }

    const chat = await loadChatForDataSession(req, sessionId);
    const dataVersion =
      chat.currentDataBlob?.version ?? chat.ragIndex?.dataVersion ?? 0;

    const out = await executePivotQuery(sessionId, req.body, { dataVersion, chat });
    res.json(out);
  } catch (error) {
    console.error('Error executing pivot query:', error);
    handleDataApiError(res, error, 'Failed to execute pivot query');
  }
});

/**
 * Pivot fields metadata
 * GET /api/data/:sessionId/pivot/fields?column=Name&q=foo&limit=50
 */
router.get('/:sessionId/pivot/fields', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    if (!sessionId) {
      return sendValidationError(res, 'Session ID is required');
    }

    if (!(await assertDataApiAccess(req, res, sessionId))) {
      return;
    }

    const column = (req.query.column as string | undefined)?.trim();
    const q = (req.query.q as string | undefined)?.trim();
    const limit = parseInt((req.query.limit as string) || '50', 10) || 50;

    const storage = new ColumnarStorageService({ sessionId });
    await storage.initialize();
    try {
      const chat = await loadChatForDataSession(req, sessionId);
      await ensureAuthoritativeDataTable(storage, chat);
      await storage.assertTableExists('data');
      let cached = metadataService.getCachedMetadata(sessionId);
      if (!cached) {
        const metadata = await storage.computeMetadata();
        const sampleRows = await storage.getSampleRows(50);
        const summary = metadataService.convertToDataSummary(metadata, sampleRows);
        metadataService.cacheMetadata(sessionId, metadata, summary);
        cached = { metadata, summary, computedAt: Date.now(), sessionId };
      }

      const { metadata, summary } = cached;

      if (!column) {
        const fields = summary.columns.map((c) => {
          const meta = metadata.columns.find((m) => m.name === c.name);
          return {
            name: c.name,
            type: c.type,
            cardinality: meta?.cardinality ?? 0,
          };
        });
        res.json({ sessionId, fields });
        return;
      }

      const colSummary = summary.columns.find((c) => c.name === column);
      const colMeta = metadata.columns.find((c) => c.name === column);
      if (!colSummary || !colMeta) {
        return sendValidationError(res, `Unknown column: ${column}`);
      }

      const where = q
        ? `WHERE LOWER(COALESCE(CAST(${quoteIdent(column)} AS VARCHAR), '')) LIKE ${escapeSqlStringLiteral(
            `%${q.toLowerCase()}%`
          )}`
        : '';

      const sql = `SELECT DISTINCT COALESCE(CAST(${quoteIdent(column)} AS VARCHAR), '') as v FROM data ${where} LIMIT ${limit}`;
      const rows = await storage.executeQuery<{ v: any }>(sql);

      const distinctValues = rows
        .map((r) => (r?.v === null || r?.v === undefined ? '' : String(r.v)))
        .filter((v) => v !== undefined);

      res.json({
        sessionId,
        fields: [
          {
            name: column,
            type: colSummary.type,
            cardinality: colMeta.cardinality,
            distinctValues,
            hasMore: distinctValues.length >= limit,
          },
        ],
      });
    } finally {
      await storage.close();
    }
  } catch (error) {
    console.error('Error getting pivot fields:', error);
    handleDataApiError(res, error, 'Failed to get pivot fields');
  }
});

/**
 * Drillthrough pivot cell: fetch raw rows for the selected row/column intersection.
 * POST /api/data/:sessionId/pivot/drillthrough
 */
router.post('/:sessionId/pivot/drillthrough', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    if (!sessionId) {
      return sendValidationError(res, 'Session ID is required');
    }
    if (!(await assertDataApiAccess(req, res, sessionId))) {
      return;
    }

    const bodySchema = z.object({
      rowFields: z.array(z.string()),
      rowValues: z.array(z.string()),
      colField: z.string().nullable().optional(),
      colKey: z.string().nullable().optional(),
      filterFields: z.array(z.string()).optional().default([]),
      filterSelections: z.record(z.array(z.string())).optional(),
      valueFields: z.array(z.string()).optional().default([]),
      limit: z.number().int().min(1).max(500).optional(),
    });

    const parsed = bodySchema.parse(req.body);
    if (parsed.rowFields.length !== parsed.rowValues.length) {
      return sendValidationError(res, 'rowFields and rowValues must align');
    }

    const limit = parsed.limit ?? 200;
    const whereParts: string[] = [];

    // Dimension filters from the pivot UI.
    const filterFields = parsed.filterFields ?? [];
    const filterSelections = parsed.filterSelections ?? {};
    for (const f of filterFields) {
      const sel = filterSelections[f];
      if (sel === undefined) continue; // includes all values
      if (sel.length === 0) {
        whereParts.push('1=0');
        break;
      }
      const inList = sel.map((v) => escapeSqlStringLiteral(String(v))).join(', ');
      const expr = `COALESCE(CAST(${quoteIdent(f)} AS VARCHAR), '') IN (${inList})`;
      whereParts.push(expr);
    }

    // Row intersection constraints
    for (let i = 0; i < parsed.rowFields.length; i++) {
      const f = parsed.rowFields[i]!;
      const v = parsed.rowValues[i] ?? '';
      whereParts.push(
        `COALESCE(CAST(${quoteIdent(f)} AS VARCHAR), '') = ${escapeSqlStringLiteral(String(v))}`
      );
    }

    // Column intersection constraint (when matrix is enabled)
    const colField = parsed.colField ?? null;
    const colKey = parsed.colKey ?? null;
    if (colField && colKey !== null && colKey !== undefined) {
      whereParts.push(
        `COALESCE(CAST(${quoteIdent(colField)} AS VARCHAR), '') = ${escapeSqlStringLiteral(
          String(colKey)
        )}`
      );
    }

    const whereSql = whereParts.length ? whereParts.join(' AND ') : '1=1';

    const wantedCols = Array.from(
      new Set<string>([
        ...parsed.rowFields,
        ...(colField ? [colField] : []),
        ...filterFields,
        ...(parsed.valueFields ?? []),
      ])
    );
    const selectCols = wantedCols.length ? wantedCols.map((c) => quoteIdent(c)).join(', ') : '*';

    const storage = new ColumnarStorageService({ sessionId });
    await storage.initialize();
    try {
      const chat = await loadChatForDataSession(req, sessionId);
      await ensureAuthoritativeDataTable(storage, chat);
      await storage.assertTableExists('data');
      const countSql = `SELECT COUNT(*) as count FROM data WHERE ${whereSql}`;
      const countRows = await storage.executeQuery<{ count: number }>(countSql);
      const count = countRows[0]?.count ?? 0;

      const sql = `SELECT ${selectCols} FROM data WHERE ${whereSql} LIMIT ${limit}`;
      const rows = await storage.executeQuery<Record<string, unknown>>(sql);

      res.json({
        sessionId,
        count,
        rows,
      });
    } finally {
      await storage.close();
    }
  } catch (error) {
    console.error('Error drilling through pivot cell:', error);
    handleDataApiError(res, error, 'Failed to drill through pivot cell');
  }
});

export default router;

