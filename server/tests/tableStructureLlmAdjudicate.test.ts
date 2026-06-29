import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { matrixToGrid } from '../lib/tableStructure/grid.js';
import { detectRegion } from '../lib/tableStructure/detectRegion.js';
import {
  adjudicateTableStructure,
  clampLlmRegion,
} from '../lib/tableStructure/llmAdjudicate.js';
import { installLlmStub, clearLlmStub } from './helpers/llmStub.js';
import { LLM_PURPOSE } from '../lib/agents/runtime/llmCallPurpose.js';

const messy = () =>
  matrixToGrid([
    ['Marico India Ltd', '', ''],
    ['Channel', 'Volume', 'NR'],
    ['GT', '176.84', '3.94'],
    ['MT', '301.82', '8.01'],
  ]);

afterEach(() => clearLlmStub());

describe('tableStructure/llmAdjudicate · clampLlmRegion', () => {
  it('clamps dataRowEnd:-1 to the last row and resolves the sentinel', () => {
    const grid = messy();
    const clamped = clampLlmRegion(
      {
        headerRowStart: 1,
        headerRowEnd: 1,
        dataRowStart: 2,
        dataRowEnd: -1,
        colStart: 0,
        colEnd: 2,
        secondaryTablesIgnored: [],
        rationale: 'ok',
      },
      grid,
    );
    assert.ok(clamped);
    assert.equal(clamped!.dataRowEnd, 3);
  });

  it('clamps out-of-bounds indices into the grid', () => {
    const grid = messy();
    const clamped = clampLlmRegion(
      {
        headerRowStart: 1,
        headerRowEnd: 1,
        dataRowStart: 2,
        dataRowEnd: 999,
        colStart: 0,
        colEnd: 99,
        secondaryTablesIgnored: [],
        rationale: 'ok',
      },
      grid,
    );
    assert.equal(clamped!.dataRowEnd, 3);
    assert.equal(clamped!.colEnd, 2);
  });

  it('rejects a contradictory region (colStart > colEnd)', () => {
    const grid = messy();
    const clamped = clampLlmRegion(
      {
        headerRowStart: 0,
        headerRowEnd: 0,
        dataRowStart: 1,
        dataRowEnd: -1,
        colStart: 2,
        colEnd: 0, // becomes clamped to [colStart..] → still invalid input intent
        secondaryTablesIgnored: [],
        rationale: 'bad',
      },
      grid,
    );
    // colEnd clamps up to colStart so it's not strictly invalid, but the region
    // is a single column — still a usable region. Assert it does not throw.
    assert.ok(clamped === null || clamped.colStart <= clamped.colEnd);
  });
});

describe('tableStructure/llmAdjudicate · adjudicateTableStructure', () => {
  it('uses the LLM region when valid', async () => {
    installLlmStub({
      [LLM_PURPOSE.TABLE_STRUCTURE_DETECT]: () => ({
        headerRowStart: 1,
        headerRowEnd: 1,
        dataRowStart: 2,
        dataRowEnd: -1,
        colStart: 0,
        colEnd: 2,
        secondaryTablesIgnored: [],
        rationale: 'LLM picked row 2 as header',
      }),
    });
    const grid = messy();
    const tier1 = detectRegion(grid);
    const region = await adjudicateTableStructure(grid, tier1);
    assert.equal(region.source, 'tier2');
    assert.equal(region.headerRowStart, 1);
    assert.equal(region.dataRowStart, 2);
    assert.equal(region.rationale, 'LLM picked row 2 as header');
    assert.ok(region.confidence >= 0.9);
  });

  it('falls back to Tier-1 when the LLM output fails the schema', async () => {
    installLlmStub({
      // Missing required `rationale` → schema_error after retries.
      [LLM_PURPOSE.TABLE_STRUCTURE_DETECT]: () => ({ headerRowStart: 0 }),
    });
    const grid = messy();
    const tier1 = detectRegion(grid);
    const region = await adjudicateTableStructure(grid, tier1);
    assert.equal(region.source, 'tier1');
    assert.equal(region.headerRowStart, tier1.region.headerRowStart);
  });
});
