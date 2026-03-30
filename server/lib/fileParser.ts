import { parse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import { DataSummary } from '../shared/schema.js';
import {
  isTemporalWhitelistColumnName,
  parseFlexibleDate,
  sanitizeDateStringForParse,
} from './dateUtils.js';
import { isLikelyIdentifierColumnName } from './columnIdHeuristics.js';
import { agentLog } from './agents/runtime/agentLogger.js';
import type { DatasetProfile } from './datasetProfile.js';
import { computeCleanedDateColumnNames } from './dirtyDateEnrichment.js';
import { inferTemporalGrainFromDates } from './temporalGrain.js';
import {
  applyTemporalFacetColumns,
  isTemporalFacetColumnKey,
  temporalFacetMetadataForDateColumns,
} from './temporalFacetColumns.js';

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

/** Warn when preview sample Row IDs collapse — often misclassified date canonicalization. */
export function warnSuspiciousDuplicateRowIdInSample(
  sampleRows: Record<string, any>[],
  context: string
): void {
  if (sampleRows.length < 5) return;
  const keys = Object.keys(sampleRows[0]);
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
    console.warn(
      `[${context}] Over 90% of sample rows share the same "${idCol}" value; possible date-column misclassification or enrichment corruption.`
    );
  }
}

export async function parseFile(buffer: Buffer, filename: string): Promise<Record<string, any>[]> {
  lastCsvParseDiagnostics = undefined;
  const ext = filename.split('.').pop()?.toLowerCase();

  if (ext === 'csv') {
    return parseCsv(buffer);
  } else if (ext === 'xlsx' || ext === 'xls') {
    return parseExcel(buffer);
  } else {
    throw new Error('Unsupported file format. Please upload CSV or Excel files.');
  }
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
    console.warn(
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
        
        if (typeof value === 'string') {
          const trimmed = value.trim();
          // Convert empty strings or whitespace-only strings to null
          if (trimmed === '' || trimmed.length === 0) {
            processedRow[key] = null;
            continue;
          }
          
          // Try to convert string numbers
          const cleaned = trimmed.replace(/[%,$€£¥₹\s]/g, '').trim();
          const num = Number(cleaned);
          // Only convert if it's a valid number and the cleaned string is not empty
          if (cleaned !== '' && !isNaN(num) && isFinite(num)) {
            processedRow[key] = num;
          } else {
            processedRow[key] = trimmed; // Keep as string if not numeric
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
      console.log(`  Processed ${Math.min(i + BATCH_SIZE, normalized.length)} / ${normalized.length} rows...`);
    }
  }
  
  return result;
}

function parseExcel(buffer: Buffer): Record<string, any>[] {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(worksheet, { raw: false, defval: null });
  
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
      
      if (typeof value === 'string') {
        const trimmed = value.trim();
        // Convert empty strings or whitespace-only strings to null
        if (trimmed === '' || trimmed.length === 0) {
          processedRow[key] = null;
          continue;
        }
        
        // Try to convert string numbers
        const cleaned = trimmed.replace(/[%,$€£¥₹\s]/g, '').trim();
        const num = Number(cleaned);
        // Only convert if it's a valid number and the cleaned string is not empty
        if (cleaned !== '' && !isNaN(num) && isFinite(num)) {
          processedRow[key] = num;
        } else {
          processedRow[key] = trimmed; // Keep as string if not numeric
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
  const firstRow = data[0];
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
    return isLocalMidnight(parsed) ? formatLocalYMD(parsed) : parsed.toISOString();
  }
  const t = sanitizeDateStringForParse(String(raw));
  const hasExplicitTime = /T\d{2}:\d{2}/.test(t) || /\b\d{1,2}:\d{2}:\d{2}\b/.test(t);
  if (!hasExplicitTime) {
    return formatLocalYMD(parsed);
  }
  return parsed.toISOString();
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
  const changedByCol = new Map<string, number>();

  for (const row of data) {
    for (const col of safeCols) {
      const v = row[col];
      if (v === null || v === undefined || v === '') continue;
      if (v instanceof Date && !isNaN(v.getTime())) {
        const out = toCanonicalDateStorage(v, v);
        if (out !== v) {
          row[col] = out;
          changedByCol.set(col, (changedByCol.get(col) || 0) + 1);
        }
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

export function createDataSummary(data: Record<string, any>[]): DataSummary {
  if (data.length === 0) {
    throw new Error('No data found in file');
  }

  const userColumns = Object.keys(data[0]).filter((k) => !isTemporalFacetColumnKey(k));
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
        
        // Strip common formatting: %, commas, spaces, currency symbols, em-dash, en-dash
        const cleaned = str.replace(/[%,$€£¥₹\s\u2013\u2014\u2015]/g, '').trim();
        
        // Skip if empty after cleaning
        if (cleaned === '') return false;
        
        // Check if it's a valid number (including scientific notation and negative numbers)
        const num = Number(cleaned);
        if (isNaN(num) || !isFinite(num)) return false;
        
        // Additional validation: if cleaned string is just digits (with optional decimal point and minus),
        // it's definitely numeric
        if (/^-?\d+\.?\d*$/.test(cleaned)) return true;
        
        // For other formats, if Number() successfully parsed it, accept it
        return cleaned !== '';
      }).length;
    }
    
    const numericThreshold = Math.max(1, Math.ceil(nonNullValues.length * 0.7)); // 70% threshold
    const isNumeric = nonNullValues.length > 0 && numericMatches >= numericThreshold;

    // Date typing is name-whitelist based; value parseability is diagnostics only.
    const nn = nonNullValues.filter((v) => v !== null && v !== undefined && v !== '');
    const isDate =
      !isLikelyIdentifierColumnName(col) &&
      nn.length > 0 &&
      isTemporalWhitelistColumnName(col);

    if (isNumeric) {
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

    return {
      name: col,
      type,
      sampleValues,
      ...(topValues?.length ? { topValues } : {}),
      ...(temporalDisplayGrain !== undefined ? { temporalDisplayGrain } : {}),
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
  const keys = new Set(Object.keys(data[0]));
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

function isDateParseableAtThreshold(values: unknown[], thresholdRatio: number): boolean {
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

  for (const col of columns) {
    if (isLikelyIdentifierColumnName(col)) continue;
    if (isTemporalWhitelistColumnName(col)) approved.push(col);
  }

  const sampleSize = Math.min(data.length, 1000);
  const llmThresholdRatio = Number(process.env.LLM_DATE_OVERRIDE_PARSE_THRESHOLD) || 0.7;
  for (const col of llmCols) {
    if (approved.includes(col)) continue;
    if (isLikelyIdentifierColumnName(col)) continue;
    if (!columns.includes(col)) continue;
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
  const interim = createDataSummary(data);
  const approvedDateCols = resolveApprovedDateColumns(data, profile, opts);
  const withDash = convertDashToZeroForNumericColumns(data, interim.numericColumns);
  canonicalizeDateColumnValues(withDash, approvedDateCols);
  applyTemporalFacetColumns(withDash, approvedDateCols);
  const summary = createDataSummary(withDash);
  applyDateColumnSelectionToSummary(summary, approvedDateCols);
  return { data: withDash, summary };
}
