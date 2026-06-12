import ExcelJS from "exceljs";
import { downloadFilenameTimestamp } from "@/lib/downloadFilenameTimestamp";
import type { TemporalFacetColumnMeta } from "@/shared/schema";
import { facetColumnHeaderLabelForColumn } from "@/lib/temporalFacetDisplay";
import type { PivotFlatRow, PivotModel, PivotValueSpec } from "./types";

export type PivotShowValuesAsExportMode = "raw" | "percentOfColumnTotal";

function valueHeader(
  spec: PivotValueSpec,
  temporalFacetColumns: TemporalFacetColumnMeta[]
): string {
  return `${facetColumnHeaderLabelForColumn(spec.field, temporalFacetColumns)} (${spec.agg})`;
}

function grandTotalForCell(
  model: PivotModel,
  ck: string | null,
  specId: string
): number {
  const hasMatrix = Boolean(model.colField && model.colKeys.length > 0);
  if (!hasMatrix || !ck) {
    return model.tree.grandTotal.flatValues?.[specId] ?? 0;
  }
  return model.tree.grandTotal.matrixValues?.[ck]?.[specId] ?? 0;
}

function displayNumeric(
  raw: number,
  ck: string | null,
  specId: string,
  model: PivotModel,
  showValuesAs: PivotShowValuesAsExportMode
): number {
  if (showValuesAs === "raw") return raw;
  const denom = grandTotalForCell(model, ck, specId);
  return denom ? (raw / denom) * 100 : 0;
}

/**
 * Column headers matching PivotGrid (single header row; matrix + multiple measures get composite names).
 */
export function pivotGridColumnKeys(
  model: PivotModel,
  temporalFacetColumns: TemporalFacetColumnMeta[]
): string[] {
  const keys: string[] = ["Row label"];
  const { colField, colKeys, valueSpecs } = model;
  const hasMatrix = Boolean(colField && colKeys.length > 0);

  if (hasMatrix && colField) {
    const fl = facetColumnHeaderLabelForColumn(colField, temporalFacetColumns);
    for (const ck of colKeys) {
      const colPart = `${fl}: ${ck || "(blank)"}`;
      if (valueSpecs.length > 1) {
        for (const spec of valueSpecs) {
          keys.push(`${colPart} | ${valueHeader(spec, temporalFacetColumns)}`);
        }
      } else {
        keys.push(colPart);
      }
    }
  } else {
    for (const spec of valueSpecs) {
      keys.push(valueHeader(spec, temporalFacetColumns));
    }
  }
  return keys;
}

/**
 * One record per pivot grid row; numeric cells are numbers (percent mode = 0–100).
 */
export function pivotGridToSheetRows(
  model: PivotModel,
  flatRows: PivotFlatRow[],
  temporalFacetColumns: TemporalFacetColumnMeta[],
  showValuesAs: PivotShowValuesAsExportMode
): Record<string, string | number>[] {
  const colKeysHeader = pivotGridColumnKeys(model, temporalFacetColumns);
  const { colField, colKeys, valueSpecs } = model;
  const hasMatrix = Boolean(colField && colKeys.length > 0);

  const out: Record<string, string | number>[] = [];

  for (const row of flatRows) {
    const rec: Record<string, string | number> = {};
    const pad = row.kind === "grand" ? 0 : row.depth;
    rec[colKeysHeader[0]!] = `${"  ".repeat(pad)}${row.label}`;

    if (row.kind === "header" || !row.values) {
      for (let i = 1; i < colKeysHeader.length; i++) {
        rec[colKeysHeader[i]!] = "";
      }
      out.push(rec);
      continue;
    }

    if (hasMatrix && colField) {
      let ci = 1;
      for (const ck of colKeys) {
        if (valueSpecs.length > 1) {
          for (const spec of valueSpecs) {
            const key = colKeysHeader[ci]!;
            const raw = row.values.matrixValues?.[ck]?.[spec.id] ?? 0;
            rec[key] = displayNumeric(raw, ck, spec.id, model, showValuesAs);
            ci++;
          }
        } else {
          const key = colKeysHeader[ci]!;
          const spec = valueSpecs[0]!;
          const raw = row.values.matrixValues?.[ck]?.[spec.id] ?? 0;
          rec[key] = displayNumeric(raw, ck, spec.id, model, showValuesAs);
          ci++;
        }
      }
    } else {
      let ci = 1;
      for (const spec of valueSpecs) {
        const key = colKeysHeader[ci]!;
        const raw = row.values.flatValues?.[spec.id] ?? 0;
        rec[key] = displayNumeric(raw, null, spec.id, model, showValuesAs);
        ci++;
      }
    }
    out.push(rec);
  }

  return out;
}

