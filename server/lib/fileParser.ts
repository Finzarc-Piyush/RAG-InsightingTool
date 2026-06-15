import { parse } from 'csv-parse/sync';
import { readExcelObjectRows, readExcelSheetNames } from './excelReader.js';
import { estimateExcelRowsFromRef } from './excelRowEstimate.js';
import { DataSummary } from '../shared/schema.js';
import { uploadLimits } from '../config/uploadLimits.js';
import {
  isDateColumnName,
  isTemporalWhitelistColumnName,
  parseFlexibleDate,
  sanitizeDateStringForParse,
  classifyAsTimeOfDay,
} from './dateUtils.js';
import { isLikelyIdentifierColumnName, isIdentifierLikeNumericColumn } from './columnIdHeuristics.js';
import { agentLog } from './agents/runtime/agentLogger.js';
import { findMatchingColumn } from './agents/utils/columnMatcher.js';
import type { DatasetProfile } from './datasetProfile.js';
import { computeCleanedDateColumnNames } from './dirtyDateEnrichment.js';
import { inferTemporalGrainFromDates } from './temporalGrain.js';
import {
  applyTemporalFacetColumns,
  isTemporalFacetColumnKey,
  stripTemporalFacetColumns,
  temporalFacetMetadataForDateColumns,
} from './temporalFacetColumns.js';
import {
  stripCurrencyAndParse,
  isoForSymbol,
} from './wideFormat/currencyVocabulary.js';

/**
 * SU-FU1 · Canonicalise boolean-shaped cell values to "Yes"/"No" at parse time.
 *
 * Excel native TRUE/FALSE cells round-trip through SheetJS (`raw: false`) as
 * uppercased "TRUE"/"FALSE" strings. CSV parsers (`cast: true`) sometimes
 * yield native JS booleans. Pre-fix the agent's PCT1 path, the planner LLM
 * was emitting `predicate.values: ["Yes"]` (from the prompt's worked example)
 * but the actual stored values were "TRUE"/"FALSE" — so the predicate
 * matched zero rows and the agent answered "0 of 0 clocked in before 9:30"
 * even when the data clearly had matching rows.
 *
 * Normalising once at parse time means downstream (DuckDB column store,
 * topValues catalog, planner prompt, in-app preview, XLSX download) all see
 * the same canonical "Yes"/"No" strings. Existing string columns whose
 * literal values happen to be "TRUE"/"FALSE" are deliberately rewritten —
 * this is the same canonicalisation the data preview UI already applies on
 * the read side, just done at write-time so the storage matches the display.
 *
 * Returns `null` when the value isn't boolean-shaped, so callers can fall
 * through to existing handling (currency parse, etc.).
 */
function coerceBooleanCellToYesNo(value: unknown): string | null {
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }
  if (typeof value === 'string') {
    const t = value.trim();
    if (!t) return null;
    if (t.length > 5) return null;
    const lower = t.toLowerCase();
    if (lower === 'true') return 'Yes';
    if (lower === 'false') return 'No';
  }
  return null;
}

export type CsvParseDiagnostics = {
  totalRows: number;
  mismatchedRows: number;
  mismatchRatio: number;
  sampleRowNumbers: number[];
  warning: string;
};

let lastCsvParseDiagnostics: CsvParseDiagnostics | undefined;

export function getAndClearLastCsvParseDiagnostics(): CsvParseDiagnostics | undefined {
  const out = lastCsvParseDiagnostics;
  lastCsvParseDiagnostics = undefined;
  return out;
}

/** Per-column currency tally captured during the parseFile coercion
 * pass. Strings are coerced to numbers via stripCurrencyAndParse, so
 * by the time createDataSummary runs the symbol is gone — we record
 * it here as a side-channel. Reset at the start of each parseFile
 * call. Read by createDataSummary. */
type CurrencyTally = {
  bySymbol: Map<string, { symbol: string; iso: string; position: 'prefix' | 'suffix'; count: number }>;
  total: number;
};
const currencyTallyByColumn: Map<string, CurrencyTally> = new Map();

function resetCurrencyTally(): void {
  currencyTallyByColumn.clear();
}

function recordCurrencySymbol(
  column: string,
  symbol: string,
  position: 'prefix' | 'suffix'
): void {
  let tally = currencyTallyByColumn.get(column);
  if (!tally) {
    tally = { bySymbol: new Map(), total: 0 };
    currencyTallyByColumn.set(column, tally);
  }
  tally.total++;
  const key = `${symbol}|${position}`;
  const entry = tally.bySymbol.get(key);
  if (entry) {
    entry.count++;
  } else {
    // Lazy import: isoForSymbol is in the wideFormat module already.
    // We resolve the iso later in finaliseCurrencyForColumn.
    tally.bySymbol.set(key, { symbol, iso: '', position, count: 1 });
  }
}

/** Finalise a per-column tally into a `currency` annotation.
 * Exported so callers (e.g. uploadQueue's wide-format melt) can
 * propagate the dominant currency from soon-to-be-melted source
 * columns onto the new long-format `Value` column. */
