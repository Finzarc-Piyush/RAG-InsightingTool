import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runHierarchicalDrill,
  hierarchicalDrillArgsSchema,
  type HierarchicalDrillArgs,
} from "../lib/agents/runtime/tools/hierarchicalDrillTool.js";

const fullArgs = (overrides: Partial<HierarchicalDrillArgs> = {}): HierarchicalDrillArgs => ({
  dimension: "Region",
  metricColumn: "Sales",
  aggregation: "sum",
  topN: 3,
  direction: "desc",
  otherLabel: "Other",
  dimensionFilters: undefined,
  ...overrides,
});

describe("WT8 · run_hierarchical_drill — bucketing + rollup", () => {
  it("keeps top-N buckets and rolls the remainder into 'Other'", () => {
    const rows = [
      { Region: "North", Sales: 100 },
      { Region: "South", Sales: 80 },
      { Region: "East", Sales: 60 },
      { Region: "West", Sales: 40 },
      { Region: "Central", Sales: 20 },
      { Region: "NorthEast", Sales: 10 },
    ];
    const result = runHierarchicalDrill(rows, fullArgs({ topN: 3 }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    assert.equal(tableRows.length, 4, "3 top + Other");
    assert.equal(tableRows[0].Region, "North");
    assert.equal(tableRows[0].Sales, 100);
    assert.equal(tableRows[1].Region, "South");
    assert.equal(tableRows[2].Region, "East");
    assert.equal(tableRows[3].Region, "Other");
    assert.equal(tableRows[3].Sales, 40 + 20 + 10);
  });

  it("does NOT emit an 'Other' row when bucketCount <= topN", () => {
    const rows = [
      { Region: "North", Sales: 100 },
      { Region: "South", Sales: 80 },
    ];
    const result = runHierarchicalDrill(rows, fullArgs({ topN: 5 }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    assert.equal(tableRows.length, 2);
    assert.ok(!tableRows.some((r) => r.Region === "Other"));
  });

  it("sums multiple rows in the same dimension bucket", () => {
    const rows = [
      { Region: "North", Sales: 50 },
      { Region: "North", Sales: 50 },
      { Region: "South", Sales: 30 },
    ];
    const result = runHierarchicalDrill(rows, fullArgs());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    const north = tableRows.find((r) => r.Region === "North")!;
    assert.equal(north.Sales, 100);
  });
});

describe("WT8 · run_hierarchical_drill — aggregation operations", () => {
  it("aggregation='mean' computes correct bucket means", () => {
    const rows = [
      { Region: "North", Sales: 10 },
      { Region: "North", Sales: 30 },
      { Region: "South", Sales: 20 },
    ];
    const result = runHierarchicalDrill(rows, fullArgs({ aggregation: "mean" }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    const north = tableRows.find((r) => r.Region === "North")!;
    assert.equal(north.Sales, 20);
  });

  it("aggregation='mean' on the Other bucket uses ROW-level total/count, not the mean of means", () => {
    // North = 10 rows × 100 each = mean 100
    // South = 1 row × 1 = mean 1
    // East = 1 row × 1 = mean 1
    // topN=1 → Other = South + East
    // Mean-of-means would be (1 + 1) / 2 = 1
    // Correct row-level mean = (1 + 1) / 2 = 1 — happens to match here, so let's pick a case where they differ.
    const rows = [
      // South: 3 rows × 30 = mean 30, total 90
      { Region: "South", Sales: 10 },
      { Region: "South", Sales: 30 },
      { Region: "South", Sales: 50 },
      // East: 1 row × 100 = mean 100, total 100
      { Region: "East", Sales: 100 },
      // North: 1 row × 1000 = mean 1000 → kept
      { Region: "North", Sales: 1000 },
    ];
    const result = runHierarchicalDrill(rows, fullArgs({ aggregation: "mean", topN: 1 }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    const other = tableRows.find((r) => r.Region === "Other")!;
    // Row-level mean over South + East = (10 + 30 + 50 + 100) / 4 = 47.5
    // Mean-of-means would be (30 + 100) / 2 = 65 — wrong
    assert.equal(other.Sales, 47.5);
  });

  it("aggregation='count' counts rows (ignores non-numeric metric cells)", () => {
    const rows = [
      { Region: "North", Sales: 10 },
      { Region: "North", Sales: "missing" },
      { Region: "South", Sales: 20 },
    ];
    const result = runHierarchicalDrill(rows, fullArgs({ aggregation: "count" }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    const north = tableRows.find((r) => r.Region === "North")!;
    assert.equal(north.Sales, 2);
  });

  it("aggregation='min' returns the smallest value per bucket", () => {
    const rows = [
      { Region: "North", Sales: 50 },
      { Region: "North", Sales: 10 },
      { Region: "South", Sales: 20 },
    ];
    const result = runHierarchicalDrill(rows, fullArgs({ aggregation: "min" }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    const north = tableRows.find((r) => r.Region === "North")!;
    assert.equal(north.Sales, 10);
  });
});

describe("WT8 · run_hierarchical_drill — direction + share-of-total", () => {
  it("direction='asc' returns the smallest contributors first", () => {
    const rows = [
      { Region: "Big", Sales: 1000 },
      { Region: "Medium", Sales: 100 },
      { Region: "Small", Sales: 10 },
    ];
    const result = runHierarchicalDrill(
      rows,
      fullArgs({ direction: "asc", topN: 5 }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    assert.equal(tableRows[0].Region, "Small");
    assert.equal(tableRows[1].Region, "Medium");
    assert.equal(tableRows[2].Region, "Big");
  });

  it("_share fractions sum to ~1.0 across all returned rows (including Other)", () => {
    const rows = [
      { Region: "A", Sales: 50 },
      { Region: "B", Sales: 30 },
      { Region: "C", Sales: 10 },
      { Region: "D", Sales: 10 },
    ];
    const result = runHierarchicalDrill(rows, fullArgs({ topN: 2 }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    const totalShare = tableRows.reduce((s, r) => s + (r._share as number), 0);
    assert.ok(
      Math.abs(totalShare - 1.0) < 1e-9,
      `expected share-of-total ≈ 1, got ${totalShare}`,
    );
  });

  it("flags the Other bucket with _rank: -1 (renderers can dim/mark)", () => {
    const rows = [
      { Region: "A", Sales: 50 },
      { Region: "B", Sales: 30 },
      { Region: "C", Sales: 10 },
    ];
    const result = runHierarchicalDrill(rows, fullArgs({ topN: 2 }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    assert.equal(tableRows[0]._rank, 1);
    assert.equal(tableRows[1]._rank, 2);
    assert.equal(tableRows[2]._rank, -1);
  });
});

describe("WT8 · run_hierarchical_drill — filters + edge cases", () => {
  it("applies dimensionFilters before bucketing (in)", () => {
    const rows = [
      { Region: "North", Channel: "Retail", Sales: 100 },
      { Region: "North", Channel: "Online", Sales: 200 },
      { Region: "South", Channel: "Retail", Sales: 50 },
    ];
    const result = runHierarchicalDrill(
      rows,
      fullArgs({
        dimensionFilters: [
          { column: "Channel", op: "in", values: ["Retail"] },
        ],
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    const north = tableRows.find((r) => r.Region === "North");
    assert.equal(north?.Sales, 100);
  });

  it("applies dimensionFilters before bucketing (not_in)", () => {
    const rows = [
      { Region: "North", Channel: "Retail", Sales: 100 },
      { Region: "North", Channel: "Online", Sales: 200 },
    ];
    const result = runHierarchicalDrill(
      rows,
      fullArgs({
        dimensionFilters: [
          { column: "Channel", op: "not_in", values: ["Online"] },
        ],
      }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    assert.equal(tableRows[0].Sales, 100);
  });

  it("skips null/empty dimension cells", () => {
    const rows = [
      { Region: "North", Sales: 100 },
      { Region: null, Sales: 50 },
      { Region: "", Sales: 25 },
      { Region: "South", Sales: 30 },
    ];
    const result = runHierarchicalDrill(rows, fullArgs());
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const tableRows = result.table.rows as Array<Record<string, unknown>>;
    assert.equal(tableRows.length, 2); // only North + South
  });

  it("returns ok:false on empty input", () => {
    const result = runHierarchicalDrill([], fullArgs());
    assert.equal(result.ok, false);
    assert.match(result.summary, /empty/);
  });

  it("returns ok:false when no row has a non-null dimension+metric pair", () => {
    const rows = [
      { Region: "North", Sales: "x" }, // non-numeric metric
      { Region: "South", Sales: null },
    ];
    const result = runHierarchicalDrill(rows, fullArgs());
    assert.equal(result.ok, false);
  });

  it("returns ok:false when filters reject every row", () => {
    const rows = [{ Region: "North", Sales: 100 }];
    const result = runHierarchicalDrill(
      rows,
      fullArgs({
        dimensionFilters: [
          { column: "Region", op: "in", values: ["does-not-exist"] },
        ],
      }),
    );
    assert.equal(result.ok, false);
    assert.match(result.summary, /no rows match/);
  });
});

describe("WT8 · args schema validation", () => {
  it("topN must be 2..50", () => {
    assert.throws(() =>
      hierarchicalDrillArgsSchema.parse({
        dimension: "x",
        metricColumn: "y",
        topN: 1,
      }),
    );
    assert.throws(() =>
      hierarchicalDrillArgsSchema.parse({
        dimension: "x",
        metricColumn: "y",
        topN: 100,
      }),
    );
  });

  it("applies defaults: aggregation=sum, direction=desc, otherLabel=Other, topN=10", () => {
    const parsed = hierarchicalDrillArgsSchema.parse({
      dimension: "Region",
      metricColumn: "Sales",
    });
    assert.equal(parsed.aggregation, "sum");
    assert.equal(parsed.direction, "desc");
    assert.equal(parsed.otherLabel, "Other");
    assert.equal(parsed.topN, 10);
  });

  it("rejects unknown args (strict schema)", () => {
    assert.throws(() =>
      hierarchicalDrillArgsSchema.parse({
        dimension: "Region",
        metricColumn: "Sales",
        nonsense: "should not pass",
      }),
    );
  });
});
