/**
 * Large File Processor
 * Handles processing of large files (50MB+) using DuckDB native CSV load (read_csv_auto)
 * for fast initial upload. No stream parse + INSERT - single native load.
 */

import { ColumnarStorageService, DatasetMetadata, isDuckDBAvailable } from './columnarStorage.js';
import { metadataService } from './metadataService.js';
import { DataSummary } from '../shared/schema.js';
import { convertDashToZeroForNumericColumns, canonicalizeDateColumnValues } from './fileParser.js';

export interface LargeFileProcessResult {
  rowCount: number;
  columns: string[];
  metadata: DatasetMetadata;
  summary: DataSummary;
  sampleRows: Record<string, any>[];
  storagePath: string;
}

export interface ProcessingProgress {
  stage: 'parsing' | 'loading' | 'computing' | 'complete';
  progress: number; // 0-100
  message?: string;
}

/**
 * Process large CSV file using DuckDB native read_csv_auto (single fast load).
 * Avoids slow stream-parse + row-by-row INSERT; typically 5-20x faster for large files.
 */
export async function processLargeFile(
  buffer: Buffer,
  sessionId: string,
  fileName: string,
  onProgress?: (progress: ProcessingProgress) => void
): Promise<LargeFileProcessResult> {
  const storage = new ColumnarStorageService({ sessionId });

  try {
    onProgress?.({ stage: 'parsing', progress: 5, message: 'Initializing columnar storage...' });
    await storage.initialize();

    // Single native DuckDB CSV load (read_csv_auto) - no JS parsing or INSERT loop
    onProgress?.({ stage: 'loading', progress: 15, message: 'Loading CSV into DuckDB (native)...' });
    await storage.loadCsvFromBuffer(buffer, 'data');

    // Compute metadata (rowCount, columns, stats)
    onProgress?.({ stage: 'computing', progress: 50, message: 'Computing dataset metadata...' });
    const metadata = await storage.computeMetadata();
    const rowCount = metadata.rowCount;
    const columns = metadata.columns.map((c) => c.name);

    onProgress?.({ stage: 'computing', progress: 75, message: 'Generating data summary...' });

    // Sample rows for summary and display
    const sampleRows = await storage.getSampleRows(50);

    let summary = metadataService.convertToDataSummary(metadata, sampleRows);
    const sampleRowsProcessed = convertDashToZeroForNumericColumns(sampleRows, summary.numericColumns);
    canonicalizeDateColumnValues(sampleRowsProcessed, summary.dateColumns);
    summary = metadataService.convertToDataSummary(metadata, sampleRowsProcessed);

    metadataService.cacheMetadata(sessionId, metadata, summary);

    onProgress?.({ stage: 'complete', progress: 100, message: 'Processing complete!' });

    return {
      rowCount,
      columns,
      metadata,
      summary,
      sampleRows: sampleRowsProcessed,
      storagePath: storage['dbPath'],
    };
  } catch (error) {
    await storage.cleanup().catch(() => {});
    throw error;
  }
}

/**
 * Check if file should use large file processing
 */
export function shouldUseLargeFileProcessing(fileSize: number): boolean {
  // Use large file processing for files >= 50MB, but only if DuckDB is available
  if (!isDuckDBAvailable()) {
    console.log('⚠️ DuckDB not available - large file processing disabled. Using traditional processing.');
    return false;
  }
  return fileSize >= 50 * 1024 * 1024;
}

/**
 * Get data from columnar storage for analysis
 * Returns sampled or aggregated data instead of full dataset
 */
export async function getDataForAnalysis(
  sessionId: string,
  requiredColumns?: string[],
  limit?: number
): Promise<Record<string, any>[]> {
  const storage = new ColumnarStorageService({ sessionId });
  await storage.initialize();

  try {
    if (requiredColumns && requiredColumns.length > 0) {
      // Query only required columns - no limit by default (load all rows)
      const columnsStr = requiredColumns.map(col => `"${col}"`).join(', ');
      const limitClause = limit ? `LIMIT ${limit}` : '';
      const query = `SELECT ${columnsStr} FROM data ${limitClause}`;
      return await storage.executeQuery(query);
    } else {
      // Get all rows if no limit specified, otherwise use limit
      if (limit) {
        return await storage.getSampleRows(limit);
      } else {
        // Load all rows - use streaming for large datasets
        return await storage.getAllRows();
      }
    }
  } finally {
    await storage.close();
  }
}

