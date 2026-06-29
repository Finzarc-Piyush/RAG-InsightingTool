import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matrixToGrid } from '../lib/tableStructure/grid.js';
import { detectRegion } from '../lib/tableStructure/detectRegion.js';
import { renderGridMap } from '../lib/tableStructure/renderGridMap.js';

describe('tableStructure/renderGridMap', () => {
  const grid = matrixToGrid([
    ['Marico India Ltd', '', '', '', '', ''],
    ['Channel', 'Volume', 'NR', '', 'Month', 'Qtr'],
    ['GT', '176.84', '3.94', '', 'Apr 25', 'Q1'],
    ['MT', '301.82', '8.01', '', 'May 25', 'Q1'],
  ]);

  it('prints A1 addresses with type tags and omits empty cells', () => {
    const { candidates } = detectRegion(grid);
    const map = renderGridMap(grid, candidates, { sheetName: 'P&L' });
    assert.match(map, /A1 txt:Marico India Ltd/);
    assert.match(map, /B3 num:176\.84/);
    assert.match(map, /E3 date:Apr 25/);
    // the empty gap column D is never printed
    assert.ok(!/\bD2\b/.test(map), 'empty gap cell D2 should be omitted');
  });

  it('includes the candidate-region footer with a MAIN tag', () => {
    const { candidates } = detectRegion(grid);
    const map = renderGridMap(grid, candidates);
    assert.match(map, /CANDIDATE REGIONS/);
    assert.match(map, /#1 MAIN/);
    assert.match(map, /#2 side/);
  });

  it('caps columns and reports the true totals', () => {
    const wide = matrixToGrid([
      Array.from({ length: 50 }, (_, i) => `col${i}`),
      Array.from({ length: 50 }, (_, i) => String(i)),
    ]);
    const map = renderGridMap(wide, [], { maxCols: 30 });
    assert.match(map, /showing 2×30 of 2×50/);
    assert.ok(!/col49/.test(map), 'columns beyond the cap are not rendered');
  });

  it('stays compact for a large sheet (token budget guard)', () => {
    const big = matrixToGrid(
      Array.from({ length: 5000 }, () => ['Channel', '100', '200', '300', '400']),
    );
    const map = renderGridMap(big, []);
    // matrixToGrid already caps the grid at 200 scan rows; the renderer renders
    // only the first 25 → bounded length regardless of the 5000-row input.
    assert.ok(map.length < 6000, `map length ${map.length} should be bounded`);
    assert.match(map, /showing 25×5 of 200×5/);
  });
});
