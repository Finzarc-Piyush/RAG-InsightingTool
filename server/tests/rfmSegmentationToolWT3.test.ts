import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runRfmSegmentation,
  rfmSegmentationArgsSchema,
  classifyRfmSegment,
  type RfmSegmentationArgs,
} from "../lib/agents/runtime/tools/rfmSegmentationTool.js";

const fullArgs = (overrides: Partial<RfmSegmentationArgs> = {}): RfmSegmentationArgs => ({
  entityColumn: "customer_id",
  periodColumn: "month",
  monetaryColumn: "revenue",
  buckets: 5,
  frequencyMode: "distinct_periods",
  maxEntities: 100,
  dimensionFilters: undefined,
  ...overrides,
});

/** Build a 5-tier dataset where each customer is clearly placed in one quintile. */
function buildQuintileDataset() {
  const rows: Array<Record<string, unknown>> = [];
  // 5 customers, each active in a different number of months (frequency)
  // and with monotonically increasing spend (monetary). Recency varies too.
  const customers = [
    // c1: 1 active month, $100 spend, last active 2024-01 (oldest)
    { id: "c1", months: ["2024-01"], spend: 100 },
    // c2: 2 active months, $400 spend, last active 2024-02
    { id: "c2", months: ["2024-01", "2024-02"], spend: 200 },
    // c3: 3 active months, $900 spend, last active 2024-03
    { id: "c3", months: ["2024-01", "2024-02", "2024-03"], spend: 300 },
    // c4: 4 active months, $1600 spend, last active 2024-04
    { id: "c4", months: ["2024-01", "2024-02", "2024-03", "2024-04"], spend: 400 },
    // c5: 5 active months, $2500 spend, last active 2024-05 (newest)
    { id: "c5", months: ["2024-01", "2024-02", "2024-03", "2024-04", "2024-05"], spend: 500 },
  ];
  for (const c of customers) {
    for (const m of c.months) {
      rows.push({ customer_id: c.id, month: m, revenue: c.spend });
    }
  }
  return rows;
}

describe("WT3 · run_rfm_segmentation — quintile scoring", () => {
  it("ranks the highest-R/F/M customer with the maximum score", () => {
    const rows = buildQuintileDataset();
    const result = runRfmSegmentation(rows, fullArgs());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    assert.equal(tableRows.length, 5);

    const c5 = tableRows.find((r) => r.customer_id === "c5")!;
    assert.equal(c5.r_score, 5);
    assert.equal(c5.f_score, 5);
    assert.equal(c5.m_score, 5);
    assert.equal(c5.rfm_score, "555");

    const c1 = tableRows.find((r) => r.customer_id === "c1")!;
    assert.equal(c1.r_score, 1);
    assert.equal(c1.f_score, 1);
    assert.equal(c1.m_score, 1);
    assert.equal(c1.rfm_score, "111");
  });

  it("sorts the table by total score descending", () => {
    const rows = buildQuintileDataset();
    const result = runRfmSegmentation(rows, fullArgs());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    // Highest-scored customer should be first (c5 = 555 → 15)
    assert.equal(tableRows[0].customer_id, "c5");
    assert.equal(tableRows[tableRows.length - 1].customer_id, "c1");
  });

  it("handles ties by giving identical scores", () => {
    const rows = [
      { customer_id: "c1", month: "2024-01", revenue: 100 },
      { customer_id: "c2", month: "2024-01", revenue: 100 },
      { customer_id: "c3", month: "2024-01", revenue: 100 },
    ];
    const result = runRfmSegmentation(rows, fullArgs());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    // All three customers have identical R/F/M values → identical scores
    const scores = new Set(tableRows.map((r) => r.rfm_score));
    assert.equal(scores.size, 1, "all customers should share the same RFM score");
  });
});

