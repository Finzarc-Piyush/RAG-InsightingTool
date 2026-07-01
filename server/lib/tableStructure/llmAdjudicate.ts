// Table-structure detection — Tier-2 LLM adjudicator. Given a compact corner
// map + the Tier-1 candidates, a MINI-tier model returns the real header/data/
// column ranges. The output is Zod-validated and CLAMPED to the grid bounds;
// on any failure or contradiction we fall back to the Tier-1 main region, so
// Tier-2 is never worse than Tier-1.

import { z } from 'zod';
import type { CellGrid } from './grid.js';
import { gridColCount } from './rowProfile.js';
import { renderGridMap } from './renderGridMap.js';
import type { TableRegion } from './types.js';
import type { DetectRegionResult } from './detectRegion.js';
import { completeJson } from '../agents/runtime/llmJson.js';
import { LLM_PURPOSE } from '../agents/runtime/llmCallPurpose.js';

export const tableStructureLlmSchema = z.object({
  headerRowStart: z.number().int().min(0),
  headerRowEnd: z.number().int().min(0),
  dataRowStart: z.number().int().min(0),
  /** -1 = "to the last row" (the model can't see every row). */
  dataRowEnd: z.number().int().min(-1),
  colStart: z.number().int().min(0),
  colEnd: z.number().int().min(0),
  secondaryTablesIgnored: z
    .array(
      z.object({
        colStart: z.number().int().min(0),
        colEnd: z.number().int().min(0),
        reason: z.string().max(160),
      }),
    )
    .max(8)
    .optional(),
  rationale: z.string().min(1).max(240),
});

export type TableStructureLlmResult = z.infer<typeof tableStructureLlmSchema>;

export const SYSTEM_PROMPT = `You are a spreadsheet-structure analyst. You are given a COMPACT MAP of the
top-left corner of one worksheet: each line lists a 0-based row index then its
populated cells as "ADDRESS tag:value". A deterministic pre-pass has proposed
candidate table regions.

Identify the ONE MAIN data table — the largest coherent block of records whose
columns share a header row of distinct labels and whose body is type-stable.

Rules:
- A single merged/wide cell at the top spanning many columns is a TITLE, not a header. Skip it.
- The header may span MULTIPLE consecutive rows (group header + sub-header). Return the full range.
- Ignore small side/lookup blocks separated by an empty column; list them in secondaryTablesIgnored.
- Return 0-based indices exactly as shown in the map. Use dataRowEnd:-1 to mean "to the last row".
- Do NOT invent rows you cannot see. Prefer the pre-pass MAIN candidate unless the map clearly contradicts it.

Return ONLY a JSON object with EXACTLY these fields (all six numeric fields are REQUIRED — never omit one; secondaryTablesIgnored is optional):
{
  "headerRowStart": <int ≥ 0>,
  "headerRowEnd": <int ≥ 0>,
  "dataRowStart": <int ≥ 0>,
  "dataRowEnd": <int, or -1 for "to the last row">,
  "colStart": <int ≥ 0>,
  "colEnd": <int ≥ 0>,
  "secondaryTablesIgnored": [ { "colStart": <int>, "colEnd": <int>, "reason": "<short>" } ],
  "rationale": "<one line>"
}
Example — a title row 0, a 2-row header on rows 1-2, data from row 3 to the end, columns A-N:
{ "headerRowStart": 1, "headerRowEnd": 2, "dataRowStart": 3, "dataRowEnd": -1, "colStart": 0, "colEnd": 13, "rationale": "2-row header under a title; body type-stable A-N." }

Keep the rationale to one line.`;

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/** Validate + clamp the LLM region against the real grid; return null if it is
 * degenerate/contradictory (caller falls back to Tier-1). */
export function clampLlmRegion(
  raw: TableStructureLlmResult,
  grid: CellGrid,
): Omit<TableRegion, 'confidence' | 'rationale' | 'source' | 'triviallyClean'> | null {
  const rowsN = grid.length;
  const colsN = gridColCount(grid);
  if (rowsN === 0 || colsN === 0) return null;

  const headerRowStart = clampInt(raw.headerRowStart, 0, rowsN - 1);
  const headerRowEnd = clampInt(raw.headerRowEnd, headerRowStart, rowsN - 1);
  const dataRowStart =
    raw.dataRowStart < 0 || raw.dataRowStart > rowsN - 1
      ? headerRowEnd + 1
      : clampInt(raw.dataRowStart, headerRowEnd + 1, rowsN);
  const dataRowEnd =
    raw.dataRowEnd < 0 ? rowsN - 1 : clampInt(raw.dataRowEnd, dataRowStart, rowsN - 1);
  const colStart = clampInt(raw.colStart, 0, colsN - 1);
  const colEnd = clampInt(raw.colEnd, colStart, colsN - 1);

  // Contradiction: no room for a data body.
  if (headerRowEnd >= rowsN || dataRowStart > rowsN) return null;
  if (colStart > colEnd) return null;

  return {
    headerRowStart,
    headerRowEnd,
    dataRowStart,
    dataRowEnd,
    colStart,
    colEnd,
    secondaryTablesIgnored: (raw.secondaryTablesIgnored ?? []).map((s) => ({
      rowStart: headerRowStart,
      rowEnd: dataRowEnd,
      colStart: clampInt(s.colStart, 0, colsN - 1),
      colEnd: clampInt(s.colEnd, 0, colsN - 1),
      reason: s.reason,
    })),
  };
}

/** Adjudicate the table region with the LLM, falling back to Tier-1 on any
 * failure. Returns a `TableRegion` with `source: 'tier2'` on success. */
export async function adjudicateTableStructure(
  grid: CellGrid,
  tier1: DetectRegionResult,
  opts: { turnId?: string; sheetName?: string } = {},
): Promise<TableRegion> {
  const map = renderGridMap(grid, tier1.candidates, { sheetName: opts.sheetName });
  const result = await completeJson(SYSTEM_PROMPT, map, tableStructureLlmSchema, {
    purpose: LLM_PURPOSE.TABLE_STRUCTURE_DETECT,
    turnId: opts.turnId,
    maxTokens: 400,
    temperature: 0,
  });
  if (!result.ok) return tier1.region;

  const clamped = clampLlmRegion(result.data, grid);
  if (!clamped) return tier1.region;

  return {
    ...clamped,
    confidence: Math.max(tier1.region.confidence, 0.9),
    rationale: result.data.rationale,
    source: 'tier2',
    triviallyClean: false,
  };
}
