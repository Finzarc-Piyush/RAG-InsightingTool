import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import ExcelJS from 'exceljs';
import { matrixToGrid, worksheetToGrid } from '../lib/tableStructure/grid.js';
import { detectRegion } from '../lib/tableStructure/detectRegion.js';

async function wsFromBuilder(build: (ws: ExcelJS.Worksheet) => void) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  build(ws);
  const buf = await wb.xlsx.writeBuffer();
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(buf);
  return wb2.getWorksheet('S')!;
}

describe('tableStructure/detectRegion', () => {
  it('skips a title row → header on row 2', () => {
    const grid = matrixToGrid([
      ['Marico India Ltd', '', ''],
      ['Channel', 'Volume', 'NR'],
      ['GT', '176.84', '3.94'],
      ['MT', '301.82', '8.01'],
    ]);
    const { region } = detectRegion(grid);
    assert.equal(region.headerRowStart, 1);
    assert.equal(region.headerRowEnd, 1);
    assert.equal(region.dataRowStart, 2);
    assert.equal(region.triviallyClean, false);
  });

  it('isolates the main table from a gap-separated side table', () => {
    const grid = matrixToGrid([
      ['Marico India Ltd', '', '', '', '', ''],
      ['Channel', 'Volume', 'NR', '', 'Month', 'Qtr'],
      ['GT', '176.84', '3.94', '', 'Apr 25', 'Q1'],
      ['MT', '301.82', '8.01', '', 'May 25', 'Q1'],
      ['EC', '51.70', '2.73', '', '', ''],
      ['DT', '114.73', '4.58', '', '', ''],
    ]);
    const { region } = detectRegion(grid);
    assert.equal(region.colStart, 0);
    assert.equal(region.colEnd, 2);
    assert.equal(region.headerRowStart, 1);
    assert.equal(region.secondaryTablesIgnored.length, 1);
    assert.deepEqual(
      { c0: region.secondaryTablesIgnored[0]!.colStart, c1: region.secondaryTablesIgnored[0]!.colEnd },
      { c0: 4, c1: 5 },
    );
  });

  it('detects a multi-row (merged super-header) header', async () => {
    const ws = await wsFromBuilder((ws) => {
      ws.getCell('B1').value = 'FY2024';
      ws.mergeCells('B1:C1');
      ws.getCell('D1').value = 'FY2025';
      ws.mergeCells('D1:E1');
      ws.getRow(2).values = ['Region', 'Value', 'Volume', 'Value', 'Volume'];
      ws.getRow(3).values = ['North', 10, 12, 11, 13];
      ws.getRow(4).values = ['South', 20, 22, 21, 23];
    });
    const { region } = detectRegion(worksheetToGrid(ws));
    assert.equal(region.headerRowStart, 0);
    assert.equal(region.headerRowEnd, 1);
    assert.equal(region.dataRowStart, 2);
  });

  it('passes a clean sheet through as triviallyClean', () => {
    const grid = matrixToGrid([
      ['Channel', 'Volume', 'NR'],
      ['GT', '176.84', '3.94'],
      ['MT', '301.82', '8.01'],
    ]);
    const { region } = detectRegion(grid);
    assert.equal(region.triviallyClean, true);
    assert.equal(region.headerRowStart, 0);
    assert.equal(region.colStart, 0);
    assert.equal(region.colEnd, 2);
    assert.equal(region.secondaryTablesIgnored.length, 0);
    assert.ok(region.confidence > 0.7);
  });

  it('keeps a totals row in the data extent', () => {
    const grid = matrixToGrid([
      ['Channel', 'Volume'],
      ['GT', '176.84'],
      ['MT', '301.82'],
      ['Total', '478.66'],
    ]);
    const { region } = detectRegion(grid);
    assert.equal(region.dataRowEnd, 3);
  });

  it('handles an all-period wide sheet as one clean block', () => {
    const grid = matrixToGrid([
      ['Brand', 'Jan 2024', 'Feb 2024', 'Mar 2024'],
      ['Nihar', '10', '12', '11'],
      ['Parachute', '20', '22', '21'],
    ]);
    const { region } = detectRegion(grid);
    assert.equal(region.headerRowStart, 0);
    assert.equal(region.secondaryTablesIgnored.length, 0);
    assert.equal(region.triviallyClean, true);
  });

  it('falls back gracefully on an empty grid', () => {
    const { region } = detectRegion([]);
    assert.equal(region.source, 'fallback');
    assert.equal(region.confidence, 0);
  });
});
