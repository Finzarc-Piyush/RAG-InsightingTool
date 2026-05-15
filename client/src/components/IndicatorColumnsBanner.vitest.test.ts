// Wave SU-UX1 · IndicatorColumnsBanner pure-helper contract.
//
// The banner itself is a thin shell over the `indicatorsFromSummary`
// pure-fn helper + the existing sessions API. Vitest runs in node
// (no jsdom), so we pin the helper's contract here — that's the
// data shape the banner depends on. Render-time concerns (collapsed
// default, ✕ click triggers onChange) are covered by the manual
// E2E check in the plan's verification section.

import { describe, it, expect } from "vitest";
import { indicatorsFromSummary } from "./IndicatorColumnsBanner";
import type { DataSummary } from "@/shared/schema";

function emptySummary(): DataSummary {
  return {
    rowCount: 0,
    columnCount: 0,
    columns: [],
    numericColumns: [],
    dateColumns: [],
  };
}

describe("indicatorsFromSummary", () => {
  it("returns [] for an undefined or column-less summary", () => {
    expect(indicatorsFromSummary(undefined)).toEqual([]);
    expect(indicatorsFromSummary(emptySummary())).toEqual([]);
  });

  it("extracts boolean indicators with their polarity + sentinels", () => {
    const summary: DataSummary = {
      ...emptySummary(),
      columnCount: 1,
      columns: [
        {
          name: "Clock-In <09:30",
          type: "text",
          sampleValues: [],
          indicator: {
            kind: "boolean",
            positiveValues: ["Yes"],
            negativeValues: ["No"],
            sentinelValues: ["Absent"],
            source: "auto",
          },
          answersQuestions: ["what % of staff clocked in before 9:30?"],
        },
      ],
    };
    const out = indicatorsFromSummary(summary);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      column: "Clock-In <09:30",
      kind: "boolean",
      positiveValues: ["Yes"],
      negativeValues: ["No"],
      sentinelValues: ["Absent"],
      source: "auto",
      answersQuestions: ["what % of staff clocked in before 9:30?"],
    });
  });

  it("ignores columns without an indicator annotation", () => {
    const summary: DataSummary = {
      ...emptySummary(),
      columnCount: 2,
      columns: [
        { name: "Region", type: "text", sampleValues: [] },
        {
          name: "Compliance Visit",
          type: "text",
          sampleValues: [],
          indicator: { kind: "boolean", source: "auto" },
        },
      ],
    };
    const out = indicatorsFromSummary(summary);
    expect(out.map((i) => i.column)).toEqual(["Compliance Visit"]);
  });

  it("preserves source enum (auto / llm / user)", () => {
    const summary: DataSummary = {
      ...emptySummary(),
      columnCount: 3,
      columns: [
        {
          name: "A",
          type: "text",
          sampleValues: [],
          indicator: { kind: "categorical", source: "auto" },
        },
        {
          name: "B",
          type: "text",
          sampleValues: [],
          indicator: { kind: "categorical", source: "llm" },
        },
        {
          name: "C",
          type: "text",
          sampleValues: [],
          indicator: { kind: "categorical", source: "user" },
        },
      ],
    };
    const out = indicatorsFromSummary(summary);
    expect(out.map((i) => i.source)).toEqual(["auto", "llm", "user"]);
  });

  it("omits empty optional fields (no implicit defaults)", () => {
    const summary: DataSummary = {
      ...emptySummary(),
      columnCount: 1,
      columns: [
        {
          name: "Tier",
          type: "text",
          sampleValues: [],
          indicator: { kind: "categorical", source: "auto" },
        },
      ],
    };
    const out = indicatorsFromSummary(summary);
    expect(out[0].positiveValues).toBeUndefined();
    expect(out[0].negativeValues).toBeUndefined();
    expect(out[0].sentinelValues).toBeUndefined();
    expect(out[0].answersQuestions).toBeUndefined();
  });
});
