import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isAnsweredByExistingCharts,
  filterAnsweredFollowUps,
  generateDeeperFollowUps,
  deepenFollowUps,
  humanizeMeasure,
  humanizeDimension,
  normalizeLabel,
  type ChartLike,
} from "../shared/followUpDeepening.js";

// Mirrors the dashboard in the user report: compliance visits charted against
// cluster, ASM, HQ and attendance status (plus a daily trend).
const COMPLIANCE_CHARTS: ChartLike[] = [
  { type: "bar", y: "Compliance Visit_sum", x: "Cluster Name", title: "Compliance Visit_sum by Cluster Name" },
  { type: "bar", y: "Compliance Visit_sum", x: "ASM", title: "Compliance Visit_sum by ASM" },
  { type: "bar", y: "Compliance Visit_sum", x: "HQ Name", title: "Compliance Visit_sum by HQ Name" },
  { type: "bar", y: "Compliance Visit_sum", x: "Attendance Status", title: "Compliance Visit_sum by Attendance Status" },
  { type: "line", y: "Compliance Visit_avg", x: "Date", title: "Compliance Visit_avg by Day · Date" },
];

test("label humanizers strip aggregation + trailer noise", () => {
  assert.equal(humanizeMeasure("Compliance Visit_sum"), "Compliance Visit");
  assert.equal(humanizeMeasure("PJP Adherence_avg"), "PJP Adherence");
  assert.equal(humanizeDimension("Cluster Name"), "Cluster");
  assert.equal(humanizeDimension("HQ Name"), "HQ");
  assert.equal(humanizeDimension("Attendance Status"), "Attendance Status");
  assert.equal(normalizeLabel("Cluster Name"), "cluster");
});

test("agg suffix is stripped ONLY on the underscore delimiter, never a space", () => {
  // Real metric names ending in an agg-word must survive intact.
  assert.equal(humanizeMeasure("Win Rate"), "Win Rate");
  assert.equal(humanizeMeasure("Market Share"), "Market Share");
  assert.equal(humanizeMeasure("Order Count"), "Order Count");
  assert.equal(humanizeMeasure("Sales Total"), "Sales Total");
  // Engine underscore form is still cleaned.
  assert.equal(humanizeMeasure("Sales_sum"), "Sales");
  assert.equal(humanizeMeasure("Revenue_total"), "Revenue");
});

test("generation reads cleanly for a space-named rate metric (no truncation)", () => {
  const charts: ChartLike[] = [
    { type: "bar", y: "Win Rate", x: "Region", title: "Win Rate by Region" },
    { type: "bar", y: "Win Rate", x: "Channel", title: "Win Rate by Channel" },
  ];
  const deeper = generateDeeperFollowUps(charts, { limit: 3 });
  assert.ok(deeper.length >= 1);
  for (const q of deeper) {
    assert.match(q, /Win Rate/, q); // not truncated to "Win"
    assert.doesNotMatch(q, /\bWin by\b|\bWin vary\b/);
  }
});

test("interaction template never pairs the measure with a time axis", () => {
  // One categorical + one temporal: interaction must be skipped, no "vary by Date".
  const charts: ChartLike[] = [
    { type: "bar", y: "Sales_sum", x: "Region", title: "Sales by Region" },
    { type: "line", y: "Sales_sum", x: "Date", title: "Sales by Date" },
  ];
  const deeper = generateDeeperFollowUps(charts, { limit: 4 });
  for (const q of deeper) assert.doesNotMatch(q, /vary by Date|within each Date/i, q);
});

test("cross-metric skips a near-tautology (Net Sales vs Sales)", () => {
  const charts: ChartLike[] = [
    { type: "bar", y: "Net Sales_sum", x: "Region", title: "Net Sales by Region" },
    { type: "bar", y: "Sales_sum", x: "Region", title: "Sales by Region" },
  ];
  const deeper = generateDeeperFollowUps(charts, { limit: 4 });
  assert.equal(deeper.some((q) => /relate to/i.test(q)), false, deeper.join(" | "));
});

test("ratio questions (per-entity) are treated as deeper, not already-answered", () => {
  const charts: ChartLike[] = [
    { type: "bar", y: "Revenue_sum", x: "Month", title: "Revenue by Month" },
    { type: "bar", y: "Sales_sum", x: "Region", title: "Sales by Region" },
  ];
  assert.equal(isAnsweredByExistingCharts("How does revenue per store vary by month?", charts), false);
  assert.equal(isAnsweredByExistingCharts("How do sales per rep vary by region?", charts), false);
  // …but a plain trailing "per <dim>" breakdown is still answered.
  const cmp: ChartLike[] = [{ type: "bar", y: "Compliance Visit_sum", x: "Cluster Name" }];
  assert.equal(isAnsweredByExistingCharts("Compliance visits per cluster", cmp), true);
});

test("dimMatches uses whole-token subset, not within-word substring", () => {
  // "attendance" ⊆ {attendance, status} → answered.
  assert.equal(isAnsweredByExistingCharts("How do compliance visits vary by attendance?", COMPLIANCE_CHARTS), true);
});

test("flat breakdowns matching a charted dimension are flagged answered", () => {
  assert.equal(isAnsweredByExistingCharts("How do compliance visits vary by cluster?", COMPLIANCE_CHARTS), true);
  assert.equal(isAnsweredByExistingCharts("How do compliance visits vary by ASM?", COMPLIANCE_CHARTS), true);
  assert.equal(isAnsweredByExistingCharts("How does PJP adherence vary by HQ Name?", COMPLIANCE_CHARTS), true);
  assert.equal(isAnsweredByExistingCharts("Compliance visits by attendance status", COMPLIANCE_CHARTS), true);
});

