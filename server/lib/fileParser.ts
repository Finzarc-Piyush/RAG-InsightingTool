import { parse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import { DataSummary } from '../shared/schema.js';
import { parseFlexibleDate, sanitizeDateStringForParse, isDateColumnName } from './dateUtils.js';
import type { DatasetProfile } from './datasetProfile.js';
import { inferTemporalGrainFromDates } from './temporalGrain.js';

// Month name mapping for date detection
const MONTH_MAP: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sept: 8,
  sep: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

export async function parseFile(buffer: Buffer, filename: string): Promise<Record<string, any>[]> {
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
    // Optimize memory for large files
    relax_column_count: true,
    relax_quotes: true,
  });
  
  // Normalize column names: trim whitespace from all column names
  const normalized = normalizeColumnNames(records as Record<string, any>[]);
  
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
 * Comprehensive date detection function that handles multiple date formats:
 * - Month-Year: "Apr-24", "April 2024", "Jan-2024", "Mar/24", "Apr-23", "Apr 23"
 * - Standard dates: "DD-MM-YYYY", "MM-DD-YYYY", "YYYY-MM-DD", "DD/MM/YYYY"
 * - Dot separators: "DD.MM.YYYY", "MM.DD.YYYY"
 * - Month names with day: "April 15, 2024", "15 April 2024"
 * - Date objects and timestamps
 */
function isDateValue(value: any): boolean {
  if (value === null || value === undefined || value === '') return false;
  
  // If it's already a Date object, it's a date
  if (value instanceof Date && !isNaN(value.getTime())) return true;
  
  const str = String(value).trim();
  if (!str) return false;
  
  // Check for month-year formats: "Apr-24", "Apr-23", "April 2024", "Jan-2024", "Mar/24", "Apr 23", etc.
  // Pattern: Month name (3+ letters) followed by separator and 2-4 digit year
  const mmmYyMatch = str.match(/^([A-Za-z]{3,})[-\s/](\d{2,4})$/i);
  if (mmmYyMatch) {
    const monthName = mmmYyMatch[1].toLowerCase().substring(0, 3);
    if (MONTH_MAP[monthName] !== undefined) {
      const yearStr = mmmYyMatch[2];
      let year = parseInt(yearStr, 10);
      
      // Handle 2-digit years: assume 20xx if < 50, 19xx if >= 50
      if (yearStr.length === 2) {
        year = year < 50 ? 2000 + year : 1900 + year;
      }
      
      // Validate year is reasonable (1900-2100)
      if (year >= 1900 && year <= 2100) {
        return true;
      }
    }
  }
  
  // Also check for formats like "Apr-23" without separator (though less common)
  const mmmYyNoSepMatch = str.match(/^([A-Za-z]{3,})(\d{2,4})$/i);
  if (mmmYyNoSepMatch) {
    const monthName = mmmYyNoSepMatch[1].toLowerCase().substring(0, 3);
    if (MONTH_MAP[monthName] !== undefined) {
      const yearStr = mmmYyNoSepMatch[2];
      let year = parseInt(yearStr, 10);
      if (yearStr.length === 2) {
        year = year < 50 ? 2000 + year : 1900 + year;
      }
      if (year >= 1900 && year <= 2100) {
        return true;
      }
    }
  }
  
  // Check for date formats with separators: "DD-MM-YYYY", "MM-DD-YYYY", "YYYY-MM-DD", etc.
  const dateWithSeparators = str.match(/^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/);
  if (dateWithSeparators) {
    const date = new Date(str);
    if (!isNaN(date.getTime())) {
      // Additional validation: check if the parsed date components make sense
      const parts = str.split(/[-/]/);
      if (parts.length === 3) {
        const [part1, part2, part3] = parts.map(p => parseInt(p, 10));
        // Check if month is valid (1-12) and day is valid (1-31)
        if ((part1 >= 1 && part1 <= 12 && part2 >= 1 && part2 <= 31) ||
            (part2 >= 1 && part2 <= 12 && part1 >= 1 && part1 <= 31)) {
          return true;
        }
        // Check if it's YYYY-MM-DD format
        if (part1 >= 1900 && part1 <= 2100 && part2 >= 1 && part2 <= 12 && part3 >= 1 && part3 <= 31) {
          return true;
        }
      }
    }
  }
  
  // Check for formats like "DD.MM.YYYY" or "MM.DD.YYYY"
  const dateWithDots = str.match(/^\d{1,2}\.\d{1,2}\.\d{4}$/);
  if (dateWithDots) {
    const date = new Date(str.replace(/\./g, '-'));
    if (!isNaN(date.getTime())) return true;
  }
  
  // Check for month name with day and year: "April 15, 2024", "15 April 2024", "Apr 15 2024", etc.
  const monthNameWithDay = str.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i);
  if (monthNameWithDay) {
    const date = new Date(str);
    if (!isNaN(date.getTime())) {
      // Additional check: make sure it actually contains a year
      if (str.match(/\d{4}/)) {
        return true;
      }
    }
  }
  
  // Check for formats like "YYYYMMDD" (8 digits)
  const compactDate = str.match(/^\d{8}$/);
  if (compactDate) {
    const year = parseInt(str.substring(0, 4), 10);
    const month = parseInt(str.substring(4, 6), 10);
    const day = parseInt(str.substring(6, 8), 10);
    if (year >= 1900 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return true;
    }
  }
  
  // Try native Date parsing as fallback
  const date = new Date(str);
  if (!isNaN(date.getTime())) {
    // Additional validation: reject if it's just a number that happens to parse as a date
    if (str.match(/^\d+$/)) {
      // If it's just digits, be more strict - only accept if it's a reasonable timestamp
      const num = parseInt(str, 10);
      // Accept if it's a reasonable Unix timestamp (between 1970 and 2100)
      // Milliseconds: 0 to 4102444800000 (Jan 1, 2100)
      // Seconds: 0 to 4102444800
      if (num > 0) {
        // Check if it's milliseconds (13+ digits) or seconds (10 digits)
        if (str.length >= 13) {
          return num < 4102444800000; // Max timestamp for year 2100 in milliseconds
        } else if (str.length === 10) {
          return num < 4102444800; // Max timestamp for year 2100 in seconds
        }
      }
      return false;
    }
    // For non-numeric strings, check if the parsed date is reasonable
    const year = date.getFullYear();
    if (year >= 1900 && year <= 2100) {
      return true;
    }
  }
  
  return false;
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
  for (const row of data) {
    for (const col of dateColumns) {
      const v = row[col];
      if (v === null || v === undefined || v === '') continue;
      if (v instanceof Date && !isNaN(v.getTime())) {
        row[col] = toCanonicalDateStorage(v, v);
        continue;
      }
      const parsed = parseFlexibleDate(String(v));
      if (parsed) {
        row[col] = toCanonicalDateStorage(v, parsed);
      }
    }
  }
}