export function finaliseCurrencyForColumn(column: string):
  | { symbol: string; isoCode: string; position: 'prefix' | 'suffix'; confidence: number }
  | undefined {
  const tally = currencyTallyByColumn.get(column);
  if (!tally || tally.total === 0) return undefined;
  let best: { symbol: string; iso: string; position: 'prefix' | 'suffix'; count: number } | null = null;
  for (const e of tally.bySymbol.values()) {
    if (!best || e.count > best.count) best = e;
  }
  if (!best) return undefined;
  const ratio = best.count / tally.total;
  if (ratio < 0.8) return undefined;
  const iso = isoForSymbol(best.symbol);
  if (!iso) return undefined;
  return {
    symbol: best.symbol,
    isoCode: iso,
    position: best.position,
    confidence: ratio,
  };
}

/** Warn when preview sample Row IDs collapse — often misclassified date canonicalization. */
export function warnSuspiciousDuplicateRowIdInSample(
  sampleRows: Record<string, any>[],
  context: string
): void {
  if (sampleRows.length < 5) return;
  const keys = Object.keys(sampleRows[0]!);
  const idCol = keys.find((k) => {
    const n = k.trim().replace(/\s+/g, " ").replace(/^#\s*/, "").toLowerCase();
    return n === "row id";
  });
  if (!idCol) return;
  const counts = new Map<string, number>();
  for (const r of sampleRows) {
    const v = r[idCol];
    if (v === null || v === undefined) continue;
    const s = String(v);
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  let max = 0;
  for (const c of counts.values()) max = Math.max(max, c);
  if (max / sampleRows.length >= 0.9) {
    logger.warn(
      `[${context}] Over 90% of sample rows share the same "${idCol}" value; possible date-column misclassification or enrichment corruption.`
    );
  }
}

export type ParseFileOptions = {
  sheetName?: string;
};

export async function parseFile(
  buffer: Buffer,
  filename: string,
  opts: ParseFileOptions = {}
): Promise<Record<string, any>[]> {
  lastCsvParseDiagnostics = undefined;
  resetCurrencyTally();
  const ext = filename.split('.').pop()?.toLowerCase();

  if (ext === 'csv') {
    return parseCsv(buffer);
  } else if (ext === 'xlsx' || ext === 'xls') {
    return parseExcel(buffer, opts);
  } else {
    throw new Error('Unsupported file format. Please upload CSV or Excel files.');
  }
}

export async function getExcelSheetNames(buffer: Buffer): Promise<string[]> {
  return readExcelSheetNames(buffer);
}

function parseCsv(buffer: Buffer): Record<string, any>[] {
  const content = buffer.toString('utf-8');
  
  // For very large files, use streaming parser if available
  // For now, we use sync parser but optimize memory usage
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    cast: true,
    cast_date: true,
    info: true,
    // Optimize memory for large files
    relax_column_count: true,
    relax_quotes: true,
  });

  const withInfo = records as Array<{ record: Record<string, any>; info?: { lines?: number; invalid_field_length?: number } }>;
  let mismatchedRows = 0;
  const sampleRowNumbers: number[] = [];
  const unwrappedRecords: Record<string, any>[] = [];
  for (let i = 0; i < withInfo.length; i++) {
    const entry = withInfo[i] as any;
    const record = entry?.record ?? entry;
    const info = entry?.info;
    if ((info?.invalid_field_length ?? 0) > 0) {
      mismatchedRows += 1;
      if (sampleRowNumbers.length < 10) {
        sampleRowNumbers.push(info?.lines ?? i + 1);
      }
    }
    unwrappedRecords.push(record);
  }

  const mismatchRatio = unwrappedRecords.length > 0 ? mismatchedRows / unwrappedRecords.length : 0;
  if (mismatchedRows > 0) {
    lastCsvParseDiagnostics = {
      totalRows: unwrappedRecords.length,
      mismatchedRows,
      mismatchRatio,
      sampleRowNumbers,
      warning: `CSV rows with mismatched column counts detected: ${mismatchedRows}/${unwrappedRecords.length} (${(mismatchRatio * 100).toFixed(2)}%).`,
    };
    logger.warn(
      `⚠️ ${lastCsvParseDiagnostics.warning} Sample rows: ${sampleRowNumbers.join(', ') || 'n/a'}`
    );
  }
  
  // Normalize column names: trim whitespace from all column names
  const normalized = normalizeColumnNames(unwrappedRecords as Record<string, any>[]);
  
  // Post-process: Convert empty values to null and string numbers to actual numbers
  // This handles cases where CSV parser didn't convert formatted numbers (with %, commas, etc.)
  // Process in batches for very large datasets to avoid memory spikes
  const BATCH_SIZE = 10000;
  const result: Record<string, any>[] = [];
  
  for (let i = 0; i < normalized.length; i += BATCH_SIZE) {
    const batch = normalized.slice(i, i + BATCH_SIZE);
    const processedBatch = batch.map(row => {
      const processedRow: Record<string, any> = {};
      for (const [key, value] of Object.entries(row)) {
        // Convert empty strings and whitespace-only strings to null
        if (value === null || value === undefined) {
          processedRow[key] = null;
          continue;
        }

        // SU-FU1 · canonicalise booleans (native bool from `cast: true`
        // OR pre-stringified "true"/"false") to "Yes"/"No" so the
        // planner's PCT1 path matches the actual stored values.
        const boolCanon = coerceBooleanCellToYesNo(value);
        if (boolCanon !== null) {
          processedRow[key] = boolCanon;
          continue;
        }

        if (typeof value === 'string') {
          const trimmed = value.trim();
          // Convert empty strings or whitespace-only strings to null
          if (trimmed === '' || trimmed.length === 0) {
            processedRow[key] = null;
            continue;
          }

          // Try to convert string numbers — currency-aware: strips
          // leading/trailing currency symbols (đ, $, €, £, ¥, ₹, R$,
          // S$, HK$, RM, Rp, kr, …) before parsing. The symbol is
          // tallied via `recordCurrencySymbol` and finalised onto
          // `ColumnInfo.currency` by `createDataSummary`.
          const parsed = stripCurrencyAndParse(trimmed);
          if (parsed !== null) {
            processedRow[key] = parsed.num;
            if (parsed.symbol && parsed.position) {
              recordCurrencySymbol(key, parsed.symbol, parsed.position);
            }
          } else {
            processedRow[key] = trimmed;
          }
        } else if (typeof value === 'number') {
          // If already a number, keep it
          if (!isNaN(value) && isFinite(value)) {
            processedRow[key] = value;
          } else {
            processedRow[key] = null; // Convert NaN/Infinity to null
          }
        } else {
          processedRow[key] = value;
        }
      }
      return processedRow;
    });
    
    result.push(...processedBatch);
    
    // Log progress for very large files
    if (normalized.length > 50000 && (i + BATCH_SIZE) % 50000 === 0) {
      logger.log(`  Processed ${Math.min(i + BATCH_SIZE, normalized.length)} / ${normalized.length} rows...`);
    }
  }
  
  return result;
}

