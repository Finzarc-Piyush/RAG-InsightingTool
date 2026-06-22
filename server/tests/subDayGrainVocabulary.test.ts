// Wave H2 · sub-day grain vocabulary. The grain authority/facet module must know
// hour / hour_of_day / minute as first-class grains: correct period keys (sortable),
// facet display-key round-trip, and the "Hour of day" label must not be swallowed
// by the shorter "Hour" alternative.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeDateToPeriod } from "../lib/dateUtils.js";
import {
  facetColumnKey,
  parseTemporalFacetDisplayKey,
  temporalFacetGrainTokenFromFacetColumnName,
  isTemporalFacetColumnKey,
} from "../lib/temporalFacetColumns.js";

const d = new Date(2026, 5, 22, 14, 30, 0); // 2026-06-22 14:30:00 local

describe("Wave H2 · normalizeDateToPeriod sub-day keys", () => {
  it("hour → absolute YYYY-MM-DD HH bucket", () => {
    assert.equal(normalizeDateToPeriod(d, "hour")?.normalizedKey, "2026-06-22 14");
  });
  it("minute → absolute YYYY-MM-DD HH:MM bucket", () => {
    assert.equal(normalizeDateToPeriod(d, "minute")?.normalizedKey, "2026-06-22 14:30");
  });
  it("hour_of_day → zero-padded cyclical key (sorts chronologically)", () => {
    assert.equal(normalizeDateToPeriod(d, "hour_of_day")?.normalizedKey, "14");
    const early = new Date(2026, 5, 22, 8, 0, 0);
    assert.equal(normalizeDateToPeriod(early, "hour_of_day")?.normalizedKey, "08");
    assert.ok("08" < "14", "zero-padded keys sort as clock order");
  });
});

describe("Wave H2 · facet display-key round-trip", () => {
  it("hour", () => {
    const key = facetColumnKey("Stamp", "hour");
    assert.equal(key, "Hour · Stamp");
    assert.deepEqual(parseTemporalFacetDisplayKey(key), { sourceColumn: "Stamp", grain: "hour" });
  });
  it("hour_of_day round-trips and is NOT mis-parsed as 'hour'", () => {
    const key = facetColumnKey("Stamp", "hour_of_day");
    assert.equal(key, "Hour of day · Stamp");
    assert.deepEqual(parseTemporalFacetDisplayKey(key), {
      sourceColumn: "Stamp",
      grain: "hour_of_day",
    });
    assert.equal(temporalFacetGrainTokenFromFacetColumnName(key), "hour_of_day");
  });
  it("minute", () => {
    const key = facetColumnKey("Stamp", "minute");
    assert.deepEqual(parseTemporalFacetDisplayKey(key), { sourceColumn: "Stamp", grain: "minute" });
  });
  it("isTemporalFacetColumnKey recognizes all sub-day display keys", () => {
    assert.ok(isTemporalFacetColumnKey("Hour · Stamp"));
    assert.ok(isTemporalFacetColumnKey("Hour of day · Stamp"));
    assert.ok(isTemporalFacetColumnKey("Minute · Stamp"));
    assert.ok(!isTemporalFacetColumnKey("Login Time"));
  });
});
