import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  tableDetectionSchema,
  tableRegionOverrideSchema,
  dataSummarySchema,
} from '../shared/schema/charts.js';

describe('tableDetectionSchema', () => {
  it('round-trips a valid detection', () => {
    const parsed = tableDetectionSchema.parse({
      headerRowStart: 1,
      headerRowEnd: 1,
      dataRowStart: 2,
      dataRowEnd: 300,
      colStart: 0,
      colEnd: 12,
      confidence: 0.82,
      rationale: 'Header at row 2; ignored a side table in columns O–P.',
      source: 'tier2',
      nonTrivial: true,
      secondaryTablesIgnored: [
        { rowStart: 1, rowEnd: 13, colStart: 14, colEnd: 15, reason: 'gap-separated side table' },
      ],
      rawGridPreview: [['Marico India Ltd', '', ''], ['Channel', 'Volume', 'NR']],
    });
    assert.equal(parsed.headerRowStart, 1);
    assert.equal(parsed.secondaryTablesIgnored.length, 1);
  });

  it('defaults secondaryTablesIgnored to []', () => {
    const parsed = tableDetectionSchema.parse({
      headerRowStart: 0,
      headerRowEnd: 0,
      dataRowStart: 1,
      dataRowEnd: 99,
      colStart: 0,
      colEnd: 5,
      confidence: 0.95,
      rationale: 'clean',
      source: 'tier1',
      nonTrivial: false,
    });
    assert.deepEqual(parsed.secondaryTablesIgnored, []);
  });

  it('rejects an invalid source and out-of-range confidence', () => {
    assert.throws(() =>
      tableDetectionSchema.parse({
        headerRowStart: 0, headerRowEnd: 0, dataRowStart: 1, dataRowEnd: 1,
        colStart: 0, colEnd: 1, confidence: 2, rationale: 'x', source: 'bogus', nonTrivial: false,
      }),
    );
  });
});

describe('tableRegionOverrideSchema', () => {
  it('accepts headerRow alone', () => {
    const parsed = tableRegionOverrideSchema.parse({ headerRow: 2 });
    assert.equal(parsed.headerRow, 2);
    assert.equal(parsed.colStart, undefined);
  });

  it('rejects a negative headerRow', () => {
    assert.throws(() => tableRegionOverrideSchema.parse({ headerRow: -1 }));
  });
});

describe('dataSummarySchema carries tableDetection', () => {
  it('accepts a summary with tableDetection and without', () => {
    const base = { rowCount: 3, columnCount: 2, columns: [], numericColumns: [], dateColumns: [] };
    assert.ok(dataSummarySchema.parse(base));
    const withDet = dataSummarySchema.parse({
      ...base,
      tableDetection: {
        headerRowStart: 1, headerRowEnd: 1, dataRowStart: 2, dataRowEnd: 3,
        colStart: 0, colEnd: 1, confidence: 0.8, rationale: 'r', source: 'tier1', nonTrivial: true,
      },
    });
    assert.equal(withDet.tableDetection?.headerRowStart, 1);
  });
});
