// Wave H3 · sub-day intent detection. Explicitly-cyclical phrasing → hour_of_day;
// bare "hourly"/"by hour" → "hour" (the authority later downgrades to hour_of_day
// on multi-day spans). CRITICAL negatives: duration phrasings like "working hours"
// must NOT be read as hour bucketing, and "24-hour"/"happy hour" must not fire.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectCoarseTimeIntentFromMessage } from "../lib/temporalFacetColumns.js";

const intent = detectCoarseTimeIntentFromMessage;

describe("Wave H3 · forced cyclical (hour_of_day)", () => {
  for (const q of [
    "what is the peak hour for logins",
    "busiest hour of the day",
    "show sales by hour of day",
    "footfall by time of day",
    "which hour has the most orders",
    "hourly pattern of website visits",
  ]) {
    it(q, () => assert.equal(intent(q), "hour_of_day"));
  }
});

describe("Wave H3 · bare/absolute hour", () => {
  for (const q of [
    "show hourly sales",
    "revenue by hour",
    "orders per hour",
    "intraday trend of transactions",
    "sales hour-by-hour on June 22",
  ]) {
    it(q, () => assert.equal(intent(q), "hour"));
  }
});

describe("Wave H3 · minute", () => {
  for (const q of ["transactions by minute", "load minute-by-minute", "errors every 5 minutes"]) {
    it(q, () => assert.equal(intent(q), "minute"));
  }
});

describe("Wave H3 · negatives (must NOT be hour/minute intents)", () => {
  for (const q of [
    "average working hours per employee", // duration, not bucketing
    "total man-hours by department",
    "we offer 24-hour support", // not temporal bucketing
    "monthly sales trend", // calendar intent preserved
    "revenue by region",
  ]) {
    it(q, () => {
      const r = intent(q);
      assert.ok(r !== "hour" && r !== "hour_of_day" && r !== "minute", `got ${r}`);
    });
  }
  it("monthly still resolves to month", () => assert.equal(intent("monthly sales trend"), "month"));
});
