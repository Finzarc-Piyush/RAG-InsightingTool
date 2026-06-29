// Table-structure detection — region application helpers shared by the Excel
// reader and the CSV parser: turn a user override into a region, flatten the
// detected header into object keys, and project a region to the persisted
// `TableDetection`. Pure (no I/O); kept here so both ingest paths reuse one copy.

import type { CellGrid } from './grid.js';
import { buildRawGridPreview } from './grid.js';
import { lastNonEmptyColumn } from './rowProfile.js';
import type { TableRegion } from './types.js';
import type { TableDetection, TableRegionOverride } from '../../shared/schema.js';

/**
 * Build SheetJS-compatible object header keys: empty header cells become
 * `__EMPTY`/`__EMPTY_1`…; duplicate keys get `_1`/`_2`… suffixes. Pure string
 * logic (moved out of excelReader so applyRegion stays cycle-free).
 */
export function buildHeaderKeys(headerCells: (string | null)[]): string[] {
  const used = new Map<string, number>();
  return headerCells.map((raw) => {
    const base = raw ?? '__EMPTY';
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    if (n === 0) return base;
    let suffixed = `${base}_${n}`;
    while (used.has(suffixed)) suffixed = `${base}_${(used.get(base) ?? 0) + 1}`;
    used.set(suffixed, 1);
    return suffixed;
  });
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/** Turn a user correction into a concrete region against the scanned grid. */
export function regionFromOverride(
  override: TableRegionOverride,
  rowsN: number,
  colsN: number,
): TableRegion {
  const headerRowStart = clampInt(override.headerRow, 0, Math.max(0, rowsN - 1));
  const headerRowEnd = headerRowStart;
  const colStart = override.colStart != null ? clampInt(override.colStart, 0, colsN - 1) : 0;
  const colEnd =
    override.colEnd != null ? clampInt(override.colEnd, colStart, colsN - 1) : colsN - 1;
  const dataRowStart =
    override.dataRowStart != null
      ? clampInt(override.dataRowStart, headerRowEnd + 1, Math.max(headerRowEnd + 1, rowsN))
      : headerRowEnd + 1;
  const dataRowEnd =
    override.dataRowEnd != null && override.dataRowEnd >= 0
      ? clampInt(override.dataRowEnd, dataRowStart, rowsN - 1)
      : rowsN - 1;
  return {
    headerRowStart,
    headerRowEnd,
    dataRowStart,
    dataRowEnd,
    colStart,
    colEnd,
    confidence: 1,
    rationale: `Header set to row ${headerRowStart + 1} by you.`,
    source: 'override',
    triviallyClean: false,
    secondaryTablesIgnored: [],
  };
}

/** Header keys for a detected region: flatten multi-row headers (joining the
 * grid's display text top-to-bottom; merged super-headers already propagate
 * across their span in the grid), then route through `buildHeaderKeys` so a
 * genuinely-empty header cell still becomes `__EMPTY`/`__EMPTY_N`. */
export function buildHeaderKeysFromGrid(grid: CellGrid, region: TableRegion): string[] {
  const labels: (string | null)[] = [];
  for (let c = region.colStart; c <= region.colEnd; c++) {
    const parts: string[] = [];
    for (let r = region.headerRowStart; r <= region.headerRowEnd; r++) {
      const t = grid[r]?.[c]?.text?.trim();
      if (t) parts.push(t);
    }
    labels.push(parts.length ? Array.from(new Set(parts)).join(' ') : null);
  }
  return buildHeaderKeys(labels);
}

/** Project a `TableRegion` to the persisted `TableDetection`, computing the
 * `nonTrivial` gate the banner reads (true ⇒ the user should verify). */
export function toTableDetection(region: TableRegion, grid: CellGrid): TableDetection {
  const lastCol = lastNonEmptyColumn(grid);
  const nonTrivial =
    region.headerRowStart > 0 ||
    region.headerRowEnd > region.headerRowStart ||
    region.colStart > 0 ||
    region.colEnd < lastCol ||
    region.secondaryTablesIgnored.length > 0 ||
    region.confidence < 0.7 ||
    region.source === 'override';
  return {
    headerRowStart: region.headerRowStart,
    headerRowEnd: region.headerRowEnd,
    dataRowStart: region.dataRowStart,
    dataRowEnd: region.dataRowEnd,
    colStart: region.colStart,
    colEnd: region.colEnd,
    confidence: region.confidence,
    rationale: region.rationale,
    source: region.source,
    nonTrivial,
    secondaryTablesIgnored: region.secondaryTablesIgnored,
    rawGridPreview: buildRawGridPreview(grid),
  };
}
