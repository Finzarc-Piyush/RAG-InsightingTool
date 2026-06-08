import { describe, it, expect } from 'vitest';
import { splitTableCells, isTableSeparatorRow, parseGfmTableBlock } from './markdownTable';

describe('markdownTable', () => {
  it('splits a pipe row into trimmed cells (drops outer pipes)', () => {
    expect(splitTableCells('| TSO_TSE Name | compliance_visits |')).toEqual([
      'TSO_TSE Name',
      'compliance_visits',
    ]);
  });

  it('recognizes a separator row and rejects a data row', () => {
    expect(isTableSeparatorRow('| --- | --- |')).toBe(true);
    expect(isTableSeparatorRow('| :--: | ---: |')).toBe(true);
    expect(isTableSeparatorRow('| AJAYKUMAR | 738 |')).toBe(false);
  });

  it('parses a full GFM table block and reports the next index', () => {
    const lines = [
      'Top 10 TSOEs by compliance visits',
      '',
      '| TSO_TSE Name | compliance_visits |',
      '| --- | --- |',
      '| AJAYKUMAR | 738 |',
      '| Nitesh Jaiswal | 717 |',
      'trailing prose',
    ];
    const block = parseGfmTableBlock(lines, 2);
    expect(block).not.toBeNull();
    expect(block!.header).toEqual(['TSO_TSE Name', 'compliance_visits']);
    expect(block!.rows).toEqual([
      ['AJAYKUMAR', '738'],
      ['Nitesh Jaiswal', '717'],
    ]);
    expect(block!.nextIndex).toBe(6); // 'trailing prose'
  });

  it('returns null when the line is not a table header (no separator follows)', () => {
    const lines = ['just a sentence', 'another one'];
    expect(parseGfmTableBlock(lines, 0)).toBeNull();
  });

  it('returns null when a pipe row is not followed by a separator', () => {
    const lines = ['| a | b |', '| c | d |'];
    expect(parseGfmTableBlock(lines, 0)).toBeNull();
  });
});
