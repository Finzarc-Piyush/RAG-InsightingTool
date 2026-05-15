import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isTimeOfDayValue,
  classifyAsTimeOfDay,
} from "../lib/dateUtils.js";
import { createDataSummary } from "../lib/fileParser.js";

describe("Wave TOD1 · time-of-day detection", () => {
  describe("isTimeOfDayValue", () => {
    it("matches HH:MM and HH:MM:SS", () => {
      assert.equal(isTimeOfDayValue("09:45:34"), true);
      assert.equal(isTimeOfDayValue("9:45"), true);
      assert.equal(isTimeOfDayValue("23:59:59"), true);
      assert.equal(isTimeOfDayValue("00:00"), true);
      assert.equal(isTimeOfDayValue("  09:30  "), true, "trims whitespace");
    });

    it("rejects out-of-range values", () => {
      assert.equal(isTimeOfDayValue("24:00:00"), false);
      assert.equal(isTimeOfDayValue("12:60"), false);
      assert.equal(isTimeOfDayValue("99:99"), false);
    });

    it("rejects non-time-only strings", () => {
      assert.equal(isTimeOfDayValue("Absent"), false);
      assert.equal(isTimeOfDayValue("2024-01-01"), false);
      assert.equal(isTimeOfDayValue("2024-01-01T09:45:34"), false);
      assert.equal(isTimeOfDayValue("9:45 AM"), false, "AM/PM not supported v1");
      assert.equal(isTimeOfDayValue(""), false);
    });
  });

  describe("classifyAsTimeOfDay", () => {
    const TIME_SAMPLES = [
      "09:45:34",
      "10:05:45",
      "09:18:57",
      "09:48:06",
      "10:28:21",
      "11:19:35",
      "09:58:54",
      "08:23:54",
    ];

    it("flags HH:MM:SS column with time-y name", () => {
      const verdict = classifyAsTimeOfDay("Clock-In Time", TIME_SAMPLES);
      assert.equal(verdict.isTimeOfDay, true);
      assert.deepEqual(verdict.sentinelValues, []);
    });

    it("captures sentinel placeholders alongside time values", () => {
      const samples = [...TIME_SAMPLES, "Absent", "Absent", "N/A"];
      const verdict = classifyAsTimeOfDay("Clock-In Time", samples);
      assert.equal(verdict.isTimeOfDay, true);
      assert.ok(verdict.sentinelValues.includes("Absent"));
      assert.ok(verdict.sentinelValues.includes("N/A"));
    });

    it("rejects when too few non-sentinel samples", () => {
      const samples = ["09:00", "09:30", "Absent", "Absent"];
      const verdict = classifyAsTimeOfDay("Clock-In Time", samples);
      assert.equal(verdict.isTimeOfDay, false);
    });

    it("rejects without a time-hint name unless share is high enough", () => {
      // 6/8 = 75% time, name has no time hint → reject (need 95% without hint).
      const mixed = [
        "09:00",
        "09:30",
        "10:00",
        "11:00",
        "12:00",
        "13:00",
        "morning",
        "evening",
      ];
      assert.equal(
        classifyAsTimeOfDay("Greeting", mixed).isTimeOfDay,
        false,
      );
      // Same shape but name hints "time" → 75% < 85% threshold, still rejected.
      assert.equal(
        classifyAsTimeOfDay("Time Of Day", mixed).isTimeOfDay,
        false,
      );
    });

    it("accepts even without time-hint name when share is overwhelming (>=95%)", () => {
      // 19/20 = 95% time, name without hint
      const samples = [...TIME_SAMPLES, ...TIME_SAMPLES, ...TIME_SAMPLES.slice(0, 3), "garbage"];
      const verdict = classifyAsTimeOfDay("RandomCol", samples);
      assert.equal(verdict.isTimeOfDay, true);
    });

    it("rejects real datetimes (with calendar component)", () => {
      const samples = [
        "2024-01-15T09:45:34",
        "2024-01-16T10:05:45",
        "2024-01-17T09:18:57",
        "2024-01-18T11:00:00",
        "2024-01-19T08:30:00",
        "2024-01-20T07:15:00",
        "2024-01-21T12:45:00",
      ];
      assert.equal(
        classifyAsTimeOfDay("Clock-In Time", samples).isTimeOfDay,
        false,
      );
    });
  });

  describe("createDataSummary integration", () => {
    it("tags Clock-In Time as text + timeOfDay (NOT date)", () => {
      // Build 12 rows mimicking the Marico clock-in data.
      const rows = [
        { "Cluster Name": "North", "Clock-In Time": "09:45:34", "Working Hrs": 8 },
        { "Cluster Name": "North", "Clock-In Time": "10:05:45", "Working Hrs": 7 },
        { "Cluster Name": "South", "Clock-In Time": "09:18:57", "Working Hrs": 8.5 },
        { "Cluster Name": "South", "Clock-In Time": "09:48:06", "Working Hrs": 8 },
        { "Cluster Name": "North", "Clock-In Time": "10:28:21", "Working Hrs": 7.5 },
        { "Cluster Name": "North", "Clock-In Time": "Absent", "Working Hrs": 0 },
        { "Cluster Name": "South", "Clock-In Time": "11:19:35", "Working Hrs": 7 },
        { "Cluster Name": "South", "Clock-In Time": "09:58:54", "Working Hrs": 8 },
        { "Cluster Name": "North", "Clock-In Time": "08:23:54", "Working Hrs": 9 },
        { "Cluster Name": "North", "Clock-In Time": "Absent", "Working Hrs": 0 },
        { "Cluster Name": "South", "Clock-In Time": "09:25:00", "Working Hrs": 8 },
        { "Cluster Name": "South", "Clock-In Time": "09:40:00", "Working Hrs": 8 },
      ];
      const summary = createDataSummary(rows);
      const clockIn = summary.columns.find((c) => c.name === "Clock-In Time");
      assert.ok(clockIn, "Clock-In Time column must be present");
      assert.equal(clockIn!.type, "string", "type should be string, not date");
      assert.ok(clockIn!.timeOfDay, "timeOfDay annotation must be present");
      assert.ok(
        (clockIn!.timeOfDay!.sentinelValues ?? []).includes("Absent"),
        "Absent must be captured as a sentinel",
      );
      assert.ok(
        !summary.dateColumns.includes("Clock-In Time"),
        "Clock-In Time must not appear in dateColumns",
      );
    });
  });
});
