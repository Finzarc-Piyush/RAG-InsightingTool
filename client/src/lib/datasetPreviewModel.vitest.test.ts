import { describe, it, expect } from "vitest";
import {
  estimateColumnWidth,
  buildPreviewCaption,
  resolvePreviewCellText,
  COL_MIN_PX,
  COL_MAX_PX,
} from "@/lib/datasetPreviewModel";

describe("estimateColumnWidth", () => {
  it("clamps a short column to the minimum width", () => {
    expect(estimateColumnWidth("id", [{ id: 1 }, { id: 2 }])).toBe(COL_MIN_PX);
  });

  it("clamps a very long value to the maximum width", () => {
    const rows = [{ name: "x".repeat(500) }];
    expect(estimateColumnWidth("name", rows)).toBe(COL_MAX_PX);
  });

  it("widens for the longest sampled value (header or cell)", () => {
    const narrow = estimateColumnWidth("c", [{ c: "ab" }]);
    const wide = estimateColumnWidth("c", [{ c: "a value that is clearly wider" }]);
    expect(wide).toBeGreaterThan(narrow);
    expect(wide).toBeLessThanOrEqual(COL_MAX_PX);
  });

  it("ignores null/undefined cells when measuring (not stringified to 'null')", () => {
    // If null were stringified ("null" = 4 chars) it could exceed the 1-char
    // header; skipping it keeps the width at the header-only minimum.
    expect(estimateColumnWidth("c", [{ c: null }, { c: undefined }])).toBe(
      estimateColumnWidth("c", [])
    );
    expect(estimateColumnWidth("c", [{ c: null }])).toBe(COL_MIN_PX);
  });
});

describe("buildPreviewCaption", () => {
  const capLabel = "50,000";

  it("200 mode: first N of total matching", () => {
    expect(
      buildPreviewCaption({ mode: "200", shown: 200, filteredRows: 4210, capLabel })
    ).toBe("Showing first 200 of 4,210 rows matching");
  });

  it("full mode untruncated: all N of total", () => {
    expect(
      buildPreviewCaption({ mode: "full", shown: 3000, filteredRows: 3000, capLabel })
    ).toBe("Showing all 3,000 of 3,000 rows");
  });

  it("full mode truncated: notes the cap", () => {
    expect(
      buildPreviewCaption({
        mode: "full",
        shown: 50000,
        filteredRows: 120000,
        truncated: true,
        capLabel,
      })
    ).toBe("Showing first 50,000 of 120,000 rows (capped at 50,000)");
  });
});

describe("resolvePreviewCellText", () => {
  it("returns null for empty / missing values (caller renders the placeholder)", () => {
    expect(resolvePreviewCellText(null, false, undefined)).toBeNull();
    expect(resolvePreviewCellText(undefined, false, undefined)).toBeNull();
    expect(resolvePreviewCellText("", false, undefined)).toBeNull();
  });

  it("renders non-date values raw", () => {
    expect(resolvePreviewCellText(7500000, false, undefined)).toBe("7500000");
    expect(resolvePreviewCellText("MARICO", false, undefined)).toBe("MARICO");
    expect(resolvePreviewCellText(0, false, undefined)).toBe("0");
    expect(resolvePreviewCellText(false, false, undefined)).toBe("false");
  });

  it("formats date columns by grain, falling back to raw when unparseable", () => {
    // A clearly parseable ISO date with a year grain stays year-ish; an
    // unparseable value falls back to its raw string.
    expect(resolvePreviewCellText("not-a-date", true, "year")).toBe("not-a-date");
  });
});
