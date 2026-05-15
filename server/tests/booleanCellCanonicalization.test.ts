/**
 * Wave SU-FU1 · boolean canonicalization tests.
 *
 * Pin the contract: booleans (native bool from CSV `cast: true`, OR
 * pre-stringified "TRUE"/"FALSE" / "true"/"false" from XLSX `raw: false`)
 * are coerced to "Yes"/"No" strings at parse time so the planner's PCT1
 * predicate matches the actual stored values. Pre-fix, the agent emitted
 * `predicate.values: ["Yes"]` (from the prompt's worked example) but the
 * actual stored values were "TRUE"/"FALSE" — predicate matched zero rows
 * and the agent answered "0 of 0 clocked in before 9:30".
 *
 * Also pin: `resolveApprovedDateColumns` refuses time-of-day columns
 * even when the LLM dataset profile mistakenly labels them as dates,
 * and `applyTemporalFacetColumns` honours an explicit exclusion set.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseFile,
  resolveApprovedDateColumns,
} from "../lib/fileParser.js";
import { applyTemporalFacetColumns } from "../lib/temporalFacetColumns.js";
import * as XLSX from "xlsx";

function buildXlsxBufferWithBooleanCells(): Buffer {
  // Construct a workbook whose "Clock-In <09:30" column contains native
  // Excel boolean cells (cell type 'b'). Pairs with HH:MM:SS time strings
  // so the time-of-day classifier picks up the time column.
  const ws = XLSX.utils.aoa_to_sheet([
    ["TSO_TSE Name", "Clock-In Time", "Clock-In <09:30"],
    ["Alice", "09:18:57", true],
    ["Bob", "09:45:34", false],
    ["Charlie", "Absent", "Absent"],
    ["Dave", "10:05:00", false],
    ["Eve", "08:55:00", true],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("Wave SU-FU1 · boolean cell canonicalization at parse time", () => {
  it("converts XLSX native booleans to Yes/No strings", async () => {
    const buf = buildXlsxBufferWithBooleanCells();
    const rows = await parseFile(buf, "fixture.xlsx");
    assert.equal(rows.length, 5);
    assert.equal(rows[0]["Clock-In <09:30"], "Yes");
    assert.equal(rows[1]["Clock-In <09:30"], "No");
    assert.equal(rows[2]["Clock-In <09:30"], "Absent");
    assert.equal(rows[3]["Clock-In <09:30"], "No");
    assert.equal(rows[4]["Clock-In <09:30"], "Yes");
  });

  it("preserves the time column verbatim (not booleanised)", async () => {
    const buf = buildXlsxBufferWithBooleanCells();
    const rows = await parseFile(buf, "fixture.xlsx");
    assert.equal(rows[0]["Clock-In Time"], "09:18:57");
    assert.equal(rows[1]["Clock-In Time"], "09:45:34");
    assert.equal(rows[2]["Clock-In Time"], "Absent");
  });

  it("normalises pre-stringified TRUE/FALSE (case-insensitive)", async () => {
    // CSV path with raw "TRUE"/"FALSE" / "true"/"false" strings — these
    // arrive as strings (csv-parse `cast: true` may yield bools, but
    // upstream tools / paste-jobs commonly keep them as strings).
    const csv = [
      "Name,Flag",
      "Alice,TRUE",
      "Bob,FALSE",
      "Charlie,true",
      "Dave,False",
      "Eve,Absent",
    ].join("\n");
    const rows = await parseFile(Buffer.from(csv, "utf-8"), "fixture.csv");
    assert.equal(rows[0]["Flag"], "Yes");
    assert.equal(rows[1]["Flag"], "No");
    assert.equal(rows[2]["Flag"], "Yes");
    assert.equal(rows[3]["Flag"], "No");
    assert.equal(rows[4]["Flag"], "Absent");
  });

  it("does NOT boolean-coerce longer strings that happen to start with true/false", async () => {
    // Defensive: only exact "TRUE"/"FALSE" (≤ 5 chars) get normalised.
    // Strings like "True positive" or "false alarm" must pass through.
    const csv = [
      "Note",
      "True positive",
      "false alarm",
      "TRUEISH",
    ].join("\n");
    const rows = await parseFile(Buffer.from(csv, "utf-8"), "fixture.csv");
    assert.equal(rows[0]["Note"], "True positive");
    assert.equal(rows[1]["Note"], "false alarm");
    assert.equal(rows[2]["Note"], "TRUEISH");
  });
});

describe("Wave SU-FU1 · time-of-day columns excluded from date approval", () => {
  it("refuses to approve a time-only column the LLM labelled as a date", () => {
    // Simulate the failure mode: LLM dataset profile sees "Clock-In Time"
    // and (because the name contains "time") emits it in dateColumns.
    // Pre-fix, the column would be approved and `applyTemporalFacetColumns`
    // would generate empty Day/Week/Month facets. Post-fix, the
    // time-of-day classifier vetoes the approval. Need ≥ 5 non-sentinel
    // samples for the classifier to make a confident verdict.
    const data: Record<string, unknown>[] = [];
    const times = [
      "09:18:57",
      "09:45:34",
      "10:05:00",
      "08:55:00",
      "11:23:01",
      "07:10:42",
      "Absent",
      "09:30:15",
    ];
    for (const t of times) data.push({ "Clock-In Time": t });
    const profile = {
      shortDescription: "test",
      dateColumns: ["Clock-In Time"],
      suggestedQuestions: [],
    };
    const approved = resolveApprovedDateColumns(data, profile);
    assert.deepEqual(approved, []);
  });

  it("still approves a real date column the LLM labelled correctly", () => {
    const data = [
      { "Order Date": "2024-04-30" },
      { "Order Date": "2024-05-01" },
      { "Order Date": "2024-05-02" },
    ];
    const profile = {
      shortDescription: "test",
      dateColumns: ["Order Date"],
      suggestedQuestions: [],
    };
    const approved = resolveApprovedDateColumns(data, profile);
    assert.deepEqual(approved, ["Order Date"]);
  });
});

describe("Wave SU-FU1 · applyTemporalFacetColumns honours TOD exclusion set", () => {
  it("skips facet generation for excluded (time-of-day) columns", () => {
    // Stale-session safety: if `dateColumns` already includes a TOD column
    // (uploaded before the source-side filter landed), the caller can pass
    // an exclusion set and the function will skip those columns from
    // facet generation.
    const data: Record<string, unknown>[] = [
      { "Clock-In Time": "09:18:57", "Order Date": "2024-04-30" },
      { "Clock-In Time": "09:45:34", "Order Date": "2024-05-01" },
    ];
    const meta = applyTemporalFacetColumns(
      data as Record<string, any>[],
      ["Clock-In Time", "Order Date"],
      { excludeTimeOfDayColumns: new Set(["Clock-In Time"]) }
    );
    // Only Order Date facets emitted.
    assert.ok(meta.some((m) => m.sourceColumn === "Order Date"));
    assert.ok(!meta.some((m) => m.sourceColumn === "Clock-In Time"));
    // Row keys: facets exist for Order Date, NOT for Clock-In Time.
    assert.ok("Day · Order Date" in data[0]);
    assert.equal("Day · Clock-In Time" in data[0], false);
  });

  it("returns empty when every dateColumn is excluded", () => {
    const data: Record<string, unknown>[] = [
      { "Clock-In Time": "09:18:57" },
    ];
    const meta = applyTemporalFacetColumns(
      data as Record<string, any>[],
      ["Clock-In Time"],
      { excludeTimeOfDayColumns: new Set(["Clock-In Time"]) }
    );
    assert.deepEqual(meta, []);
    assert.equal("Day · Clock-In Time" in data[0], false);
  });

  it("preserves backwards-compatible behaviour when no exclusion set is provided", () => {
    const data: Record<string, unknown>[] = [
      { "Order Date": "2024-04-30" },
      { "Order Date": "2024-05-01" },
    ];
    const meta = applyTemporalFacetColumns(
      data as Record<string, any>[],
      ["Order Date"]
    );
    assert.ok(meta.some((m) => m.sourceColumn === "Order Date"));
    assert.ok("Day · Order Date" in data[0]);
  });
});
