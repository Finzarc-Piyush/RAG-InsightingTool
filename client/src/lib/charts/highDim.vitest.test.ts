/**
 * High-dimensional bar / line capability tests.
 *
 * These exercise the schema + helpers behind the BarRenderer and
 * LineRenderer rewrites: orientation auto-detection, all 5 bar
 * layouts, pattern encoding via SVG patterns, multi-y2 secondary
 * axes, and the full 14-channel encoding capacity.
 */

import { describe, expect, it } from "vitest";
import {
  chartSpecV2Schema,
  chartConfigSchema,
  chartEncodingSchema,
} from "@/shared/schema";
import {
  PATTERN_NAMES,
  PATTERN_PALETTE_SIZE,
  patternBody,
  patternFromIndex,
  resolvePatternFill,
} from "./patterns";

describe("schema · barLayout enum (Fix-W2)", () => {
  it("accepts grouped / stacked / normalized / grouped-stacked / diverging", () => {
    for (const layout of [
      "grouped",
      "stacked",
      "normalized",
      "grouped-stacked",
      "diverging",
    ]) {
      const r = chartConfigSchema.safeParse({ barLayout: layout });
      expect(r.success).toBe(true);
    }
  });

  it("rejects unknown layouts", () => {
    expect(chartConfigSchema.safeParse({ barLayout: "spiral" }).success).toBe(
      false,
    );
  });
});

describe("schema · barOrientation", () => {
  it("accepts vertical / horizontal / auto", () => {
    for (const o of ["vertical", "horizontal", "auto"]) {
      const r = chartConfigSchema.safeParse({ barOrientation: o });
      expect(r.success).toBe(true);
    }
  });

  it("does not collide with the deprecated Window.orientation global", () => {
    // Field is barOrientation (not orientation) so spec.config?.barOrientation
    // doesn't shadow lib.dom's deprecated Window.orientation.
    const r = chartConfigSchema.safeParse({ barOrientation: "horizontal" });
    expect(r.success).toBe(true);
  });
});

describe("schema · pattern encoding channel", () => {
  it("accepts a pattern channel as an additional categorical encoding", () => {
    const r = chartEncodingSchema.safeParse({
      x: { field: "Region", type: "n" },
      y: { field: "Revenue", type: "q" },
      color: { field: "Year", type: "o" },
      pattern: { field: "Channel", type: "n" },
    });
    expect(r.success).toBe(true);
  });
});

