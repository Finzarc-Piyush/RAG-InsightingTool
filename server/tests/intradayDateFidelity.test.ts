// Wave H0 · intraday-timestamp ingest fidelity. parseFlexibleDate must recognize
// space- AND T-separated datetimes (previously only `T`-separated ISO parsed, so
// "2026-06-22 14:30" returned null and lost its time), and the canonical storage
// form must keep the wall-clock hour the user typed (naive, no UTC `Z` shift).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFlexibleDate } from "../lib/dateUtils.js";

describe("Wave H0 · parseFlexibleDate intraday shapes", () => {
  it("parses space-separated datetime (HH:MM) and keeps the local hour/minute", () => {
    const d = parseFlexibleDate("2026-06-22 14:30");
    assert.ok(d instanceof Date && !isNaN(d.getTime()), "should parse, not null");
    assert.equal(d!.getFullYear(), 2026);
    assert.equal(d!.getMonth(), 5); // June = 5
    assert.equal(d!.getDate(), 22);
    assert.equal(d!.getHours(), 14);
    assert.equal(d!.getMinutes(), 30);
  });

  it("parses space-separated datetime with seconds", () => {
    const d = parseFlexibleDate("2026-06-22 14:30:45");
    assert.ok(d instanceof Date && !isNaN(d.getTime()));
    assert.equal(d!.getHours(), 14);
    assert.equal(d!.getSeconds(), 45);
  });

  it("parses T-separated ISO datetime", () => {
    const d = parseFlexibleDate("2026-06-22T09:05:00");
    assert.ok(d instanceof Date && !isNaN(d.getTime()));
    assert.equal(d!.getHours(), 9);
    assert.equal(d!.getMinutes(), 5);
  });

  it("parses M/D/YYYY HH:MM datetime", () => {
    const d = parseFlexibleDate("06/22/2026 23:15");
    assert.ok(d instanceof Date && !isNaN(d.getTime()));
    assert.equal(d!.getMonth(), 5);
    assert.equal(d!.getDate(), 22);
    assert.equal(d!.getHours(), 23);
    assert.equal(d!.getMinutes(), 15);
  });

  it("still parses date-only values (no time component)", () => {
    const d = parseFlexibleDate("2026-06-22");
    assert.ok(d instanceof Date && !isNaN(d.getTime()));
    assert.equal(d!.getHours(), 0);
    assert.equal(d!.getMinutes(), 0);
  });

  it("rejects out-of-range times", () => {
    assert.equal(parseFlexibleDate("2026-06-22 25:00"), null);
    assert.equal(parseFlexibleDate("2026-06-22 14:75"), null);
  });
});
