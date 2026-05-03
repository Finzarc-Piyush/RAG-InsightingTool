import { test } from "node:test";
import assert from "node:assert/strict";
import type { DataSummary } from "../shared/schema.js";
import { buildDeterministicScopeFacts } from "../lib/datasetScopeFacts.js";

const superstoreSummary: DataSummary = {
  rowCount: 9800,
  columnCount: 5,
  columns: [
    {
      name: "Order Date",
      type: "date",
      sampleValues: ["1/4/15", "1/5/15", "6/30/16", "12/30/18"],
    },
    {
      name: "Region",
      type: "string",
      sampleValues: ["West", "East", "Central", "South"],
      topValues: [
        { value: "West", count: 3203 },
        { value: "East", count: 2848 },
        { value: "Central", count: 2323 },
        { value: "South", count: 1620 },
      ],
    },
    {
      name: "Category",
      type: "string",
      sampleValues: [],
      topValues: Array.from({ length: 17 }, (_, i) => ({ value: `cat${i}`, count: 100 })),
    },
    { name: "Sales", type: "number", sampleValues: [] },
    { name: "Order ID", type: "string", sampleValues: [], topValues: [{ value: "X", count: 1 }] },
  ],
  numericColumns: ["Sales"],
  dateColumns: ["Order Date"],
};

test("highlights include time span pulled from date sampleValues", () => {
  const facts = buildDeterministicScopeFacts(superstoreSummary);
  const span = facts.highlights.find((h) => /years|months|→/.test(h));
  assert.ok(span, `expected a time-span bullet in ${JSON.stringify(facts.highlights)}`);
  assert.match(span!, /\(2015 → 2018\)/);
});

test("highlights include scope counts pluralized from low-cardinality categorical columns", () => {
  const facts = buildDeterministicScopeFacts(superstoreSummary);
  const joined = facts.highlights.join(" | ");
  assert.match(joined, /4 regions/);
  assert.match(joined, /17 categories/);
});

test("highlights skip identifier-looking columns even when topValues is present", () => {
  const facts = buildDeterministicScopeFacts(superstoreSummary);
  for (const h of facts.highlights) {
    assert.doesNotMatch(h, /order id/i, `Order ID leaked into highlights: ${h}`);
  }
});

test("highlights include a row-count records-in-scope bullet", () => {
  const facts = buildDeterministicScopeFacts(superstoreSummary);
  const records = facts.highlights.find((h) => /records in scope/.test(h));
  assert.ok(records, `expected a row-count bullet in ${JSON.stringify(facts.highlights)}`);
  assert.match(records!, /9\.8K/);
});

test("analyzeThemes picks the primary metric heuristically (Sales)", () => {
  const facts = buildDeterministicScopeFacts(superstoreSummary);
  const joined = facts.analyzeThemes.join(" | ");
  assert.match(joined, /Track Sales over time/);
  assert.match(joined, /Compare Sales across regions/);
});

test("analyzeThemes caps at 4 entries", () => {
  const facts = buildDeterministicScopeFacts(superstoreSummary);
  assert.ok(facts.analyzeThemes.length <= 4);
  assert.ok(facts.analyzeThemes.length >= 1);
});

test("dataset without dates omits the time-span bullet but still produces highlights", () => {
  const noDate: DataSummary = {
    ...superstoreSummary,
    dateColumns: [],
    columns: superstoreSummary.columns.filter((c) => c.name !== "Order Date"),
    columnCount: 4,
  };
  const facts = buildDeterministicScopeFacts(noDate);
  const span = facts.highlights.find((h) => /→/.test(h));
  assert.equal(span, undefined);
  assert.ok(facts.highlights.length >= 2);
});

test("dataset with two numeric columns and no metric hint surfaces a relationship theme", () => {
  const twoMetrics: DataSummary = {
    rowCount: 100,
    columnCount: 3,
    columns: [
      { name: "x", type: "number", sampleValues: [] },
      { name: "y", type: "number", sampleValues: [] },
      {
        name: "Region",
        type: "string",
        sampleValues: [],
        topValues: [
          { value: "A", count: 10 },
          { value: "B", count: 10 },
        ],
      },
    ],
    numericColumns: ["x", "y"],
    dateColumns: [],
  };
  const facts = buildDeterministicScopeFacts(twoMetrics);
  const joined = facts.analyzeThemes.join(" | ");
  assert.match(joined, /Compare key metrics across regions/);
  assert.match(joined, /relationship between x and y/);
});

test("empty-ish dataset still returns at least one analyze theme", () => {
  const empty: DataSummary = {
    rowCount: 0,
    columnCount: 0,
    columns: [],
    numericColumns: [],
    dateColumns: [],
  };
  const facts = buildDeterministicScopeFacts(empty);
  assert.ok(facts.analyzeThemes.length >= 1);
  assert.equal(facts.highlights.length, 0);
});

test("pluralization handles 'category' → 'categories'", () => {
  const facts = buildDeterministicScopeFacts(superstoreSummary);
  assert.ok(facts.highlights.some((h) => h.includes("categories")));
});

// Regression — Marico-VN wide-format columns are already plural English nouns
// ("Facts", "Markets", "Products"). The old pluraliser blindly appended "es"
// to any -s suffix, producing "factses / marketses / productses". Now we
// singularise first, then re-pluralise.
test("pluralization does not double-pluralize already-plural column headers", () => {
  const wideMaricoSummary: DataSummary = {
    rowCount: 13_500,
    columnCount: 7,
    columns: [
      {
        name: "Facts",
        type: "string",
        sampleValues: [],
        topValues: Array.from({ length: 24 }, (_, i) => ({ value: `metric${i}`, count: 10 })),
      },
      {
        name: "Markets",
        type: "string",
        sampleValues: [],
        topValues: Array.from({ length: 5 }, (_, i) => ({ value: `mkt${i}`, count: 10 })),
      },
      {
        name: "Products",
        type: "string",
        sampleValues: [],
        topValues: Array.from({ length: 5 }, (_, i) => ({ value: `prod${i}`, count: 10 })),
      },
      { name: "Value", type: "number", sampleValues: [] },
    ],
    numericColumns: ["Value"],
    dateColumns: [],
  };
  const facts = buildDeterministicScopeFacts(wideMaricoSummary);
  const joined = `${facts.highlights.join(" | ")} || ${facts.analyzeThemes.join(" | ")}`;
  assert.doesNotMatch(joined, /factses|marketses|productses/, joined);
  assert.match(joined, /24 facts/);
  assert.match(joined, /5 markets/);
  assert.match(joined, /5 products/);
});
