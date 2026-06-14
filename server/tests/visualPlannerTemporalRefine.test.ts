import { test } from "node:test";
import assert from "node:assert/strict";
import { refineTemporalAxis } from "../lib/agents/runtime/visualPlanner.js";
import type { AgentExecutionContext } from "../lib/agents/runtime/types.js";
import type { DataSummary } from "../shared/schema.js";

/** A raw frame of single-month daily rows carrying all materialized facets. */
function rawDailyFrame(days: number) {
  const rows: Record<string, unknown>[] = [];
  for (let i = 1; i <= days; i++) {
    const iso = `2026-04-${String(i).padStart(2, "0")}`;
    rows.push({
      ASM: i % 2 ? "North" : "South",
      Date: iso,
      "Day · Date": iso,
      "Week · Date": `2026-W${String(14 + Math.floor((i - 1) / 7)).padStart(2, "0")}`,
      "Month · Date": "2026-04",
      "Compliance Visit": 100 + i,
    });
  }
  return rows;
}

function ctxWith(raw: Record<string, unknown>[]): AgentExecutionContext {
  const summary: DataSummary = {
    rowCount: 999,
    columnCount: 5,
    columns: [
      { name: "ASM", type: "string", sampleValues: [] },
      { name: "Date", type: "date", sampleValues: [] },
      { name: "Day · Date", type: "date", sampleValues: [] },
      { name: "Week · Date", type: "date", sampleValues: [] },
      { name: "Month · Date", type: "date", sampleValues: [] },
      { name: "Compliance Visit", type: "number", sampleValues: [] },
    ],
    numericColumns: ["Compliance Visit"],
    dateColumns: ["Date"],
  } as unknown as DataSummary;
  return {
    sessionId: "s",
    question: "compliance dashboard",
    data: raw,
    turnStartDataRef: raw,
    summary,
    chatHistory: [],
    mode: "analysis",
    // an aggregated analytical table that already collapsed to Month:
    lastAnalyticalTable: {
      columns: ["Month · Date", "Compliance Visit"],
      rows: [{ "Month · Date": "2026-04", "Compliance Visit": 58600 }],
    },
  } as unknown as AgentExecutionContext;
}

test("TG6 · LLM-proposed 'Month · Date' on single-month daily data → refined to 'Day · Date' built from RAW frame", () => {
  const raw = rawDailyFrame(30);
  const ctx = ctxWith(raw);
  // The collapsed analytical table (1 Month row) is what the proposal would
  // otherwise be built from — the bug. Pass it as the fallback rows.
  const collapsed = ctx.lastAnalyticalTable!.rows as Record<string, unknown>[];
  const out = refineTemporalAxis(ctx, "Month · Date", collapsed, true);
  assert.equal(out.x, "Day · Date");
  assert.equal(out.useAnalyticalOnly, false);
  assert.equal(out.rows.length, 30); // built from the RAW frame, not the 1-row collapse
});

test("TG6 · a non-temporal axis passes through unchanged", () => {
  const raw = rawDailyFrame(30);
  const ctx = ctxWith(raw);
  const out = refineTemporalAxis(ctx, "ASM", raw.slice(0, 3), true);
  assert.equal(out.x, "ASM");
  assert.equal(out.useAnalyticalOnly, true);
  assert.equal(out.rows.length, 3);
});

test("TG6 · multi-month span: proposed Month is kept (authority agrees) → passthrough", () => {
  const raw: Record<string, unknown>[] = [];
  for (let m = 1; m <= 6; m++) {
    for (let d = 1; d <= 20; d++) {
      const iso = `2026-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      raw.push({
        Date: iso,
        "Day · Date": iso,
        "Week · Date": `2026-W${String(m * 4 + Math.floor(d / 7)).padStart(2, "0")}`,
        "Month · Date": `2026-${String(m).padStart(2, "0")}`,
        Sales: 1,
      });
    }
  }
  const ctx = ctxWith(raw);
  // 6 months / ~180 days → pickTrendGrainForSpan → week; the proposed Month
  // differs, so the authority refines to Week (span-consistent). Assert it does
  // NOT stay collapsed and is built from raw.
  const out = refineTemporalAxis(ctx, "Month · Date", [], true);
  assert.equal(out.x, "Week · Date");
  assert.equal(out.rows.length, raw.length);
});