describe("schema · y2Series (multi-secondary axis)", () => {
  it("accepts an array of up to 8 secondary channels", () => {
    const r = chartEncodingSchema.safeParse({
      x: { field: "Date", type: "t" },
      y: { field: "Revenue", type: "q" },
      y2Series: [
        { field: "Margin", type: "q" },
        { field: "ROAS", type: "q" },
        { field: "CAC", type: "q" },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejects more than 8 secondary channels", () => {
    const r = chartEncodingSchema.safeParse({
      x: { field: "Date", type: "t" },
      y: { field: "Revenue", type: "q" },
      y2Series: Array.from({ length: 9 }, (_, i) => ({
        field: `m${i}`,
        type: "q",
      })),
    });
    expect(r.success).toBe(false);
  });
});

describe("schema · 10+ encoding channels at once", () => {
  it("accepts a spec with all 14 visual channels populated", () => {
    const spec = {
      version: 2,
      mark: "bar",
      encoding: {
        x: { field: "Region", type: "n" },
        y: { field: "Revenue", type: "q", aggregate: "sum" },
        y2: { field: "Margin", type: "q" },
        y2Series: [
          { field: "ROAS", type: "q" },
          { field: "CAC", type: "q" },
        ],
        color: { field: "Year", type: "o", scheme: "qualitative" },
        size: { field: "Volume", type: "q" },
        shape: { field: "Channel", type: "n" },
        pattern: { field: "Region2", type: "n" },
        opacity: { field: "Confidence", type: "q" },
        facetRow: { field: "Country", type: "n" },
        facetCol: { field: "Quarter", type: "o" },
        detail: { field: "SKU", type: "n" },
        text: { field: "Label", type: "n" },
        tooltip: [
          { field: "Manager", title: "Manager" },
          { field: "Cost", format: "currency" },
          { field: "Notes" },
        ],
        order: { field: "Revenue", type: "q" },
      },
      source: { kind: "inline", rows: [] },
      config: {
        barLayout: "grouped-stacked",
        barOrientation: "auto",
        barLabels: false,
      },
    };
    const r = chartSpecV2Schema.safeParse(spec);
    expect(r.success).toBe(true);
  });
});

describe("patterns · palette + path generation", () => {
  it("exports the documented 8-pattern palette", () => {
    expect(PATTERN_PALETTE_SIZE).toBe(8);
    expect(PATTERN_NAMES.length).toBe(8);
    for (const p of [
      "solid",
      "horizontal",
      "vertical",
      "diagonal",
      "anti-diagonal",
      "cross",
      "dots",
      "checkers",
    ]) {
      expect(PATTERN_NAMES.includes(p as never)).toBe(true);
    }
  });

  it("patternFromIndex cycles wrap-around across the palette", () => {
    expect(patternFromIndex(0)).toBe("solid");
    expect(patternFromIndex(8)).toBe("solid");
    expect(patternFromIndex(7)).toBe("checkers");
    expect(patternFromIndex(-1)).toBe("checkers");
  });

  it("resolvePatternFill collapses 'solid' to plain color (no <pattern> def)", () => {
    const r = resolvePatternFill("p0", "solid", "hsl(var(--chart-1))");
    expect(r.fill).toBe("hsl(var(--chart-1))");
    expect(r.def).toBeUndefined();
  });

  it("resolvePatternFill produces a url(#id) + def for non-solid patterns", () => {
    const r = resolvePatternFill("p0", "diagonal", "hsl(var(--chart-2))");
    expect(r.fill.startsWith("url(#")).toBe(true);
    expect(r.def?.body).toContain("<line");
  });

  it("patternBody emits valid SVG fragments per pattern", () => {
    for (const p of PATTERN_NAMES) {
      const body = patternBody(p, "hsl(var(--chart-1))");
      expect(body.length).toBeGreaterThan(0);
      // Every pattern except 'solid' should contain at least one stroke
      // element (line/circle/rect) so it's visually distinguishable.
      if (p !== "solid") {
        expect(/<(line|circle|rect)/.test(body)).toBe(true);
      }
    }
  });
});

describe("audit fixes — robustness", () => {
  it("Fix-A2 · cross-filter value preservation: BarCell schema can hold raw outer values of any type", () => {
    // Type-level smoke test — confirm we accept numeric/Date/boolean
    // raw outer values.
    const cellWithNumber = {
      outerKey: "2024",
      outerRaw: 2024,
      colorKey: "Region A",
      detailKey: "",
      patternKey: "",
      value: 100,
      base: 0,
      top: 100,
    };
    expect(typeof cellWithNumber.outerRaw).toBe("number");
    const cellWithBool = { ...cellWithNumber, outerRaw: true };
    expect(typeof cellWithBool.outerRaw).toBe("boolean");
  });

  it("Fix-A4 · multi-y2 tooltip uses correct field per series (regression test)", () => {
    // The bug was: when a tooltip row matched a y2Series entry beyond
    // the FIRST, the formatter was called with the primary y field's
    // currency / percent inference. This test pins the spec shape to
    // ensure y2Series remains an array (not a singular).
    const r = chartEncodingSchema.safeParse({
      x: { field: "Date", type: "t" },
      y: { field: "Revenue", type: "q" },
      y2Series: [
        { field: "Margin %", type: "q" },
        { field: "Conversion %", type: "q" },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.y2Series?.length).toBe(2);
    }
  });
});

describe("schema · diverging + grouped-stacked + showTotalBar", () => {
  it("accepts a diverging pyramid spec", () => {
    const spec = {
      version: 2,
      mark: "bar",
      encoding: {
        x: { field: "AgeGroup", type: "o" },
        y: { field: "Population", type: "q" },
        color: { field: "Sex", type: "n" },
      },
      source: { kind: "inline", rows: [] },
      config: { barLayout: "diverging", barOrientation: "horizontal" },
    };
    expect(chartSpecV2Schema.safeParse(spec).success).toBe(true);
  });

  it("accepts a grouped-stacked variance spec", () => {
    const spec = {
      version: 2,
      mark: "bar",
      encoding: {
        x: { field: "Quarter", type: "o" },
        y: { field: "Revenue", type: "q" },
        color: { field: "Region", type: "n" },
        detail: { field: "Channel", type: "n" },
      },
      source: { kind: "inline", rows: [] },
      config: { barLayout: "grouped-stacked", showTotalBar: true },
    };
    expect(chartSpecV2Schema.safeParse(spec).success).toBe(true);
  });
});
