// Wave T4 · build_chart `grain` — lets any chart go by day/week/month/quarter/
// half_year/year. Prefers the precomputed `<Grain> · <Date>` facet column when
// present; otherwise buckets the raw date x at the requested grain.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../lib/agents/runtime/toolRegistry.js";
import { registerDefaultTools } from "../lib/agents/runtime/tools/registerTools.js";
import type { DataSummary } from "../shared/schema.js";

function isoWeek(day: number): string {
  // April 2026 days 1..30 → ISO-ish week labels for the fixture (coarse is fine;
  // we only assert the bucket column / bucket count, not the exact week math).
  const wk = 14 + Math.floor((day - 1) / 7);
  return `2026-W${wk}`;
}

function dailyRows(withWeekFacet: boolean): Record<string, unknown>[] {
  return Array.from({ length: 30 }, (_, i) => {
    const d = i + 1;
    const row: Record<string, unknown> = {
      Date: `2026-04-${String(d).padStart(2, "0")}`,
      Sales: 100 + d,
    };
    if (withWeekFacet) row["Week · Date"] = isoWeek(d);
    return row;
  });
}

function summaryFor(cols: string[]): DataSummary {
  return {
    rowCount: 30,
    columnCount: cols.length,
    columns: cols.map((name) => ({
      name,
      type: name === "Sales" ? "number" : name === "Date" ? "date" : "string",
      sampleValues: [],
    })),
    numericColumns: ["Sales"],
    dateColumns: ["Date"],
  } as unknown as DataSummary;
}

function ctxFor(data: Record<string, unknown>[], summary: DataSummary): any {
  return {
    exec: { mode: "analysis", sessionId: "t", summary, data, question: "sales over time" },
    metadata: {},
  };
}

describe("Wave T4 · build_chart grain parameter", () => {
  it("grain:'week' uses the precomputed 'Week · Date' facet column when present", async () => {
    const reg = new ToolRegistry();
    registerDefaultTools(reg);
    const data = dailyRows(true);
    const ctx = ctxFor(data, summaryFor(["Date", "Week · Date", "Sales"]));
    const out = await reg.execute(
      "build_chart",
      { type: "line", x: "Date", y: "Sales", aggregate: "sum", grain: "week" },
      ctx,
    );
    assert.equal(out.ok, true);
    assert.equal(out.memorySlots?.chart_x, "Week · Date");
  });

  it("grain:'week' buckets the raw date when no facet column exists", async () => {
    const reg = new ToolRegistry();
    registerDefaultTools(reg);
    const data = dailyRows(false); // only Date + Sales
    const ctx = ctxFor(data, summaryFor(["Date", "Sales"]));
    const out = await reg.execute(
      "build_chart",
      { type: "line", x: "Date", y: "Sales", aggregate: "sum", grain: "week" },
      ctx,
    );
    assert.equal(out.ok, true);
    assert.equal(out.memorySlots?.chart_x, "Date");
    const points = (out.charts?.[0] as { data: unknown[] })?.data?.length ?? 0;
    // 30 daily rows → a handful of weekly buckets, far fewer than 30.
    assert.ok(points >= 4 && points <= 8, `expected ~weekly buckets, got ${points}`);
  });

  it("grain omitted leaves the x column unchanged", async () => {
    const reg = new ToolRegistry();
    registerDefaultTools(reg);
    const data = dailyRows(true);
    const ctx = ctxFor(data, summaryFor(["Date", "Week · Date", "Sales"]));
    const out = await reg.execute(
      "build_chart",
      { type: "line", x: "Date", y: "Sales", aggregate: "sum" },
      ctx,
    );
    assert.equal(out.ok, true);
    assert.equal(out.memorySlots?.chart_x, "Date");
  });
});
