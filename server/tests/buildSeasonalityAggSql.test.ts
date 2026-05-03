// WSE2 · buildSeasonalityAggSql — pin SQL shape per granularity × shape
// (raw-date / wide-format-PeriodIso) and verify against an in-memory
// DuckDB on a Q4-spike fixture so the math reaches the WSE1 helpers
// correctly.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import duckdb from "duckdb";
import { buildSeasonalityAggSql } from "../lib/seasonality/buildSeasonalityAggSql.js";

// ---------------------------------------------------------------------
// Layer (a) · SQL shape
// ---------------------------------------------------------------------

describe("WSE2 · buildSeasonalityAggSql · SQL shape", () => {
  it("monthly + PeriodIso uses SUBSTR(...,1,4) for year and SUBSTR(...,6,2) for month", () => {
    const r = buildSeasonalityAggSql({
      tableName: "data",
      valueColumn: "Value",
      periodIsoColumn: "PeriodIso",
      grain: "month",
    });
    assert.match(r.sql, /CAST\(SUBSTR\("PeriodIso", 1, 4\) AS INTEGER\) AS year/);
    assert.match(r.sql, /CAST\(SUBSTR\("PeriodIso", 6, 2\) AS INTEGER\) AS position/);
    assert.match(r.sql, /position BETWEEN 1 AND 12/);
    assert.deepEqual(r.columns, ["year", "position", "value"]);
  });

  it("quarterly + PeriodIso uses SUBSTR(...,7,1) for the quarter digit", () => {
    const r = buildSeasonalityAggSql({
      tableName: "data",
      valueColumn: "Value",
      periodIsoColumn: "PeriodIso",
      grain: "quarter",
    });
    assert.match(r.sql, /CAST\(SUBSTR\("PeriodIso", 7, 1\) AS INTEGER\) AS position/);
    assert.match(r.sql, /position BETWEEN 1 AND 4/);
  });

  it("raw-date path uses MONTH() / QUARTER() / YEAR() (not EXTRACT)", () => {
    const monthly = buildSeasonalityAggSql({
      tableName: "data",
      valueColumn: "Sales",
      dateColumn: "Order Date",
      grain: "month",
    });
    assert.match(monthly.sql, /YEAR\(TRY_CAST\("Order Date" AS TIMESTAMP\)\)/);
    assert.match(monthly.sql, /MONTH\(TRY_CAST\("Order Date" AS TIMESTAMP\)\)/);
    assert.doesNotMatch(monthly.sql, /EXTRACT\(/);

    const quarterly = buildSeasonalityAggSql({
      tableName: "data",
      valueColumn: "Sales",
      dateColumn: "Order Date",
      grain: "quarter",
    });
    assert.match(quarterly.sql, /QUARTER\(TRY_CAST\("Order Date" AS TIMESTAMP\)\)/);
  });

  it("dimension column adds 'dimension' column to SELECT and GROUP BY", () => {
    const r = buildSeasonalityAggSql({
      tableName: "data",
      valueColumn: "Value",
      periodIsoColumn: "PeriodIso",
      grain: "month",
      dimensionColumn: "Markets",
    });
    assert.match(r.sql, /"Markets" AS dimension/);
    assert.match(r.sql, /GROUP BY .*"Markets"/);
    assert.deepEqual(r.columns, ["year", "position", "dimension", "value"]);
  });

  it("dimensionFilters compose into WHERE … IN list", () => {
    const r = buildSeasonalityAggSql({
      tableName: "data",
      valueColumn: "Value",
      periodIsoColumn: "PeriodIso",
      grain: "month",
      dimensionFilters: [{ column: "Metric", op: "in", values: ["Value Sales"] }],
    });
    assert.match(r.sql, /WHERE COALESCE\(CAST\("Metric" AS VARCHAR\), ''\) IN \('Value Sales'\)/);
  });

  it("rejects when neither periodIsoColumn nor dateColumn is supplied", () => {
    assert.throws(() =>
      buildSeasonalityAggSql({
        tableName: "data",
        valueColumn: "Value",
        grain: "month",
      })
    );
  });

  it("identifiers with embedded quotes are doubled (injection guard)", () => {
    const r = buildSeasonalityAggSql({
      tableName: "weird table",
      valueColumn: "Net Sales (VND)",
      dimensionColumn: 'Mar"kets',
      periodIsoColumn: "PeriodIso",
      grain: "month",
    });
    assert.match(r.sql, /"weird table"/);
    assert.match(r.sql, /"Net Sales \(VND\)"/);
    assert.match(r.sql, /"Mar""kets"/);
  });

  it("string literal escape (single-quote injection guard)", () => {
    const r = buildSeasonalityAggSql({
      tableName: "data",
      valueColumn: "Value",
      periodIsoColumn: "PeriodIso",
      grain: "month",
      dimensionFilters: [{ column: "Markets", op: "in", values: ["O'Reilly"] }],
    });
    assert.match(r.sql, /'O''Reilly'/);
  });
});

// ---------------------------------------------------------------------
// Layer (b) · live DuckDB execution
// ---------------------------------------------------------------------

interface Row {
  [k: string]: unknown;
}

function exec(db: duckdb.Database, sql: string): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, rows) => {
      if (err) reject(err);
      else resolve((rows ?? []) as Row[]);
    });
  });
}