// Re-exported from its own module (Wave R8) so the ExcelJS reader and
// fileParser can share it without a circular import.
export { estimateExcelRowsFromRef } from './excelRowEstimate.js';
import { logger } from "./logger.js";

async function parseExcel(buffer: Buffer, opts: ParseFileOptions = {}): Promise<Record<string, any>[]> {
  // Phase 0 · large-dataset OOM guard. ExcelJS has no zero-copy streaming on
  // this path either, and materialising one JS object per row is the step most
  // likely to exhaust the heap. Refuse oversized sheets with actionable
  // guidance instead of crashing. (Wording avoids "memory"/"too large" so the
  // upload pipeline's generic memory-error remap doesn't mask this message.)
  // NOTE: this guards the row-object allocation, NOT the preceding workbook
  // load — a pathological workbook can still OOM at load time. Phase 2 removes
  // both risks with a streaming Excel ingest.
  const excelRowCap = uploadLimits.maxExcelRowsInMemory;
  const { rows: data } = await readExcelObjectRows(buffer, {
    sheetName: opts.sheetName,
    maxRows: excelRowCap,
    onOversize: (estimatedRows): never => {
      throw new Error(
        `This Excel sheet has about ${estimatedRows.toLocaleString('en-US')} rows, above the supported ` +
          `Excel size of ${excelRowCap.toLocaleString('en-US')} rows. Excel files this large can fail ` +
          `during parsing — please export the sheet to CSV and upload that instead (CSV handles far larger ` +
          `datasets). Operators can raise MAX_EXCEL_ROWS_IN_MEMORY when the server has ample RAM.`,
      );
    },
  });

  // Normalize column names: trim whitespace from all column names
  const normalized = normalizeColumnNames(data as Record<string, any>[]);
  
  // Post-process: Convert empty values to null and string numbers to actual numbers
  // This handles cases where Excel parser didn't convert formatted numbers (with %, commas, etc.)
  return normalized.map(row => {
    const processedRow: Record<string, any> = {};
    for (const [key, value] of Object.entries(row)) {
      // Convert empty strings and whitespace-only strings to null
      if (value === null || value === undefined) {
        processedRow[key] = null;
        continue;
      }

      // SU-FU1 · canonicalise booleans (native or pre-stringified
      // "TRUE"/"FALSE" from XLSX `raw: false`) to "Yes"/"No" so the
      // planner's PCT1 path matches the actual stored values.
      const boolCanon = coerceBooleanCellToYesNo(value);
      if (boolCanon !== null) {
        processedRow[key] = boolCanon;
        continue;
      }

      if (typeof value === 'string') {
        const trimmed = value.trim();
        // Convert empty strings or whitespace-only strings to null
        if (trimmed === '' || trimmed.length === 0) {
          processedRow[key] = null;
          continue;
        }

        // Currency-aware string→number coercion (mirror of the CSV
        // path above — see comment there).
        const parsed = stripCurrencyAndParse(trimmed);
        if (parsed !== null) {
          processedRow[key] = parsed.num;
          if (parsed.symbol && parsed.position) {
            recordCurrencySymbol(key, parsed.symbol, parsed.position);
          }
        } else {
          processedRow[key] = trimmed;
        }
      } else if (typeof value === 'number') {
        // If already a number, keep it
        if (!isNaN(value) && isFinite(value)) {
          processedRow[key] = value;
        } else {
          processedRow[key] = null; // Convert NaN/Infinity to null
        }
      } else {
        processedRow[key] = value;
      }
    }
    return processedRow;
  });
}