describe("WT3 · run_rfm_segmentation — frequency modes", () => {
  it("frequencyMode='distinct_periods' counts unique periods per entity", () => {
    const rows = [
      { customer_id: "c1", month: "2024-01", revenue: 50 },
      { customer_id: "c1", month: "2024-01", revenue: 60 }, // same month, double-row
      { customer_id: "c1", month: "2024-02", revenue: 70 },
    ];
    const result = runRfmSegmentation(rows, fullArgs());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const c1 = (result.table.rows as Array<Record<string, unknown>>)[0];
    assert.equal(c1.frequency, 2, "distinct periods = 2024-01, 2024-02");
  });

  it("frequencyMode='rows' counts every row", () => {
    const rows = [
      { customer_id: "c1", month: "2024-01", revenue: 50 },
      { customer_id: "c1", month: "2024-01", revenue: 60 },
      { customer_id: "c1", month: "2024-02", revenue: 70 },
    ];
    const result = runRfmSegmentation(rows, fullArgs({ frequencyMode: "rows" }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const c1 = (result.table.rows as Array<Record<string, unknown>>)[0];
    assert.equal(c1.frequency, 3, "row count = 3");
  });
});

describe("WT3 · run_rfm_segmentation — recency derivation", () => {
  it("recency uses the entity's most-recent observed period", () => {
    const rows = [
      // c1 last active 2024-01, c2 last active 2024-05
      { customer_id: "c1", month: "2024-01", revenue: 100 },
      { customer_id: "c2", month: "2024-01", revenue: 100 },
      { customer_id: "c2", month: "2024-05", revenue: 100 },
    ];
    const result = runRfmSegmentation(rows, fullArgs());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    const c2 = tableRows.find((r) => r.customer_id === "c2")!;
    assert.equal(c2.last_period, "2024-05");
    assert.equal(c2.r_score, 5, "most recent customer gets max recency");

    const c1 = tableRows.find((r) => r.customer_id === "c1")!;
    assert.equal(c1.last_period, "2024-01");
    assert.equal(c1.r_score, 3, "earlier customer gets lower recency (rank=1 of 2 → ceil(1/2*5)=3)");
  });
});

describe("WT3 · run_rfm_segmentation — segment classifier", () => {
  it("classifies a 555 entity as Champions", () => {
    assert.equal(classifyRfmSegment(5, 5, 5, 5), "Champions");
  });
  it("classifies a 111 entity as Lost", () => {
    assert.equal(classifyRfmSegment(1, 1, 1, 5), "Lost");
  });
  it("classifies a low-R high-FM as 'Cant Lose Them'", () => {
    assert.equal(classifyRfmSegment(1, 5, 5, 5), "Cant Lose Them");
  });
  it("classifies a top-R F=1 as New Customers", () => {
    assert.equal(classifyRfmSegment(5, 1, 3, 5), "New Customers");
  });
  it("classifies a low-R mid-F as At Risk", () => {
    assert.equal(classifyRfmSegment(2, 4, 4, 5), "At Risk");
  });
  it("classifies a 222 entity as Hibernating", () => {
    assert.equal(classifyRfmSegment(2, 2, 2, 5), "Hibernating");
  });
  it("Champions takes precedence over Loyal", () => {
    assert.equal(classifyRfmSegment(5, 5, 5, 5), "Champions");
    assert.equal(classifyRfmSegment(4, 5, 5, 5), "Champions");
  });
  it("falls back to Regular for mid-range scores", () => {
    assert.equal(classifyRfmSegment(3, 3, 5, 5), "Regular");
  });
});

describe("WT3 · run_rfm_segmentation — output shape", () => {
  it("emits expected columns", () => {
    const rows = buildQuintileDataset();
    const result = runRfmSegmentation(rows, fullArgs());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.table.columns, [
      "customer_id",
      "last_period",
      "frequency",
      "monetary",
      "r_score",
      "f_score",
      "m_score",
      "rfm_score",
      "segment",
    ]);
  });

  it("emits segmentBreakdown in numericPayload", () => {
    const rows = buildQuintileDataset();
    const result = runRfmSegmentation(rows, fullArgs());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(result.numericPayload);
    const payload = JSON.parse(result.numericPayload!);
    assert.equal(payload.kind, "rfm_segmentation");
    assert.equal(payload.totalEntities, 5);
    assert.ok(Array.isArray(payload.segmentBreakdown));
    const totalInBreakdown = payload.segmentBreakdown.reduce(
      (s: number, e: { count: number }) => s + e.count,
      0,
    );
    assert.equal(totalInBreakdown, 5, "every entity is counted exactly once");
  });

  it("caps the table at maxEntities while keeping all in segmentBreakdown", () => {
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 50; i++) {
      rows.push({ customer_id: `c${i}`, month: "2024-01", revenue: i * 10 });
    }
    const result = runRfmSegmentation(rows, fullArgs({ maxEntities: 10 }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    assert.equal(tableRows.length, 10);
    const payload = JSON.parse(result.numericPayload!);
    assert.equal(payload.totalEntities, 50);
    assert.equal(payload.cappedTo, 10);
  });
});

describe("WT3 · run_rfm_segmentation — filters + failures", () => {
  it("applies dimensionFilters before aggregation", () => {
    const rows = [
      { customer_id: "c1", month: "2024-01", revenue: 100, region: "North" },
      { customer_id: "c2", month: "2024-01", revenue: 100, region: "South" },
    ];
    const result = runRfmSegmentation(
      rows,
      fullArgs({
        dimensionFilters: [{ column: "region", op: "in", values: ["North"] }],
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    assert.equal(tableRows.length, 1);
    assert.equal(tableRows[0].customer_id, "c1");
  });

  it("returns ok:false for empty dataset", () => {
    const result = runRfmSegmentation([], fullArgs());
    assert.equal(result.ok, false);
  });

  it("returns ok:false when no rows survive filters", () => {
    const rows = [{ customer_id: "c1", month: "2024-01", revenue: 100, region: "North" }];
    const result = runRfmSegmentation(
      rows,
      fullArgs({
        dimensionFilters: [{ column: "region", op: "in", values: ["South"] }],
      }),
    );
    assert.equal(result.ok, false);
  });
});

describe("WT3 · run_rfm_segmentation — schema", () => {
  it("accepts valid args with defaults", () => {
    const parsed = rfmSegmentationArgsSchema.safeParse({
      entityColumn: "c",
      periodColumn: "m",
      monetaryColumn: "r",
    });
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.buckets, 5);
      assert.equal(parsed.data.frequencyMode, "distinct_periods");
      assert.equal(parsed.data.maxEntities, 100);
    }
  });

  it("rejects buckets out of [3,7]", () => {
    assert.equal(
      rfmSegmentationArgsSchema.safeParse({
        entityColumn: "c",
        periodColumn: "m",
        monetaryColumn: "r",
        buckets: 10,
      }).success,
      false,
    );
    assert.equal(
      rfmSegmentationArgsSchema.safeParse({
        entityColumn: "c",
        periodColumn: "m",
        monetaryColumn: "r",
        buckets: 2,
      }).success,
      false,
    );
  });

  it("rejects unknown keys (.strict)", () => {
    const parsed = rfmSegmentationArgsSchema.safeParse({
      entityColumn: "c",
      periodColumn: "m",
      monetaryColumn: "r",
      bogus: "x",
    });
    assert.equal(parsed.success, false);
  });
});
