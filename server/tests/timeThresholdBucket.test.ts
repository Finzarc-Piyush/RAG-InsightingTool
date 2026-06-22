// Wave H7 · one-step "on time vs late" split (time_threshold_bucket). Parses a
// clock or datetime column, compares to a HH:MM[:SS] cutoff, labels each row.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyAddComputedColumns } from "../lib/computedColumns.js";
import type { DataSummary } from "../shared/schema.js";

function summary(): DataSummary {
  return {
    rowCount: 5,
    columnCount: 2,
    columns: [
      {
        name: "Login Time",
        type: "text",
        sampleValues: [],
        timeOfDay: { sentinelValues: ["Absent"] },
      },
      { name: "Employee", type: "text", sampleValues: [] },
    ],
    numericColumns: [],
    dateColumns: [],
    categoricalColumns: ["Employee"],
  } as unknown as DataSummary;
}

describe("Wave H7 · time_threshold_bucket", () => {
  it('splits a time-of-day column into "On time" / "Late" at 09:30', () => {
    const rows = [
      { Employee: "A", "Login Time": "09:15:00" },
      { Employee: "B", "Login Time": "09:30:00" }, // exactly cutoff → on time
      { Employee: "C", "Login Time": "09:45:00" },
      { Employee: "D", "Login Time": "8:05:00" }, // single-digit hour
      { Employee: "E", "Login Time": "Absent" }, // sentinel → null
    ];
    const res = applyAddComputedColumns(rows, summary(), {
      columns: [
        {
          name: "Punctuality",
          def: {
            type: "time_threshold_bucket",
            column: "Login Time",
            threshold: "09:30",
            atOrBeforeLabel: "On time",
            afterLabel: "Late",
          },
        },
      ],
    });
    assert.ok(res.ok, res.ok ? "" : res.error);
    const got = res.rows.map((r) => r["Punctuality"]);
    assert.deepEqual(got, ["On time", "On time", "Late", "On time", null]);
  });

  it("also works on a datetime column (extracts the time part)", () => {
    const rows = [
      { Employee: "A", "Login Time": "2026-06-22 09:15:00" },
      { Employee: "B", "Login Time": "2026-06-22 10:00:00" },
    ];
    const res = applyAddComputedColumns(rows, summary(), {
      columns: [
        {
          name: "Punctuality",
          def: {
            type: "time_threshold_bucket",
            column: "Login Time",
            threshold: "09:30",
            atOrBeforeLabel: "On time",
            afterLabel: "Late",
          },
        },
      ],
    });
    assert.ok(res.ok, res.ok ? "" : res.error);
    assert.deepEqual(res.rows.map((r) => r["Punctuality"]), ["On time", "Late"]);
  });

  it("rejects an invalid threshold", () => {
    const res = applyAddComputedColumns([{ "Login Time": "09:00:00" }], summary(), {
      columns: [
        {
          name: "P",
          def: {
            type: "time_threshold_bucket",
            column: "Login Time",
            threshold: "9am",
            atOrBeforeLabel: "On time",
            afterLabel: "Late",
          },
        },
      ],
    });
    assert.equal(res.ok, false);
  });
});
