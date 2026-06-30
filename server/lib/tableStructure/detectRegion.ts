// Table-structure detection — Tier-1 deterministic orchestrator.
//
// Splits the grid into gap-separated column blocks, finds the best header row
// for each (skipping title/junk rows), extends multi-row headers, scores each
// block size-weighted, and picks the main table. Other blocks become
// `secondaryTablesIgnored`. Emits a confidence and a `triviallyClean` flag (a
// normal sheet that needs no LLM and passes through unchanged).
//
// Pure: input grid → region + candidates. No I/O, no LLM.

import type { CellGrid } from './grid.js';
import { gridColCount, lastNonEmptyColumn } from './rowProfile.js';
import {
  columnBlocks,
  rowStatsInRange,
  type ColumnBlock,
} from './rowProfile.js';
import { scoreHeaderRow, scoreHeaderRowDetailed } from './scoreHeaderRow.js';
import { colLetter } from './address.js';
import type { TableRegion, DetectionCandidate } from './types.js';

export const MIN_ROW_DENSITY = 0.3;
export const HEADER_WINDOW = 8;
const MAX_HEADER_RUN = 3;

export interface DetectRegionResult {
  region: TableRegion;
  candidates: DetectionCandidate[];
}

/** A row qualifies as part of a multi-row header run: text-dominant, little
 * numeric, and either dense or carrying ≥2 distinct labels (excludes a
 * single-cell title row). */
function isHeaderLikeLite(grid: CellGrid, r: number, block: ColumnBlock): boolean {
  const row = grid[r];
  if (!row) return false;
  const s = rowStatsInRange(row, block.colStart, block.colEnd, r);
  if (s.nonEmpty === 0) return false;
  const numericFrac = s.numberCount / s.nonEmpty;
  // Labels are non-numeric cells — text OR date/period labels ("FY2024").
  const labelFrac = (s.textCount + s.dateCount + s.boolCount) / s.nonEmpty;
  if (labelFrac < 0.5 || numericFrac >= 0.25) return false;
  return s.density >= 0.4 || s.distinctText >= 2 || s.dateCount >= 2;
}

/** Extend a chosen header row UPWARD across consecutive group-header rows
 * (e.g. a merged "FY24 | FY25" super-header above the label row). Never crosses
 * a title row (merge penalty). Capped to MAX_HEADER_RUN rows. */
function extendHeaderRun(grid: CellGrid, bestH: number, block: ColumnBlock): [number, number] {
  let hs = bestH;
  while (
    hs - 1 >= 0 &&
    bestH - (hs - 1) < MAX_HEADER_RUN &&
    isHeaderLikeLite(grid, hs - 1, block) &&
    scoreHeaderRowDetailed(grid, hs - 1, block).merge === 0
  ) {
    hs--;
  }
  return [hs, bestH];
}

function buildCandidate(grid: CellGrid, block: ColumnBlock): DetectionCandidate | null {
  const { colStart: c0, colEnd: c1 } = block;
  const rowsN = grid.length;

  // First "real" row of the block — skips leading blank/sparse rows.
  let firstReal = -1;
  for (let r = 0; r < rowsN; r++) {
    const s = rowStatsInRange(grid[r]!, c0, c1, r);
    if (s.density >= MIN_ROW_DENSITY) {
      firstReal = r;
      break;
    }
  }
  if (firstReal < 0) return null;

  // Best header row within a small window from the first real row.
  let bestH = firstReal;
  let bestScore = -Infinity;
  const wEnd = Math.min(rowsN - 1, firstReal + HEADER_WINDOW);
  for (let h = firstReal; h <= wEnd; h++) {
    const sc = scoreHeaderRow(grid, h, block);
    if (sc > bestScore) {
      bestScore = sc;
      bestH = h;
    }
  }

  const [hs, he] = extendHeaderRun(grid, bestH, block);

  // Data extent: end at the last DENSE row (≥ MIN_ROW_DENSITY), trimming any
  // trailing stray-value rows (e.g. formula/footer cells below the table whose
  // dimension columns are blank) that would otherwise become phantom
  // null-dimension buckets. Fall back to the last non-blank row when NO row is
  // dense (a legitimately sparse table — don't collapse it).
  const ds = he + 1;
  let de = ds;
  let lastDense = -1;
  for (let r = ds; r < rowsN; r++) {
    const s = rowStatsInRange(grid[r]!, c0, c1, r);
    if (s.nonEmpty > 0) de = r;
    if (s.density >= MIN_ROW_DENSITY) lastDense = r;
  }
  if (lastDense >= ds) de = lastDense;
  const dataRows = Math.max(0, de - ds + 1);
  const width = c1 - c0 + 1;
  const score = Math.max(0, bestScore) * Math.log1p(dataRows) * width;

  return {
    headerRowStart: hs,
    headerRowEnd: he,
    dataRowStart: ds,
    dataRowEnd: de,
    colStart: c0,
    colEnd: c1,
    score,
    headerScore: bestScore,
  };
}

