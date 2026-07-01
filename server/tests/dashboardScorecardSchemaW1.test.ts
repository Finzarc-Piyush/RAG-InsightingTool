import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dashboardCardDefinitionSchema,
  dashboardScorecardSpecSchema,
  chartSpecSchema,
  dashboardTableSpecSchema,
  dashboardSheetSchema,
  dashboardSheetSpecSchema,
  dashboardSchema,
  dashboardSpecSchema,
  dashboardPatchSchema,
} from "../shared/schema.js";

/**
 * Wave W1 (data-bound cards) · the schema spine for recomputable,
 * data-bound dashboard tiles. This test PINS the L-021 trap: a persisted
 * field is declared in FIVE separate Zod objects, and adding it to one is
 * not enough — an object that doesn't learn the field silently strips it on
 * the round-trip. Here we assert the new `cardDefinition` / `scorecards`
 * survive EVERY object they must travel through (chart/table specs, sheet,
 * sheet-spec, dashboard doc, dashboard spec, patch), plus back-compat.
 */

const CARD_DEF = {
  version: 1 as const,
  cardType: "scorecard" as const,
  measure: { kind: "column" as const, ref: "NR", label: "Net Revenue" },
  aggregation: "avg" as const,
  filters: [{ column: "Channel", op: "in" as const, values: ["GT"] }],
  comparison: { mode: "period_over_period" as const },
};

const SCORECARD = {
  id: "sc_nr_gt",
  title: "NR (avg) · GT",
  cardDefinition: CARD_DEF,
  format: "currency" as const,
  currencyCode: "INR",
  decimals: 0,
  metricPolarity: "higher_better" as const,
  snapshot: {
    value: 482_00_000,
    priorValue: 445_00_000,
    deltaAbs: 37_00_000,
    deltaPct: 0.083,
    tone: "good" as const,
    sparkline: [
      { label: "Feb", value: 4.1 },
      { label: "Mar", value: 4.45 },
      { label: "Apr", value: 4.82 },
    ],
    periodLabel: "Apr vs Mar",
    computedAt: 1_700_000_000_000,
    dataVersion: 2,
  },
};

describe("W1 · cardDefinition + scorecard spec parse", () => {
  it("parses a full card definition (measure×agg×filter)", () => {
    const parsed = dashboardCardDefinitionSchema.parse(CARD_DEF);
    assert.equal(parsed.measure.ref, "NR");
    assert.equal(parsed.aggregation, "avg");
    assert.equal(parsed.filters?.[0].column, "Channel");
    assert.deepEqual(parsed.filters?.[0].values, ["GT"]);
  });

  it("parses a scorecard spec and preserves the computed snapshot", () => {
    const parsed = dashboardScorecardSpecSchema.parse(SCORECARD);
    assert.equal(parsed.snapshot?.value, 482_00_000);
    assert.equal(parsed.snapshot?.deltaPct, 0.083);
    assert.equal(parsed.snapshot?.tone, "good");
    assert.equal(parsed.snapshot?.sparkline?.length, 3);
    assert.equal(parsed.metricPolarity, "higher_better");
    assert.equal(parsed.currencyCode, "INR");
  });

  it("rejects a bad currency code (guardrail on the format side)", () => {
    assert.throws(() =>
      dashboardScorecardSpecSchema.parse({ ...SCORECARD, currencyCode: "rupees" })
    );
  });
});

describe("W1 · cardDefinition rides on chart + table specs", () => {
  it("chart spec round-trips with a cardDefinition", () => {
    const chart = {
      type: "bar" as const,
      title: "NR by Channel",
      x: "Channel",
      y: "NR",
      cardDefinition: { ...CARD_DEF, cardType: "chart" as const, groupBy: ["Channel"] },
    };
    const parsed = chartSpecSchema.parse(chart);
    assert.ok(parsed.cardDefinition, "cardDefinition must survive chartSpec parse");
    assert.equal(parsed.cardDefinition?.cardType, "chart");
    assert.deepEqual(parsed.cardDefinition?.groupBy, ["Channel"]);
  });

  it("table spec round-trips with a cardDefinition", () => {
    const table = {
      caption: "NR by Channel",
      columns: ["Channel", "NR"],
      rows: [["GT", 482]],
      cardDefinition: { ...CARD_DEF, cardType: "table" as const },
    };
    const parsed = dashboardTableSpecSchema.parse(table);
    assert.ok(parsed.cardDefinition, "cardDefinition must survive tableSpec parse");
  });

  it("a legacy chart/table with NO cardDefinition still parses (back-compat)", () => {
    const legacyChart = chartSpecSchema.parse({
      type: "line" as const,
      title: "trend",
      x: "Month",
      y: "NR",
    });
    assert.equal(legacyChart.cardDefinition, undefined);
    const legacyTable = dashboardTableSpecSchema.parse({
      caption: "t",
      columns: ["a"],
      rows: [["x"]],
    });
    assert.equal(legacyTable.cardDefinition, undefined);
  });
});

describe("W1 · scorecards survive EVERY dashboard object (L-021 strip guard)", () => {
  it("sheet + sheet-spec carry per-sheet scorecards", () => {
    const sheet = dashboardSheetSchema.parse({
      id: "s1",
      name: "Sheet 1",
      charts: [],
      scorecards: [SCORECARD],
    });
    assert.equal(sheet.scorecards?.length, 1);
    assert.equal(sheet.scorecards?.[0].id, "sc_nr_gt");

    const sheetSpec = dashboardSheetSpecSchema.parse({
      id: "s1",
      name: "Sheet 1",
      scorecards: [SCORECARD],
    });
    assert.equal(sheetSpec.scorecards?.length, 1);
  });

  it("dashboard document carries the top-level Exec-Summary scorecard band", () => {
    const doc = dashboardSchema.parse({
      id: "d1",
      username: "u@x.com",
      name: "D",
      createdAt: 1,
      updatedAt: 1,
      charts: [],
      scorecards: [SCORECARD],
    });
    assert.equal(doc.scorecards?.length, 1);
    assert.equal(doc.scorecards?.[0].snapshot?.value, 482_00_000);
  });

  it("dashboard SPEC carries scorecards top-level AND per-sheet (spec→persist round-trip)", () => {
    const spec = dashboardSpecSchema.parse({
      name: "D",
      template: "executive" as const,
      sheets: [
        { id: "sheet_summary", name: "Executive summary", scorecards: [SCORECARD] },
      ],
      scorecards: [SCORECARD],
    });
    assert.equal(spec.scorecards?.length, 1);
    assert.equal(spec.sheets[0].scorecards?.length, 1);
  });

  it("dashboard PATCH carries a whole-array scorecard replace (edit/recompute)", () => {
    const patch = dashboardPatchSchema.parse({ scorecards: [SCORECARD] });
    assert.equal(patch.scorecards?.length, 1);
  });

  it("a legacy dashboard doc with NO scorecards parses unchanged (back-compat)", () => {
    const doc = dashboardSchema.parse({
      id: "d0",
      username: "u@x.com",
      name: "legacy",
      createdAt: 1,
      updatedAt: 1,
      charts: [],
    });
    assert.equal(doc.scorecards, undefined);
  });
});
