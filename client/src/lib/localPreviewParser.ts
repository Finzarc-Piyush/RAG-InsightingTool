// @ts-expect-error papaparse has no bundled types and @types/papaparse is not installed
import Papa from "papaparse";
import ExcelJS from "exceljs";

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

/**
 * Wave R9 · Map an ExcelJS cell to the preview value the former SheetJS
 * `sheet_to_json({ header:1, raw:false, defval:null })` produced. The preview
 * pipeline (`inferColumnTypes`, display grid) is STRING-heuristic based, so —
 * unlike the server ingest path (Date objects) — dates are rendered as ISO
 * strings that `isExplicitDateLikeForPreview` recognises. Percent-formatted
 * cells are re-stringified ("12.34%") so the column stays non-numeric exactly
 * as before; booleans render "TRUE"/"FALSE" as SheetJS `raw:false` did.
 */
function percentDecimals(numFmt: string): number {
  const beforePct = numFmt.split("%")[0] ?? "";
  const dot = beforePct.lastIndexOf(".");
  if (dot < 0) return 0;
  return (beforePct.slice(dot + 1).match(/[0#]/g) || []).length;
}

function formatPercentDisplay(value: number, numFmt: string): string {
  const fixed = (value * 100).toFixed(percentDecimals(numFmt));
  const beforePct = numFmt.split("%")[0] ?? "";
  if (/[#0],[#0]/.test(beforePct)) {
    const neg = fixed.startsWith("-");
    const [intPart, fracPart] = (neg ? fixed.slice(1) : fixed).split(".");
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${neg ? "-" : ""}${fracPart ? `${grouped}.${fracPart}` : grouped}%`;
  }
  return `${fixed}%`;
}

function previewDateString(d: Date): string {
  const iso = d.toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
  // Date-only (UTC midnight) → "YYYY-MM-DD"; else "YYYY-MM-DD HH:mm".
  return iso.endsWith("T00:00:00.000Z")
    ? iso.slice(0, 10)
    : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function previewCellValue(
  v: ExcelJS.CellValue,
  numFmt: string | undefined
): string | number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return previewDateString(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    if (numFmt && numFmt.includes("%")) return formatPercentDisplay(v, numFmt);
    return v;
  }
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if ("result" in o) return previewCellValue(o.result as ExcelJS.CellValue, numFmt);
    if ("error" in o) return null;
    if (Array.isArray(o.richText)) {
      return (o.richText as Array<{ text?: string }>).map((r) => r?.text ?? "").join("");
    }
    if (typeof o.text === "string") return o.text;
  }
  return null;
}

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
      complete: (result: { data: unknown[]; meta: { fields?: string[] }; errors?: Array<{ message: string }> }) => {
        const columns = normalizeHeaders((result.meta.fields ?? []).slice(0, MAX_COLUMNS));
        const rows = (result.data || []).slice(0, MAX_PREVIEW_ROWS).map((row: unknown) => {
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
      error: (err: { message?: string }) => {
        resolve(fromHeadersOnly(file.name, [], err.message || "Failed to parse CSV"));
      },
    });
  });
}

async function loadWorkbook(file: File): Promise<ExcelJS.Workbook> {
  const buffer = await file.arrayBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

export async function inspectLocalWorkbookSheets(file: File): Promise<LocalWorkbookSheetInfo> {
  const wb = await loadWorkbook(file);
  const sheetNames = wb.worksheets.map((w) => w.name);
  return {
    sheetNames,
    selectedSheetName: sheetNames[0],
    requiresSelection: sheetNames.length > 1,
  };
}

async function parseXlsx(file: File, selectedSheetName?: string): Promise<LocalPreviewResult> {
  try {
    const wb = await loadWorkbook(file);
    const sheetNames = wb.worksheets.map((w) => w.name);
    if (sheetNames.length === 0) {
      return fromHeadersOnly(file.name, [], "No sheet found in workbook");
    }
    const sheetName = selectedSheetName || sheetNames[0];
    if (!sheetNames.includes(sheetName)) {
      return fromHeadersOnly(file.name, [], `Sheet "${sheetName}" not found in workbook`);
    }
    const ws = wb.getWorksheet(sheetName)!;

    // Build a SheetJS `header:1`-equivalent AOA: skip fully-blank rows
    // (blankrows:false), cap columns + a little past the preview window.
    const colCount = Math.min(ws.columnCount, MAX_COLUMNS);
    const grid: (string | number | null)[][] = [];
    const ROW_SCAN_CAP = MAX_PREVIEW_ROWS + 2; // header + preview rows
    for (let r = 1; r <= ws.rowCount && grid.length < ROW_SCAN_CAP; r++) {
      const row = ws.getRow(r);
      const arr: (string | number | null)[] = [];
      let allEmpty = true;
      for (let c = 1; c <= colCount; c++) {
        const cell = row.getCell(c);
        const val = previewCellValue(cell.value, cell.numFmt);
        arr.push(val);
        if (val !== null) allEmpty = false;
      }
      if (allEmpty) continue;
      grid.push(arr);
    }
    if (grid.length === 0) {
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

