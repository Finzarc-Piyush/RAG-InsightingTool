import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import ExcelJS from 'exceljs';
import { parseFile, getAndClearLastTableDetection } from '../lib/fileParser.js';
import { installLlmStub, clearLlmStub } from './helpers/llmStub.js';
import { LLM_PURPOSE } from '../lib/agents/runtime/llmCallPurpose.js';

const FLAG = 'TABLE_STRUCTURE_DETECT_ENABLED';

/** A messy single-sheet workbook: merged title row 1, real header row 2
 * (A-C), data rows 3-5, and a gap-separated side table in columns E-F. */
async function messyWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('P&L');
  ws.getCell('A1').value = 'Marico India Ltd';
  ws.mergeCells('A1:C1');
  ws.getCell('A2').value = 'Channel';
  ws.getCell('B2').value = 'Volume';
  ws.getCell('C2').value = 'NR';
  ws.getCell('E2').value = 'Month';
  ws.getCell('F2').value = 'Qtr';
  const data = [
    ['GT', 176.84, 3.94],
    ['MT', 301.82, 8.01],
    ['EC', 51.7, 2.73],
  ];
  data.forEach(([ch, vol, nr], i) => {
    const r = 3 + i;
    ws.getCell(`A${r}`).value = ch as string;
    ws.getCell(`B${r}`).value = vol as number;
    ws.getCell(`C${r}`).value = nr as number;
  });
  ws.getCell('E3').value = 'Apr 25';
  ws.getCell('F3').value = 'Q1';
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function cleanWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  ws.getCell('A1').value = 'Channel';
  ws.getCell('B1').value = 'Volume';
  ws.getCell('A2').value = 'GT';
  ws.getCell('B2').value = 176.84;
  ws.getCell('A3').value = 'MT';
  ws.getCell('B3').value = 301.82;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

afterEach(() => {
  clearLlmStub();
  delete process.env[FLAG];
});

describe('Excel table-structure integration', () => {
  it('flag OFF → legacy path mangles a messy sheet (the bug we fix)', async () => {
    process.env[FLAG] = 'false';
    const rows = await parseFile(await messyWorkbook(), 'f.xlsx');
    const keys = Object.keys(rows[0]!);
    assert.ok(keys.includes('Marico India Ltd'), 'legacy uses the title row as header');
    assert.ok(keys.some((k) => k.startsWith('__EMPTY')), 'legacy emits __EMPTY columns');
    assert.equal(getAndClearLastTableDetection(), undefined);
  });

  it('flag ON → detects the real header, drops the title + side table', async () => {
    process.env[FLAG] = 'true';
    installLlmStub({
      [LLM_PURPOSE.TABLE_STRUCTURE_DETECT]: () => ({
        headerRowStart: 1,
        headerRowEnd: 1,
        dataRowStart: 2,
        dataRowEnd: -1,
        colStart: 0,
        colEnd: 2,
        secondaryTablesIgnored: [{ colStart: 4, colEnd: 5, reason: 'side table' }],
        rationale: 'Header at row 2; ignored side table E-F.',
      }),
    });
    const rows = await parseFile(await messyWorkbook(), 'f.xlsx');
    const keys = Object.keys(rows[0]!);
    assert.deepEqual(keys, ['Channel', 'Volume', 'NR']);
    assert.ok(!keys.includes('Marico India Ltd'));
    assert.ok(!keys.some((k) => k.startsWith('__EMPTY')));
    assert.equal(rows.length, 3);
    assert.equal(rows[0]!.Volume, 176.84);

    const det = getAndClearLastTableDetection();
    assert.ok(det);
    assert.equal(det!.headerRowStart, 1);
    assert.equal(det!.nonTrivial, true);
    assert.equal(det!.source, 'tier2');
    assert.ok((det!.rawGridPreview?.length ?? 0) > 0);
  });

  it('override path honors a user-chosen header regardless of flag', async () => {
    process.env[FLAG] = 'false'; // even with detection off, an override is honored
    const rows = await parseFile(await messyWorkbook(), 'f.xlsx', {
      tableRegionOverride: { headerRow: 1 },
    });
    const keys = Object.keys(rows[0]!);
    assert.ok(keys.includes('Channel'));
    assert.ok(!keys.includes('Marico India Ltd'));
    const det = getAndClearLastTableDetection();
    assert.equal(det!.source, 'override');
  });

  it('flag ON → a clean sheet is unchanged and skips the LLM', async () => {
    process.env[FLAG] = 'true';
    let llmCalled = false;
    installLlmStub({
      [LLM_PURPOSE.TABLE_STRUCTURE_DETECT]: () => {
        llmCalled = true;
        return { headerRowStart: 0, headerRowEnd: 0, dataRowStart: 1, dataRowEnd: -1, colStart: 0, colEnd: 1, secondaryTablesIgnored: [], rationale: 'x' };
      },
    });
    const rows = await parseFile(await cleanWorkbook(), 'clean.xlsx');
    assert.deepEqual(Object.keys(rows[0]!), ['Channel', 'Volume']);
    assert.equal(llmCalled, false, 'clean sheet must not call the LLM');
    const det = getAndClearLastTableDetection();
    assert.equal(det!.nonTrivial, false);
    assert.equal(det!.source, 'tier1');
  });
});
