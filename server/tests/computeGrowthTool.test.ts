// WGR3 · compute_growth tool — pin tool registration, arg validation,
// in-memory growth computation, compound-shape Metric guard, and the
// rankByGrowth ordering on a synthetic 3-year × 3-market panel.
//
// The DuckDB execution path is exercised by buildGrowthSql.test.ts (live
// in-memory DuckDB) — here we cover the tool wrapper, fallbacks, and
// guards using the in-memory path so tests stay fast and don't require
// a session columnar store.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../lib/agents/runtime/toolRegistry.js";
import { registerComputeGrowthTool } from "../lib/agents/runtime/tools/computeGrowthTool.js";
import type { DataSummary, WideFormatTransform } from "../shared/schema.js";

function makeLongFormatSummary(): DataSummary {
  return {
    rowCount: 36,
    columnCount: 5,
    columns: [
      { name: "Markets", type: "string", sampleValues: ["VN", "IN", "ID"] },
      { name: "Metric", type: "string", sampleValues: ["Value Sales"] },
      { name: "Period", type: "string", sampleValues: ["Q1 22"] },
      { name: "PeriodIso", type: "string", sampleValues: ["2022-Q1"] },
      { name: "Value", type: "number", sampleValues: [100] },
    ],
    numericColumns: ["Value"],
    dateColumns: [],
  };
}

function makeCompoundShapeSummary(): DataSummary {
  const wft: WideFormatTransform = {
    detected: true,
    shape: "compound",
    idColumns: ["Markets"],
    meltedColumns: ["Q1 22 - Value Sales", "Q1 22 - Volume"],
    periodCount: 12,
    periodColumn: "Period",
    periodIsoColumn: "PeriodIso",
    periodKindColumn: "PeriodKind",
    valueColumn: "Value",
    metricColumn: "Metric",
    detectedCurrencySymbol: "đ",
  };
  return {
    ...makeLongFormatSummary(),
    wideFormatTransform: wft,
  };
}

// 3-year × 4-quarter × 3-market panel.
//   VN: 100→133→177  (~33% YoY each year)
//   IN: 80→80→80     (flat)
//   ID: 120→90→67.5  (-25% YoY each year)
function makeFixtureRows(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const markets: Array<[string, number, number]> = [
    ["VN", 100, 1.33],
    ["IN", 80, 1.0],
    ["ID", 120, 0.75],
  ];
  for (const [mkt, base, yoyMult] of markets) {
    for (let yi = 0; yi < 3; yi++) {
      const year = 2022 + yi;
      const yearBase = base * Math.pow(yoyMult, yi);
      for (let q = 1; q <= 4; q++) {
        rows.push({
          Markets: mkt,
          Metric: "Value Sales",
          Period: `Q${q} ${String(year).slice(2)}`,
          PeriodIso: `${year}-Q${q}`,
          Value: +(yearBase * (1 + q * 0.05)).toFixed(2),
        });
      }
    }
  }
  return rows;
}

function makeCtx(
  summary: DataSummary,
  data: Record<string, unknown>[],
  overrides: Record<string, unknown> = {}
): any {
  return {
    exec: {
      mode: "analysis",
      summary,
      data,
      sessionId: "test-session",
      // No columnarStoragePath ⇒ tool uses in-memory fallback.
      ...overrides,
    },
    config: {},
  };
}

describe("WGR3 · compute_growth · registration", () => {
  it("registers under the name compute_growth", () => {
    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);
    assert.ok(reg.listToolDescriptions().includes("compute_growth"));
  });

  it("registering twice on the same registry throws (W F2 invariant)", () => {
    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);
    assert.throws(() => registerComputeGrowthTool(reg), /already registered/);
  });
});

