import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import { matrixToGrid, worksheetToGrid } from '../lib/tableStructure/grid.js';
import {
  scoreHeaderRow,
  scoreHeaderRowDetailed,
} from '../lib/tableStructure/scoreHeaderRow.js';

const FULL_BLOCK = { colStart: 0, colEnd: 2 };

describe('tableStructure/scoreHeaderRow', () => {
  const grid = matrixToGrid([
    ['Channel', 'Volume', 'NR'], // 0 — real header
    ['GT', '176.84', '3.94'], // 1 — data (numeric)
    ['MT', '301.82', '8.01'], // 2 — data
  ]);

  it('scores the header row above a numeric data row', () => {
    const header = scoreHeaderRow(grid, 0, FULL_BLOCK);
    const data = scoreHeaderRow(grid, 1, FULL_BLOCK);
    assert.ok(header > data, `header ${header} should beat data ${data}`);
    assert.ok(header > 0.5, `header score ${header} should be strong`);
  });

  it('penalizes a numeric "header" row', () => {
    const b = scoreHeaderRowDetailed(grid, 1, FULL_BLOCK);
    assert.ok(b.fracNumeric > 0.5);
    assert.ok(b.score < 0.5);
  });

  it('rewards type contrast (text header over numeric body)', () => {
    const b = scoreHeaderRowDetailed(grid, 0, FULL_BLOCK);
    // 2 of 3 columns are numeric below; the id column stays text → 2/3.
    assert.ok(b.contrast >= 0.66, `contrast ${b.contrast}`);
    assert.ok(b.tag > 0);
  });

  it('drives a merged title row strongly negative', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.getCell('A1').value = 'Marico India Ltd';
    ws.mergeCells('A1:C1');
    ws.getRow(2).values = ['Channel', 'Volume', 'NR'];
    ws.getRow(3).values = ['GT', 176.84, 3.94];
    const buf = await wb.xlsx.writeBuffer();
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(buf);
    const grid2 = worksheetToGrid(wb2.getWorksheet('S')!);

    const titleScore = scoreHeaderRow(grid2, 0, FULL_BLOCK);
    const headerScore = scoreHeaderRow(grid2, 1, FULL_BLOCK);
    const detail = scoreHeaderRowDetailed(grid2, 0, FULL_BLOCK);
    assert.equal(detail.merge, 1, 'merge penalty applied to the title row');
    assert.ok(titleScore < 0.35, `title score ${titleScore} should be low`);
    assert.ok(headerScore > titleScore + 0.4, 'real header decisively beats the title row');
  });
});
