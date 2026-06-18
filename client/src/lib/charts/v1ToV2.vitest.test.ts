import { describe, expect, it } from "vitest";
import { convertV1ToV2 } from "./v1ToV2";
import { applyTransforms } from "./dataEngine";
import { resolveBarEncoding, distinctOrdered } from "./encodingResolver";
import type { ChartSpec } from "@/shared/schema";

function v1(spec: Partial<ChartSpec>): ChartSpec {
  return {
    type: "bar",
    title: "Untitled",
    x: "x",
    y: "y",
    ...spec,
  } as ChartSpec;
}

describe("v1ToV2 · type → mark mapping", () => {
  it("line/bar/area pass through unchanged", () => {
    expect(convertV1ToV2(v1({ type: "line" })).spec.mark).toBe("line");
    expect(convertV1ToV2(v1({ type: "bar" })).spec.mark).toBe("bar");
    expect(convertV1ToV2(v1({ type: "area" })).spec.mark).toBe("area");
  });

  it("scatter → point, pie → arc, heatmap → rect", () => {
    expect(convertV1ToV2(v1({ type: "scatter" })).spec.mark).toBe("point");
    expect(convertV1ToV2(v1({ type: "pie" })).spec.mark).toBe("arc");
    expect(convertV1ToV2(v1({ type: "heatmap" })).spec.mark).toBe("rect");
  });
});

describe("v1ToV2 · core encodings", () => {
  it("maps x/y to v2 encoding channels with inferred types", () => {
    const r = convertV1ToV2(
      v1({
        type: "bar",
        x: "Region",
        y: "Revenue",
        xLabel: "Region",
        yLabel: "Revenue ($)",
      }),
    );
    expect(r.spec.encoding.x?.field).toBe("Region");
    expect(r.spec.encoding.x?.type).toBe("n");
    expect(r.spec.encoding.x?.axis?.title).toBe("Region");
    expect(r.spec.encoding.y?.field).toBe("Revenue");
    expect(r.spec.encoding.y?.type).toBe("q");
    expect(r.spec.encoding.y?.axis?.title).toBe("Revenue ($)");
  });

  it("infers temporal x type for line over a date-named field", () => {
    const r = convertV1ToV2(v1({ type: "line", x: "Date", y: "Revenue" }));
    expect(r.spec.encoding.x?.type).toBe("t");
    // …but "Order Date" / "created_at" also stay temporal.
    expect(convertV1ToV2(v1({ type: "line", x: "Order Date", y: "Revenue" })).spec.encoding.x?.type).toBe("t");
    expect(convertV1ToV2(v1({ type: "line", x: "created_at", y: "Revenue" })).spec.encoding.x?.type).toBe("t");
  });

  it("does NOT infer temporal x for an ordinal 'Day' counter (no epoch collapse)", () => {
    // Regression: a `Day` ordinal x on a line/area chart was typed "t" → run
    // through a time scale → `new Date(15)` collapsed every point to the epoch.
    // It must be an ordered category instead.
    expect(convertV1ToV2(v1({ type: "line", x: "Day", y: "Revenue" })).spec.encoding.x?.type).toBe("n");
    expect(convertV1ToV2(v1({ type: "area", x: "Day", y: "Revenue" })).spec.encoding.x?.type).toBe("n");
  });

  it("infers quantitative x for scatter (point)", () => {
    const r = convertV1ToV2(
      v1({ type: "scatter", x: "Cost", y: "Revenue" }),
    );
    expect(r.spec.encoding.x?.type).toBe("q");
  });

  it("maps seriesColumn → color (qualitative)", () => {
    const r = convertV1ToV2(
      v1({ type: "bar", seriesColumn: "Year" } as Partial<ChartSpec>),
    );
    expect(r.spec.encoding.color?.field).toBe("Year");
    expect(r.spec.encoding.color?.scheme).toBe("qualitative");
  });

  it("maps z → size for scatter (bubble)", () => {
    const r = convertV1ToV2(
      v1({ type: "scatter", x: "X", y: "Y", z: "Volume" }),
    );
    expect(r.spec.encoding.size?.field).toBe("Volume");
  });

  it("maps y2 → y2 channel", () => {
    const r = convertV1ToV2(
      v1({ type: "line", x: "Date", y: "Revenue", y2: "Margin" }),
    );
    expect(r.spec.encoding.y2?.field).toBe("Margin");
  });

  it("maps domains to scale.domain", () => {
    const r = convertV1ToV2(
      v1({ xDomain: [0, 100] as [number, number], yDomain: [0, 1000] as [number, number] }),
    );
    expect(r.spec.encoding.x?.scale?.domain).toEqual([0, 100]);
    expect(r.spec.encoding.y?.scale?.domain).toEqual([0, 1000]);
  });

  it("maps aggregate=sum to y.aggregate", () => {
    const r = convertV1ToV2(v1({ aggregate: "sum" }));
    expect(r.spec.encoding.y?.aggregate).toBe("sum");
  });

  it("aggregate='none' is dropped, not propagated", () => {
    const r = convertV1ToV2(v1({ aggregate: "none" }));
    expect(r.spec.encoding.y?.aggregate).toBeUndefined();
  });
});

