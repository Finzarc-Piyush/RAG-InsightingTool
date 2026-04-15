import * as XLSX from "xlsx";
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

export function downloadPivotGridAsXlsx(
  model: PivotModel,
  flatRows: PivotFlatRow[],
  temporalFacetColumns: TemporalFacetColumnMeta[],
  showValuesAs: PivotShowValuesAsExportMode,
  baseName: string | undefined | null
): void {
  const rows = pivotGridToSheetRows(
    model,
    flatRows,
    temporalFacetColumns,
    showValuesAs
  );
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Pivot");
  const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
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
