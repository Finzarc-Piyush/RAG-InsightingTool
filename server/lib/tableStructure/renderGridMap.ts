// Table-structure detection — compact textual "corner map" of a grid for the
// Tier-2 LLM adjudicator. Renders only the top-left corner (≈25 rows × ≤30
// cols) so the LLM reads STRUCTURE, never the whole dataset — cost is constant
// regardless of row count.
//
// Each populated cell prints `ADDR tag:value` (A1-style address, short type
// tag, truncated value). Empty cells are omitted. The Tier-1 candidate regions
// are appended so the model can prefer the pre-pass guess unless the map
// clearly contradicts it. Row/col indices are 0-based (what the schema returns).

import type { CellGrid, CellKind } from './grid.js';
import { gridColCount } from './rowProfile.js';
import { cellAddr, colLetter } from './address.js';
import type { DetectionCandidate } from './types.js';

const KIND_TAG: Record<CellKind, string> = {
  empty: '',
  text: 'txt',
  number: 'num',
  date: 'date',
  bool: 'bool',
};

function truncate(s: string, n = 24): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export interface RenderGridMapOptions {
  maxRows?: number;
  maxCols?: number;
  sheetName?: string;
}

export function renderGridMap(
  grid: CellGrid,
  candidates: DetectionCandidate[],
  opts: RenderGridMapOptions = {},
): string {
  const maxRows = opts.maxRows ?? 25;
  const maxCols = opts.maxCols ?? 30;
  const totalRows = grid.length;
  const totalCols = gridColCount(grid);
  const rowsN = Math.min(totalRows, maxRows);
  const colsN = Math.min(totalCols, maxCols);

  const lines: string[] = [];
  const title = opts.sheetName ? `Sheet "${opts.sheetName}"` : 'Sheet';
  lines.push(
    `${title} — showing ${rowsN}×${colsN} of ${totalRows}×${totalCols} (row/col indices are 0-based)`,
  );
  lines.push('ROWS (index | populated cells as ADDR tag:value):');
  for (let r = 0; r < rowsN; r++) {
    const cells: string[] = [];
    for (let c = 0; c < colsN; c++) {
      const cell = grid[r]?.[c];
      if (!cell || cell.kind === 'empty') continue;
      cells.push(`${cellAddr(r, c)} ${KIND_TAG[cell.kind]}:${truncate(cell.text)}`);
    }
    lines.push(`${r} | ${cells.length ? cells.join(' | ') : '(blank)'}`);
  }

  if (candidates.length) {
    lines.push('CANDIDATE REGIONS (Tier-1 pre-pass, 0-based):');
    candidates.forEach((c, i) => {
      const tag = i === 0 ? 'MAIN' : 'side';
      lines.push(
        `#${i + 1} ${tag} headerRows ${c.headerRowStart}-${c.headerRowEnd} ` +
          `dataRows ${c.dataRowStart}-${c.dataRowEnd} ` +
          `cols ${c.colStart}-${c.colEnd} (${colLetter(c.colStart)}-${colLetter(c.colEnd)}) ` +
          `score=${c.score.toFixed(1)}`,
      );
    });
  }

  return lines.join('\n');
}
