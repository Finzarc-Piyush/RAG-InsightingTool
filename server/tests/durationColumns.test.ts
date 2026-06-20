import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseDurationToHours,
  classifyAsDuration,
  formatHoursAsDuration,
  timeOfDayToSeconds,
  formatSecondsAsClock,
} from "../lib/durationColumns.js";

/**
 * DUR1 · the duration authority. "Working Hrs" (HH:MM:SS elapsed time) must be
 * recognised as a numeric quantity (decimal hours), distinct from a time-of-day
 * clock reading ("Clock-In Time"). These pin parse, classify (incl. the
 * duration-vs-clock disambiguation + the ≥24h strong signal), and the display
 * formatters.
 */

describe("parseDurationToHours", () => {
  it("parses HH:MM:SS to decimal hours", () => {
    assert.ok(Math.abs(parseDurationToHours("03:31:57")! - 3.5325) < 1e-6);
    assert.equal(parseDurationToHours("00:00:00"), 0);
    assert.ok(Math.abs(parseDurationToHours("05:08:52")! - 5.147777) < 1e-4);
  });
  it("parses HH:MM (no seconds) as hours:minutes", () => {
    assert.equal(parseDurationToHours("01:30"), 1.5);
  });
  it("parses durations >= 24h (not capped like a clock)", () => {
    assert.equal(parseDurationToHours("30:15:00"), 30.25);
  });
  it("passes through a numeric (already-hours) value", () => {
    assert.equal(parseDurationToHours(8), 8);
  });
  it("returns null for sentinels and non-durations", () => {
    assert.equal(parseDurationToHours("Absent"), null);
    assert.equal(parseDurationToHours(""), null);
    assert.equal(parseDurationToHours(null), null);
    assert.equal(parseDurationToHours("hello"), null);
  });
});

describe("classifyAsDuration", () => {
  const work = ["03:31:57", "00:00:00", "05:08:52", "03:16:19", "08:23:54", "03:10:18"];

  it("classifies a duration-named HH:MM:SS column as duration", () => {
    const v = classifyAsDuration("Working Hrs", work);
    assert.equal(v.isDuration, true);
    assert.equal(v.strongSignal, false);
  });

  it("does NOT classify a clock-named column as duration", () => {
    const clock = ["09:45:34", "10:05:45", "09:18:57", "09:48:06", "10:28:21", "09:58:54"];
    assert.equal(classifyAsDuration("Clock-In Time", clock).isDuration, false);
  });

  it("treats any value >= 24h as a strong duration signal regardless of name", () => {
    const v = classifyAsDuration("Elapsed", ["30:15:00", "26:00:00", "01:00:00", "02:30:00", "12:00:00"]);
    assert.equal(v.isDuration, true);
    assert.equal(v.strongSignal, true);
  });

  it("requires >= 5 non-sentinel samples", () => {
    assert.equal(classifyAsDuration("Working Hrs", ["03:31:57", "Absent"]).isDuration, false);
  });

  it("does NOT classify a plain numeric column (e.g. counts >= 24) as duration", () => {
    assert.equal(
      classifyAsDuration("Total PC", [30, 45, 12, 8, 60, 27]).isDuration,
      false
    );
  });

  it("collects sentinel values", () => {
    const v = classifyAsDuration("Working Hrs", [...work, "Absent", "N/A"]);
    assert.deepEqual(v.sentinelValues, ["Absent", "N/A"]);
  });
});

describe("formatHoursAsDuration", () => {
  it("formats hm by default", () => {
    assert.equal(formatHoursAsDuration(3.5325), "3h 32m");
    assert.equal(formatHoursAsDuration(0), "0h 00m");
  });
  it("formats hms and decimal", () => {
    assert.equal(formatHoursAsDuration(3.5325, "hms"), "03:31:57");
    assert.equal(formatHoursAsDuration(3.5325, "decimal"), "3.53h");
  });
  it("handles non-finite as em-dash", () => {
    assert.equal(formatHoursAsDuration(null), "—");
    assert.equal(formatHoursAsDuration(NaN), "—");
  });
});

describe("timeOfDayToSeconds / formatSecondsAsClock", () => {
  it("parses clock to seconds since midnight", () => {
    assert.equal(timeOfDayToSeconds("09:45:34"), 9 * 3600 + 45 * 60 + 34);
    assert.equal(timeOfDayToSeconds("00:00:00"), 0);
  });
  it("rejects >= 24h and sentinels", () => {
    assert.equal(timeOfDayToSeconds("30:15:00"), null);
    assert.equal(timeOfDayToSeconds("Absent"), null);
  });
  it("formats seconds back to HH:MM", () => {
    assert.equal(formatSecondsAsClock(9 * 3600 + 51 * 60), "09:51");
    assert.equal(formatSecondsAsClock(null), "—");
  });
});
