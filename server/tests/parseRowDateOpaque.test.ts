import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRowDate } from "../lib/temporalFacetColumns.js";

const MS_PER_DAY = 86400000;

describe("parseRowDate — primitive inputs", () => {
  it("returns null for null/undefined/empty", () => {
    assert.equal(parseRowDate(null), null);
    assert.equal(parseRowDate(undefined), null);
    assert.equal(parseRowDate(""), null);
  });

  it("returns the same JS Date for a valid Date instance", () => {
    const d = new Date("2024-03-15T00:00:00Z");
    const out = parseRowDate(d);
    assert.ok(out instanceof Date);
    assert.equal(out!.getTime(), d.getTime());
  });

  it("parses Excel serial day numbers", () => {
    const out = parseRowDate(44941);
    assert.ok(out instanceof Date);
    assert.equal(out!.getUTCFullYear(), 2023);
  });

  it("parses ISO date strings", () => {
    const out = parseRowDate("2023-01-15");
    assert.ok(out instanceof Date);
    assert.equal(out!.getUTCFullYear(), 2023);
    assert.equal(out!.getUTCMonth(), 0);
  });

  it("parses M/D/YYYY date strings", () => {
    const out = parseRowDate("1/15/2023");
    assert.ok(out instanceof Date);
    assert.equal(out!.getFullYear(), 2023);
  });
});

describe("parseRowDate — opaque object wrappers (DuckDB / driver-shaped)", () => {
  it("returns null for plain empty object {}", () => {
    assert.equal(parseRowDate({}), null);
  });

  it("returns null for the literal string '[object Object]'", () => {
    assert.equal(parseRowDate("[object Object]"), null);
  });

  it("parses wrappers exposing toISOString()", () => {
    const wrapper = {
      toISOString() {
        return "2023-06-01T00:00:00.000Z";
      },
    };
    const out = parseRowDate(wrapper);
    assert.ok(out instanceof Date);
    assert.equal(out!.getUTCFullYear(), 2023);
    assert.equal(out!.getUTCMonth(), 5);
  });

  it("parses wrappers with .epochMs", () => {
    const ms = Date.UTC(2024, 0, 1);
    const out = parseRowDate({ epochMs: ms });
    assert.ok(out instanceof Date);
    assert.equal(out!.getTime(), ms);
  });

  it("parses wrappers with .epochSeconds", () => {
    const seconds = Math.floor(Date.UTC(2024, 0, 1) / 1000);
    const out = parseRowDate({ epochSeconds: seconds });
    assert.ok(out instanceof Date);
    assert.equal(out!.getTime(), seconds * 1000);
  });

  it("parses DuckDB DATE-shaped wrappers via .days", () => {
    // DuckDB DATE = days since 1970-01-01.
    // 19723 days = 2024-01-01 UTC.
    const out = parseRowDate({ days: 19723 });
    assert.ok(out instanceof Date);
    assert.equal(out!.getTime(), 19723 * MS_PER_DAY);
    assert.equal(out!.getUTCFullYear(), 2024);
  });

  it("parses DuckDB TIMESTAMP-shaped wrappers via .micros (bigint)", () => {
    const ms = Date.UTC(2025, 5, 15);
    const out = parseRowDate({ micros: BigInt(ms) * 1000n });
    assert.ok(out instanceof Date);
    assert.equal(out!.getTime(), ms);
  });

  it("parses DuckDB TIMESTAMP-shaped wrappers via .micros (number)", () => {
    const ms = Date.UTC(2025, 5, 15);
    const out = parseRowDate({ micros: ms * 1000 });
    assert.ok(out instanceof Date);
    assert.equal(out!.getTime(), ms);
  });

  it("falls back to toString() for wrappers that stringify to a date", () => {
    const wrapper = {
      toString() {
        return "2024-07-04";
      },
    };
    const out = parseRowDate(wrapper);
    assert.ok(out instanceof Date);
    assert.equal(out!.getUTCFullYear(), 2024);
  });

  it("returns null for arrays (not Dates)", () => {
    assert.equal(parseRowDate([2024, 1, 1]), null);
  });

  it("returns null for wrappers with no recognised shape", () => {
    assert.equal(parseRowDate({ foo: "bar" }), null);
    assert.equal(parseRowDate({ days: NaN }), null);
    assert.equal(parseRowDate({ micros: Number.POSITIVE_INFINITY }), null);
  });
});
