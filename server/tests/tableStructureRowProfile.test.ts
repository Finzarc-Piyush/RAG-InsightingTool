import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matrixToGrid } from '../lib/tableStructure/grid.js';
import {
  profileRows,
  profileCols,
  columnBlocks,
  rowStatsInRange,
} from '../lib/tableStructure/rowProfile.js';

describe('tableStructure/rowProfile · profileRows', () => {
  const grid = matrixToGrid([
    ['Quarterly report', '', ''], // sparse title
    ['Channel', 'Volume', 'NR'], // header: 3 distinct text
    ['GT', '176.84', '3.94'], // data: text + 2 numbers
    ['MT', '301.82', '8.01'],
  ]);

  it('marks the title row sparse', () => {
    const rows = profileRows(grid);
    assert.equal(rows[0]!.nonEmpty, 1);
    assert.ok(rows[0]!.density < 0.4);
  });

  it('marks the header row text-dominant with distinct labels', () => {
    const rows = profileRows(grid);
    assert.equal(rows[1]!.dominantKind, 'text');
    assert.equal(rows[1]!.distinctText, 3);
    assert.equal(rows[1]!.density, 1);
  });

  it('marks data rows number-dominant', () => {
    const rows = profileRows(grid);
    assert.equal(rows[2]!.numberCount, 2);
    assert.equal(rows[2]!.textCount, 1);
    assert.equal(rows[2]!.dominantKind, 'number');
  });
});

describe('tableStructure/rowProfile · column blocks', () => {
  it('splits a main table from a gap-separated side table', () => {
    // Cols 0-2 = main table, col 3 = empty gap, cols 4-5 = side table.
    const grid = matrixToGrid([
      ['Channel', 'Volume', 'NR', '', 'Month', 'Qtr'],
      ['GT', '176.84', '3.94', '', 'Apr 25', 'Q1'],
      ['MT', '301.82', '8.01', '', 'May 25', 'Q1'],
    ]);
    const blocks = columnBlocks(grid);
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[0], { colStart: 0, colEnd: 2 });
    assert.deepEqual(blocks[1], { colStart: 4, colEnd: 5 });
  });

  it('returns one block for a contiguous table', () => {
    const grid = matrixToGrid([
      ['Channel', 'Volume'],
      ['GT', '176.84'],
    ]);
    assert.deepEqual(columnBlocks(grid), [{ colStart: 0, colEnd: 1 }]);
  });
});

describe('tableStructure/rowProfile · profileCols + range stats', () => {
  it('reports per-column type stability', () => {
    const grid = matrixToGrid([
      ['Channel', 'Volume'],
      ['GT', '176.84'],
      ['MT', '301.82'],
    ]);
    const cols = profileCols(grid, 1); // data rows only
    assert.equal(cols[0]!.dominantKind, 'text');
    assert.equal(cols[1]!.dominantKind, 'number');
    assert.equal(cols[1]!.typeStability, 1);
  });

  it('rowStatsInRange scopes to a column block', () => {
    const grid = matrixToGrid([
      ['Channel', 'Volume', 'NR', '', 'Month', 'Qtr'],
    ]);
    const main = rowStatsInRange(grid[0]!, 0, 2);
    assert.equal(main.nonEmpty, 3);
    assert.equal(main.distinctText, 3);
    const side = rowStatsInRange(grid[0]!, 4, 5);
    assert.equal(side.nonEmpty, 2);
  });
});
