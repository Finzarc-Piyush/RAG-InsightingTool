/**
 * Characterization test for the dataOps per-operation handler extraction
 * (ARCH-2 / CQ-2). Pins the exact shape + values returned for the network-free,
 * read-only operations whose switch branches were moved into
 * `lib/dataOps/handlers/*`:
 *   - count_nulls  → handlers/countNulls.ts
 *   - describe     → handlers/describe.ts
 *
 * Asserted BOTH through the public `executeDataOperation` dispatch (so the
 * switch wiring is covered) AND against the extracted handlers directly (so the
 * pure move is pinned). These ops never touch persistence / the Python service
 * / Cosmos, so the test is deterministic and runs offline.
 *
 * Also pins the pure intent helpers moved into `lib/dataOps/intent/*`:
 *   - isCorrelationRequest               → intent/isCorrelationRequest.ts
 *   - userRequestedPreview               → intent/userRequestedPreview.ts
 *   - isDataModificationOperation        → intent/isDataModificationOperation.ts
 *   - translateLegacyFilterToActiveFilter→ intent/translateLegacyFilterToActiveFilter.ts
 * Each is asserted via its re-export from `dataOpsOrchestrator.js` (the public
 * surface internal call sites use) AND via a re-export identity (===) check
 * against the source module, so the move stays a pure code-motion.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  executeDataOperation,
  handleCountNulls,
  handleDescribe,
  isCorrelationRequest,
  userRequestedPreview,
  isDataModificationOperation,
  translateLegacyFilterToActiveFilter,
  type DataOpsIntent,
} from "../lib/dataOps/dataOpsOrchestrator.js";
import { isCorrelationRequest as isCorrelationRequestSrc } from "../lib/dataOps/intent/isCorrelationRequest.js";
import { userRequestedPreview as userRequestedPreviewSrc } from "../lib/dataOps/intent/userRequestedPreview.js";
import { isDataModificationOperation as isDataModificationOperationSrc } from "../lib/dataOps/intent/isDataModificationOperation.js";
import { translateLegacyFilterToActiveFilter as translateLegacyFilterToActiveFilterSrc } from "../lib/dataOps/intent/translateLegacyFilterToActiveFilter.js";
import type { DataRow } from "../lib/dataOps/dataOpsTypes.js";

const fixture: DataRow[] = [
  { region: "North", sales: 100, notes: "ok" },
  { region: "South", sales: null, notes: "" },
  { region: "North", sales: 200, notes: null },
  { region: "", sales: 50, notes: "fine" },
];

const SESSION_ID = "char-test-session";

describe("dataOps executeDataOperation — count_nulls characterization", () => {
  it("counts nulls in a specific column with stable wording", async () => {
    const intent: DataOpsIntent = {
      operation: "count_nulls",
      column: "sales",
      requiresClarification: false,
    };
    const result = await executeDataOperation(intent, fixture, SESSION_ID);
    // sales has exactly one null (row 2); '' is not counted for a numeric col here
    assert.equal(
      result.answer,
      'There are 1 null/missing values in the "sales" column out of 4 total rows.'
    );
    assert.equal(result.data, undefined);
    assert.equal(result.preview, undefined);
    assert.equal(result.saved, undefined);
  });

  it("counts nulls across all columns and lists offending columns", async () => {
    const intent: DataOpsIntent = {
      operation: "count_nulls",
      requiresClarification: false,
    };
    const result = await executeDataOperation(intent, fixture, SESSION_ID);
    // region: 1 ('' empty), sales: 1 (null), notes: 2 ('' + null) => 4 total across 3 cols
    assert.match(
      result.answer,
      /There are 4 null\/missing value\(s\) in your dataset across 3 column\(s\) out of 3 total columns\./
    );
    assert.match(result.answer, /notes: 2 nulls/);
    assert.match(result.answer, /Total rows: 4/);
  });

  it("dispatch matches the extracted handler exactly", async () => {
    const intent: DataOpsIntent = {
      operation: "count_nulls",
      column: "sales",
      requiresClarification: false,
    };
    const viaDispatch = await executeDataOperation(intent, fixture, SESSION_ID);
    const viaHandler = handleCountNulls({ data: fixture, column: "sales" });
    assert.deepEqual(viaDispatch, viaHandler);
  });
});

describe("dataOps executeDataOperation — describe characterization", () => {
  it("describes rows/columns/types/nulls with stable wording", async () => {
    const intent: DataOpsIntent = {
      operation: "describe",
      requiresClarification: false,
    };
    const result = await executeDataOperation(intent, fixture, SESSION_ID);
    assert.match(result.answer, /\*\*4 rows\*\* of data/);
    assert.match(result.answer, /\*\*3 columns\*\*: 1 numeric, 2 text, 0 date/);
    assert.match(result.answer, /\*\*4 null\/missing values\*\* across 3 column\(s\)/);
    assert.match(result.answer, /Column names: region, sales, notes/);
  });

  it("dispatch matches the extracted handler exactly", async () => {
    const intent: DataOpsIntent = {
      operation: "describe",
      requiresClarification: false,
    };
    const viaDispatch = await executeDataOperation(intent, fixture, SESSION_ID);
    const viaHandler = handleDescribe({ data: fixture });
    assert.deepEqual(viaDispatch, viaHandler);
  });
});

describe("dataOps intent helpers — extraction characterization", () => {
  it("re-exports are identical (===) to the source intent modules", () => {
    assert.equal(isCorrelationRequest, isCorrelationRequestSrc);
    assert.equal(userRequestedPreview, userRequestedPreviewSrc);
    assert.equal(isDataModificationOperation, isDataModificationOperationSrc);
    assert.equal(
      translateLegacyFilterToActiveFilter,
      translateLegacyFilterToActiveFilterSrc
    );
  });

  it("isCorrelationRequest classifies correlation phrasing, not aggregation", () => {
    assert.equal(isCorrelationRequest("correlation between sales and spend"), true);
    assert.equal(isCorrelationRequest("correlate volume with price"), true);
    assert.equal(isCorrelationRequest("what affects sales"), true);
    assert.equal(isCorrelationRequest("relationship between A and B"), true);
    // Aggregation / preview asks must NOT be flagged as correlation.
    assert.equal(isCorrelationRequest("aggregate sales by region"), false);
    assert.equal(isCorrelationRequest("show me the first 10 rows"), false);
  });

  it("userRequestedPreview detects explicit show/preview asks only", () => {
    assert.equal(userRequestedPreview(undefined), false);
    assert.equal(userRequestedPreview("show me the data"), true);
    assert.equal(userRequestedPreview("give me a preview"), true);
    assert.equal(userRequestedPreview("display the dataset"), true);
    assert.equal(userRequestedPreview("view the data"), true);
    assert.equal(userRequestedPreview("aggregate sales by region"), false);
  });

  it("isDataModificationOperation flags mutating ops and not read-only ones", () => {
    assert.equal(isDataModificationOperation("remove_column"), true);
    assert.equal(isDataModificationOperation("convert_type"), true);
    assert.equal(isDataModificationOperation("aggregate"), true);
    assert.equal(isDataModificationOperation("revert"), true);
    // Read-only / lookup ops should not auto-show a preview.
    assert.equal(isDataModificationOperation("count_nulls"), false);
    assert.equal(isDataModificationOperation("describe"), false);
    assert.equal(isDataModificationOperation("summary"), false);
    assert.equal(isDataModificationOperation("preview"), false);
    assert.equal(isDataModificationOperation("identify_outliers"), false);
  });

  it("translateLegacyFilterToActiveFilter maps modelable operators", () => {
    assert.deepEqual(
      translateLegacyFilterToActiveFilter([
        { column: "region", operator: "=", value: "North" },
      ]),
      { ok: true, conditions: [{ kind: "in", column: "region", values: ["North"] }] }
    );
    assert.deepEqual(
      translateLegacyFilterToActiveFilter([
        { column: "region", operator: "in", values: ["North", "South"] },
      ]),
      {
        ok: true,
        conditions: [{ kind: "in", column: "region", values: ["North", "South"] }],
      }
    );
    assert.deepEqual(
      translateLegacyFilterToActiveFilter([
        { column: "sales", operator: ">=", value: 100 },
      ]),
      { ok: true, conditions: [{ kind: "range", column: "sales", min: 100 }] }
    );
    assert.deepEqual(
      translateLegacyFilterToActiveFilter([
        { column: "sales", operator: "between", value: 10, value2: 20 },
      ]),
      { ok: true, conditions: [{ kind: "range", column: "sales", min: 10, max: 20 }] }
    );
    assert.deepEqual(
      translateLegacyFilterToActiveFilter([
        { column: "date", operator: "between", value: "2026-01-01", value2: "2026-02-01" },
      ]),
      {
        ok: true,
        conditions: [
          { kind: "dateRange", column: "date", from: "2026-01-01", to: "2026-02-01" },
        ],
      }
    );
  });

  it("translateLegacyFilterToActiveFilter falls back for non-modelable operators", () => {
    assert.deepEqual(
      translateLegacyFilterToActiveFilter([
        { column: "region", operator: "contains", value: "or" },
      ]),
      { ok: false, reason: "operator 'contains' not representable as active filter" }
    );
    assert.deepEqual(
      translateLegacyFilterToActiveFilter([
        { column: "", operator: "=", value: "x" },
      ]),
      { ok: false, reason: "missing column" }
    );
  });
});
