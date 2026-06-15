/**
 * Large File Processor
 * Handles processing of large files (50MB+) using DuckDB native CSV load (read_csv_auto)
 * for fast initial upload. No stream parse + INSERT - single native load.
 */

import { ColumnarStorageService, DatasetMetadata, isDuckDBAvailable } from './columnarStorage.js';
import { uploadLimits } from '../config/uploadLimits.js';
import { metadataService } from './metadataService.js';
import { DataSummary } from '../shared/schema.js';
import { convertDashToZeroForNumericColumns, canonicalizeDateColumnValues } from './fileParser.js';
import { stripCurrencyAndParse } from './wideFormat/currencyVocabulary.js';
import {
  applyTemporalFacetColumns,
  isTemporalFacetColumnKey,
  periodDimensionFromSummary,
} from './temporalFacetColumns.js';
import { logger } from "./logger.js";
import { errorMessage } from "../utils/errorMessage.js";

/**
 * Wave Dup3 · feature flag — DEFAULT OFF. Mirrors the `USE_PARQUET_READ_PATH`
 * convention in `sessionParquet.ts` (`isParquetReadPathEnabled`). When unset (or
 * anything other than the exact string "true"), `processLargeFile` behaves
 * byte-for-byte as it always has: NO coercion pass, NO extra queries.
 *
 * When enabled, the ≥50MB DuckDB-native ingest path runs a SQL-only coercion
 * pass (`coerceDataTableInPlace`) that brings the authoritative `data` table to
 * the same canonical form the <50MB `parseFile` + `applyUploadPipelineWithProfile`
 * path already produces: currency/formatted-number strings → DOUBLE (with lone
 * "-"/"" → 0, matching `convertDashToZeroForNumericColumns`), and boolean-shaped
 * columns → "Yes"/"No" VARCHAR (matching `coerceBooleanCellToYesNo`).
 */
export function isLargeFileCoercionEnabled(): boolean {
  return process.env.LARGE_FILE_COERCION_ENABLED === 'true';
}

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
    let metadata = await storage.computeMetadata();

    // Idempotency: a re-uploaded enriched file carries our own derived facet
    // columns ("Month · Date", even nested "Day · Day · Date"). DuckDB re-types
    // some as DATE, so leaving them in the table would re-nest them on enrich
    // AND re-export them on download. Drop them up-front and recompute, so the
    // table holds only real columns + exactly one clean facet generation
    // (re-derived from the genuine date columns below).
    const incomingFacetColumns = metadata.columns
      .map((c) => c.name)
      .filter(isTemporalFacetColumnKey);
    if (incomingFacetColumns.length > 0) {
      await storage.dropColumns(incomingFacetColumns);
      metadata = await storage.computeMetadata();
    }

    // Wave Dup3 · OPT-IN coercion pass (default OFF). When the flag is unset the
    // entire block below is skipped — no extra queries, identical code path to
    // the historical behaviour. When enabled, bring the authoritative `data`
    // table to the same canonical shape the <50MB path produces (currency/dash,
    // booleans), then recompute metadata/summary/sample so downstream sees the
    // coerced values. A coercion failure must NOT break the upload.
    if (isLargeFileCoercionEnabled()) {
      try {
        const preSummary = metadataService.convertToDataSummary(
          metadata,
          await storage.getSampleRows(50),
        );
        const changed = await coerceDataTableInPlace(storage, preSummary);
        if (changed) {
          metadata = await storage.computeMetadata();
        }
      } catch (coerceErr) {
        logger.warn(
          `⚠️ Large-file coercion pass failed (continuing with un-coerced data): ${
            errorMessage(coerceErr)
          }`,
        );
      }
    }

    const rowCount = metadata.rowCount;
    const columns = metadata.columns.map((c) => c.name);

    onProgress?.({ stage: 'computing', progress: 75, message: 'Generating data summary...' });

    // Sample rows for summary and display
    const sampleRows = await storage.getSampleRows(50);

    let summary = metadataService.convertToDataSummary(metadata, sampleRows);
    const sampleRowsProcessed = convertDashToZeroForNumericColumns(sampleRows, summary.numericColumns);
    canonicalizeDateColumnValues(sampleRowsProcessed, summary.dateColumns);
    if (summary.dateColumns.length > 0) {
      applyTemporalFacetColumns(sampleRowsProcessed, summary.dateColumns, {
        periodDimension: periodDimensionFromSummary(summary),
      });
    }
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

