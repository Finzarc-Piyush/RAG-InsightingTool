/**
 * DuckDB Sample Helper
 * Pulls a small sample from a session's DuckDB-backed data table for column
 * identification without loading the full dataset into memory.
 */

import type { ChatDocument } from '../models/chat.model.js';
import { ColumnarStorageService, isDuckDBAvailable } from './columnarStorage.js';
import { ensureAuthoritativeDataTable } from './ensureSessionDuckdbMaterialized.js';

/**
 * Get a small sample from DuckDB for column identification (no full load).
 */
export async function getSampleFromDuckDB(
  sessionId: string,
  limit: number = 5000,
  chat?: ChatDocument | null
): Promise<Record<string, any>[]> {
  if (!isDuckDBAvailable()) return [];

  const storage = new ColumnarStorageService({ sessionId });
  try {
    await storage.initialize();
    if (chat) {
      try {
        await ensureAuthoritativeDataTable(storage, chat);
      } catch {
        return [];
      }
    }
    return await storage.getSampleRows(limit);
  } catch {
    return [];
  } finally {
    await storage.close();
  }
}
