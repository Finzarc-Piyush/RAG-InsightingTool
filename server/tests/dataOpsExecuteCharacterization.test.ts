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
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  executeDataOperation,
  handleCountNulls,
  handleDescribe,
  type DataOpsIntent,
} from "../lib/dataOps/dataOpsOrchestrator.js";
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