/** DuckDB types that already hold numbers — never re-coerce these. */
function isNumericDuckType(type: string | undefined): boolean {
  if (!type) return false;
  const t = type.toUpperCase();
  return (
    t.includes('DOUBLE') ||
    t.includes('INTEGER') ||
    t.includes('BIGINT') ||
    t.includes('DECIMAL') ||
    t.includes('FLOAT') ||
    t.includes('HUGEINT') ||
    t.includes('SMALLINT') ||
    t.includes('TINYINT') ||
    t.includes('UBIGINT') ||
    t.includes('UINTEGER') ||
    t.includes('USMALLINT') ||
    t.includes('UTINYINT') ||
    t.includes('REAL') ||
    t.includes('NUMERIC')
  );
}

function isBooleanDuckType(type: string | undefined): boolean {
  return !!type && type.toUpperCase().includes('BOOLEAN');
}

function isVarcharDuckType(type: string | undefined): boolean {
  if (!type) return false;
  const t = type.toUpperCase();
  return t.includes('VARCHAR') || t.includes('CHAR') || t === 'TEXT' || t === 'STRING';
}

/**
 * Boolean vocabulary recognised by the <50MB path's `coerceBooleanCellToYesNo`.
 * That helper only canonicalises native booleans and the literal strings
 * "true"/"false" (case-insensitive). We stay equally conservative here: a
 * VARCHAR column is treated as boolean ONLY when EVERY distinct non-null value
 * is in {true,false} (any case). We deliberately do NOT convert 1/0, y/n, or
 * yes/no string columns — `coerceBooleanCellToYesNo` does not either, so doing
 * so would DIVERGE from the small-file path rather than match it.
 */
const BOOLEAN_TRUE_LITERALS = new Set(['true']);
const BOOLEAN_FALSE_LITERALS = new Set(['false']);

/**
 * Decide whether a VARCHAR column's distinct values are a pure true/false set.
 * `SELECT DISTINCT` over a string column — memory-safe (DuckDB returns only the
 * distinct set, not the full column).
 */
async function varcharColumnIsBoolean(
  storage: ColumnarStorageService,
  col: string,
): Promise<boolean> {
  const ident = `"${col.replace(/"/g, '""')}"`;
  const rows = await storage.executeQuery<{ v: string | null }>(
    `SELECT DISTINCT CAST(${ident} AS VARCHAR) AS v FROM "data" WHERE ${ident} IS NOT NULL LIMIT 50`,
  );
  if (rows.length === 0) return false;
  let sawTrue = false;
  let sawFalse = false;
  for (const r of rows) {
    if (r.v === null || r.v === undefined) continue;
    const lower = String(r.v).trim().toLowerCase();
    if (lower === '') continue;
    if (BOOLEAN_TRUE_LITERALS.has(lower)) {
      sawTrue = true;
    } else if (BOOLEAN_FALSE_LITERALS.has(lower)) {
      sawFalse = true;
    } else {
      return false; // any non-boolean literal disqualifies the column
    }
  }
  return sawTrue || sawFalse;
}

/**
 * Classify a VARCHAR column as numeric-once-cleaned by mirroring the <50MB
 * path's `createDataSummary` heuristic: a column is numeric when ≥70% of its
 * non-null sample values parse via `stripCurrencyAndParse` (currency-aware:
 * "$1,234.56", "₹2,000", "1.234,56 €", "-12%"). Lone "-" / "—" / "–" count as
 * numeric-shaped (they map to 0). Driven off the 50-row sample, matching the
 * small-file path which classifies off a leading sample.
 */
function sampleColumnIsNumeric(
  col: string,
  sample: Record<string, any>[],
): boolean {
  const values = sample
    .map((r) => r[col])
    .filter((v) => v !== null && v !== undefined && v !== '');
  if (values.length === 0) return false;
  let numericMatches = 0;
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      numericMatches++;
      continue;
    }
    const str = String(v).trim();
    if (str === '-' || str === '—' || str === '–') {
      numericMatches++; // dash → 0 in the small-file path
      continue;
    }
    if (stripCurrencyAndParse(str) !== null) {
      numericMatches++;
    }
  }
  const threshold = Math.max(1, Math.ceil(values.length * 0.7));
  return numericMatches >= threshold;
}

/**
 * Wave Dup3 · SQL-only, memory-safe coercion of the authoritative DuckDB `data`
 * table — closing the ≥50MB ingest gap (C1) so large files land in the same
 * canonical form the <50MB `parseFile` + `applyUploadPipelineWithProfile` path
 * already produces. NEVER materialises the full table into JS — it inspects
 * `computeMetadata()` types + a 50-row sample, then issues `ALTER TABLE …`
 * statements that DuckDB applies columnarly.
 *
 * Touched column-classes (matching the small-file semantics):
 *  • Currency / formatted numbers + dash→0 — for every VARCHAR column whose
 *    sample is ≥70% numeric-shaped (the same `stripCurrencyAndParse` rule
 *    `createDataSummary` uses), rewrite to DOUBLE: strip everything but digits,
 *    decimal point and sign; lone "-"/"" → 0. (Skips columns already numeric.)
 *  • Booleans → "Yes"/"No" — for DuckDB BOOLEAN columns, OR VARCHAR columns
 *    whose distinct non-null values are a pure true/false set (matching
 *    `coerceBooleanCellToYesNo`'s exact vocabulary). Rewritten to VARCHAR.
 *
 * Date handling is intentionally out of scope (per the C1 brief). Returns true
 * if any column was rewritten (so the caller can recompute metadata).
 */
