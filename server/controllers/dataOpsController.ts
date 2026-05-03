/**
 * Data Ops Controller
 * Thin controller layer for data operations endpoints - delegates to services
 */
import { Request, Response } from "express";
import { processDataOperation } from "../services/dataOps/dataOps.service.js";
import { processStreamDataOperation } from "../services/dataOps/dataOpsStream.service.js";
import { requireUsername, AuthenticationError } from "../utils/auth.helper.js";
import { sendError, sendValidationError, sendNotFound } from "../utils/responseFormatter.js";
import { getChatBySessionIdEfficient } from "../models/chat.model.js";
import { loadLatestData } from "../utils/dataLoader.js";
import { downloadFilenameTimestamp } from "../utils/downloadFilenameTimestamp.js";
import * as XLSX from 'xlsx';

function sanitizeDownloadFileStem(stem: string, fallback: string): string {
  let s = stem.trim().replace(/"/g, "_");
  s = s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
  s = s.replace(/_+/g, "_").replace(/^_|_$/g, "");
  return s.length > 0 ? s : fallback;
}

/**
 * Non-streaming Data Ops chat endpoint
 */
export const dataOpsChatWithAI = async (req: Request, res: Response) => {
  try {
    console.log('📨 dataOpsChatWithAI() called');
    const { sessionId, message, dataOpsMode } = req.body;
    const username = requireUsername(req);

    // Validate required fields
    if (!sessionId || !message) {
      return sendValidationError(res, 'Missing required fields');
    }

    // Process data operation (chatHistory will be fetched from Cosmos DB in the service)
    const result = await processDataOperation({
      sessionId,
      message,
      dataOpsMode,
      username,
    });

    res.json(result);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return res.status(401).json({ error: error.message });
    }
    console.error('Data Ops chat error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to process data operation';
    sendError(res, errorMessage);
  }
};

/**
 * Streaming Data Ops chat endpoint using Server-Sent Events (SSE)
 */
export const dataOpsChatWithAIStream = async (req: Request, res: Response) => {
  try {
    console.log('📨 dataOpsChatWithAIStream() called');
    const { sessionId, message, dataOpsMode } = req.body;
    const username = requireUsername(req);

    // Validate required fields
    if (!sessionId || !message) {
      return;
    }
    
    // Process streaming data operation (chatHistory will be fetched from Cosmos DB in the service)
    await processStreamDataOperation({
      sessionId,
      message,
      dataOpsMode,
      username,
      res,
    });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      if (!res.headersSent) {
        res.status(401).json({ error: (error as AuthenticationError).message });
      }
      return;
    }
    console.error('Data Ops stream error:', error);
    // Error handling is done in the service
  }
};

/**
 * Download modified dataset as CSV or Excel
 */
export const downloadModifiedDataset = async (req: Request, res: Response) => {
  try {
    console.log('📥 downloadModifiedDataset() called');
    const { sessionId } = req.params;
    const format = (req.query.format as string) || 'csv'; // csv or xlsx
    const username = requireUsername(req);

    if (!sessionId) {
      return sendValidationError(res, 'Session ID is required');
    }

    // Get chat document
    const chatDocument = await getChatBySessionIdEfficient(sessionId);
    if (!chatDocument) {
      return sendNotFound(res, 'Session not found');
    }

    // Verify user has access to this session
    if (chatDocument.username.toLowerCase() !== username.toLowerCase()) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Load the latest modified data
    const data = await loadLatestData(chatDocument);
    
    if (!data || data.length === 0) {
      return sendError(res, 'No data available to download');
    }

    const originalFileName = chatDocument.fileName || "dataset";
    const stem = originalFileName.replace(/\.[^/.]+$/, "");
    const baseFileName = sanitizeDownloadFileStem(stem, "dataset");
    const timestamp = downloadFilenameTimestamp();

    if (format === 'xlsx') {
      // Convert to Excel
      const worksheet = XLSX.utils.json_to_sheet(data);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
      
      // Generate buffer
      const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      
      // Set headers
      res.setHeader('Content-Disposition', `attachment; filename="${baseFileName}_modified_${timestamp}.xlsx"`);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Length', excelBuffer.length);
      
      res.send(excelBuffer);
    } else {
      // Convert to CSV
      if (data.length === 0) {
        return sendError(res, 'No data to export');
      }

      // Get all column names
      const columns = Object.keys(data[0] || {});
      
      // Create CSV header
      const csvHeader = columns.map(col => `"${String(col).replace(/"/g, '""')}"`).join(',');
      
      // Create CSV rows
      const csvRows = data.map(row => {
        return columns.map(col => {
          const value = row[col];
          if (value === null || value === undefined) {
            return '';
          }
          // Escape quotes and wrap in quotes if contains comma, newline, or quote
          const stringValue = String(value);
          if (stringValue.includes(',') || stringValue.includes('\n') || stringValue.includes('"')) {
            return `"${stringValue.replace(/"/g, '""')}"`;
          }
          return stringValue;
        }).join(',');
      });
      
      // Combine header and rows
      const csvContent = [csvHeader, ...csvRows].join('\n');
      const csvBuffer = Buffer.from(csvContent, 'utf-8');
      
      // Set headers
      res.setHeader('Content-Disposition', `attachment; filename="${baseFileName}_modified_${timestamp}.csv"`);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Length', csvBuffer.length);
      
      res.send(csvBuffer);
    }
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return res.status(401).json({ error: error.message });
    }
    console.error('Download modified dataset error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to download dataset';
    sendError(res, errorMessage);
  }
};