describe("v1ToV2 · source + config + provenance", () => {
  it("inline data becomes inline source rows", () => {
    const data = [{ Region: "N", Revenue: 100 }, { Region: "S", Revenue: 200 }];
    const r = convertV1ToV2(v1({ data }));
    expect(r.spec.source.kind).toBe("inline");
    if (r.spec.source.kind === "inline") {
      expect(r.spec.source.rows.length).toBe(2);
    }
  });

  it("title becomes config.title.text (truncated to 200)", () => {
    const r = convertV1ToV2(v1({ title: "Revenue by region" }));
    expect(r.spec.config?.title?.text).toBe("Revenue by region");
  });

  it("preserves _agentProvenance / _agentEvidenceRef / _agentTurnId", () => {
    const r = convertV1ToV2(
      v1({
        _agentEvidenceRef: "tool-123",
        _agentTurnId: "turn-7",
        _agentProvenance: {
          toolCalls: [{ id: "t1", tool: "execute_query_plan" }],
        },
      } as Partial<ChartSpec>),
    );
    expect(r.spec._agentEvidenceRef).toBe("tool-123");
    expect(r.spec._agentTurnId).toBe("turn-7");
    expect(r.spec._agentProvenance?.toolCalls?.[0]?.id).toBe("t1");
  });
});

describe("v1ToV2 · Fix-1 parity (heatmap value, barLayout, seriesKeys)", () => {
  it("heatmap z → encoding.color (the value channel)", () => {
    const r = convertV1ToV2(
      v1({ type: "heatmap", x: "Row", y: "Col", z: "Value" }),
    );
    expect(r.spec.mark).toBe("rect");
    expect(r.spec.encoding.color?.field).toBe("Value");
    expect(r.spec.encoding.color?.type).toBe("q");
  });

  it("v1.barLayout → v2.config.barLayout (no warning)", () => {
    const r = convertV1ToV2(
      v1({ type: "bar", barLayout: "stacked" } as Partial<ChartSpec>),
    );
    expect(r.spec.config?.barLayout).toBe("stacked");
    expect(r.warnings.join(" | ")).not.toMatch(/barLayout/);
  });

  it("v1.seriesKeys forwarded as a color.sort hint", () => {
    const r = convertV1ToV2(
      v1({
        type: "bar",
        seriesColumn: "Region",
        seriesKeys: ["North", "South", "East"],
      } as Partial<ChartSpec>),
    );
    expect(r.spec.encoding.color?.sort).toBeDefined();
    expect(r.warnings.join(" | ")).not.toMatch(/seriesKeys/);
  });

  it("y2Series + trendLine still warn (out of scope of Fix-1)", () => {
    const r = convertV1ToV2(
      v1({
        type: "line",
        y2Series: ["m"],
        trendLine: [{ x: 0, y: 1 }, { x: 1, y: 2 }],
      } as Partial<ChartSpec>),
    );
    const text = r.warnings.join(" | ");
    expect(text).toMatch(/y2Series/);
    expect(text).toMatch(/trendLine/);
  });

  it("clean spec produces no warnings", () => {
    const r = convertV1ToV2(v1({ type: "bar", x: "Region", y: "Revenue" }));
    expect(r.warnings).toEqual([]);
  });
});

describe("v1ToV2 · Wave V3 — wide-format multi-series fold (C1 fix)", () => {
  // Mirrors processChartData's multi-series bar output: WIDE rows (series as
  // columns = seriesKeys), seriesColumn set, y = the measure name.
  const wide = (): ChartSpec =>
    v1({
      type: "bar",
      x: "Age",
      y: "N",
      seriesColumn: "Gender",
      seriesKeys: ["M", "F"],
      data: [
        { Age: "5", M: 2, F: 3 },
        { Age: "10", M: 7, F: 1 },
      ],
    } as Partial<ChartSpec>);

  it("emits a fold transform folding the seriesKeys into (seriesColumn, y)", () => {
    const r = convertV1ToV2(wide());
    const t = r.spec.transform?.[0] as { type: string; fields: string[]; as: [string, string] };
    expect(t?.type).toBe("fold");
    expect(t.fields).toEqual(["M", "F"]);
    expect(t.as).toEqual(["Gender", "N"]);
  });

  it("routes color to the folded key field so v2 renders N series", () => {
    const r = convertV1ToV2(wide());
    expect(r.spec.encoding.color?.field).toBe("Gender");
    expect(r.spec.encoding.y?.field).toBe("N");
  });

  it("END-TO-END: folded rows + color yield 2 distinct series (no renderer change)", () => {
    const r = convertV1ToV2(wide());
    const rows = (r.spec.source as { rows: Array<Record<string, unknown>> }).rows;
    const long = applyTransforms(rows, r.spec.transform);
    expect(long.length).toBe(4); // 2 categories × 2 series
    const enc = resolveBarEncoding(r.spec);
    expect(enc.color).toBeTruthy();
    expect(distinctOrdered(long, enc.color!.accessor)).toEqual(["M", "F"]); // seriesKeys order
  });

  it("does NOT fold long-format data (seriesKeys not present as columns)", () => {
    const r = convertV1ToV2(
      v1({
        type: "bar",
        x: "Age",
        y: "N",
        seriesColumn: "Gender",
        seriesKeys: ["M", "F"],
        data: [
          { Age: "5", Gender: "M", N: 2 },
          { Age: "5", Gender: "F", N: 3 },
        ],
      } as Partial<ChartSpec>),
    );
    expect(r.spec.transform).toBeUndefined();
    expect(r.spec.encoding.color?.field).toBe("Gender"); // long path unchanged
  });

  it("KNOWN LOSSES (future waves): y2Series + maxRows still drop", () => {
    const r = convertV1ToV2(
      v1({ type: "bar", y2Series: ["m"], maxRows: 10 } as Partial<ChartSpec>),
    );
    expect(r.warnings.join(" | ")).toMatch(/y2Series/); // V4
    expect((r.spec.config as { maxRows?: number }).maxRows).toBeUndefined(); // V5
  });
});
