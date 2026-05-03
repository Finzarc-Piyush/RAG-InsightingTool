// WGR6 · End-to-end pipeline test that pins the full Marico-VN-style
// trend/growth contract from upload-time melt through the compute_growth
// tool. The point: prove that on a 3-year × 3-market × 4-quarter
// compound-shape wide CSV, the system computes growth across ALL years
// (not just Year1 → Year2) and correctly ranks the fastest-growing market.
//
// Pipeline traversed:
//   parseFile → classifyDataset → meltDataset →
//   applyWideFormatTransformToSummary → registerComputeGrowthTool →
//   compute_growth (in-memory path) → assert YoY across 3 years +
//   rankByGrowth ordering.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFile, createDataSummary } from "../lib/fileParser.js";
import { classifyDataset } from "../lib/wideFormat/classifyDataset.js";
import { meltDataset } from "../lib/wideFormat/meltDataset.js";
import { applyWideFormatTransformToSummary } from "../lib/wideFormat/applyWideFormatToSummary.js";
import { ToolRegistry } from "../lib/agents/runtime/toolRegistry.js";
import { registerComputeGrowthTool } from "../lib/agents/runtime/tools/computeGrowthTool.js";
import { buildGrowthSql } from "../lib/growth/buildGrowthSql.js";

function csv(rows: string[]): Buffer {
  return Buffer.from(rows.join("\n"), "utf-8");
}

// 3 markets × 3 years × 4 quarters × 1 metric (Value Sales) = 36 long rows.
//   VN: ramp 100→133→177    (~33% YoY)
//   IN: flat 80
//   ID: 120→90→67.5         (-25% YoY)
function buildFixtureCsv(): Buffer {
  const markets: Array<[string, number, number]> = [
    ["VN", 100, 1.33],
    ["IN", 80, 1.0],
    ["ID", 120, 0.75],
  ];
  // Build header: "Markets,<each year-quarter Value Sales>"
  const periods: string[] = [];
  for (let yi = 0; yi < 3; yi++) {
    const yyShort = String(2022 + yi).slice(2);
    for (let q = 1; q <= 4; q++) periods.push(`Q${q} ${yyShort} Value Sales`);
  }
  const header = `"Markets",${periods.map((p) => `"${p}"`).join(",")}`;
  const lines = [header];
  for (const [mkt, base, yoy] of markets) {
    const cells: string[] = [`"${mkt}"`];
    for (let yi = 0; yi < 3; yi++) {
      const yearBase = base * Math.pow(yoy, yi);
      for (let q = 1; q <= 4; q++) {
        const v = (yearBase * (1 + q * 0.05)).toFixed(2);
        cells.push(`"đ${v}"`);
      }
    }
    lines.push(cells.join(","));
  }
  return csv(lines);
}