export function createDataSummary(data: Record<string, any>[]): DataSummary {
  if (data.length === 0) {
    throw new Error('No data found in file');
  }

  const columns = Object.keys(data[0]);
  const numericColumns: string[] = [];
  const dateColumns: string[] = [];

  const columnInfo = columns.map((col) => {
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
    
    // Date detection: prefer parseFlexibleDate (handles DD/MM/YYYY + ISO mixes); keep legacy isDateValue as signal
    const flexibleDateMatches = nonNullValues.filter((v) => {
      if (v === null || v === undefined || v === '') return false;
      return parseFlexibleDate(v instanceof Date ? v : String(v)) !== null;
    }).length;
    const flexThreshold = Math.max(1, Math.ceil(nonNullValues.length * 0.5));
    const flexRate = nonNullValues.length > 0 ? flexibleDateMatches / nonNullValues.length : 0;
    const baseDate = nonNullValues.length > 0 && flexibleDateMatches >= flexThreshold;
    // Name boost for borderline columns; do not promote ID-like columns on name alone unless ≥50% parse as dates
    const nameBoost =
      isDateColumnName(col) && flexRate >= 0.4 && !(/\bid\b/i.test(col) && flexRate < 0.5);
    const isDate = baseDate || nameBoost;

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
    if (isDate && nonNullValues.length > 0) {
      const parsedDates = nonNullValues
        .map((v) => parseFlexibleDate(v instanceof Date ? v : String(v)))
        .filter((d): d is Date => d !== null);
      temporalDisplayGrain = inferTemporalGrainFromDates(parsedDates);
    }

    return {
      name: col,
      type,
      sampleValues,
      ...(temporalDisplayGrain !== undefined ? { temporalDisplayGrain } : {}),
    };
  });

  return {
    rowCount: data.length,
    columnCount: columns.length,
    columns: columnInfo,
    numericColumns,
    dateColumns,
  };
}

/** Drop LLM-picked date columns that do not parse as dates on a sample (guards hallucinated names). */
export function filterDateColumnsByParseability(
  data: Record<string, any>[],
  candidateCols: string[],
  sampleSize = 300
): string[] {
  if (!data.length || !candidateCols.length) return [];
  const keys = new Set(Object.keys(data[0]));
  return candidateCols.filter((col) => {
    if (!keys.has(col)) return false;
    const slice = data.slice(0, sampleSize);
    return slice.some((row) => {
      const v = row[col];
      if (v === null || v === undefined || v === '') return false;
      return parseFlexibleDate(v instanceof Date ? v : String(v)) !== null;
    });
  });
}

export function resolveDateColumnsForUpload(
  data: Record<string, any>[],
  profile: DatasetProfile,
  fallbackSummary: DataSummary
): string[] {
  const keys = new Set(Object.keys(data[0]));
  let cols = profile.dateColumns.filter((c) => keys.has(c));
  cols = filterDateColumnsByParseability(data, cols);
  if (cols.length === 0) return [...fallbackSummary.dateColumns];
  return cols;
}

/**
 * After inferDatasetProfile: dash cleanup, canonicalize dates, final summary.
 * Returns a new row array (convertDash copies rows).
 */
export function applyUploadPipelineWithProfile(
  data: Record<string, any>[],
  profile: DatasetProfile
): { data: Record<string, any>[]; summary: DataSummary } {
  if (data.length === 0) throw new Error('No data');
  const interim = createDataSummary(data);
  const dateCols = resolveDateColumnsForUpload(data, profile, interim);
  const withDash = convertDashToZeroForNumericColumns(data, interim.numericColumns);
  canonicalizeDateColumnValues(withDash, dateCols);
  const summary = createDataSummary(withDash);
  return { data: withDash, summary };
}
