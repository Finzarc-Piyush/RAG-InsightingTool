import { describe, expect, it } from "vitest";
import {
  asNumber,
  asString,
  resolveBarEncoding,
  resolveChannel,
  numericExtent,
  paddedDomain,
  distinctOrdered,
} from "./encodingResolver";
import type { ChartSpecV2 } from "@/shared/schema";

describe("encodingResolver · primitives", () => {
  it("asNumber coerces strings, currency-formatted strings, and numbers", () => {
    expect(asNumber(42)).toBe(42);
    expect(asNumber("42")).toBe(42);
    expect(asNumber("$1,234")).toBe(1234);
    expect(asNumber("  3.14 ")).toBe(3.14);
    expect(Number.isNaN(asNumber("abc"))).toBe(true);
    expect(Number.isNaN(asNumber(null))).toBe(true);
    expect(Number.isNaN(asNumber(undefined))).toBe(true);
  });

  it("asString coerces null/undefined to empty and primitives to strings", () => {
    expect(asString(null)).toBe("");
    expect(asString(undefined)).toBe("");
    expect(asString("x")).toBe("x");
    expect(asString(42)).toBe("42");
    expect(asString(true)).toBe("true");
  });

  it("numericExtent returns [0,1] for empty input", () => {
    expect(numericExtent([], () => 0)).toEqual([0, 1]);
  });

  it("numericExtent skips non-finite values", () => {
    const rows = [
      { v: 5 },
      { v: "abc" },
      { v: 10 },
      { v: null },
      { v: -2 },
    ] as Array<Record<string, unknown>>;
    expect(numericExtent(rows, (r) => asNumber(r.v))).toEqual([-2, 10]);
  });

  it("paddedDomain expands by paddingFraction on both sides", () => {
    expect(paddedDomain([0, 100], 0.1)).toEqual([-10, 110]);
    expect(paddedDomain([10, 10], 0.1)).toEqual([9, 11]);
  });

  it("distinctOrdered preserves first-seen order", () => {
    const rows = [
      { r: "B" },
      { r: "A" },
      { r: "B" },
      { r: "C" },
      { r: "A" },
    ];
    expect(distinctOrdered(rows, (row) => row.r)).toEqual(["B", "A", "C"]);
  });
});

describe("encodingResolver · resolveChannel", () => {
  it("returns null for missing channel", () => {
    expect(resolveChannel(undefined)).toBeNull();
  });

  it("returns numeric accessor for quantitative channel", () => {
    const ch = resolveChannel({ field: "Revenue", type: "q" });
    expect(ch).not.toBeNull();
    expect(ch!.accessor({ Revenue: "1,000" })).toBe(1000);
  });

  it("returns identity accessor for nominal channel", () => {
    const ch = resolveChannel({ field: "Region", type: "n" });
    expect(ch).not.toBeNull();
    expect(ch!.accessor({ Region: "North" })).toBe("North");
  });
});

describe("encodingResolver · resolveBarEncoding", () => {
  function specOf(enc: ChartSpecV2["encoding"]): ChartSpecV2 {
    return {
      version: 2,
      mark: "bar",
      encoding: enc,
      source: { kind: "inline", rows: [] },
    } as ChartSpecV2;
  }

  it("returns x and y for a valid bar spec", () => {
    const r = resolveBarEncoding(
      specOf({
        x: { field: "Region", type: "n" },
        y: { field: "Revenue", type: "q" },
      }),
    );
    expect(r.x.field).toBe("Region");
    expect(r.y.field).toBe("Revenue");
    expect(r.color).toBeUndefined();
  });

  it("includes color when provided", () => {
    const r = resolveBarEncoding(
      specOf({
        x: { field: "Region", type: "n" },
        y: { field: "Revenue", type: "q" },
        color: { field: "Year", type: "o" },
      }),
    );
    expect(r.color?.field).toBe("Year");
  });

  it("throws when y is non-quantitative", () => {
    expect(() =>
      resolveBarEncoding(
        specOf({
          x: { field: "Region", type: "n" },
          y: { field: "Year", type: "o" },
        }),
      ),
    ).toThrow(/quantitative/);
  });

  it("throws when x or y is missing", () => {
    expect(() => resolveBarEncoding(specOf({ y: { field: "v", type: "q" } }))).toThrow(/x/);
    expect(() => resolveBarEncoding(specOf({ x: { field: "r", type: "n" } }))).toThrow(/y/);
  });
});