describe("WGR6 · golden e2e — growth analysis on Marico-VN-style wide-format CSV", () => {
  it("upload pipeline detects compound shape and melts to 36 long rows", async () => {
    const buf = buildFixtureCsv();
    const wideRows = await parseFile(buf, "marico-vn-trend.csv");
    assert.equal(wideRows.length, 3); // 3 market rows wide

    const headers = Object.keys(wideRows[0] ?? {});
    const classification = classifyDataset(headers);
    assert.equal(classification.isWide, true);
    // Compound: each header carries period AND a metric token (Value Sales).
    assert.equal(classification.shape, "compound");

    const melted = meltDataset(wideRows, classification);
    // 3 markets × 12 periods × 1 metric = 36 long rows
    assert.equal(melted.rows.length, 36);

    // Schema check.
    for (const r of melted.rows) {
      assert.ok("Markets" in r);
      assert.ok("Period" in r);
      assert.ok("PeriodIso" in r);
      assert.ok("Metric" in r);
      assert.ok("Value" in r);
      assert.equal(typeof r.Value, "number");
    }
  });

  it("YoY ranking via the compute_growth tool puts VN at the top, ID at the bottom — across ALL three years", async () => {
    const buf = buildFixtureCsv();
    let data = await parseFile(buf, "marico-vn-trend.csv");
    const classification = classifyDataset(Object.keys(data[0] ?? {}));
    const melted = meltDataset(data, classification);
    data = melted.rows;
    const summary = createDataSummary(data);
    applyWideFormatTransformToSummary(summary, {
      detected: true,
      shape: melted.summary.shape,
      idColumns: melted.summary.idColumns,
      meltedColumns: melted.summary.meltedColumns,
      periodCount: melted.summary.periodCount,
      periodColumn: melted.summary.periodColumn,
      periodIsoColumn: melted.summary.periodIsoColumn,
      periodKindColumn: melted.summary.periodKindColumn,
      valueColumn: melted.summary.valueColumn,
      metricColumn: melted.summary.metricColumn,
      detectedCurrencySymbol: melted.summary.detectedCurrencySymbol,
    });

    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);

    // Run rankByGrowth — YoY across the post-melt long rows.
    const ctx: any = {
      exec: {
        mode: "analysis",
        sessionId: "e2e-test",
        summary,
        data,
      },
      config: {},
    };

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
        // Compound-shape Metric guard requires the Metric filter (or
        // metric-on-groupBy). The data only has one metric here, so an
        // exact filter is straightforward.
        dimensionFilters: [
          { column: "Metric", op: "in", values: ["Value Sales"] },
        ],
      },
      ctx
    );
    assert.equal(out.ok, true, `compute_growth failed: ${out.summary}`);
    const rows = out.table?.rows as Array<{
      dimension: string;
      growth_pct: number;
    }>;
    assert.equal(rows.length, 3);
    assert.equal(rows[0].dimension, "VN", "VN must be the fastest-growing market");
    assert.equal(rows[2].dimension, "ID", "ID must be the slowest / declining market");
    assert.ok(rows[0].growth_pct > 0, "VN growth_pct positive");
    assert.ok(rows[2].growth_pct < 0, "ID growth_pct negative");
  });

  it("YoY series via compute_growth produces growth pairs for Year2 AND Year3 (not just Year2)", async () => {
    const buf = buildFixtureCsv();
    let data = await parseFile(buf, "marico-vn-trend.csv");
    const classification = classifyDataset(Object.keys(data[0] ?? {}));
    const melted = meltDataset(data, classification);
    data = melted.rows;
    const summary = createDataSummary(data);
    applyWideFormatTransformToSummary(summary, {
      detected: true,
      shape: melted.summary.shape,
      idColumns: melted.summary.idColumns,
      meltedColumns: melted.summary.meltedColumns,
      periodCount: melted.summary.periodCount,
      periodColumn: melted.summary.periodColumn,
      periodIsoColumn: melted.summary.periodIsoColumn,
      periodKindColumn: melted.summary.periodKindColumn,
      valueColumn: melted.summary.valueColumn,
      metricColumn: melted.summary.metricColumn,
      detectedCurrencySymbol: melted.summary.detectedCurrencySymbol,
    });

    const reg = new ToolRegistry();
    registerComputeGrowthTool(reg);
    const ctx: any = {
      exec: {
        mode: "analysis",
        sessionId: "e2e-test",
        summary,
        data,
      },
      config: {},
    };
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
          { column: "Metric", op: "in", values: ["Value Sales"] },
        ],
      },
      ctx
    );
    assert.equal(out.ok, true);
    const rows = out.table?.rows as Array<{
      dimension: string;
      period: string;
      growth_pct: number | null;
    }>;
    // 3 markets × 12 periods = 36; non-null growth for Year2 + Year3 = 24.
    assert.equal(rows.length, 36);
    const nonNull = rows.filter((r) => r.growth_pct !== null);
    assert.equal(
      nonNull.length,
      24,
      "must have YoY pairs for BOTH Year2 AND Year3 — pre-WGR fix only got Year2"
    );

    // Spot-check that VN has Year3-vs-Year2 AND Year2-vs-Year1 pairs (the
    // bug the user reported was missing data after Year2).
    const vnY2 = rows.find((r) => r.dimension === "VN" && r.period === "2023-Q1");
    const vnY3 = rows.find((r) => r.dimension === "VN" && r.period === "2024-Q1");
    assert.ok(vnY2);
    assert.ok(vnY3);
    assert.notEqual(vnY2!.growth_pct, null, "VN Year2 Q1 has YoY (vs Year1)");
    assert.notEqual(vnY3!.growth_pct, null, "VN Year3 Q1 has YoY (vs Year2)");
  });

  it("buildGrowthSql for the same fixture wires PeriodIso into ORDER BY and lag=4 for YoY-quarterly", () => {
    const built = buildGrowthSql({
      tableName: "data",
      metricColumn: "Value",
      dimensionColumn: "Markets",
      periodIsoColumn: "PeriodIso",
      grain: "yoy",
      periodKind: "quarter",
      mode: "rankByGrowth",
      dimensionFilters: [{ column: "Metric", op: "in", values: ["Value Sales"] }],
      topN: 10,
    });
    assert.equal(built.lagOffset, 4);
    assert.match(built.sql, /PARTITION BY dimension ORDER BY period ASC/);
    // PeriodIso surfaces as the period axis (quoted).
    assert.match(built.sql, /"PeriodIso"/);
    assert.match(built.sql, /ORDER BY growth_pct DESC NULLS LAST/);
  });
});