describe("WGR3 · compute_growth · in-memory series mode", () => {
  it("YoY series produces growth_pct for Year2 AND Year3 (not just Year2)", async () => {
    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);
    const ctx = makeCtx(makeLongFormatSummary(), makeFixtureRows());
    const out = await reg.execute(
      "compute_growth",
      {
        metricColumn: "Value",
        dimensionColumn: "Markets",
        periodIsoColumn: "PeriodIso",
        grain: "yoy",
        periodKind: "quarter",
        mode: "series",
      },
      ctx
    );
    assert.equal(out.ok, true);
    const rows = out.table?.rows as Array<{
      dimension: string;
      period: string;
      growth_pct: number | null;
    }>;
    // 3 markets × 12 periods = 36 rows; 24 with non-null growth_pct (Years 2 + 3).
    assert.equal(rows.length, 36);
    const nonNull = rows.filter((r) => r.growth_pct !== null);
    assert.equal(nonNull.length, 24);
    // Spot-check VN 2024-Q1 ≈ 33% growth.
    const vnY3Q1 = rows.find(
      (r) => r.dimension === "VN" && r.period === "2024-Q1"
    );
    assert.ok(vnY3Q1);
    assert.ok(typeof vnY3Q1!.growth_pct === "number");
    assert.ok(
      Math.abs((vnY3Q1!.growth_pct as number) - 0.33) < 0.05,
      `VN 2024-Q1 YoY ≈ 0.33, got ${vnY3Q1!.growth_pct}`
    );
  });

  it("memorySlots carry top-grower hints for downstream chaining", async () => {
    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);
    const ctx = makeCtx(makeLongFormatSummary(), makeFixtureRows());
    const out = await reg.execute(
      "compute_growth",
      {
        metricColumn: "Value",
        dimensionColumn: "Markets",
        periodIsoColumn: "PeriodIso",
        grain: "yoy",
        periodKind: "quarter",
        mode: "rankByGrowth",
      },
      ctx
    );
    assert.equal(out.ok, true);
    assert.equal(out.memorySlots?.growth_grain, "yoy");
    assert.equal(out.memorySlots?.growth_mode, "rankByGrowth");
    // Top should be VN (~33%).
    assert.equal(out.memorySlots?.growth_top_dimension, "VN");
  });
});

describe("WGR3 · compute_growth · rankByGrowth", () => {
  it("orders markets by latest YoY growth — VN top, ID bottom", async () => {
    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);
    const ctx = makeCtx(makeLongFormatSummary(), makeFixtureRows());
    const out = await reg.execute(
      "compute_growth",
      {
        metricColumn: "Value",
        dimensionColumn: "Markets",
        periodIsoColumn: "PeriodIso",
        grain: "yoy",
        periodKind: "quarter",
        mode: "rankByGrowth",
        topN: 10,
      },
      ctx
    );
    assert.equal(out.ok, true);
    const rows = out.table?.rows as Array<{
      dimension: string;
      growth_pct: number;
    }>;
    assert.equal(rows.length, 3);
    assert.equal(rows[0].dimension, "VN");
    assert.equal(rows[2].dimension, "ID");
  });
});

describe("WGR3 · compute_growth · summary mode", () => {
  it("aggregates across all dimensions to one row per period", async () => {
    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);
    const ctx = makeCtx(makeLongFormatSummary(), makeFixtureRows());
    const out = await reg.execute(
      "compute_growth",
      {
        metricColumn: "Value",
        periodIsoColumn: "PeriodIso",
        grain: "yoy",
        periodKind: "quarter",
        mode: "summary",
      },
      ctx
    );
    assert.equal(out.ok, true);
    const rows = out.table?.rows as Array<{ period: string; growth_pct: number | null }>;
    assert.equal(rows.length, 12); // 3 years × 4 quarters
    const nonNull = rows.filter((r) => r.growth_pct !== null);
    assert.equal(nonNull.length, 8); // Years 2 + 3 each have 4 quarters
  });
});

describe("WGR3 · compute_growth · compound-shape Metric guard", () => {
  it("refuses when compound shape AND no Metric filter AND no Metric in groupBy", async () => {
    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);
    const ctx = makeCtx(makeCompoundShapeSummary(), makeFixtureRows());
    const out = await reg.execute(
      "compute_growth",
      {
        metricColumn: "Value",
        dimensionColumn: "Markets",
        periodIsoColumn: "PeriodIso",
        grain: "yoy",
        periodKind: "quarter",
        mode: "rankByGrowth",
      },
      ctx
    );
    assert.equal(out.ok, false);
    assert.match(out.summary, /compound-shape/);
    assert.match(out.summary, /Metric/);
  });

  it("accepts when Metric filter is supplied", async () => {
    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);
    const ctx = makeCtx(makeCompoundShapeSummary(), makeFixtureRows());
    const out = await reg.execute(
      "compute_growth",
      {
        metricColumn: "Value",
        dimensionColumn: "Markets",
        periodIsoColumn: "PeriodIso",
        grain: "yoy",
        periodKind: "quarter",
        mode: "rankByGrowth",
        dimensionFilters: [
          { column: "Metric", op: "in", values: ["Value Sales"] },
        ],
      },
      ctx
    );
    assert.equal(out.ok, true);
  });
});