async function seedFixture(): Promise<duckdb.Database> {
  const db = new duckdb.Database(":memory:");
  await exec(
    db,
    `CREATE TABLE data (
       Markets VARCHAR,
       PeriodIso VARCHAR,
       Value DOUBLE
     )`
  );
  // 5 years × 12 months × 1 market with Q4 spike.
  // Nov +50%, Oct/Dec +25%, others = 100.
  const spike: Record<number, number> = { 10: 1.25, 11: 1.5, 12: 1.25 };
  for (let y = 2018; y <= 2022; y++) {
    for (let m = 1; m <= 12; m++) {
      const v = (100 * (spike[m] ?? 1)).toFixed(2);
      const mm = m < 10 ? `0${m}` : String(m);
      await exec(
        db,
        `INSERT INTO data VALUES ('VN', '${y}-${mm}', ${v})`
      );
    }
  }
  return db;
}

describe("WSE2 · buildSeasonalityAggSql · live DuckDB", () => {
  it("monthly aggregation returns 60 rows (5 years × 12 months)", async () => {
    const db = await seedFixture();
    const { sql } = buildSeasonalityAggSql({
      tableName: "data",
      valueColumn: "Value",
      periodIsoColumn: "PeriodIso",
      grain: "month",
    });
    const rows = await exec(db, sql);
    assert.equal(rows.length, 60);
    // Spot-check Nov 2020.
    const nov2020 = rows.find(
      (r) => Number(r.year) === 2020 && Number(r.position) === 11
    );
    assert.ok(nov2020);
    assert.equal(Number(nov2020!.value), 150);
  });

  it("quarterly aggregation on monthly fixture returns 20 rows (5 years × 4 quarters)", async () => {
    const db = await seedFixture();
    // Use the raw-date path with a synthesised date column.
    await exec(
      db,
      `CREATE TABLE data_dated AS
         SELECT Markets, Value,
                CAST(SUBSTR(PeriodIso, 1, 4) || '-' || SUBSTR(PeriodIso, 6, 2) || '-01' AS DATE) AS Order_Date
         FROM data`
    );
    const { sql } = buildSeasonalityAggSql({
      tableName: "data_dated",
      valueColumn: "Value",
      dateColumn: "Order_Date",
      grain: "quarter",
    });
    const rows = await exec(db, sql);
    assert.equal(rows.length, 20);
    // Q4 2020 = Oct(125) + Nov(150) + Dec(125) = 400 (sum aggregation).
    const q4_2020 = rows.find(
      (r) => Number(r.year) === 2020 && Number(r.position) === 4
    );
    assert.ok(q4_2020);
    assert.equal(Number(q4_2020!.value), 400);
  });
});
