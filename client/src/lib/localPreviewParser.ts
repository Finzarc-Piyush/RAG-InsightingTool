import Papa from "papaparse";
import * as XLSX from "xlsx";

export type LocalPreviewParseStatus = "full" | "headers_only" | "failed";

export interface LocalPreviewResult {
  fileName: string;
  rows: Record<string, any>[];
  columns: string[];
  numericColumns: string[];
  dateColumns: string[];
  rowCountEstimate: number;
  parseStatus: LocalPreviewParseStatus;
  parseError?: string;
}

export interface LocalWorkbookSheetInfo {
  sheetNames: string[];
  selectedSheetName?: string;
  requiresSelection: boolean;
}

const MAX_PREVIEW_ROWS = 100;
const MAX_COLUMNS = 200;

export function isExplicitDateLikeForPreview(value: unknown): boolean {
  const s = String(value ?? "").trim();
  if (!s) return false;
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(s)) return true;
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(s)) return true;
  if (/^[A-Za-z]{3,}\s+\d{4}$/.test(s)) return true; // e.g. Apr 2024
  return false;
}

function normalizeHeaders(input: unknown[]): string[] {
  const seen = new Map<string, number>();
  const headers = input.slice(0, MAX_COLUMNS).map((raw, idx) => {
    const base = String(raw ?? "").trim() || `Column ${idx + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
  return headers;
}

function inferColumnTypes(rows: Record<string, any>[], columns: string[]) {
  const numericColumns: string[] = [];
  const dateColumns: string[] = [];
  const sample = rows.slice(0, MAX_PREVIEW_ROWS);

  for (const col of columns) {
    const vals = sample
      .map((r) => r[col])
      .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
      .slice(0, 50);
    if (vals.length === 0) continue;

    const numericHits = vals.filter((v) => {
      if (typeof v === "number") return Number.isFinite(v);
      const s = String(v).replace(/,/g, "").trim();
      return /^-?\d+(\.\d+)?$/.test(s);
    }).length;

    const dateHits = vals.filter((v) => {
      return isExplicitDateLikeForPreview(v);
    }).length;

    if (numericHits / vals.length >= 0.8) numericColumns.push(col);
    if (dateHits / vals.length >= 0.7) dateColumns.push(col);
  }

  return { numericColumns, dateColumns };
}

function fromHeadersOnly(fileName: string, columns: string[], parseError?: string): LocalPreviewResult {
  return {
    fileName,
    rows: [],
    columns,
    numericColumns: [],
    dateColumns: [],
    rowCountEstimate: 0,
    parseStatus: columns.length > 0 ? "headers_only" : "failed",
    parseError,
  };
}

async function parseCsv(file: File): Promise<LocalPreviewResult> {
  return new Promise((resolve) => {
    Papa.parse<Record<string, any>>(file, {
      header: true,
      skipEmptyLines: "greedy",
      preview: MAX_PREVIEW_ROWS + 1,
      dynamicTyping: false,
      complete: (result) => {
        const columns = normalizeHeaders((result.meta.fields ?? []).slice(0, MAX_COLUMNS));
        const rows = (result.data || []).slice(0, MAX_PREVIEW_ROWS).map((row) => {
          const out: Record<string, any> = {};
          columns.forEach((c) => {
            out[c] = (row as any)[c] ?? null;
          });
          return out;
        });
        const { numericColumns, dateColumns } = inferColumnTypes(rows, columns);
        resolve({
          fileName: file.name,
          rows,
          columns,
          numericColumns,
          dateColumns,
          rowCountEstimate: rows.length,
          parseStatus: rows.length > 0 ? "full" : columns.length > 0 ? "headers_only" : "failed",
          parseError: result.errors?.length ? result.errors[0].message : undefined,
        });
      },
      error: (err) => {
        resolve(fromHeadersOnly(file.name, [], err.message || "Failed to parse CSV"));
      },
    });
  });
}

export async function inspectLocalWorkbookSheets(file: File): Promise<LocalWorkbookSheetInfo> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", dense: true, cellDates: false });
  const sheetNames = workbook.SheetNames || [];
  return {
    sheetNames,
    selectedSheetName: sheetNames[0],
    requiresSelection: sheetNames.length > 1,
  };
}

async function parseXlsx(file: File, selectedSheetName?: string): Promise<LocalPreviewResult> {
  try {
    const workbookInfo = await inspectLocalWorkbookSheets(file);
    const { sheetNames } = workbookInfo;
    if (sheetNames.length === 0) {
      return fromHeadersOnly(file.name, [], "No sheet found in workbook");
    }
    const sheetName = selectedSheetName || sheetNames[0];
    if (!sheetNames.includes(sheetName)) {
      return fromHeadersOnly(file.name, [], `Sheet "${sheetName}" not found in workbook`);
    }
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array", dense: true, cellDates: false });
    const ws = workbook.Sheets[sheetName];
    const grid = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, {
      header: 1,
      raw: false,
      defval: null,
      blankrows: false,
    });
    if (!grid || grid.length === 0) {
      return fromHeadersOnly(file.name, [], "Sheet is empty");
    }

    const columns = normalizeHeaders((grid[0] || []).slice(0, MAX_COLUMNS));
    const rowArrays = grid.slice(1, MAX_PREVIEW_ROWS + 1);
    const rows = rowArrays.map((arr) => {
      const out: Record<string, any> = {};
      columns.forEach((c, idx) => {
        out[c] = arr?.[idx] ?? null;
      });
      return out;
    });
    const { numericColumns, dateColumns } = inferColumnTypes(rows, columns);
    return {
      fileName: file.name,
      rows,
      columns,
      numericColumns,
      dateColumns,
      rowCountEstimate: rows.length,
      parseStatus: rows.length > 0 ? "full" : columns.length > 0 ? "headers_only" : "failed",
    };
  } catch (error) {
    return fromHeadersOnly(
      file.name,
      [],
      error instanceof Error ? error.message : "Failed to parse spreadsheet"
    );
  }
}

export async function parseLocalPreview(
  file: File,
  opts?: {
    sheetName?: string;
  }
): Promise<LocalPreviewResult> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".csv")) {
    return parseCsv(file);
  }
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    return parseXlsx(file, opts?.sheetName);
  }
  return fromHeadersOnly(file.name, [], "Unsupported local preview format");
}