/**
 * Normalizes column names by trimming whitespace from all keys
 * This ensures consistent column name handling throughout the application
 */
function normalizeColumnNames(data: Record<string, any>[]): Record<string, any>[] {
  if (!data || data.length === 0) {
    return data;
  }
  
  // Create a mapping of old column names to normalized (trimmed) names
  const firstRow = data[0]!;
  const columnMapping: Record<string, string> = {};
  
  for (const oldKey of Object.keys(firstRow)) {
    const normalizedKey = oldKey.trim();
    if (oldKey !== normalizedKey) {
      columnMapping[oldKey] = normalizedKey;
    }
  }
  
  // If no normalization needed, return as-is
  if (Object.keys(columnMapping).length === 0) {
    return data;
  }
  
  // Remap all rows to use normalized column names
  return data.map(row => {
    const normalizedRow: Record<string, any> = {};
    for (const [oldKey, value] of Object.entries(row)) {
      const newKey = columnMapping[oldKey] || oldKey.trim();
      normalizedRow[newKey] = value;
    }
    return normalizedRow;
  });
}

/**
 * Convert "-" values to 0 for numerical columns
 * This ensures that dash placeholders in numeric columns are treated as 0, not null
 */
export function convertDashToZeroForNumericColumns(
  data: Record<string, any>[],
  numericColumns: string[]
): Record<string, any>[] {
  if (!data || data.length === 0 || !numericColumns || numericColumns.length === 0) {
    return data;
  }

  return data.map(row => {
    const processedRow: Record<string, any> = { ...row };
    
    for (const col of numericColumns) {
      if (col in processedRow) {
        const value = processedRow[col];
        
        // Check if value is "-" (with or without whitespace)
        if (typeof value === 'string') {
          const trimmed = value.trim();
          // Match exactly "-" or variations with whitespace
          if (trimmed === '-' || trimmed === '—' || trimmed === '–') {
            processedRow[col] = 0;
          }
        } else if (value === null || value === undefined) {
          // Keep null/undefined as is - only convert "-" to 0
          processedRow[col] = value;
        }
      }
    }
    
    return processedRow;
  });
}

function isLocalMidnight(d: Date): boolean {
  return (
    d.getHours() === 0 &&
    d.getMinutes() === 0 &&
    d.getSeconds() === 0 &&
    d.getMilliseconds() === 0
  );
}

