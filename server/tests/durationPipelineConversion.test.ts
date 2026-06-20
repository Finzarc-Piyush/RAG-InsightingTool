import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyUploadPipelineWithProfile } from "../lib/fileParser.js";
import type { DatasetProfile } from "../lib/datasetProfile.js";

/**
 * DUR2/DUR3 · the upload pipeline must convert a HH:MM:SS DURATION column
 * ("Working Hrs") into a numeric measure (decimal hours) so "average Working
 * Hrs" stops returning 0, while leaving a time-of-day clock column ("Clock-In
 * Time") and a plain count column ("Total PC") untouched.
 */
describe("duration column pipeline conversion", () => {
  const profile: DatasetProfile = {
    shortDescription: "",
    dateColumns: ["Date"],
  } as DatasetProfile;

  const rows = [
    { Date: "2026-04-01", ASM: "Bengal Central", "Working Hrs": "03:31:57", "Clock-In Time": "09:45:34", "Total PC": 30 },
    { Date: "2026-04-02", ASM: "Bengal Central", "Working Hrs": "05:08:52", "Clock-In Time": "09:18:57", "Total PC": 45 },
    { Date: "2026-04-03", ASM: "Bengal North", "Working Hrs": "03:16:19", "Clock-In Time": "10:05:45", "Total PC": 30 },
    { Date: "2026-04-04", ASM: "Bengal North", "Working Hrs": "08:23:54", "Clock-In Time": "11:19:35", "Total PC": 60 },
    { Date: "2026-04-05", ASM: "Bengal Central", "Working Hrs": "03:10:18", "Clock-In Time": "09:58:54", "Total PC": 45 },
    { Date: "2026-04-06", ASM: "Bengal North", "Working Hrs": "Absent", "Clock-In Time": "Absent", "Total PC": 30 },
  ];

  it("converts Working Hrs to decimal-hours numbers + marks it numeric with a duration annotation", () => {
    const { data, summary } = applyUploadPipelineWithProfile(
      rows.map((r) => ({ ...r })),
      profile
    );

    // (a) cells are numbers (decimal hours), sentinel -> null
    assert.ok(Math.abs((data[0]!["Working Hrs"] as number) - 3.5325) < 1e-6);
    assert.equal(data[5]!["Working Hrs"], null);

    // (b) the summary lists it as a numeric column
    assert.ok(summary.numericColumns.includes("Working Hrs"));

    // (c) it carries the duration annotation and is NOT a time-of-day column
    const wh = summary.columns.find((c) => c.name === "Working Hrs")!;
    assert.equal(wh.type, "number");
    assert.deepEqual(wh.duration, { unit: "hours", format: "hm" });
    assert.equal(wh.timeOfDay, undefined);
  });

  it("an average over the converted column is non-zero", () => {
    const { data } = applyUploadPipelineWithProfile(
      rows.map((r) => ({ ...r })),
      profile
    );
    const vals = data
      .map((r) => r["Working Hrs"] as number | null)
      .filter((v): v is number => typeof v === "number");
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    assert.ok(mean > 3 && mean < 6, `expected a real mean, got ${mean}`);
  });

  it("leaves Clock-In Time as a time-of-day text column (not a duration)", () => {
    const { data, summary } = applyUploadPipelineWithProfile(
      rows.map((r) => ({ ...r })),
      profile
    );
    assert.equal(data[0]!["Clock-In Time"], "09:45:34"); // unchanged string
    const ci = summary.columns.find((c) => c.name === "Clock-In Time")!;
    assert.equal(ci.duration, undefined);
    assert.ok(!summary.numericColumns.includes("Clock-In Time"));
  });

  it("does not mis-flag a plain count column as a duration", () => {
    const { summary } = applyUploadPipelineWithProfile(
      rows.map((r) => ({ ...r })),
      profile
    );
    const pc = summary.columns.find((c) => c.name === "Total PC")!;
    assert.equal(pc.duration, undefined);
    assert.ok(summary.numericColumns.includes("Total PC"));
  });
});
