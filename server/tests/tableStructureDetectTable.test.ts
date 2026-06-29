import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { matrixToGrid } from '../lib/tableStructure/grid.js';
import {
  detectTableFromGrid,
  detectTableFromMatrix,
  buildRawGridPreview,
} from '../lib/tableStructure/detectTable.js';
import { installLlmStub, clearLlmStub } from './helpers/llmStub.js';
import { LLM_PURPOSE } from '../lib/agents/runtime/llmCallPurpose.js';

const cleanGrid = () =>
  matrixToGrid([
    ['Channel', 'Volume', 'NR'],
    ['GT', '176.84', '3.94'],
    ['MT', '301.82', '8.01'],
  ]);

const messyGrid = () =>
  matrixToGrid([
    ['Marico India Ltd', '', ''],
    ['Channel', 'Volume', 'NR'],
    ['GT', '176.84', '3.94'],
    ['MT', '301.82', '8.01'],
  ]);

afterEach(() => clearLlmStub());

describe('tableStructure/detectTable', () => {
  it('skips the LLM for a trivially-clean sheet', async () => {
    let called = false;
    installLlmStub({
      [LLM_PURPOSE.TABLE_STRUCTURE_DETECT]: () => {
        called = true;
        return { headerRowStart: 0, headerRowEnd: 0, dataRowStart: 1, dataRowEnd: -1, colStart: 0, colEnd: 2, secondaryTablesIgnored: [], rationale: 'x' };
      },
    });
    const region = await detectTableFromGrid(cleanGrid(), { llmEnabled: true });
    assert.equal(called, false, 'LLM must not be called for a clean sheet');
    assert.equal(region.source, 'tier1');
    assert.equal(region.triviallyClean, true);
  });

  it('calls the LLM for a non-trivial sheet when enabled', async () => {
    let called = false;
    installLlmStub({
      [LLM_PURPOSE.TABLE_STRUCTURE_DETECT]: () => {
        called = true;
        return { headerRowStart: 1, headerRowEnd: 1, dataRowStart: 2, dataRowEnd: -1, colStart: 0, colEnd: 2, secondaryTablesIgnored: [], rationale: 'row 2 header' };
      },
    });
    const region = await detectTableFromGrid(messyGrid(), { llmEnabled: true });
    assert.equal(called, true, 'LLM must adjudicate a messy sheet');
    assert.equal(region.source, 'tier2');
    assert.equal(region.headerRowStart, 1);
  });

  it('stays on Tier-1 for a non-trivial sheet when the LLM is disabled', async () => {
    const region = await detectTableFromGrid(messyGrid(), { llmEnabled: false });
    assert.equal(region.source, 'tier1');
    assert.equal(region.headerRowStart, 1);
  });

  it('returns a raw-grid preview alongside the region', async () => {
    const result = await detectTableFromMatrix(
      [
        ['Marico India Ltd', '', ''],
        ['Channel', 'Volume', 'NR'],
        ['GT', '176.84', '3.94'],
      ],
      { llmEnabled: false },
    );
    assert.equal(result.rawGridPreview[0]![0], 'Marico India Ltd');
    assert.equal(result.rawGridPreview[1]![0], 'Channel');
    assert.equal(result.region.headerRowStart, 1);
  });

  it('buildRawGridPreview caps rows and columns', () => {
    const grid = matrixToGrid(Array.from({ length: 100 }, () => ['a', 'b']));
    const preview = buildRawGridPreview(grid, 5, 1);
    assert.equal(preview.length, 5);
    assert.equal(preview[0]!.length, 1);
  });
});
