// WSE3 · detect_seasonality tool — pin registration, arg validation,
// in-memory aggregation path, compound-shape Metric guard, and the
// recurring-peak surfacing on a 5-year × 12-month × 1-market Q4-spike
// fixture. The DuckDB execution path is exercised by buildSeasonalityAggSql.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../lib/agents/runtime/toolRegistry.js";
import { registerDetectSeasonalityTool } from "../lib/agents/runtime/tools/detectSeasonalityTool.js";
import type { DataSummary, WideFormatTransform } from "../shared/schema.js";

function makeWideFormatSummary(): DataSummary {
  return {
    rowCount: 60,
    columnCount: 5,
    columns: [
      { name: "Markets", type: "string", sampleValues: ["VN"] },
      { name: "Metric", type: "string", sampleValues: ["Value Sales"] },
      { name: "Period", type: "string", sampleValues: ["Q1 18"] },
      { name: "PeriodIso", type: "string", sampleValues: ["2018-01"] },
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
    meltedColumns: ["Q1 18 Value Sales", "Q1 18 Volume"],
    periodCount: 60,
    periodColumn: "Period",
    periodIsoColumn: "PeriodIso",
    periodKindColumn: "PeriodKind",
    valueColumn: "Value",
    metricColumn: "Metric",
    detectedCurrencySymbol: "đ",
  };
  return {
    ...makeWideFormatSummary(),
    wideFormatTransform: wft,
  };
}

// 5 years × 12 months × 1 market with Q4 spike (Nov +50%, Oct/Dec +25%).
function q4SpikeRows(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const spike: Record<number, number> = { 10: 1.25, 11: 1.5, 12: 1.25 };
  for (let y = 2018; y <= 2022; y++) {
    for (let m = 1; m <= 12; m++) {
      const mm = m < 10 ? `0${m}` : String(m);
      rows.push({
        Markets: "VN",
        Metric: "Value Sales",
        Period: `M${m} ${String(y).slice(2)}`,
        PeriodIso: `${y}-${mm}`,
        Value: 100 * (spike[m] ?? 1),
      });
    }
  }
  return rows;
}

function makeCtx(
  summary: DataSummary,
  data: Record<string, unknown>[]
): any {
  return {
    exec: {
      mode: "analysis",
      sessionId: "test-session",
      summary,
      data,
    },
    config: {},
  };
}

describe("WSE3 · detect_seasonality · registration", () => {
  it("registers under the name detect_seasonality", () => {
    const reg = new ToolRegistry();
    registerDetectSeasonalityTool(reg);
    assert.ok(reg.listToolDescriptions().includes("detect_seasonality"));
  });
  it("duplicate registration throws (W F2 invariant)", () => {
    const reg = new ToolRegistry();
    registerDetectSeasonalityTool(reg);
    assert.throws(() => registerDetectSeasonalityTool(reg), /already registered/);
  });
});

describe("WSE3 · detect_seasonality · in-memory monthly path", () => {
  it("on the Q4-spike fixture, surfaces Oct/Nov/Dec as the consistent peaks", async () => {
    const reg = new ToolRegistry();
    registerDetectSeasonalityTool(reg);
    const ctx = makeCtx(makeWideFormatSummary(), q4SpikeRows());
    const out = await reg.execute(
      "detect_seasonality",
      {
        metricColumn: "Value",
        periodIsoColumn: "PeriodIso",
        granularity: "month",
      },
      ctx
    );
    assert.equal(out.ok, true);
    assert.match(out.memorySlots!.seasonality_grain, /month/);
    assert.equal(out.memorySlots!.seasonality_years_observed, "5");
    // Either 'strong' or 'moderate' depending on rounding — both are
    // valid; the user's complaint is "Q4 always peaks", not a specific tier.
    assert.match(
      out.memorySlots!.seasonality_strength,
      /strong|moderate/
    );
    assert.match(
      out.memorySlots!.seasonality_peak_positions,
      /Nov.*Oct.*Dec|Oct.*Nov.*Dec|Nov.*Dec.*Oct|Dec.*Nov.*Oct|Oct.*Dec.*Nov/
    );
    // Top consistency = 1.0 (Nov in top-3 all 5 years).
    assert.equal(Number(out.memorySlots!.seasonality_consistency_max), 1);
  });

  it("summary line names the consistent peak window AND the consistency fraction", async () => {
    const reg = new ToolRegistry();
    registerDetectSeasonalityTool(reg);
    const ctx = makeCtx(makeWideFormatSummary(), q4SpikeRows());
    const out = await reg.execute(
      "detect_seasonality",
      { metricColumn: "Value", periodIsoColumn: "PeriodIso", granularity: "month" },
      ctx
    );
    assert.equal(out.ok, true);
    // The narrator drops `summary` directly into findings[].evidence.
    assert.match(out.summary, /Nov|Oct|Dec/);
    assert.match(out.summary, /5 of 5/);
  });

  it("table.rows include index + fractionInTopK per month", async () => {
    const reg = new ToolRegistry();
    registerDetectSeasonalityTool(reg);
    const ctx = makeCtx(makeWideFormatSummary(), q4SpikeRows());
    const out = await reg.execute(
      "detect_seasonality",
      { metricColumn: "Value", periodIsoColumn: "PeriodIso", granularity: "month" },
      ctx
    );
    const rows = out.table?.rows as Array<{
      position: number;
      label: string;
      index: number;
      fractionInTopK: number;
    }>;
    assert.equal(rows.length, 12);
    const nov = rows.find((r) => r.position === 11)!;
    assert.equal(nov.fractionInTopK, 1);
    assert.ok(nov.index > 1.2);
  });
});

describe("WSE3 · detect_seasonality · auto grain selection", () => {
  it("picks 'month' on multi-year monthly fixture", async () => {
    const reg = new ToolRegistry();
    registerDetectSeasonalityTool(reg);
    const ctx = makeCtx(makeWideFormatSummary(), q4SpikeRows());
    const out = await reg.execute(
      "detect_seasonality",
      { metricColumn: "Value", periodIsoColumn: "PeriodIso" },  // granularity defaults to "auto"
      ctx
    );
    assert.equal(out.ok, true);
    assert.equal(out.memorySlots!.seasonality_grain, "month");
  });

  it("refuses on single-year data", async () => {
    const reg = new ToolRegistry();
    registerDetectSeasonalityTool(reg);
    // 12 months × 1 year only.
    const rows = q4SpikeRows().filter((r) =>
      String(r.PeriodIso).startsWith("2018")
    );
    const ctx = makeCtx(makeWideFormatSummary(), rows);
    const out = await reg.execute(
      "detect_seasonality",
      { metricColumn: "Value", periodIsoColumn: "PeriodIso", granularity: "auto" },
      ctx
    );
    assert.equal(out.ok, false);
    assert.match(out.summary, /≥2 full years|requires.*years/);
  });
});

describe("WSE3 · detect_seasonality · compound-shape Metric guard", () => {
  it("refuses when compound shape AND no Metric filter AND no Metric in dimensions", async () => {
    const reg = new ToolRegistry();
    registerDetectSeasonalityTool(reg);
    const ctx = makeCtx(makeCompoundShapeSummary(), q4SpikeRows());
    const out = await reg.execute(
      "detect_seasonality",
      {
        metricColumn: "Value",
        periodIsoColumn: "PeriodIso",
        granularity: "month",
      },
      ctx
    );
    assert.equal(out.ok, false);
    assert.match(out.summary, /compound-shape/);
    assert.match(out.summary, /Metric filter/);
  });

  it("accepts when Metric filter is supplied", async () => {
    const reg = new ToolRegistry();
    registerDetectSeasonalityTool(reg);
    const ctx = makeCtx(makeCompoundShapeSummary(), q4SpikeRows());
    const out = await reg.execute(
      "detect_seasonality",
      {
        metricColumn: "Value",
        periodIsoColumn: "PeriodIso",
        granularity: "month",
        dimensionFilters: [
          { column: "Metric", op: "in", values: ["Value Sales"] },
        ],
      },
      ctx
    );
    assert.equal(out.ok, true);
  });
});

describe("WSE3 · detect_seasonality · arg & schema validation", () => {
  it("rejects column not in schema", async () => {
    const reg = new ToolRegistry();
    registerDetectSeasonalityTool(reg);
    const ctx = makeCtx(makeWideFormatSummary(), q4SpikeRows());
    const out = await reg.execute(
      "detect_seasonality",
      {
        metricColumn: "DoesNotExist",
        periodIsoColumn: "PeriodIso",
        granularity: "month",
      },
      ctx
    );
    assert.equal(out.ok, false);
    assert.match(out.summary, /not in schema/);
  });

  it("rejects when no period column resolvable", async () => {
    const reg = new ToolRegistry();
    registerDetectSeasonalityTool(reg);
    const summary = makeWideFormatSummary();
    summary.dateColumns = [];
    const ctx = makeCtx(summary, q4SpikeRows());
    const out = await reg.execute(
      "detect_seasonality",
      { metricColumn: "Value", granularity: "month" },
      ctx
    );
    assert.equal(out.ok, false);
    assert.match(out.summary, /no period column/i);
  });
});

describe("WSE3 · detect_seasonality · weak/no seasonality", () => {
  it("on a flat fixture, returns strength 'none' and refuses to name peaks", async () => {
    const reg = new ToolRegistry();
    registerDetectSeasonalityTool(reg);
    const flatRows: Record<string, unknown>[] = [];
    for (let y = 2018; y <= 2022; y++) {
      for (let m = 1; m <= 12; m++) {
        const mm = m < 10 ? `0${m}` : String(m);
        flatRows.push({
          Markets: "VN",
          Metric: "Value Sales",
          PeriodIso: `${y}-${mm}`,
          Value: 100,
        });
      }
    }
    const ctx = makeCtx(makeWideFormatSummary(), flatRows);
    const out = await reg.execute(
      "detect_seasonality",
      { metricColumn: "Value", periodIsoColumn: "PeriodIso", granularity: "month" },
      ctx
    );
    assert.equal(out.ok, true);
    assert.equal(out.memorySlots!.seasonality_strength, "none");
    assert.match(out.summary, /No meaningful|no.+seasonality/i);
  });
});
