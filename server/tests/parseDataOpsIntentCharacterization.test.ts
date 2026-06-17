/**
 * CHARACTERIZATION · the ORDER-SENSITIVE regex fallback chain inside
 * `parseDataOpsIntent` (lib/dataOps/dataOpsOrchestrator.ts), the second mega-fn
 * of the ARCH-2 god-file decomposition.
 *
 * `parseDataOpsIntent` runs AI detection FIRST and only falls back to a long
 * sequence of per-operation regex blocks (FIRST-match-wins) when the AI returns
 * `unknown`/`null` or throws. The relative ORDER of those blocks is load-bearing:
 * several messages could match two blocks and must keep resolving to the SAME
 * operation. This test pins the resolved `operation` (and key extracted fields)
 * for a representative spread of messages — INCLUDING order-ambiguous ones —
 * BEFORE the blocks are extracted into `dataOps/intent/detect<Op>.ts`, and must
 * stay green through the extraction (proving order was preserved EXACTLY).
 *
 * Hermeticity: the AI path is short-circuited at the lowest clean seam —
 * `__setIntentAiDetectorForTesting` in `dataOpsOrchestrator.ts` (mirrors
 * `__setFetchFnForTesting` in `pythonService.ts`). The injected detector returns
 * `null`, so every case deterministically falls through to the regex chain
 * regardless of whether OpenAI env vars are present. No network, no Python, no
 * Cosmos — the regex paths are pure message→intent.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseDataOpsIntent,
  __setIntentAiDetectorForTesting,
  type DataOpsIntent,
} from "../lib/dataOps/dataOpsOrchestrator.js";
import { logger } from "../lib/logger.js";
import type { DataSummary } from "../../shared/schema.js";

// A column set with multi-word + single-word + underscore names so the column
// matchers are genuinely exercised.
const COLUMNS = [
  "region",
  "sales",
  "RISK_VOLUME",
  "DEPOT",
  "Emami 7 Oils TOM",
  "Dove nGRP Adstocked",
  "SKU Desc",
  "Brand",
  "Month",
];

const dataSummary = {
  rowCount: 100,
  columnCount: COLUMNS.length,
  columns: COLUMNS.map((name) => ({ name, type: "numeric" })),
} as unknown as DataSummary;

// Convenience: drive the regex chain with no chat history / no session doc.
function parse(message: string): Promise<DataOpsIntent> {
  return parseDataOpsIntent(message, [], dataSummary, undefined);
}

const originalLogger = {
  error: logger.error,
  warn: logger.warn,
  log: logger.log,
  debug: logger.debug,
};

before(() => {
  // Silence structured logger output — its objects break the node:test TAP IPC.
  logger.error = () => {};
  logger.warn = () => {};
  logger.log = () => {};
  logger.debug = () => {};
  // Force the AI detector to defer to the regex chain for every case.
  __setIntentAiDetectorForTesting(async () => null);
});

after(() => {
  logger.error = originalLogger.error;
  logger.warn = originalLogger.warn;
  logger.log = originalLogger.log;
  logger.debug = originalLogger.debug;
  __setIntentAiDetectorForTesting(null);
});

describe("parseDataOpsIntent — order-sensitive regex fallback characterization", () => {
  // ── STEP -1: correlation routes to analysis (unknown), never aggregate ──────
  it("[1] correlation request → unknown (analysis, not aggregate)", async () => {
    const r = await parse("correlation of sales with region");
    assert.equal(r.operation, "unknown");
    assert.equal(r.requiresClarification, false);
  });

  it("[2] 'what affects X' → unknown (analysis)", async () => {
    const r = await parse("what affects sales the most?");
    assert.equal(r.operation, "unknown");
  });

  // ── replace_value (regex fallback) — runs before revert / aggregate ─────────
  it("[3] 'replace - with 0' → replace_value", async () => {
    const r = await parse("replace - with 0");
    assert.equal(r.operation, "replace_value");
    assert.equal(r.oldValue, "-");
    assert.equal(r.newValue, 0);
  });

  it("[4] 'remove - and put 134.2 instead' → replace_value (not remove_rows)", async () => {
    const r = await parse("remove - and put 134.2 instead");
    assert.equal(r.operation, "replace_value");
    assert.equal(r.oldValue, "-");
    // Pinned: the non-greedy newValue capture stops before ".2 instead", so the
    // extracted value is 134 (NOT 134.2). Characterization pins reality.
    assert.equal(r.newValue, 134);
  });

  it("[5] 'change null to 5' → replace_value", async () => {
    const r = await parse("change null to 5");
    assert.equal(r.operation, "replace_value");
    assert.equal(r.oldValue, null);
    assert.equal(r.newValue, 5);
  });

  // ── STEP 0b: revert ─────────────────────────────────────────────────────────
  it("[6] 'revert to original' → revert", async () => {
    const r = await parse("revert to original");
    assert.equal(r.operation, "revert");
  });

  it("[7] 'restore original data' → revert", async () => {
    const r = await parse("restore original data");
    assert.equal(r.operation, "revert");
  });

  // ── STEP 0c: aggregate / pivot (high confidence, before remove/preview) ──────
  it("[8] 'aggregate sales, group by region order by sales DESC' → aggregate", async () => {
    const r = await parse("aggregate sales, group by region, order by sales DESC");
    assert.equal(r.operation, "aggregate");
    assert.equal(r.groupByColumn, "region");
    assert.deepEqual(r.aggColumns, ["sales"]);
    // Pinned: the orderBy direction regex captures 'asc' for this exact phrasing
    // (the direction token isn't picked up). Characterization pins reality.
    assert.equal(r.orderByDirection, "asc");
  });

  it("[9] 'aggregate RISK_VOLUME on DEPOT' → aggregate", async () => {
    const r = await parse("aggregate RISK_VOLUME on DEPOT");
    assert.equal(r.operation, "aggregate");
    assert.equal(r.groupByColumn, "DEPOT");
    assert.deepEqual(r.aggColumns, ["RISK_VOLUME"]);
  });

  it("[10] 'aggregate all columns by region using sum' → aggregate (auto cols)", async () => {
    const r = await parse("aggregate all the other columns by region using sum");
    assert.equal(r.operation, "aggregate");
    assert.equal(r.groupByColumn, "region");
    assert.equal(r.aggColumns, undefined);
    assert.equal(r.aggFunc, "sum");
  });

  it("[11] 'aggregate over region' → aggregate (auto cols)", async () => {
    const r = await parse("aggregate the whole data over region");
    assert.equal(r.operation, "aggregate");
    assert.equal(r.groupByColumn, "region");
    assert.equal(r.aggColumns, undefined);
  });

  it("[12] 'aggregate sales by region using avg' → aggregate w/ func", async () => {
    const r = await parse("aggregate sales by region using avg");
    assert.equal(r.operation, "aggregate");
    assert.equal(r.groupByColumn, "region");
    assert.deepEqual(r.aggColumns, ["sales"]);
    assert.equal(r.aggFunc, "avg");
  });

  it("[13] 'aggregate by Month column' → aggregate", async () => {
    const r = await parse("aggregate by Month column");
    assert.equal(r.operation, "aggregate");
    assert.equal(r.groupByColumn, "Month");
  });

  it("[14] 'create a pivot on Brand showing sales, region fields' → pivot", async () => {
    const r = await parse("create a pivot on Brand showing sales, region fields");
    assert.equal(r.operation, "pivot");
    assert.equal(r.pivotIndex, "Brand");
    assert.deepEqual(r.pivotValues, ["sales", "region"]);
  });

  it("[15] 'pivot table for region' → pivot (no explicit values)", async () => {
    const r = await parse("pivot table for region");
    assert.equal(r.operation, "pivot");
    assert.equal(r.pivotIndex, "region");
  });

  // ── remove_column high-confidence regex (before STEP-1 / STEP-2) ────────────
  it("[16] 'remove the column sales' → remove_column", async () => {
    const r = await parse("remove the column sales");
    assert.equal(r.operation, "remove_column");
    assert.equal(r.column, "sales");
    assert.equal(r.requiresClarification, false);
  });

  it("[17] 'drop column' (no column named) → remove_column needs clarification", async () => {
    const r = await parse("drop the column please");
    assert.equal(r.operation, "remove_column");
    assert.equal(r.requiresClarification, true);
    assert.equal(r.clarificationType, "column");
  });

  // ── remove_rows high-confidence regex (before STEP-1 / STEP-2) ──────────────
  it("[18] 'keep only the first 100 rows' → remove_rows keep_first", async () => {
    const r = await parse("keep only the first 100 rows");
    assert.equal(r.operation, "remove_rows");
    assert.equal(r.rowPosition, "keep_first");
    assert.equal(r.rowCount, 100);
  });

  it("[19] 'delete the last 5 rows' → remove_rows last/5 (count wins over plain last)", async () => {
    const r = await parse("delete the last 5 rows");
    assert.equal(r.operation, "remove_rows");
    assert.equal(r.rowPosition, "last");
    assert.equal(r.rowCount, 5);
  });

  it("[20] 'remove the first row' → remove_rows first (no count)", async () => {
    const r = await parse("remove the first row");
    assert.equal(r.operation, "remove_rows");
    assert.equal(r.rowPosition, "first");
    assert.equal(r.rowCount, undefined);
  });

  it("[21] 'delete row 3' → remove_rows rowIndex 3", async () => {
    const r = await parse("delete row 3");
    assert.equal(r.operation, "remove_rows");
    assert.equal(r.rowIndex, 3);
  });

  // ── STEP 2 regex chain ──────────────────────────────────────────────────────
  it("[22] 'fill null values with mean' → remove_nulls method=mean", async () => {
    const r = await parse("fill null values with mean");
    assert.equal(r.operation, "remove_nulls");
    assert.equal(r.method, "mean");
    assert.equal(r.requiresClarification, false);
  });

  it("[23] 'remove null values' → remove_nulls (clarification, method unset)", async () => {
    const r = await parse("remove null values");
    assert.equal(r.operation, "remove_nulls");
    assert.equal(r.requiresClarification, true);
  });

  it("[24] 'give me data preview of 10 rows' → preview first/10", async () => {
    const r = await parse("give me data preview of 10 rows");
    assert.equal(r.operation, "preview");
    assert.equal(r.previewMode, "first");
    assert.equal(r.limit, 10);
  });

  it("[25] 'show rows 12 to 28' → preview range", async () => {
    const r = await parse("show rows 12 to 28");
    assert.equal(r.operation, "preview");
    assert.equal(r.previewMode, "range");
    assert.equal(r.previewStartRow, 12);
    assert.equal(r.previewEndRow, 28);
  });

  it("[26] 'show last 5 rows' → preview last/5", async () => {
    const r = await parse("show last 5 rows");
    assert.equal(r.operation, "preview");
    assert.equal(r.previewMode, "last");
    assert.equal(r.limit, 5);
  });

  it("[27] ORDER-AMBIGUOUS 'show me the data summary' → preview (show+data block precedes summary block)", async () => {
    const r = await parse("show me the data summary");
    assert.equal(r.operation, "preview");
    assert.equal(r.previewMode, "first");
    assert.equal(r.limit, 50);
  });

  it("[28] 'how many nulls are there in sales' → count_nulls", async () => {
    const r = await parse("how many nulls are there in sales");
    assert.equal(r.operation, "count_nulls");
    assert.equal(r.column, "sales");
  });

  it("[29] 'how many rows' → describe", async () => {
    const r = await parse("how many rows are there");
    assert.equal(r.operation, "describe");
  });

  it("[30] 'give me the summary' → summary (no show+data interception)", async () => {
    const r = await parse("give me the summary");
    assert.equal(r.operation, "summary");
  });

  it("[31] 'describe the data' → describe", async () => {
    const r = await parse("describe the data");
    assert.equal(r.operation, "describe");
  });

  it("[32] 'create a new column Total = sales + sales' → create_derived_column", async () => {
    const r = await parse("create a new column Total = sales + sales");
    assert.equal(r.operation, "create_derived_column");
  });

  it("[33] 'add a new column Notes' → create_derived_column (verb 'add' is a derived trigger)", async () => {
    // Pinned: the derived-column branch fires whenever the message includes the
    // word "add" (a derived trigger), so "add a new column Notes" resolves to
    // create_derived_column, NOT create_column. Characterization pins reality.
    const r = await parse("add a new column Notes");
    assert.equal(r.operation, "create_derived_column");
  });

  it("[33b] 'create column status' → create_column (static, no derived tokens)", async () => {
    const r = await parse("create column status");
    assert.equal(r.operation, "create_column");
  });

  it("[34] 'normalize Emami 7 Oils TOM' → normalize_column (multi-word match)", async () => {
    const r = await parse("normalize Emami 7 Oils TOM");
    assert.equal(r.operation, "normalize_column");
    assert.equal(r.column, "Emami 7 Oils TOM");
  });

  it("[35] 'add row at the bottom' → add_row", async () => {
    const r = await parse("add row at the bottom");
    assert.equal(r.operation, "add_row");
  });

  it("[36] 'increase the sales column by 10' → modify_column add/10", async () => {
    const r = await parse("increase the sales column by 10");
    assert.equal(r.operation, "modify_column");
    assert.equal(r.column, "sales");
    assert.equal(r.transformType, "add");
    assert.equal(r.transformValue, 10);
  });

  it("[37] 'rename column sales to revenue' → rename_column", async () => {
    const r = await parse("rename column sales to revenue");
    assert.equal(r.operation, "rename_column");
    assert.equal(r.oldColumnName, "sales");
    assert.equal(r.newColumnName, "revenue");
  });

  it("[38] 'convert Dove nGRP Adstocked to string' → convert_type (multi-word)", async () => {
    const r = await parse("convert Dove nGRP Adstocked to string");
    assert.equal(r.operation, "convert_type");
    assert.equal(r.column, "Dove nGRP Adstocked");
    assert.equal(r.targetType, "string");
  });

  it("[39] 'how can we improve the model' → unknown (model advice, not train_model)", async () => {
    const r = await parse("how can we improve the model?");
    assert.equal(r.operation, "unknown");
  });

  it("[40] 'build a linear model' → train_model", async () => {
    const r = await parse("build a linear model");
    assert.equal(r.operation, "train_model");
  });

  it("[41] 'train a model' → train_model", async () => {
    const r = await parse("train a model on the data");
    assert.equal(r.operation, "train_model");
  });

  it("[42] gibberish → unknown (terminal fallthrough)", async () => {
    const r = await parse("hello there friend");
    assert.equal(r.operation, "unknown");
    assert.equal(r.requiresClarification, false);
  });
});