test("a breakdown by an UNCHARTED dimension is NOT flagged", () => {
  assert.equal(isAnsweredByExistingCharts("How do compliance visits vary by region?", COMPLIANCE_CHARTS), false);
  assert.equal(isAnsweredByExistingCharts("How do compliance visits vary by device platform?", COMPLIANCE_CHARTS), false);
});

test("plural / odd breakdown phrasings still match a charted dimension", () => {
  assert.equal(isAnsweredByExistingCharts("Break compliance visits down across clusters", COMPLIANCE_CHARTS), true);
  assert.equal(isAnsweredByExistingCharts("Compliance visits per cluster", COMPLIANCE_CHARTS), true);
  assert.equal(isAnsweredByExistingCharts("Show me visits grouped by ASM", COMPLIANCE_CHARTS), true);
});

test("a deeper ask that NAMES a charted dim but adds qualifying words is NOT dropped", () => {
  const charts: ChartLike[] = [{ type: "bar", y: "Sales_sum", x: "Region", title: "Sales by Region" }];
  // YoY comparison — "by region to last year" must not be mistaken for "by region".
  assert.equal(isAnsweredByExistingCharts("Compare sales by region to last year", charts), false);
  // A nested / more-specific slice is a different, deeper question.
  assert.equal(isAnsweredByExistingCharts("How do sales vary by region and channel?", charts), false);
});

test("deeper-dive questions are never flagged answered (even if they name a charted dim)", () => {
  assert.equal(isAnsweredByExistingCharts("What explains the differences in compliance visits by cluster?", COMPLIANCE_CHARTS), false);
  assert.equal(isAnsweredByExistingCharts("Within each cluster, how does compliance vary by attendance status?", COMPLIANCE_CHARTS), false);
  assert.equal(isAnsweredByExistingCharts("Which cluster is the biggest outlier and why?", COMPLIANCE_CHARTS), false);
  assert.equal(isAnsweredByExistingCharts("How has compliance trended over time by cluster?", COMPLIANCE_CHARTS), false);
});

test("filterAnsweredFollowUps drops the redundant restatements", () => {
  const stored = [
    "How do compliance visits vary by cluster?",
    "How do compliance visits vary by ASM?",
    "How does PJP adherence vary by HQ Name?",
  ];
  assert.deepEqual(filterAnsweredFollowUps(stored, COMPLIANCE_CHARTS), []);
});

test("generateDeeperFollowUps produces deeper, non-restating questions", () => {
  const deeper = generateDeeperFollowUps(COMPLIANCE_CHARTS, { limit: 3 });
  assert.equal(deeper.length, 3);
  // None may be a flat breakdown already on a chart.
  for (const q of deeper) {
    assert.equal(isAnsweredByExistingCharts(q, COMPLIANCE_CHARTS), false, `should be deeper: ${q}`);
  }
  // The strongest (interaction) leads, and the measure reads cleanly (no "_sum").
  assert.match(deeper[0]!, /within each/i);
  for (const q of deeper) assert.doesNotMatch(q, /_sum|_avg/);
});

test("deepenFollowUps replaces all-redundant stored prompts with deeper ones", () => {
  const stored = [
    "How do compliance visits vary by cluster?",
    "How do compliance visits vary by ASM?",
    "How does PJP adherence vary by HQ Name?",
  ];
  const result = deepenFollowUps(stored, COMPLIANCE_CHARTS, { limit: 3 });
  assert.equal(result.length, 3);
  // Every result is a genuine deeper dive, not a chart restatement…
  for (const q of result) {
    assert.equal(isAnsweredByExistingCharts(q, COMPLIANCE_CHARTS), false, q);
  }
  // …and none of the original flat prompts survive verbatim.
  for (const original of stored) {
    assert.equal(result.includes(original), false, `flat prompt should be gone: ${original}`);
  }
});

test("deepenFollowUps keeps a stored prompt that is already a deeper dive", () => {
  const stored = ["Why is Cluster 2 NORTH 45% below the compliance average?"];
  const result = deepenFollowUps(stored, COMPLIANCE_CHARTS, { limit: 3 });
  assert.ok(result.includes("Why is Cluster 2 NORTH 45% below the compliance average?"));
  assert.ok(result.length >= 1 && result.length <= 3);
});

test("deepenFollowUps is a safe passthrough when there are no charts", () => {
  const stored = ["How do compliance visits vary by cluster?", "and another one"];
  assert.deepEqual(deepenFollowUps(stored, [], { limit: 3 }), stored);
  assert.deepEqual(deepenFollowUps([], [], { limit: 3 }), []);
});

test("cross-metric relationship surfaces when two measures are charted", () => {
  const charts: ChartLike[] = [
    { type: "bar", y: "Revenue_sum", x: "Region", title: "Revenue by Region" },
    { type: "bar", y: "Spend_sum", x: "Region", title: "Spend by Region" },
  ];
  const deeper = generateDeeperFollowUps(charts, { limit: 4 });
  assert.ok(deeper.some((q) => /relate to/i.test(q)), deeper.join(" | "));
});

test("output is capped at the requested limit and deduped", () => {
  const result = deepenFollowUps(["dup", "dup", "DUP"], COMPLIANCE_CHARTS, { limit: 2 });
  assert.ok(result.length <= 2);
});
