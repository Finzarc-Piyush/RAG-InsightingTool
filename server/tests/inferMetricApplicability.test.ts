/**
 * W4 · valid-measurement-universe inference. A boolean metric is only
 * applicable in its planned-context rows; off-day/absent rows are structural
 * zeros. The gate is chosen by name-affinity + plan/type hint (NOT an outcome
 * column like Attendance), with a safe no-scope fallback.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  inferMetricApplicability,
  applyMetricApplicabilityToSummary,
} from "../lib/inferMetricApplicability.js";
import type { DataSummary } from "../shared/schema.js";

// Mirror the Marico cross-tab: "Yes" only on PJP Planned Type = Market Working;
// Attendance also has "Yes" only in one value (Present) — the over-gate trap.
function maricoRows(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const push = (n: number, pt: string, ad: string, att: string) => {
    for (let i = 0; i < n; i++) rows.push({ "PJP Planned Type": pt, "PJP Adherence": ad, "Attendance Status": att });
  };
  push(2102, "Market Working", "Yes", "Present");
  push(4170, "Market Working", "No", "Absent");
  push(979, "Weekly Off", "No", "WO/H");
  push(438, "Leave", "No", "Leave");
  push(628, "No PJP Available", "No PJP Available", "PJP Error");
  push(618, "Distributor Visit", "No", "Present");
  return rows;
}

function summaryFor(rows: Record<string, unknown>[]): DataSummary {
  return {
    rowCount: rows.length,
    columnCount: 3,
    columns: [
      { name: "PJP Planned Type", type: "string", sampleValues: [] },
      {
        name: "PJP Adherence",
        type: "string",
        sampleValues: [],
        indicator: { kind: "boolean", positiveValues: ["Yes"], negativeValues: ["No"], sentinelValues: ["No PJP Available"], source: "auto" },
      },
      { name: "Attendance Status", type: "string", sampleValues: [] },
    ],
    numericColumns: [],
    dateColumns: [],
  } as unknown as DataSummary;
}

describe("W4 · inferMetricApplicability", () => {
  it("gates PJP Adherence on PJP Planned Type = Market Working (name-affinity), NOT Attendance", () => {
    const rows = maricoRows();
    const gates = inferMetricApplicability(summaryFor(rows), rows);
    const g = gates.get("PJP Adherence");
    assert.ok(g, "expected an applicability gate for PJP Adherence");
    assert.equal(g![0].gateColumn, "PJP Planned Type");
    assert.deepEqual(g![0].inScopeValues, ["Market Working"]);
  });

  it("stamps applicabilityScope onto the indicator metadata", () => {
    const rows = maricoRows();
    const summary = summaryFor(rows);
    applyMetricApplicabilityToSummary(summary, inferMetricApplicability(summary, rows));
    const col = summary.columns.find((c) => c.name === "PJP Adherence");
    const scope = (col!.indicator as { applicabilityScope?: { gateColumn: string }[] }).applicabilityScope;
    assert.equal(scope?.[0].gateColumn, "PJP Planned Type");
  });

  it("no gate when there is no name-affine / plan-typed concentrating column (safe fallback)", () => {
    // Metric concentrates only in an outcome-named column → no signal → no scope.
    const rows = maricoRows().map((r) => ({ Region: (r as any)["Attendance Status"], Flag: (r as any)["PJP Adherence"] }));
    const summary = {
      rowCount: rows.length, columnCount: 2,
      columns: [
        { name: "Region", type: "string", sampleValues: [] },
        { name: "Flag", type: "string", sampleValues: [], indicator: { kind: "boolean", positiveValues: ["Yes"], negativeValues: ["No"], source: "auto" } },
      ],
      numericColumns: [], dateColumns: [],
    } as unknown as DataSummary;
    // "Region" shares no token with "Flag" and isn't plan/type-named → no gate.
    assert.equal(inferMetricApplicability(summary, rows).size, 0);
  });

  it("is a no-op on empty rows", () => {
    assert.equal(inferMetricApplicability(summaryFor([]), []).size, 0);
  });
});