export function sanitizeExportBasename(
  name: string | undefined | null,
  fallback: string
): string {
  const base = (name ?? "").trim() || fallback;
  const cleaned = base
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  return cleaned || fallback;
}

function coerceFlatCell(v: unknown): string | number | boolean {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Date) return v.toISOString();
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function unionKeysInOrder(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const row of rows) {
    if (!row) continue;
    for (const k of Object.keys(row)) {
      if (seen.has(k)) continue;
      seen.add(k);
      ordered.push(k);
    }
  }
  return ordered;
}

/**
 * Populate an ExcelJS worksheet with the flat-table data. Cells are written
 * positionally (header order) so heterogeneous rows stay column-aligned and
 * `coerceFlatCell` empties round-trip as "". When a note is supplied it lands
 * on A1 with a blank spacer at A2, so the header lands on A3 — matching the
 * former SheetJS `aoa_to_sheet([[note]])` + `sheet_add_json({origin:'A3'})`.
 */
function populateFlatTableSheet(
  ws: ExcelJS.Worksheet,
  flatTableRows: Record<string, unknown>[],
  note?: string
): void {
  const headers = unionKeysInOrder(flatTableRows);
  if (note && note.length > 0) {
    ws.addRow([note]);
    ws.addRow([]); // blank spacer (A2) — header lands on A3
  }
  ws.addRow(headers);
  for (const row of flatTableRows) {
    ws.addRow(headers.map((k) => coerceFlatCell(row?.[k])));
  }
}

/** Standalone single-sheet workbook for the flat table (test seam). */
export function buildFlatTableSheet(
  flatTableRows: Record<string, unknown>[],
  note?: string
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  populateFlatTableSheet(wb.addWorksheet("Flat Table"), flatTableRows, note);
  return wb;
}

export function buildPivotWorkbook(
  model: PivotModel,
  flatRows: PivotFlatRow[],
  temporalFacetColumns: TemporalFacetColumnMeta[],
  showValuesAs: PivotShowValuesAsExportMode,
  flatTableRows?: Record<string, unknown>[],
  options?: { flatSheetNote?: string }
): ExcelJS.Workbook {
  const rows = pivotGridToSheetRows(
    model,
    flatRows,
    temporalFacetColumns,
    showValuesAs
  );
  const header = pivotGridColumnKeys(model, temporalFacetColumns);
  const wb = new ExcelJS.Workbook();
  const pivot = wb.addWorksheet("Pivot");
  pivot.addRow(header);
  for (const rec of rows) {
    pivot.addRow(header.map((k) => rec[k] ?? ""));
  }

  if (flatTableRows && flatTableRows.length > 0) {
    populateFlatTableSheet(
      wb.addWorksheet("Flat Table"),
      flatTableRows,
      options?.flatSheetNote
    );
  }

  return wb;
}

export async function downloadPivotGridAsXlsx(
  model: PivotModel,
  flatRows: PivotFlatRow[],
  temporalFacetColumns: TemporalFacetColumnMeta[],
  showValuesAs: PivotShowValuesAsExportMode,
  baseName: string | undefined | null,
  flatTableRows?: Record<string, unknown>[],
  options?: { flatSheetNote?: string }
): Promise<void> {
  const wb = buildPivotWorkbook(
    model,
    flatRows,
    temporalFacetColumns,
    showValuesAs,
    flatTableRows,
    options
  );
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const ts = downloadFilenameTimestamp();
  const safe = sanitizeExportBasename(baseName, "dataset");
  const filename = `${safe}_pivot_${ts}.xlsx`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