function fallbackRegion(lastCol: number): TableRegion {
  return {
    headerRowStart: 0,
    headerRowEnd: 0,
    dataRowStart: 1,
    dataRowEnd: 1,
    colStart: 0,
    colEnd: Math.max(0, lastCol),
    confidence: 0,
    rationale: 'No table-like block found; defaulted to the whole sheet.',
    source: 'fallback',
    triviallyClean: false,
    secondaryTablesIgnored: [],
  };
}

function rationaleFor(main: DetectionCandidate, secondaryCount: number): string {
  const rowPart =
    main.headerRowEnd > main.headerRowStart
      ? `rows ${main.headerRowStart + 1}–${main.headerRowEnd + 1}`
      : `row ${main.headerRowStart + 1}`;
  const colPart = `columns ${colLetter(main.colStart)}–${colLetter(main.colEnd)}`;
  const side =
    secondaryCount > 0
      ? ` Ignored ${secondaryCount} gap-separated side table${secondaryCount === 1 ? '' : 's'}.`
      : '';
  return `Main table header at ${rowPart}, ${colPart}.${side}`;
}

export function detectRegion(grid: CellGrid): DetectRegionResult {
  // Compare bounds against the last NON-EMPTY column so trailing blank columns
  // don't make a clean sheet look non-trivial.
  const lastCol = lastNonEmptyColumn(grid);
  if (grid.length === 0 || gridColCount(grid) === 0 || lastCol < 0) {
    return { region: fallbackRegion(Math.max(0, gridColCount(grid) - 1)), candidates: [] };
  }

  const blocks = columnBlocks(grid);
  const candidates: DetectionCandidate[] = [];
  for (const block of blocks) {
    const cand = buildCandidate(grid, block);
    if (cand) candidates.push(cand);
  }
  if (candidates.length === 0) {
    return { region: fallbackRegion(lastCol), candidates: [] };
  }

  // Main = highest size-weighted score; tiebreak leftmost.
  const sorted = [...candidates].sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.colStart - b.colStart,
  );
  const main = sorted[0]!;
  const secondary = sorted.slice(1);

  const second = secondary[0];
  const separation = second && main.score > 0 ? Math.min(1, (main.score - second.score) / main.score) : 1;
  const singleBlock = blocks.length === 1;
  const cleanBonus = main.headerRowStart === 0 && singleBlock ? 1 : 0.4;
  const confidence = Math.max(
    0,
    Math.min(1, 0.5 * Math.max(0, main.headerScore) + 0.3 * separation + 0.2 * cleanBonus),
  );

  const triviallyClean =
    singleBlock &&
    main.headerRowStart === 0 &&
    main.headerRowEnd === 0 &&
    main.colStart === 0 &&
    main.colEnd === lastCol &&
    main.headerScore >= 0.55;

  const region: TableRegion = {
    headerRowStart: main.headerRowStart,
    headerRowEnd: main.headerRowEnd,
    dataRowStart: main.dataRowStart,
    dataRowEnd: main.dataRowEnd,
    colStart: main.colStart,
    colEnd: main.colEnd,
    confidence,
    rationale: rationaleFor(main, secondary.length),
    source: 'tier1',
    triviallyClean,
    secondaryTablesIgnored: secondary.map((c) => ({
      rowStart: c.headerRowStart,
      rowEnd: c.dataRowEnd,
      colStart: c.colStart,
      colEnd: c.colEnd,
      reason: 'gap-separated secondary block',
    })),
  };

  return { region, candidates: sorted };
}
