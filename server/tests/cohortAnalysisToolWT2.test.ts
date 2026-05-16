import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runCohortAnalysis,
  cohortAnalysisArgsSchema,
  type CohortAnalysisArgs,
} from "../lib/agents/runtime/tools/cohortAnalysisTool.js";

const fullArgs = (overrides: Partial<CohortAnalysisArgs> = {}): CohortAnalysisArgs => ({
  entityColumn: "customer_id",
  periodColumn: "month",
  cohortColumn: undefined,
  metricColumn: undefined,
  aggregation: "count_distinct",
  maxPeriods: 6,
  retentionMode: false,
  dimensionFilters: undefined,
  ...overrides,
});

describe("WT2 · run_cohort_analysis — acquisition cohort (cohortColumn omitted)", () => {
  it("uses each entity's earliest period as its cohort label", () => {
    const rows = [
      // customer 1 first seen in 2024-01, returns in 2024-02 + 2024-03
      { customer_id: "c1", month: "2024-01" },
      { customer_id: "c1", month: "2024-02" },
      { customer_id: "c1", month: "2024-03" },
      // customer 2 first seen in 2024-01, returns in 2024-03
      { customer_id: "c2", month: "2024-01" },
      { customer_id: "c2", month: "2024-03" },
      // customer 3 first seen in 2024-02, returns in 2024-03
      { customer_id: "c3", month: "2024-02" },
      { customer_id: "c3", month: "2024-03" },
    ];
    const result = runCohortAnalysis(rows, fullArgs({ maxPeriods: 4 }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    assert.equal(tableRows.length, 2, "2 cohorts: 2024-01 + 2024-02");

    const c1 = tableRows.find((r) => r.cohort === "2024-01")!;
    assert.equal(c1.cohort_size, 2, "c1 + c2 acquired in 2024-01");
    assert.equal(c1.period_offset_0, 2);
    assert.equal(c1.period_offset_1, 1, "only c1 active in offset 1 (2024-02)");
    assert.equal(c1.period_offset_2, 2, "c1 + c2 active in offset 2 (2024-03)");

    const c2 = tableRows.find((r) => r.cohort === "2024-02")!;
    assert.equal(c2.cohort_size, 1, "c3 acquired in 2024-02");
    assert.equal(c2.period_offset_0, 1);
    assert.equal(c2.period_offset_1, 1);
  });

  it("emits cohorts sorted lexicographically", () => {
    const rows = [
      { customer_id: "a", month: "2024-03" },
      { customer_id: "b", month: "2024-01" },
      { customer_id: "c", month: "2024-02" },
    ];
    const result = runCohortAnalysis(rows, fullArgs({ maxPeriods: 4 }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    assert.deepEqual(
      tableRows.map((r) => r.cohort),
      ["2024-01", "2024-02", "2024-03"],
    );
  });
});

describe("WT2 · run_cohort_analysis — explicit cohortColumn", () => {
  it("uses cohortColumn as the cohort label", () => {
    const rows = [
      { customer_id: "c1", signup_month: "2024-01", month: "2024-01", revenue: 100 },
      { customer_id: "c1", signup_month: "2024-01", month: "2024-02", revenue: 150 },
      { customer_id: "c2", signup_month: "2024-01", month: "2024-01", revenue: 50 },
      { customer_id: "c3", signup_month: "2024-02", month: "2024-02", revenue: 200 },
    ];
    const result = runCohortAnalysis(
      rows,
      fullArgs({
        cohortColumn: "signup_month",
        metricColumn: "revenue",
        aggregation: "sum",
        maxPeriods: 4,
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    const c1 = tableRows.find((r) => r.cohort === "2024-01")!;
    assert.equal(c1.period_offset_0, 150, "c1@2024-01 + c2@2024-01 = 100+50");
    assert.equal(c1.period_offset_1, 150, "c1@2024-02");
  });
});

describe("WT2 · run_cohort_analysis — aggregation modes", () => {
  it("aggregation='sum' sums the metric column per cell", () => {
    const rows = [
      { customer_id: "c1", month: "2024-01", revenue: 100 },
      { customer_id: "c1", month: "2024-02", revenue: 200 },
      { customer_id: "c2", month: "2024-01", revenue: 50 },
      { customer_id: "c2", month: "2024-02", revenue: 75 },
    ];
    const result = runCohortAnalysis(
      rows,
      fullArgs({ metricColumn: "revenue", aggregation: "sum", maxPeriods: 3 }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    const cohort = tableRows[0];
    assert.equal(cohort.period_offset_0, 150);
    assert.equal(cohort.period_offset_1, 275);
  });

  it("aggregation='mean' averages the metric column per cell", () => {
    const rows = [
      { customer_id: "c1", month: "2024-01", revenue: 100 },
      { customer_id: "c2", month: "2024-01", revenue: 200 },
      { customer_id: "c1", month: "2024-02", revenue: 50 },
    ];
    const result = runCohortAnalysis(
      rows,
      fullArgs({ metricColumn: "revenue", aggregation: "mean", maxPeriods: 3 }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    const cohort = tableRows[0];
    assert.equal(cohort.period_offset_0, 150);
    assert.equal(cohort.period_offset_1, 50);
  });

  it("count_distinct dedupes rows from the same entity in a cell", () => {
    const rows = [
      { customer_id: "c1", month: "2024-01" },
      { customer_id: "c1", month: "2024-01" }, // duplicate row for c1
      { customer_id: "c2", month: "2024-01" },
    ];
    const result = runCohortAnalysis(rows, fullArgs({ maxPeriods: 2 }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    assert.equal(tableRows[0].period_offset_0, 2, "distinct = c1, c2");
  });
});

describe("WT2 · run_cohort_analysis — retention mode", () => {
  it("retentionMode divides every cell by period_offset_0", () => {
    const rows = [
      { customer_id: "c1", month: "2024-01" },
      { customer_id: "c1", month: "2024-02" },
      { customer_id: "c2", month: "2024-01" },
      { customer_id: "c3", month: "2024-01" },
      { customer_id: "c3", month: "2024-02" },
    ];
    const result = runCohortAnalysis(
      rows,
      fullArgs({ retentionMode: true, maxPeriods: 3 }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    const cohort = tableRows[0];
    assert.equal(cohort.period_offset_0, 1, "base normalised to 1.0");
    // 2 of 3 still active in offset_1 = 2/3
    assert.equal(
      Math.round((cohort.period_offset_1 as number) * 1000) / 1000,
      Math.round((2 / 3) * 1000) / 1000,
    );
  });

  it("retentionMode emits 0 when baseValue is 0", () => {
    // Construct a case where the first period has no metric values.
    const rows = [
      { customer_id: "c1", month: "2024-01", revenue: null },
      { customer_id: "c1", month: "2024-02", revenue: 100 },
    ];
    const result = runCohortAnalysis(
      rows,
      fullArgs({
        metricColumn: "revenue",
        aggregation: "sum",
        retentionMode: true,
        maxPeriods: 3,
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    assert.equal(tableRows[0].period_offset_0, 0);
    assert.equal(tableRows[0].period_offset_1, 0, "no normalisation possible");
  });
});

describe("WT2 · run_cohort_analysis — period offset bounds", () => {
  it("maxPeriods caps the number of offset columns", () => {
    const rows = [{ customer_id: "c1", month: "2024-01" }];
    const result = runCohortAnalysis(rows, fullArgs({ maxPeriods: 4 }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.table.columns, [
      "cohort",
      "cohort_size",
      "period_offset_0",
      "period_offset_1",
      "period_offset_2",
      "period_offset_3",
    ]);
  });

  it("ignores rows whose offset exceeds maxPeriods", () => {
    const rows = [
      { customer_id: "c1", month: "2024-01" },
      { customer_id: "c1", month: "2024-02" },
      { customer_id: "c1", month: "2024-03" },
      { customer_id: "c1", month: "2024-04" }, // offset 3, excluded if maxPeriods=3
    ];
    const result = runCohortAnalysis(rows, fullArgs({ maxPeriods: 3 }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    assert.equal(tableRows[0].period_offset_2, 1);
    // period_offset_3 column does not exist
    assert.equal(tableRows[0].period_offset_3, undefined);
  });
});

describe("WT2 · run_cohort_analysis — dimension filters", () => {
  it("applies dimensionFilters before bucketing", () => {
    const rows = [
      { customer_id: "c1", month: "2024-01", region: "North" },
      { customer_id: "c2", month: "2024-01", region: "South" },
      { customer_id: "c3", month: "2024-01", region: "North" },
    ];
    const result = runCohortAnalysis(
      rows,
      fullArgs({
        maxPeriods: 2,
        dimensionFilters: [{ column: "region", op: "in", values: ["North"] }],
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    assert.equal(tableRows[0].period_offset_0, 2, "only c1 + c3 (North)");
  });

  it("returns ok:false when all rows are filtered out", () => {
    const rows = [{ customer_id: "c1", month: "2024-01", region: "North" }];
    const result = runCohortAnalysis(
      rows,
      fullArgs({
        dimensionFilters: [{ column: "region", op: "in", values: ["South"] }],
      }),
    );
    assert.equal(result.ok, false);
  });
});

describe("WT2 · run_cohort_analysis — failure modes + schema", () => {
  it("returns ok:false for empty dataset", () => {
    const result = runCohortAnalysis([], fullArgs());
    assert.equal(result.ok, false);
  });

  it("returns ok:false when periodColumn has no values", () => {
    const rows = [{ customer_id: "c1", month: null }];
    const result = runCohortAnalysis(rows, fullArgs());
    assert.equal(result.ok, false);
  });

  it("schema rejects aggregation='sum' without metricColumn", () => {
    const parsed = cohortAnalysisArgsSchema.safeParse({
      entityColumn: "customer_id",
      periodColumn: "month",
      aggregation: "sum",
    });
    assert.equal(parsed.success, false);
  });

  it("schema rejects aggregation='mean' without metricColumn", () => {
    const parsed = cohortAnalysisArgsSchema.safeParse({
      entityColumn: "customer_id",
      periodColumn: "month",
      aggregation: "mean",
    });
    assert.equal(parsed.success, false);
  });

  it("schema accepts valid args with defaults", () => {
    const parsed = cohortAnalysisArgsSchema.safeParse({
      entityColumn: "customer_id",
      periodColumn: "month",
    });
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.aggregation, "count_distinct");
      assert.equal(parsed.data.maxPeriods, 12);
      assert.equal(parsed.data.retentionMode, false);
    }
  });

  it("schema rejects maxPeriods > 24", () => {
    const parsed = cohortAnalysisArgsSchema.safeParse({
      entityColumn: "customer_id",
      periodColumn: "month",
      maxPeriods: 50,
    });
    assert.equal(parsed.success, false);
  });
});

describe("WT2 · run_cohort_analysis — numericPayload metadata", () => {
  it("emits structured metadata for downstream consumers", () => {
    const rows = [
      { customer_id: "c1", month: "2024-01" },
      { customer_id: "c2", month: "2024-01" },
      { customer_id: "c3", month: "2024-02" },
    ];
    const result = runCohortAnalysis(rows, fullArgs({ maxPeriods: 6 }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.numericPayload, "numericPayload present");
    const payload = JSON.parse(result.numericPayload!);
    assert.equal(payload.kind, "cohort_analysis");
    assert.equal(payload.entityColumn, "customer_id");
    assert.equal(payload.periodColumn, "month");
    assert.equal(payload.aggregation, "count_distinct");
    assert.equal(payload.cohortCount, 2);
    assert.equal(payload.totalEntities, 3);
  });
});
