// WGR2 · buildGrowthSql tests — pin the SQL shape per mode/grain and
// verify execution against an in-memory DuckDB on a small fixture so
// "fastest growing market" actually returns the right answer.
//
// Two layers:
//   (a) string-shape tests — fast, deterministic, catch obvious regressions
//   (b) live DuckDB tests  — pin numerical correctness end-to-end
//
// Both layers stay in this single test file (per CLAUDE.md explicit-test-list rule).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import duckdb from "duckdb";
import { buildGrowthSql } from "../lib/growth/buildGrowthSql.js";

// ---------------------------------------------------------------------
// Layer (a) · SQL string-shape tests
// ---------------------------------------------------------------------

describe("WGR2 · buildGrowthSql · SQL shape", () => {
  it("series mode emits PARTITION BY dimension and LAG by 4 for YoY-quarterly", () => {
    const r = buildGrowthSql({
      tableName: "data",
      metricColumn: "Value",
      dimensionColumn: "Markets",
      periodIsoColumn: "PeriodIso",
      grain: "yoy",
      periodKind: "quarter",
      mode: "series",
    });
    assert.match(r.sql, /PARTITION BY dimension ORDER BY period ASC/);
    assert.match(r.sql, /LAG\(value, 4\)/);
    assert.equal(r.lagOffset, 4);
    assert.deepEqual(r.columns, [
      "dimension",
      "period",
      "value",
      "prior_value",
      "growth_pct",
      "growth_abs",
    ]);
  });

  it("series mode uses LAG by 12 for YoY-monthly", () => {
    const r = buildGrowthSql({
      tableName: "data",
      metricColumn: "Sales",
      dimensionColumn: "Region",
      periodIsoColumn: "PeriodIso",
      grain: "yoy",
      periodKind: "month",
      mode: "series",
    });
    assert.match(r.sql, /LAG\(value, 12\)/);
    assert.equal(r.lagOffset, 12);
  });

  it("QoQ uses LAG 1", () => {
    const r = buildGrowthSql({
      tableName: "data",
      metricColumn: "Value",
      periodIsoColumn: "PeriodIso",
      grain: "qoq",
      periodKind: "quarter",
      mode: "summary",
    });
    assert.match(r.sql, /LAG\(value, 1\)/);
    assert.equal(r.lagOffset, 1);
  });

  it("WoW with weekly kind uses LAG 1", () => {
    const r = buildGrowthSql({
      tableName: "data",
      metricColumn: "Value",
      periodIsoColumn: "PeriodIso",
      grain: "wow",
      periodKind: "week",
      mode: "summary",
    });
    assert.match(r.sql, /LAG\(value, 1\)/);
  });

  it("rankByGrowth requires dimension and emits ORDER BY growth_pct DESC LIMIT", () => {
    const r = buildGrowthSql({
      tableName: "data",
      metricColumn: "Value",
      dimensionColumn: "Markets",
      periodIsoColumn: "PeriodIso",
      grain: "yoy",
      periodKind: "quarter",
      mode: "rankByGrowth",
      topN: 5,
    });
    assert.match(r.sql, /ORDER BY growth_pct DESC NULLS LAST/);
    assert.match(r.sql, /LIMIT 5/);
    assert.match(r.sql, /ROW_NUMBER\(\) OVER \(PARTITION BY dimension/);
  });

  it("rankByGrowth without dimension throws", () => {
    assert.throws(() =>
      buildGrowthSql({
        tableName: "data",
        metricColumn: "Value",
        periodIsoColumn: "PeriodIso",
        grain: "yoy",
        mode: "rankByGrowth",
      })
    );
  });

  it("topN is clamped to [2, 50]", () => {
    const tooSmall = buildGrowthSql({
      tableName: "data",
      metricColumn: "Value",
      dimensionColumn: "Markets",
      periodIsoColumn: "PeriodIso",
      grain: "yoy",
      periodKind: "quarter",
      mode: "rankByGrowth",
      topN: 1,
    });
    assert.match(tooSmall.sql, /LIMIT 2/);
    const tooBig = buildGrowthSql({
      tableName: "data",
      metricColumn: "Value",
      dimensionColumn: "Markets",
      periodIsoColumn: "PeriodIso",
      grain: "yoy",
      periodKind: "quarter",
      mode: "rankByGrowth",
      topN: 999,
    });
    assert.match(tooBig.sql, /LIMIT 50/);
  });

  it("dateColumn fallback uses date_trunc when periodIsoColumn missing", () => {
    const r = buildGrowthSql({
      tableName: "data",
      metricColumn: "Value",
      dateColumn: "Date",
      grain: "mom",
      periodKind: "month",
      mode: "summary",
    });
    assert.match(r.sql, /date_trunc\('month',/);
  });

  it("identifiers are quoted (defensive against odd column names)", () => {
    const r = buildGrowthSql({
      tableName: "weird table",
      metricColumn: "Net Sales (VND)",
      dimensionColumn: "Mar\"kets",
      periodIsoColumn: "PeriodIso",
      grain: "yoy",
      periodKind: "quarter",
      mode: "series",
    });
    assert.match(r.sql, /"weird table"/);
    assert.match(r.sql, /"Net Sales \(VND\)"/);
    // Embedded double-quote is doubled per quoteIdent contract.
    assert.match(r.sql, /"Mar""kets"/);
  });

  it("dimensionFilters compose into WHERE … IN list", () => {
    const r = buildGrowthSql({
      tableName: "data",
      metricColumn: "Value",
      dimensionColumn: "Markets",
      periodIsoColumn: "PeriodIso",
      grain: "yoy",
      periodKind: "quarter",
      mode: "series",
      dimensionFilters: [
        { column: "Metric", op: "in", values: ["Value Sales"] },
      ],
    });
    assert.match(r.sql, /WHERE COALESCE\(CAST\("Metric" AS VARCHAR\), ''\) IN \('Value Sales'\)/);
  });

  it("not_in dimension filter inverts to NOT IN", () => {
    const r = buildGrowthSql({
      tableName: "data",
      metricColumn: "Value",
      dimensionColumn: "Markets",
      periodIsoColumn: "PeriodIso",
      grain: "yoy",
      periodKind: "quarter",
      mode: "series",
      dimensionFilters: [
        { column: "Markets", op: "not_in", values: ["FEMALE SHOWER GEL"] },
      ],
    });
    assert.match(r.sql, /NOT IN \('FEMALE SHOWER GEL'\)/);
  });

  it("SQL string literals escape single quotes (injection guard)", () => {
    const r = buildGrowthSql({
      tableName: "data",
      metricColumn: "Value",
      dimensionColumn: "Markets",
      periodIsoColumn: "PeriodIso",
      grain: "yoy",
      periodKind: "quarter",
      mode: "series",
      dimensionFilters: [
        { column: "Markets", op: "in", values: ["O'Reilly"] },
      ],
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
       Metric  VARCHAR,
       Period  VARCHAR,
       PeriodIso VARCHAR,
       Value DOUBLE
     )`
  );
  // 3-year × 4-quarter × 3-market panel; metric "Value Sales" only.
  // VN: ramp 100→200 across years (steady ~33% YoY)
  // IN: flat 80
  // ID: declining 120→60 (-25% YoY each year)
  const rows: Array<[string, string, string, string, number]> = [];
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
        const v = +(yearBase * (1 + q * 0.05)).toFixed(2); // small intra-year wiggle
        rows.push([
          mkt,
          "Value Sales",
          `Q${q} ${String(year).slice(2)}`,
          `${year}-Q${q}`,
          v,
        ]);
      }
    }
  }
  for (const r of rows) {
    await exec(
      db,
      `INSERT INTO data VALUES ('${r[0]}', '${r[1]}', '${r[2]}', '${r[3]}', ${r[4]})`
    );
  }
  return db;
}

describe("WGR2 · buildGrowthSql · live DuckDB", () => {
  it("YoY series produces a value for every year-pair (Year3-Year2 AND Year3-Year1 chain)", async () => {
    const db = await seedFixture();
    const { sql } = buildGrowthSql({
      tableName: "data",
      metricColumn: "Value",
      dimensionColumn: "Markets",
      periodIsoColumn: "PeriodIso",
      grain: "yoy",
      periodKind: "quarter",
      mode: "series",
    });
    const rows = await exec(db, sql);
    // 3 markets × 12 periods = 36 rows total. The first year (4 periods
    // per market) has NULL prior_value (no Year-1). Years 2 and 3 have
    // valid YoY pairs ⇒ 3 markets × 8 periods = 24 non-null growth_pct.
    assert.equal(rows.length, 36);
    const nonNull = rows.filter((r) => r.growth_pct !== null);
    assert.equal(nonNull.length, 24, "YoY non-null count covers Year2 AND Year3 (not just Year2)");
    // Spot-check VN Year3 Q1 ~ 33% growth over Year2 Q1.
    const vnY3Q1 = rows.find(
      (r) => r.Markets === undefined && r.dimension === "VN" && r.period === "2024-Q1"
    );
    assert.ok(vnY3Q1, "found VN 2024-Q1 row");
    assert.ok(typeof vnY3Q1!.growth_pct === "number");
    assert.ok(
      Math.abs(Number(vnY3Q1!.growth_pct) - 0.33) < 0.05,
      `VN 2024-Q1 YoY ≈ 0.33, got ${vnY3Q1!.growth_pct}`
    );
  });

  it("rankByGrowth orders markets by latest YoY growth — VN top, ID bottom", async () => {
    const db = await seedFixture();
    const { sql } = buildGrowthSql({
      tableName: "data",
      metricColumn: "Value",
      dimensionColumn: "Markets",
      periodIsoColumn: "PeriodIso",
      grain: "yoy",
      periodKind: "quarter",
      mode: "rankByGrowth",
      topN: 10,
    });
    const rows = await exec(db, sql);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].dimension, "VN", "VN is fastest growing");
    assert.equal(rows[2].dimension, "ID", "ID is fastest declining");
    assert.ok(Number(rows[0].growth_pct) > 0);
    assert.ok(Number(rows[2].growth_pct) < 0);
  });

  it("dimensionFilters narrow the SQL — only Value Sales metric", async () => {
    const db = await seedFixture();
    // Add a noise row with a different metric — should be excluded.
    await exec(
      db,
      `INSERT INTO data VALUES ('VN', 'Volume', 'Q1 24', '2024-Q1', 9999)`
    );
    const { sql } = buildGrowthSql({
      tableName: "data",
      metricColumn: "Value",
      dimensionColumn: "Markets",
      periodIsoColumn: "PeriodIso",
      grain: "yoy",
      periodKind: "quarter",
      mode: "rankByGrowth",
      dimensionFilters: [{ column: "Metric", op: "in", values: ["Value Sales"] }],
    });
    const rows = await exec(db, sql);
    // VN top should still be ~33% — not poisoned by the 9999 noise row.
    const vn = rows.find((r) => r.dimension === "VN")!;
    assert.ok(Math.abs(Number(vn.growth_pct) - 0.33) < 0.05);
  });

  it("QoQ series gives latest-quarter delta — Q4 vs Q3, Q3 vs Q2, etc.", async () => {
    const db = await seedFixture();
    const { sql } = buildGrowthSql({
      tableName: "data",
      metricColumn: "Value",
      dimensionColumn: "Markets",
      periodIsoColumn: "PeriodIso",
      grain: "qoq",
      periodKind: "quarter",
      mode: "series",
    });
    const rows = await exec(db, sql);
    // Q1 of each year has a prior (the prior year's Q4) since LAG 1 over
    // sorted PeriodIso. Only the very first row per market has NULL prior.
    const nullPrior = rows.filter((r) => r.prior_value === null);
    assert.equal(nullPrior.length, 3, "one NULL prior per market");
  });

  it("summary mode aggregates across all dimensions", async () => {
    const db = await seedFixture();
    const { sql } = buildGrowthSql({
      tableName: "data",
      metricColumn: "Value",
      periodIsoColumn: "PeriodIso",
      grain: "yoy",
      periodKind: "quarter",
      mode: "summary",
    });
    const rows = await exec(db, sql);
    // 12 distinct periods (3 years × 4 quarters), 8 with non-null priors.
    assert.equal(rows.length, 12);
    const nonNull = rows.filter((r) => r.growth_pct !== null);
    assert.equal(nonNull.length, 8);
  });
});
