import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DataSummary, DashboardScorecardSpec } from "../shared/schema.js";
import { computeScorecard } from "../lib/scorecard/computeScorecard.js";

/**
 * Wave W4 (data-bound cards) · computeScorecard. Pins the end-to-end KPI
 * math over real rows: monthly period bucketing, latest-vs-prior delta,
 * direction-aware tone, sparkline ordering, and the degenerate paths
 * (no temporal column, vs-target, empty result).
 */

const NR_COL = {
  name: "NR",
  type: "numeric",
  additivity: "additive",
  semantics: { semanticType: "measure_additive", aggregation: "sum", displayKind: "numeric", source: "auto" },
} as any;
const DATE_COL = { name: "Date", type: "date", sampleValues: [] } as any;
const CHANNEL_COL = { name: "Channel", type: "text", uniqueValues: 2 } as any;

const summary: DataSummary = {
  columns: [DATE_COL, NR_COL, CHANNEL_COL],
  numericColumns: ["NR"],
  dateColumns: ["Date"],
  totalRows: 6,
  sampleRows: [],
} as any;

// GT monthly sums: Jan 100, Feb 120, Mar 90, Apr 150. One MT row that the
// Channel=GT filter must exclude.
const ROWS = [
  { Date: "2017-01-10", Channel: "GT", NR: 60 },
  { Date: "2017-01-20", Channel: "GT", NR: 40 },
  { Date: "2017-02-15", Channel: "GT", NR: 120 },
  { Date: "2017-03-15", Channel: "GT", NR: 90 },
  { Date: "2017-04-15", Channel: "GT", NR: 150 },
  { Date: "2017-04-15", Channel: "MT", NR: 999 },
];
const loadRows = async () => ROWS;

function scorecard(over: Partial<DashboardScorecardSpec["cardDefinition"]> = {}, top: Partial<DashboardScorecardSpec> = {}): DashboardScorecardSpec {
  return {
    id: "sc",
    title: "NR · GT",
    metricPolarity: "higher_better",
    cardDefinition: {
      cardType: "scorecard",
      measure: { kind: "column", ref: "NR", label: "Net Revenue" },
      aggregation: "sum",
      filters: [{ column: "Channel", op: "in", values: ["GT"] }],
      comparison: { mode: "period_over_period" },
      ...over,
    },
    ...top,
  } as DashboardScorecardSpec;
}

describe("W4 · computeScorecard period-over-period", () => {
  it("latest month vs prior, with sparkline + tone", async () => {
    const snap = await computeScorecard(scorecard(), { summary, loadRows, now: 123 });
    assert.equal(snap.value, 150, "latest (Apr) GT sum");
    assert.equal(snap.priorValue, 90, "prior (Mar) GT sum");
    assert.equal(snap.deltaAbs, 60);
    assert.ok(Math.abs((snap.deltaPct ?? 0) - 60 / 90) < 1e-9);
    assert.equal(snap.tone, "good", "NR is higher_better, went up → good");
    assert.equal(snap.computedAt, 123);
    // Sparkline is chronologically ordered Jan→Apr (NOT lexical Apr,Feb,Jan,Mar).
    assert.deepEqual(
      snap.sparkline?.map((p) => p.value),
      [100, 120, 90, 150]
    );
    assert.match(snap.periodLabel ?? "", /Apr 2017 vs Mar 2017/);
  });

  it("lower_better metric going up → bad", async () => {
    const snap = await computeScorecard(
      scorecard({}, { metricPolarity: "lower_better" }),
      { summary, loadRows, now: 1 }
    );
    assert.equal(snap.value, 150);
    assert.equal(snap.tone, "bad", "up is bad for a lower_better metric");
  });
});

describe("W4 · degenerate paths", () => {
  it("no temporal column → single total, no delta, neutral tone", async () => {
    const noDate: DataSummary = { ...summary, dateColumns: [], columns: [{ ...DATE_COL, type: "text" }, NR_COL, CHANNEL_COL] } as any;
    const snap = await computeScorecard(scorecard({ comparison: { mode: "none" } }), {
      summary: noDate,
      loadRows,
      now: 1,
    });
    assert.equal(snap.value, 460, "sum of all GT NR (100+120+90+150)");
    assert.equal(snap.deltaPct ?? null, null);
    assert.equal(snap.tone, "neutral");
  });

  it("vs-target: latest above target → good", async () => {
    const snap = await computeScorecard(
      scorecard({ comparison: { mode: "vs_target", target: 140 } }),
      { summary, loadRows, now: 1 }
    );
    assert.equal(snap.value, 150);
    assert.equal(snap.targetValue, 140);
    assert.equal(snap.deltaAbs, 10);
    assert.equal(snap.tone, "good");
  });

  it("empty result (filter matches nothing) → value null, neutral", async () => {
    const snap = await computeScorecard(
      scorecard({ filters: [{ column: "Channel", op: "in", values: ["NOPE"] }] }),
      { summary, loadRows, now: 1 }
    );
    assert.equal(snap.value, null);
    assert.equal(snap.tone, "neutral");
  });
});