function formatLocalYMD(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Prefer YYYY-MM-DD when the source has no explicit time; otherwise full ISO UTC. */
function toCanonicalDateStorage(raw: unknown, parsed: Date): string {
  if (raw instanceof Date) {
    // Excel date cells have no time component. xlsx parses them as Date objects
    // at UTC midnight (00:00 UTC). On non-UTC servers isLocalMidnight() returns
    // false, causing toISOString() to be used ("2018-01-03T00:00:00.000Z").
    // DuckDB cannot TRY_CAST that form directly to DATE → inline SQL returns null.
    // Treat UTC midnight as date-only too so DuckDB always gets "YYYY-MM-DD".
    const isUtcMidnight =
      parsed.getUTCHours() === 0 &&
      parsed.getUTCMinutes() === 0 &&
      parsed.getUTCSeconds() === 0 &&
      parsed.getUTCMilliseconds() === 0;
    return isLocalMidnight(parsed) || isUtcMidnight
      ? formatLocalYMD(parsed)
      : parsed.toISOString();
  }
  const t = sanitizeDateStringForParse(String(raw));
  const hasExplicitTime = /T\d{2}:\d{2}/.test(t) || /\b\d{1,2}:\d{2}:\d{2}\b/.test(t);
  if (!hasExplicitTime) {
    return formatLocalYMD(parsed);
  }
  return parsed.toISOString();
}

/**
 * When row keys differ from summary date names (e.g. DuckDB "Order_Date" vs profile "Order Date"),
 * copy values onto the logical column name so canonicalization and temporal facets see them.
 */
function hydrateLogicalDateColumnKeysFromPhysical(
  data: Record<string, any>[],
  logicalCols: string[]
): void {
  if (data.length === 0) return;
  const physical = Object.keys(data[0]!);
  for (const logical of logicalCols) {
    if (physical.includes(logical)) continue;
    const m = findMatchingColumn(logical, physical);
    if (!m || m === logical) continue;
    for (const row of data) {
      if (row[logical] === undefined && row[m] !== undefined) {
        row[logical] = row[m];
      }
    }
  }
}

/**
 * Normalize values in date columns to ISO (date-only or full instant) for consistent analysis and display.
 */
export function canonicalizeDateColumnValues(data: Record<string, any>[], dateColumns: string[]): void {
  if (data.length === 0 || dateColumns.length === 0) return;

  const verbose =
    process.env.AGENT_VERBOSE_LOGS === "true" ||
    process.env.ENRICHMENT_DEBUG_LOGS === "true";
  const skippedId = dateColumns.filter((c) => isLikelyIdentifierColumnName(c));
  if (skippedId.length && verbose) {
    agentLog("canonicalize_skip_identifier_cols", {
      cols: skippedId.join("|").slice(0, 200),
    });
  }
  for (const col of dateColumns) {
    if (!isLikelyIdentifierColumnName(col) || !verbose) continue;
    const slice = data.slice(0, Math.min(50, data.length));
    const vals = slice.map((r) => r[col]).filter((v) => v != null && v !== "");
    const uniq = new Set(vals.map((v) => String(v)));
    agentLog("enrichment_date_col_identifier", {
      col,
      distinct: uniq.size,
      preview: [...uniq].slice(0, 3).join("|").slice(0, 120),
    });
  }

  const safeCols = dateColumns.filter((c) => !isLikelyIdentifierColumnName(c));
  if (safeCols.length === 0) return;
  hydrateLogicalDateColumnKeysFromPhysical(data, safeCols);
  const changedByCol = new Map<string, number>();

  for (const row of data) {
    for (const col of safeCols) {
      const v = row[col];
      if (v === null || v === undefined || v === '') continue;
      if (v instanceof Date && !isNaN(v.getTime())) {
        const out = toCanonicalDateStorage(v, v);
        row[col] = out;
        changedByCol.set(col, (changedByCol.get(col) || 0) + 1);
        continue;
      }
      if (typeof v === 'string' || typeof v === 'number') {
        const parsed = parseFlexibleDate(String(v));
        if (parsed) {
          const out = toCanonicalDateStorage(v, parsed);
          if (out !== v) {
            row[col] = out;
            changedByCol.set(col, (changedByCol.get(col) || 0) + 1);
          }
        }
      }
    }
  }
  if (verbose && changedByCol.size > 0) {
    agentLog("enrichment_mutation_counts", {
      counts: [...changedByCol.entries()]
        .map(([k, v]) => `${k}:${v}`)
        .join("|")
        .slice(0, 500),
    });
  }
}

/** Distinct value counts for low-cardinality string columns (optional metadata). */
function computeTopStringValues(
  data: Record<string, any>[],
  col: string,
  maxScan: number,
  maxDistinct: number,
  maxReturn: number
): { value: string | number; count: number }[] | undefined {
  const slice = data.slice(0, Math.min(data.length, maxScan));
  const counts = new Map<string, number>();
  for (const row of slice) {
    const v = row[col];
    if (v === null || v === undefined || v === '') continue;
    const key = String(v);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (counts.size === 0 || counts.size > maxDistinct) {
    return undefined;
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxReturn)
    .map(([value, count]) => ({ value, count }));
}

/** Share threshold logic for summary typing and upload approval. */
export function isDateParseableAtThreshold(
  values: unknown[],
  thresholdRatio: number
): boolean {
  const nonNull = values.filter((v) => v !== null && v !== undefined && v !== '');
  if (nonNull.length === 0) return false;
  const matches = nonNull.filter((v) => {
    if (v instanceof Date && !isNaN(v.getTime())) return true;
    if (typeof v === 'string' || typeof v === 'number') {
      return !!parseFlexibleDate(String(v));
    }
    return false;
  }).length;
  const threshold = Math.max(1, Math.ceil(nonNull.length * thresholdRatio));
  return matches >= threshold;
}

export function createDataSummary(data: Record<string, any>[]): DataSummary {
  if (data.length === 0) {
    throw new Error('No data found in file');
  }

  const userColumns = Object.keys(data[0]!).filter((k) => !isTemporalFacetColumnKey(k));
  const numericColumns: string[] = [];
  const dateColumns: string[] = [];

  const columnInfo = userColumns.map((col) => {
    // Check more rows for better date detection (up to 1000 rows or all rows if less)
    // This ensures we catch date columns even if they're not in the first 100 rows
    const sampleSize = Math.min(data.length, 1000);
    const values = data.slice(0, sampleSize).map((row) => row[col]);
    const nonNullValues = values.filter((v) => v !== null && v !== undefined && v !== '');

    // Determine column type
    let type = 'string';
    
    // Check if numeric (handle percentages, commas, and string representations)
    // Use threshold approach: if most values (>=70%) are numeric, treat column as numeric
    // This handles cases where some values might be null, empty, or edge cases
    let numericMatches = 0;
    if (nonNullValues.length > 0) {
      numericMatches = nonNullValues.filter((v) => {
        if (v === '' || v === null || v === undefined) return false;
        
        // If already a number, it's numeric
        if (typeof v === 'number' && !isNaN(v) && isFinite(v)) return true;
        
        // Convert to string and clean
        const str = String(v).trim();
        if (str === '' || str === 'null' || str === 'undefined' || str.toLowerCase() === 'nan') return false;
        
        // Handle special characters that might indicate non-numeric (but allow in certain contexts)
        // Skip if it looks like a date string (has month names or date separators in date-like patterns)
        const lowerStr = str.toLowerCase();
        const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
                           'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 
                           'september', 'october', 'november', 'december'];
        const hasMonthName = monthNames.some(month => lowerStr.includes(month));
        const hasDateSeparators = /[\/\-]/.test(str) && /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(str);
        
        // If it looks like a date, don't treat as numeric
        if (hasMonthName || hasDateSeparators) return false;
        
        // Currency-aware numeric check: covers đ (VND), R$, S$, HK$,
        // RM, Rp, kr, ₩, ₪, ₺, ฿ etc. in addition to the legacy
        // $/€/£/¥/₹ set. Returns null when the value is non-numeric.
        return stripCurrencyAndParse(str) !== null;
      }).length;
    }
    
    const numericThreshold = Math.max(1, Math.ceil(nonNullValues.length * 0.7)); // 70% threshold
    const isNumeric = nonNullValues.length > 0 && numericMatches >= numericThreshold;

    const nn = nonNullValues.filter((v) => v !== null && v !== undefined && v !== '');

    // TOD1 · Time-of-day classification runs BEFORE the date check. When a
    // column's values look like HH:MM:SS strings (no calendar date), we tag
    // it as text + timeOfDay annotation rather than letting it trip the
    // word-"time" hint in isDateColumnName (which would mis-tag it as `date`
    // and cause silent shape mismatches against DuckDB's VARCHAR storage).
    let timeOfDayInfo: { sentinelValues?: string[] } | undefined;
    if (!isNumeric && nn.length > 0) {
      const verdict = classifyAsTimeOfDay(col, nn);
      if (verdict.isTimeOfDay) {
        timeOfDayInfo = verdict.sentinelValues.length
          ? { sentinelValues: verdict.sentinelValues }
          : {};
      }
    }

    let isDate = false;
    if (
      !timeOfDayInfo &&
      !isNumeric &&
      !isLikelyIdentifierColumnName(col) &&
      nn.length > 0
    ) {
      if (isTemporalWhitelistColumnName(col)) {
        isDate = true;
      } else if (
        isDateColumnName(col) &&
        isDateParseableAtThreshold(values, 0.65)
      ) {
        isDate = true;
      } else if (isDateParseableAtThreshold(values, 0.88)) {
        isDate = true;
      }
    }

    // Currency-tagged columns (those whose source strings carried a
    // currency symbol at parse time) are always real measures, never
    // identifier-like — bypass the high-cardinality / fixed-width
    // heuristic that would otherwise misclassify a column of unique
    // large currency amounts (e.g. 24 unique đX,XXX,XXX,XXX values).
    const hasCurrencyTally = currencyTallyByColumn.has(col);
    if (isNumeric && (hasCurrencyTally || !isIdentifierLikeNumericColumn(col, nonNullValues))) {
      type = 'number';
      numericColumns.push(col);
    } else if (isDate) {
      type = 'date';
      dateColumns.push(col);
    }

    // Serialize sample values to primitives (convert Date objects to strings)
    const sampleValues = values.slice(0, 3).map((v) => {
      if (v instanceof Date) {
        return v.toISOString();
      }
      return v;
    });

    let temporalDisplayGrain: 'dayOrWeek' | 'monthOrQuarter' | 'year' | undefined;
    if (isDate && nn.length > 0) {
      const parsedDates = nn
        .map((v) => {
          if (v instanceof Date && !isNaN(v.getTime())) return v;
          if (typeof v === 'string' || typeof v === 'number') {
            return parseFlexibleDate(String(v));
          }
          return null;
        })
        .filter((d): d is Date => !!d);
      if (parsedDates.length > 0) {
        temporalDisplayGrain = inferTemporalGrainFromDates(parsedDates);
      }
    }

    const topValues =
      type === 'string' ? computeTopStringValues(data, col, 12_000, 48, 24) : undefined;

    // Currency tag — finalised from the per-column tally captured
    // during parseFile coercion. By the time createDataSummary runs
    // numeric values are already coerced, so the tally side-channel
    // is the only source of the original symbol. Non-numeric columns
    // and uploads with no symbol-bearing strings produce undefined.
    const currency = type === 'number'
      ? finaliseCurrencyForColumn(col)
      : undefined;

    // Wave T1 · post-parse dateRange. Iterates the full dataset (not the
    // 1000-row sample) so the span is accurate for date-sorted uploads where
    // the first 1000 rows would cluster at one end. Cost is O(rows) per date
    // column at upload time — fine for the once-per-upload pipeline.
    let dateRange:
      | { minIso: string; maxIso: string; distinctDayCount: number; spanDays: number }
      | undefined;
    if (isDate) {
      let minMs = Number.POSITIVE_INFINITY;
      let maxMs = Number.NEGATIVE_INFINITY;
      const distinctDays = new Set<string>();
      for (const row of data) {
        const v = row[col];
        if (v === null || v === undefined || v === "") continue;
        let d: Date | null = null;
        if (v instanceof Date && !isNaN(v.getTime())) {
          d = v;
        } else if (typeof v === "string" || typeof v === "number") {
          d = parseFlexibleDate(String(v));
        }
        if (!d) continue;
        const ms = d.getTime();
        if (ms < minMs) minMs = ms;
        if (ms > maxMs) maxMs = ms;
        distinctDays.add(d.toISOString().slice(0, 10));
      }
      if (Number.isFinite(minMs) && Number.isFinite(maxMs)) {
        dateRange = {
          minIso: new Date(minMs).toISOString().slice(0, 10),
          maxIso: new Date(maxMs).toISOString().slice(0, 10),
          distinctDayCount: distinctDays.size,
          spanDays: Math.max(0, Math.floor((maxMs - minMs) / 86_400_000)),
        };
      }
    }

    return {
      name: col,
      type,
      sampleValues,
      ...(topValues?.length ? { topValues } : {}),
      ...(temporalDisplayGrain !== undefined ? { temporalDisplayGrain } : {}),
      ...(currency ? { currency } : {}),
      ...(timeOfDayInfo ? { timeOfDay: timeOfDayInfo } : {}),
      ...(dateRange ? { dateRange } : {}),
    };
  });

  const row0 = data[0] || {};
  const facetMetaList = temporalFacetMetadataForDateColumns(dateColumns);
  const facetColumnInfos = facetMetaList
    .filter((m) => Object.prototype.hasOwnProperty.call(row0, m.name))
    .map((m) => {
      const sampleValues = data.slice(0, 3).map((row) => {
        const v = row[m.name];
        if (v instanceof Date) return v.toISOString();
        return v ?? null;
      });
      return {
        name: m.name,
        type: "string" as const,
        sampleValues,
        temporalFacetGrain: m.grain,
        temporalFacetSource: m.sourceColumn,
      };
    });

  return {
    rowCount: data.length,
    columnCount: userColumns.length + facetColumnInfos.length,
    columns: [...columnInfo, ...facetColumnInfos],
    numericColumns,
    dateColumns,
    temporalFacetColumns: facetMetaList,
  };
}

/** Upload LLM lists date columns; we only validate names exist and are not identifier columns. */
export function resolveDateColumnsForUpload(
  data: Record<string, any>[],
  profile: DatasetProfile
): string[] {
  const keys = new Set(Object.keys(data[0]!));
  return profile.dateColumns.filter((c) => keys.has(c) && !isLikelyIdentifierColumnName(c));
}

/**
 * Like resolveDateColumnsForUpload, but swaps dirty string sources for their Cleaned_* column when present.
 * Pass columnOrderBeforeClean from before dirty-date enrichment so cleaned header names match computeCleanedDateColumnNames.
 */
export function resolveEffectiveDateColumns(
  data: Record<string, any>[],
  profile: DatasetProfile,
  columnOrderBeforeClean?: string[]
): string[] {
  const keys = new Set(Object.keys(data[0] || {}));
  const base = profile.dateColumns.filter(
    (c) => keys.has(c) && !isLikelyIdentifierColumnName(c)
  );
  const dirty = new Set(profile.dirtyStringDateColumns ?? []);
  if (!dirty.size) return base;
  const order = columnOrderBeforeClean?.length
    ? columnOrderBeforeClean
    : Object.keys(data[0] || {});
  const sourceToCleaned = computeCleanedDateColumnNames(order, profile);
  return base.map((c) => {
    if (!dirty.has(c)) return c;
    const cleaned = sourceToCleaned.get(c);
    if (cleaned && keys.has(cleaned)) return cleaned;
    return c;
  });
}

/**
 * Final approved set for mutation: whitelist columns + LLM columns that parse at threshold,
 * always excluding likely identifiers.
 */
export function resolveApprovedDateColumns(
  data: Record<string, any>[],
  profile: DatasetProfile,
  opts?: ApplyUploadPipelineOptions
): string[] {
  if (data.length === 0) return [];
  const columns = Object.keys(data[0] || {});
  const llmCols = resolveEffectiveDateColumns(data, profile, opts?.columnOrderBeforeClean);
  const approved: string[] = [];

  // SU-FU1 · sample once per column for the time-of-day veto so we don't
  // re-walk the data inside the LLM-col loop below.
  const sampleSizeForTodCheck = Math.min(data.length, 200);
  const isTimeOfDayColumn = (col: string): boolean => {
    if (!columns.includes(col)) return false;
    const vals = data
      .slice(0, sampleSizeForTodCheck)
      .map((r) => r[col])
      .filter((v) => v !== null && v !== undefined && v !== '');
    if (vals.length === 0) return false;
    return classifyAsTimeOfDay(col, vals).isTimeOfDay;
  };

  for (const col of columns) {
    // Never re-approve one of our own derived facet columns ("Month · Date")
    // as a date source — that is what nests into "Day · Month · Date". Mirrors
    // the createDataSummary filter above.
    if (isTemporalFacetColumnKey(col)) continue;
    if (isLikelyIdentifierColumnName(col)) continue;
    if (!isTemporalWhitelistColumnName(col)) continue;
    // SU-FU1 · refuse the whitelist approval when the column's values
    // are HH:MM:SS time-of-day strings. The whitelist regex matches "time"
    // substrings ("Clock-In Time") that should NEVER be treated as
    // calendar-date columns — `parseRowDate("09:45:34")` returns null,
    // which would generate empty Day/Week/Month facet columns.
    if (isTimeOfDayColumn(col)) continue;
    approved.push(col);
  }

  const sampleSize = Math.min(data.length, 1000);
  const llmThresholdRatio = Number(process.env.LLM_DATE_OVERRIDE_PARSE_THRESHOLD) || 0.7;
  for (const col of llmCols) {
    if (approved.includes(col)) continue;
    if (isTemporalFacetColumnKey(col)) continue;
    if (isLikelyIdentifierColumnName(col)) continue;
    if (!columns.includes(col)) continue;
    // SU-FU1 · refuse time-of-day columns even when the LLM dataset
    // profile labelled them as dates. See helper above.
    if (isTimeOfDayColumn(col)) continue;
    const values = data.slice(0, sampleSize).map((r) => r[col]);
    if (isDateParseableAtThreshold(values, llmThresholdRatio)) {
      approved.push(col);
    }
  }
  const debug =
    process.env.AGENT_VERBOSE_LOGS === "true" ||
    process.env.ENRICHMENT_DEBUG_LOGS === "true";
  if (debug) {
    agentLog("approved_date_columns", { cols: approved.join("|").slice(0, 500) });
  }
  return approved;
}

/** Sync summary.dateColumns and per-column types with the date list used for canonicalization. */
function applyDateColumnSelectionToSummary(summary: DataSummary, dateCols: string[]): void {
  const dateSet = new Set(dateCols);
  summary.dateColumns = [...dateCols];
  summary.temporalFacetColumns = temporalFacetMetadataForDateColumns(dateCols);
  for (const col of summary.columns) {
    if (dateSet.has(col.name)) {
      col.type = 'date';
    } else if (col.type === 'date') {
      col.type = summary.numericColumns.includes(col.name) ? 'number' : 'string';
      if ('temporalDisplayGrain' in col) {
        delete (col as { temporalDisplayGrain?: unknown }).temporalDisplayGrain;
      }
    }
  }
}

export type ApplyUploadPipelineOptions = {
  /** Column key order before Cleaned_* columns were inserted; required for correct dirty-date substitution when data keys changed. */
  columnOrderBeforeClean?: string[];
};

/**
 * After inferDatasetProfile + optional dirty-date enrichment: dash cleanup, canonicalize dates, final summary.
 * Returns a new row array (convertDash copies rows).
 */
export function applyUploadPipelineWithProfile(
  data: Record<string, any>[],
  profile: DatasetProfile,
  opts?: ApplyUploadPipelineOptions
): { data: Record<string, any>[]; summary: DataSummary } {
  if (data.length === 0) throw new Error('No data');
  // Idempotency guard: a re-uploaded enriched (or already-exploded) dataset
  // carries our own temporal-facet columns — "Month · Date" and even nested
  // "Day · Day · Date". Remove them up-front so they are neither summarised,
  // re-approved as new date sources, nor re-derived into a fresh nested
  // generation. Real source columns ("Date", "Day", "TSOE-Date Combo") do not
  // match isTemporalFacetColumnKey and survive; exactly one clean facet
  // generation is then produced below from the genuine date columns.
  stripTemporalFacetColumns(data);
  const interim = createDataSummary(data);
  const approvedDateCols = resolveApprovedDateColumns(data, profile, opts);
  const withDash = convertDashToZeroForNumericColumns(data, interim.numericColumns);
  canonicalizeDateColumnValues(withDash, approvedDateCols);
  applyTemporalFacetColumns(withDash, approvedDateCols);
  const summary = createDataSummary(withDash);
  applyDateColumnSelectionToSummary(summary, approvedDateCols);
  return { data: withDash, summary };
}