export async function coerceDataTableInPlace(
  storage: ColumnarStorageService,
  summary: DataSummary,
): Promise<boolean> {
  const metadata = await storage.computeMetadata();
  const sample = await storage.getSampleRows(50);
  const typeByName = new Map<string, string>();
  for (const c of metadata.columns) typeByName.set(c.name, c.type);

  // Columns the post-load summary already considers numeric (DuckDB typed them
  // numeric) need no work. Coercion targets the columns the summary MISSES —
  // currency/formatted strings DuckDB left as VARCHAR.
  const alreadyNumeric = new Set(summary.numericColumns);

  let changed = false;

  for (const col of metadata.columns) {
    const name = col.name;
    if (isTemporalFacetColumnKey(name)) continue; // never touch derived facets
    const type = col.type;
    const ident = `"${name.replace(/"/g, '""')}"`;

    // 1) Boolean → "Yes"/"No" (checked before numeric so a true/false VARCHAR
    //    column is not mis-handled as numeric).
    if (isBooleanDuckType(type)) {
      await storage.executeStatement(
        `ALTER TABLE data ALTER COLUMN ${ident} TYPE VARCHAR USING (CASE WHEN ${ident} IS NULL THEN NULL WHEN ${ident} THEN 'Yes' ELSE 'No' END)`,
      );
      changed = true;
      continue;
    }
    if (isVarcharDuckType(type) && (await varcharColumnIsBoolean(storage, name))) {
      await storage.executeStatement(
        `ALTER TABLE data ALTER COLUMN ${ident} TYPE VARCHAR USING (CASE WHEN ${ident} IS NULL THEN NULL WHEN lower(trim(CAST(${ident} AS VARCHAR))) = 'true' THEN 'Yes' WHEN lower(trim(CAST(${ident} AS VARCHAR))) = 'false' THEN 'No' ELSE CAST(${ident} AS VARCHAR) END)`,
      );
      changed = true;
      continue;
    }

    // 2) Currency / formatted-number VARCHAR → DOUBLE (with dash/"" → 0). Skip
    //    columns already numeric. Only act on string columns whose sample reads
    //    as numeric — mirrors createDataSummary's 70% rule.
    if (alreadyNumeric.has(name) || isNumericDuckType(type)) continue;
    if (!isVarcharDuckType(type)) continue;
    if (!sampleColumnIsNumeric(name, sample)) continue;

    await storage.executeStatement(
      `ALTER TABLE data ALTER COLUMN ${ident} TYPE DOUBLE USING (` +
        `CASE WHEN trim(CAST(${ident} AS VARCHAR)) IN ('-', '—', '–', '') THEN 0 ` +
        `ELSE TRY_CAST(regexp_replace(CAST(${ident} AS VARCHAR), '[^0-9.\\-]', '', 'g') AS DOUBLE) END)`,
    );
    changed = true;
  }

  // Flush the WAL into the main DB file. The `ALTER … USING (CASE … regexp_replace …)`
  // statements are logged to the WAL; this session's file-backed DuckDB handle is
  // left open by `processLargeFile`, and the very next reader (`getDataForAnalysis`)
  // opens a SECOND handle to the same file. Some DuckDB builds hit an internal
  // assertion replaying a WAL that contains a scalar-function expression in an
  // ALTER, so we checkpoint here to make the schema change durable before any
  // other handle attaches.
  if (changed) {
    await storage.executeStatement('CHECKPOINT');
  }

  return changed;
}

/**
 * Check if file should use large file processing
 */
export function shouldUseLargeFileProcessing(fileSize: number): boolean {
  // Use large file processing for files >= 50MB, but only if DuckDB is available
  if (!isDuckDBAvailable()) {
    logger.log('⚠️ DuckDB not available - large file processing disabled. Using traditional processing.');
    return false;
  }
  return fileSize >= uploadLimits.largeFileThresholdBytes;
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
  // Wrap initialize + query inside a single try so a failure during init also
  // runs close(); close() must be idempotent / tolerant of partial init (P-024).
  const storage = new ColumnarStorageService({ sessionId });
  try {
    await storage.initialize();
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
    try {
      await storage.close();
    } catch (closeErr) {
      logger.warn(
        `⚠️ Failed to close columnar storage for session ${sessionId}:`,
        closeErr instanceof Error ? closeErr.message : closeErr
      );
    }
  }
}

