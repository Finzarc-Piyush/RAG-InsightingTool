import { describe, expect, it } from "vitest";
import { __test__ } from "./InteractiveChartCard";
import type { ChartSpec } from "@/shared/schema";

const baseBar: ChartSpec = {
  type: "bar",
  title: "t",
  x: "month",
  y: "revenue",
  seriesColumn: "region",
  seriesKeys: ["A", "B", "C"],
  barLayout: "stacked",
};

describe("coerceMarkType", () => {
  it("is a no-op when next === current", () => {
    const out = __test__.coerceMarkType(baseBar, "bar");
    expect(out).toBe(baseBar);
  });

  it("strips barLayout when leaving bar", () => {
    const out = __test__.coerceMarkType(baseBar, "line");
    expect(out.type).toBe("line");
    expect(out.barLayout).toBeUndefined();
    expect(out.x).toBe("month");
    expect(out.y).toBe("revenue");
    expect(out.seriesColumn).toBe("region");
    expect(out.seriesKeys).toEqual(["A", "B", "C"]);
  });

  it("preserves barLayout when staying within bar->bar (already covered by no-op)", () => {
    const out = __test__.coerceMarkType({ ...baseBar }, "bar");
    expect(out.barLayout).toBe("stacked");
  });

  it("does not invent barLayout when entering bar from line", () => {
    const lineSpec: ChartSpec = { ...baseBar, type: "line" };
    delete (lineSpec as Partial<ChartSpec>).barLayout;
    const out = __test__.coerceMarkType(lineSpec, "bar");
    expect(out.type).toBe("bar");
    expect(out.barLayout).toBeUndefined();
  });
});

describe("chartIdentityKey", () => {
  it("returns the same key for two structurally identical v1 specs handed back as different object refs", () => {
    const a = __test__.chartIdentityKey({ ...baseBar });
    const b = __test__.chartIdentityKey({ ...baseBar });
    expect(a).toBe(b);
  });

  it("ignores fields that the toolbar is allowed to mutate (barLayout)", () => {
    const a = __test__.chartIdentityKey({ ...baseBar, barLayout: "stacked" });
    const b = __test__.chartIdentityKey({ ...baseBar, barLayout: "grouped" });
    expect(a).toBe(b);
  });

  it("changes when the encoding meaningfully differs (different y)", () => {
    const a = __test__.chartIdentityKey({ ...baseBar });
    const b = __test__.chartIdentityKey({ ...baseBar, y: "profit" });
    expect(a).not.toBe(b);
  });

  it("changes when seriesKeys change (multi-series identity)", () => {
    const a = __test__.chartIdentityKey({ ...baseBar });
    const b = __test__.chartIdentityKey({ ...baseBar, seriesKeys: ["A", "B"] });
    expect(a).not.toBe(b);
  });

  it("changes when seriesColumn changes (single-series-via-grouping identity)", () => {
    const a = __test__.chartIdentityKey({ ...baseBar, seriesColumn: "region" });
    const b = __test__.chartIdentityKey({ ...baseBar, seriesColumn: "channel" });
    expect(a).not.toBe(b);
  });

  it("changes when data length changes (catches partial→updated emissions)", () => {
    const a = __test__.chartIdentityKey({ ...baseBar, data: [] });
    const b = __test__.chartIdentityKey({
      ...baseBar,
      data: [{ month: "2024-01", revenue: 10 }],
    });
    expect(a).not.toBe(b);
  });

  it("is stable when only the data array reference changes (same length)", () => {
    const rows = [{ month: "2024-01", revenue: 10 }];
    const a = __test__.chartIdentityKey({ ...baseBar, data: rows });
    const b = __test__.chartIdentityKey({ ...baseBar, data: [...rows] });
    expect(a).toBe(b);
  });
});