/**
 * Download the latest "working" dataset as XLSX — the exact rows the agent's
 * tools see (post-upload-enrichment, post-data-ops modifications, post-
 * persisted-computed-columns), with the active filter intentionally bypassed.
 *
 * Reuses `loadLatestData(..., { skipActiveFilter: true })` so the file matches
 * what the agent reads at chat time:
 *   - Wide-format auto-melt is re-applied on blob re-parse paths.
 *   - `canonicalizeLoadedData` materializes all temporal facet columns
 *     (Year · X, Quarter · X, Month · X, …) into the returned rows.
 *   - The Wave-FA non-destructive active filter is skipped — users always get
 *     the canonical unfiltered dataset, even when a filter chip is active.
 *
 * Per-turn computed columns added without `persistToSession: true` are NOT
 * present here by design — they are also absent from the next turn's agent
 * read, so this matches the agent's view exactly.
 */
export const downloadWorkingDataset = async (req: Request, res: Response) => {
  try {
    console.log('📥 downloadWorkingDataset() called');
    const { sessionId } = req.params;
    const username = requireUsername(req);

    if (!sessionId) {
      return sendValidationError(res, 'Session ID is required');
    }

    const chatDocument = await getChatBySessionIdEfficient(sessionId);
    if (!chatDocument) {
      return sendNotFound(res, 'Session not found');
    }

    if (chatDocument.username.toLowerCase() !== username.toLowerCase()) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const data = await loadLatestData(
      chatDocument,
      undefined,
      undefined,
      { skipActiveFilter: true },
    );

    if (!data || data.length === 0) {
      return sendError(res, 'No data available to download');
    }

    const format = (req.query.format as string) === 'csv' ? 'csv' : 'xlsx';
    const originalFileName = chatDocument.fileName || 'dataset';
    const stem = originalFileName.replace(/\.[^/.]+$/, '');
    const baseFileName = sanitizeDownloadFileStem(stem, 'dataset');
    const timestamp = downloadFilenameTimestamp();
    // Wave-C · Surface row count up-front so the client can warn before a
    // huge silent download. Header is exposed via CORS in `corsAllowedOrigins`.
    res.setHeader('X-Working-Dataset-Row-Count', String(data.length));

    if (format === 'xlsx') {
      const worksheet = XLSX.utils.json_to_sheet(data);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
      const excelBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

      const filename = `${baseFileName}_working_${timestamp}.xlsx`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Length', excelBuffer.length);
      res.send(excelBuffer);
    } else {
      const csvBuffer = buildCsvBuffer(data);
      const filename = `${baseFileName}_working_${timestamp}.csv`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Length', csvBuffer.length);
      res.send(csvBuffer);
    }
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return res.status(401).json({ error: error.message });
    }
    console.error('Download working dataset error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to download working dataset';
    sendError(res, errorMessage);
  }
};

/**
 * RFC 4180-ish CSV serializer: quote any field containing a comma, newline,
 * or quote; escape embedded quotes by doubling. Null / undefined become an
 * empty cell. Mirrors the inline CSV builder in `downloadModifiedDataset`.
 */
function buildCsvBuffer(rows: Record<string, any>[]): Buffer {
  if (rows.length === 0) return Buffer.from('', 'utf-8');
  const columns = Object.keys(rows[0] ?? {});
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('\n') || s.includes('"')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const header = columns.map((c) => escape(c)).join(',');
  const body = rows.map((row) => columns.map((c) => escape(row[c])).join(',')).join('\n');
  return Buffer.from(`${header}\n${body}`, 'utf-8');
}
