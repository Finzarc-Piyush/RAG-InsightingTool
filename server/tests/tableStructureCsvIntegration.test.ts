import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { parseFile, getAndClearLastTableDetection } from '../lib/fileParser.js';
import { installLlmStub, clearLlmStub } from './helpers/llmStub.js';
import { LLM_PURPOSE } from '../lib/agents/runtime/llmCallPurpose.js';

const FLAG = 'TABLE_STRUCTURE_DETECT_ENABLED';

const MESSY_CSV = ['Quarterly Report,,', 'Channel,Volume,NR', 'GT,176.84,3.94', 'MT,301.82,8.01'].join(
  '\n',
);
const CLEAN_CSV = ['Channel,Volume,NR', 'GT,176.84,3.94', 'MT,301.82,8.01'].join('\n');

afterEach(() => {
  clearLlmStub();
  delete process.env[FLAG];
});

describe('CSV table-structure integration', () => {
  it('flag OFF → legacy path uses the title line as header', async () => {
    process.env[FLAG] = 'false';
    const rows = await parseFile(Buffer.from(MESSY_CSV), 'f.csv');
    const keys = Object.keys(rows[0]!);
    assert.ok(keys.includes('Quarterly Report'));
  });

  it('flag ON → detects the real header row in a CSV', async () => {
    process.env[FLAG] = 'true';
    installLlmStub({
      [LLM_PURPOSE.TABLE_STRUCTURE_DETECT]: () => ({
        headerRowStart: 1,
        headerRowEnd: 1,
        dataRowStart: 2,
        dataRowEnd: -1,
        colStart: 0,
        colEnd: 2,
        secondaryTablesIgnored: [],
        rationale: 'Header at row 2.',
      }),
    });
    const rows = await parseFile(Buffer.from(MESSY_CSV), 'f.csv');
    const keys = Object.keys(rows[0]!);
    assert.deepEqual(keys, ['Channel', 'Volume', 'NR']);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.Volume, 176.84);
    const det = getAndClearLastTableDetection();
    assert.equal(det!.headerRowStart, 1);
    assert.equal(det!.nonTrivial, true);
  });

  it('flag ON → a clean CSV is unchanged and skips the LLM', async () => {
    process.env[FLAG] = 'true';
    let called = false;
    installLlmStub({
      [LLM_PURPOSE.TABLE_STRUCTURE_DETECT]: () => {
        called = true;
        return { headerRowStart: 0, headerRowEnd: 0, dataRowStart: 1, dataRowEnd: -1, colStart: 0, colEnd: 2, secondaryTablesIgnored: [], rationale: 'x' };
      },
    });
    const rows = await parseFile(Buffer.from(CLEAN_CSV), 'clean.csv');
    assert.deepEqual(Object.keys(rows[0]!), ['Channel', 'Volume', 'NR']);
    assert.equal(called, false);
  });

  it('override path re-keys a CSV from the chosen header', async () => {
    process.env[FLAG] = 'false'; // override honored even with detection off
    const rows = await parseFile(Buffer.from(MESSY_CSV), 'f.csv', {
      tableRegionOverride: { headerRow: 1 },
    });
    assert.deepEqual(Object.keys(rows[0]!), ['Channel', 'Volume', 'NR']);
    const det = getAndClearLastTableDetection();
    assert.equal(det!.source, 'override');
  });
});
