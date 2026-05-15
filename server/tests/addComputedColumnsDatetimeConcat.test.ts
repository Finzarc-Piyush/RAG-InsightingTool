/**
 * Wave SU-DT2 · datetime_concat tests for add_computed_columns.
 *
 * Pin the contract: combining a date column and a paired time-of-day column
 * yields a sortable ISO `YYYY-MM-DD HH:MM:SS` string, sentinel rows collapse
 * to NULL, malformed rows collapse to NULL, the new column appears on the
 * DataSummary as a text column, and the planner-side validator accepts the
 * new def shape.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addComputedColumnsArgsSchema,
  applyAddComputedColumns,
  registerComputedColumnsOnSummary,
} from "../lib/computedColumns.js";
import type { DataSummary } from "../shared/schema.js";

function makeSummary(): DataSummary {
  return {
    rowCount: 4,
    columnCount: 2,
    columns: [
      { name: "Day · Date", type: "date", sampleValues: [] },
      {
        name: "Clock-In Time",
        type: "text",
        sampleValues: [],
        timeOfDay: { sentinelValues: ["Absent", "N/A"] },
      },
    ],
    numericColumns: [],
    dateColumns: ["Day · Date"],
  };
}

const baseRows = [
  { "Day · Date": "2024-04-30", "Clock-In Time": "09:45:34" },
  { "Day · Date": "2024-05-01", "Clock-In Time": "10:05:45" },
  { "Day · Date": "2024-05-02", "Clock-In Time": "Absent" },
  { "Day · Date": "2024-05-03", "Clock-In Time": "" },
];

describe("Wave SU-DT2 · add_computed_columns datetime_concat", () => {
  describe("schema", () => {
    it("accepts a datetime_concat def with dateColumn + timeColumn", () => {
      const parsed = addComputedColumnsArgsSchema.safeParse({
        columns: [
          {
            name: "Clock-In DateTime",
            def: {
              type: "datetime_concat",
              dateColumn: "Day · Date",
              timeColumn: "Clock-In Time",
            },
          },
        ],
      });
      assert.equal(parsed.success, true);
    });

    it("rejects a datetime_concat def missing required fields", () => {
      const parsed = addComputedColumnsArgsSchema.safeParse({
        columns: [
          {
            name: "Bad",
            def: { type: "datetime_concat", dateColumn: "X" },
          },
        ],
      });
      assert.equal(parsed.success, false);
    });
  });

  describe("apply", () => {
    it("emits sortable ISO strings, NULLs sentinels and malformed rows", () => {
      const summary = makeSummary();
      const result = applyAddComputedColumns(baseRows, summary, {
        columns: [
          {
            name: "Clock-In DateTime",
            def: {
              type: "datetime_concat",
              dateColumn: "Day · Date",
              timeColumn: "Clock-In Time",
            },
          },
        ],
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.rows.length, 4);
      assert.equal(result.rows[0]["Clock-In DateTime"], "2024-04-30 09:45:34");
      assert.equal(result.rows[1]["Clock-In DateTime"], "2024-05-01 10:05:45");
      assert.equal(result.rows[2]["Clock-In DateTime"], null); // sentinel
      assert.equal(result.rows[3]["Clock-In DateTime"], null); // empty
      // Sortability check: ISO format compares correctly lexicographically.
      const ordered = result.rows
        .map((r) => r["Clock-In DateTime"])
        .filter((v): v is string => typeof v === "string")
        .slice()
        .sort();
      assert.deepEqual(ordered, [
        "2024-04-30 09:45:34",
        "2024-05-01 10:05:45",
      ]);
    });

    it("normalises HH:MM and HH:MM:SS time strings consistently", () => {
      const summary = makeSummary();
      const rows = [
        { "Day · Date": "2024-04-30", "Clock-In Time": "9:45" },
        { "Day · Date": "2024-04-30", "Clock-In Time": "09:45:00" },
      ];
      const result = applyAddComputedColumns(rows, summary, {
        columns: [
          {
            name: "DT",
            def: {
              type: "datetime_concat",
              dateColumn: "Day · Date",
              timeColumn: "Clock-In Time",
            },
          },
        ],
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.rows[0]["DT"], "2024-04-30 09:45:00");
      assert.equal(result.rows[1]["DT"], "2024-04-30 09:45:00");
    });

    it("rejects when a referenced column isn't in the schema", () => {
      const summary = makeSummary();
      const result = applyAddComputedColumns(baseRows, summary, {
        columns: [
          {
            name: "DT",
            def: {
              type: "datetime_concat",
              dateColumn: "Missing",
              timeColumn: "Clock-In Time",
            },
          },
        ],
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /Column not in schema: Missing/);
    });

    it("returns failure when every row produces null on a non-trivial dataset", () => {
      const summary = makeSummary();
      const rows: Record<string, unknown>[] = [];
      // 12 rows of all-sentinel — guards the silent-parse-failure path.
      for (let i = 0; i < 12; i++) {
        rows.push({ "Day · Date": "2024-04-30", "Clock-In Time": "Absent" });
      }
      const result = applyAddComputedColumns(rows, summary, {
        columns: [
          {
            name: "DT",
            def: {
              type: "datetime_concat",
              dateColumn: "Day · Date",
              timeColumn: "Clock-In Time",
            },
          },
        ],
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(
        result.error,
        /produced null for every row/
      );
    });

    it("counts non-null rows correctly when sentinels are mixed in", () => {
      const summary = makeSummary();
      const result = applyAddComputedColumns(baseRows, summary, {
        columns: [
          {
            name: "DT",
            def: {
              type: "datetime_concat",
              dateColumn: "Day · Date",
              timeColumn: "Clock-In Time",
            },
          },
        ],
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.nonNull[0].name, "DT");
      assert.equal(result.nonNull[0].nonNull, 2);
      assert.equal(result.nonNull[0].total, 4);
    });
  });

  describe("registerComputedColumnsOnSummary", () => {
    it("adds the new column as text with sample values, NOT to dateColumns", () => {
      const summary = makeSummary();
      const args = {
        columns: [
          {
            name: "DT",
            def: {
              type: "datetime_concat" as const,
              dateColumn: "Day · Date",
              timeColumn: "Clock-In Time",
            },
          },
        ],
      };
      const result = applyAddComputedColumns(baseRows, summary, args);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      registerComputedColumnsOnSummary(summary, args, result.rows);
      const newCol = summary.columns.find((c) => c.name === "DT");
      assert.ok(newCol, "new column should be registered");
      assert.equal(newCol?.type, "text");
      assert.ok(
        Array.isArray(newCol?.sampleValues) && newCol!.sampleValues.length > 0,
        "sample values should be populated from non-null rows"
      );
      // Intentionally NOT in dateColumns — keeps temporal-facet auto-gen
      // from re-polluting the schema with derived buckets.
      assert.equal(summary.dateColumns.includes("DT"), false);
      assert.equal(summary.numericColumns.includes("DT"), false);
    });
  });
});