describe("WGR3 · compute_growth · arg & schema validation", () => {
  it("rejects column not in schema", async () => {
    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);
    const ctx = makeCtx(makeLongFormatSummary(), makeFixtureRows());
    const out = await reg.execute(
      "compute_growth",
      {
        metricColumn: "ColumnDoesNotExist",
        periodIsoColumn: "PeriodIso",
        grain: "yoy",
        mode: "summary",
      },
      ctx
    );
    assert.equal(out.ok, false);
    assert.match(out.summary, /not in schema/);
  });

  it("rejects when no period column resolvable", async () => {
    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);
    const summary = makeLongFormatSummary();
    summary.dateColumns = [];
    summary.wideFormatTransform = undefined;
    const ctx = makeCtx(summary, makeFixtureRows());
    const out = await reg.execute(
      "compute_growth",
      {
        metricColumn: "Value",
        grain: "yoy",
        mode: "summary",
      },
      ctx
    );
    assert.equal(out.ok, false);
    assert.match(out.summary, /no period column/i);
  });

  it("auto-detects PeriodIso from wideFormatTransform when not supplied", async () => {
    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);
    // Note: not compound shape — no Metric guard fires.
    const summary = makeLongFormatSummary();
    summary.wideFormatTransform = {
      detected: true,
      shape: "pure_period",
      idColumns: ["Markets"],
      meltedColumns: ["Q1 22"],
      periodCount: 12,
      periodColumn: "Period",
      periodIsoColumn: "PeriodIso",
      periodKindColumn: "PeriodKind",
      valueColumn: "Value",
      detectedCurrencySymbol: "đ",
    };
    const ctx = makeCtx(summary, makeFixtureRows());
    const out = await reg.execute(
      "compute_growth",
      {
        metricColumn: "Value",
        dimensionColumn: "Markets",
        grain: "yoy",
        periodKind: "quarter",
        mode: "rankByGrowth",
      },
      ctx
    );
    assert.equal(out.ok, true);
    const rows = out.table?.rows as Array<{ dimension: string }>;
    assert.equal(rows[0].dimension, "VN");
  });
});

describe("WGR3 · compute_growth · auto grain selection", () => {
  it("picks yoy when ≥2 years are covered (multi-year fixture)", async () => {
    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);
    const ctx = makeCtx(makeLongFormatSummary(), makeFixtureRows());
    const out = await reg.execute(
      "compute_growth",
      {
        metricColumn: "Value",
        dimensionColumn: "Markets",
        periodIsoColumn: "PeriodIso",
        // grain omitted — default "auto"
        mode: "rankByGrowth",
      },
      ctx
    );
    assert.equal(out.ok, true);
    assert.equal(out.memorySlots?.growth_grain, "yoy");
  });
});

describe("WGR3 · compute_growth · dimensionFilters narrowing", () => {
  it("excludes rows matching not_in filter", async () => {
    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);
    const ctx = makeCtx(makeLongFormatSummary(), makeFixtureRows());
    const out = await reg.execute(
      "compute_growth",
      {
        metricColumn: "Value",
        dimensionColumn: "Markets",
        periodIsoColumn: "PeriodIso",
        grain: "yoy",
        periodKind: "quarter",
        mode: "rankByGrowth",
        dimensionFilters: [
          { column: "Markets", op: "not_in", values: ["ID"] },
        ],
      },
      ctx
    );
    assert.equal(out.ok, true);
    const rows = out.table?.rows as Array<{ dimension: string }>;
    assert.ok(!rows.some((r) => r.dimension === "ID"));
    assert.equal(rows.length, 2);
  });

  it("includes only rows matching in filter", async () => {
    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);
    const ctx = makeCtx(makeLongFormatSummary(), makeFixtureRows());
    const out = await reg.execute(
      "compute_growth",
      {
        metricColumn: "Value",
        dimensionColumn: "Markets",
        periodIsoColumn: "PeriodIso",
        grain: "yoy",
        periodKind: "quarter",
        mode: "series",
        dimensionFilters: [
          { column: "Markets", op: "in", values: ["VN"] },
        ],
      },
      ctx
    );
    assert.equal(out.ok, true);
    const rows = out.table?.rows as Array<{ dimension: string }>;
    assert.ok(rows.every((r) => r.dimension === "VN"));
  });
});
