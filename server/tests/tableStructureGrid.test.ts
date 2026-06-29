import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import {
  worksheetToGrid,
  matrixToGrid,
  classifyValueKind,
  classifyStringKind,
} from '../lib/tableStructure/grid.js';

/** A workbook shaped like the messy demo: a merged title row spanning A1:C1,
 * the real header in row 2, two data rows below. */
async function messyWorkbook(): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('P&L');
  ws.getCell('A1').value = 'Marico India Ltd';
  ws.mergeCells('A1:C1');
  ws.getRow(2).values = ['Channel', 'Volume', 'NR'];
  ws.getRow(3).values = ['GT', 176.84, 3.94];
  ws.getRow(4).values = ['MT', 301.82, 8.01];
  // round-trip through a buffer so merge metadata is fully materialized
  const buf = await wb.xlsx.writeBuffer();
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(buf);
  return wb2.getWorksheet('P&L')!;
}

describe('tableStructure/grid · classifyValueKind', () => {
  it('classifies primitives', () => {
    assert.equal(classifyValueKind(null), 'empty');
    assert.equal(classifyValueKind(42), 'number');
    assert.equal(classifyValueKind(new Date()), 'date');
    assert.equal(classifyValueKind(true), 'bool');
    assert.equal(classifyValueKind('GT'), 'text');
  });

  it('classifies numeric/date/bool strings via parser coercions', () => {
    assert.equal(classifyStringKind(''), 'empty');
    assert.equal(classifyStringKind('  '), 'empty');
    assert.equal(classifyStringKind('1,234.5'), 'number');
    assert.equal(classifyStringKind('$99'), 'number');
    assert.equal(classifyStringKind('Jan-24'), 'date');
    assert.equal(classifyStringKind('TRUE'), 'bool');
    assert.equal(classifyStringKind('Channel'), 'text');
  });
});

describe('tableStructure/grid · worksheetToGrid', () => {
  it('reads a merged title as ONE populated cell, not many', async () => {
    const ws = await messyWorkbook();
    const grid = worksheetToGrid(ws);
    // Row 0 = the merged title row.
    assert.equal(grid[0]![0]!.kind, 'text');
    assert.equal(grid[0]![0]!.text, 'Marico India Ltd');
    assert.equal(grid[0]![0]!.merged, true);
    assert.equal(grid[0]![0]!.mergeAnchor, true);
    // Non-anchor cells of the merge are empty (so the title row reads as sparse)
    // but carry the anchor's text for later flattening.
    assert.equal(grid[0]![1]!.kind, 'empty');
    assert.equal(grid[0]![1]!.raw, null);
    assert.equal(grid[0]![1]!.text, 'Marico India Ltd');
    assert.equal(grid[0]![1]!.mergeAnchor, false);
  });

  it('classifies the real header row as text and data rows by type', async () => {
    const ws = await messyWorkbook();
    const grid = worksheetToGrid(ws);
    // Row 1 = header.
    assert.deepEqual(
      grid[1]!.slice(0, 3).map((c) => c.kind),
      ['text', 'text', 'text'],
    );
    assert.deepEqual(grid[1]!.slice(0, 3).map((c) => c.text), ['Channel', 'Volume', 'NR']);
    // Rows 2-3 = data: text id + two numbers.
    assert.deepEqual(grid[2]!.slice(0, 3).map((c) => c.kind), ['text', 'number', 'number']);
    assert.equal(grid[2]![1]!.raw, 176.84);
  });

  it('honors maxScanRows', async () => {
    const ws = await messyWorkbook();
    const grid = worksheetToGrid(ws, { maxScanRows: 2 });
    assert.equal(grid.length, 2);
  });
});

describe('tableStructure/grid · matrixToGrid', () => {
  it('classifies a raw CSV matrix and rectangularizes', () => {
    const grid = matrixToGrid([
      ['Quarterly report'],
      ['Channel', 'Volume', 'NR'],
      ['GT', '176.84', '3.94'],
    ]);
    assert.equal(grid.length, 3);
    // rectangularized to the widest row (3 cols)
    assert.equal(grid[0]!.length, 3);
    assert.equal(grid[0]![0]!.kind, 'text');
    assert.equal(grid[0]![1]!.kind, 'empty');
    assert.deepEqual(grid[1]!.map((c) => c.kind), ['text', 'text', 'text']);
    assert.deepEqual(grid[2]!.map((c) => c.kind), ['text', 'number', 'number']);
  });
});
