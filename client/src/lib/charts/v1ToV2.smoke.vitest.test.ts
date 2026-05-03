/**
 * Fix-6 · smoke-render tests for the v1→v2 flag-flip path.
 *
 * For each of the 6 v1 chart types, build a synthetic v1 spec, run it
 * through `convertV1ToV2()`, and validate the result with the v2 Zod
 * schema. This catches conversion bugs that would otherwise only
 * surface at render time when a feature flag is flipped.
 *
 * No DOM / no React rendering — pure schema validation. Heavier
 * jsdom-based render tests can come later in a focused wave.
 */

import { describe, expect, it } from "vitest";
import { convertV1ToV2 } from "./v1ToV2";
import { chartSpecV2Schema } from "@/shared/schema";
import type { ChartSpec } from "@/shared/schema";

interface BuildOpts extends Partial<ChartSpec> {
  type: ChartSpec["type"];
}

function build(opts: BuildOpts): ChartSpec {
  return {
    title: `Test ${opts.type}`,
    x: "Region",
    y: "Revenue",
    ...opts,
  } as ChartSpec;
}

describe("v1ToV2 smoke render — Fix-6", () => {
  it("bar (single-series) round-trips and validates", () => {
    const v1 = build({ type: "bar" });
    const r = convertV1ToV2(v1);
    expect(chartSpecV2Schema.safeParse(r.spec).success).toBe(true);
  });

  it("bar stacked round-trips with config.barLayout", () => {
    const v1 = build({
      type: "bar",
      barLayout: "stacked",
      seriesColumn: "Year",
      seriesKeys: ["2023", "2024", "2025"],
    });
    const r = convertV1ToV2(v1);
    expect(chartSpecV2Schema.safeParse(r.spec).success).toBe(true);
    expect(r.spec.config?.barLayout).toBe("stacked");
  });

  it("line with y2 dual axis validates", () => {
    const v1 = build({
      type: "line",
      x: "Month",
      y: "Revenue",
      y2: "Margin",
    });
    const r = convertV1ToV2(v1);
    expect(chartSpecV2Schema.safeParse(r.spec).success).toBe(true);
    expect(r.spec.encoding.y2?.field).toBe("Margin");
  });

  it("area validates and infers temporal x for date-named field", () => {
    const v1 = build({ type: "area", x: "Date", y: "Revenue" });
    const r = convertV1ToV2(v1);
    expect(chartSpecV2Schema.safeParse(r.spec).success).toBe(true);
    expect(r.spec.encoding.x?.type).toBe("t");
  });

  it("scatter (point) validates with bubble z encoding", () => {
    const v1 = build({
      type: "scatter",
      x: "X",
      y: "Y",
      z: "Volume",
    });
    const r = convertV1ToV2(v1);
    expect(chartSpecV2Schema.safeParse(r.spec).success).toBe(true);
    expect(r.spec.encoding.size?.field).toBe("Volume");
  });

  it("pie (arc) validates", () => {
    const v1 = build({
      type: "pie",
      x: "Region",
      y: "Revenue",
    });
    const r = convertV1ToV2(v1);
    expect(chartSpecV2Schema.safeParse(r.spec).success).toBe(true);
    expect(r.spec.mark).toBe("arc");
  });

  it("heatmap (rect) validates with z mapped to color (Fix-1)", () => {
    const v1 = build({
      type: "heatmap",
      x: "Row",
      y: "Col",
      z: "Value",
    });
    const r = convertV1ToV2(v1);
    expect(chartSpecV2Schema.safeParse(r.spec).success).toBe(true);
    expect(r.spec.encoding.color?.field).toBe("Value");
    expect(r.spec.encoding.color?.type).toBe("q");
  });

  it("preserves _autoLayers from server when present", () => {
    const v1 = build({ type: "line", x: "Date", y: "Revenue" });
    v1._autoLayers = [
      { type: "reference-line", on: "y", value: 1000, label: "Target" },
      { type: "trend", on: "y", method: "linear" },
    ];
    const r = convertV1ToV2(v1);
    expect(chartSpecV2Schema.safeParse(r.spec).success).toBe(true);
    expect(r.spec.layers?.length).toBe(2);
    expect(r.spec.layers?.[0]?.type).toBe("reference-line");
  });

  it("preserves provenance fields", () => {
    const v1 = build({
      type: "bar",
      _agentEvidenceRef: "tool-99",
      _agentTurnId: "turn-7",
    } as BuildOpts);
    const r = convertV1ToV2(v1);
    expect(r.spec._agentEvidenceRef).toBe("tool-99");
    expect(r.spec._agentTurnId).toBe("turn-7");
  });

  it("inline data flows through to source.rows", () => {
    const data = [{ Region: "N", Revenue: 100 }, { Region: "S", Revenue: 50 }];
    const v1 = build({ type: "bar", data });
    const r = convertV1ToV2(v1);
    expect(r.spec.source.kind).toBe("inline");
    if (r.spec.source.kind === "inline") {
      expect(r.spec.source.rows.length).toBe(2);
    }
  });
});
