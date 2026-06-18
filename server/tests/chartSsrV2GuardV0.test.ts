/**
 * Wave V0 · the deck-export SVG renderer is v1-only. A v2 ChartSpecV2 must not
 * silently vanish from a shared PPTX/PDF — it gets a visible placeholder + a
 * logged reason instead of an invisible gap.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  renderChartSpecToSvg,
  chartSpecToEchartsOption,
} from "../lib/exports/chartSsr.js";

const v2 = {
  version: 2,
  mark: "radar",
  encoding: { x: { field: "k", type: "n" }, y: { field: "v", type: "q" } },
  source: { kind: "inline", rows: [{ k: "A", v: 1 }] },
} as unknown;

const v1 = {
  type: "bar",
  title: "Sales",
  x: "category",
  y: "value",
  data: [{ category: "A", value: 10 }, { category: "B", value: 20 }],
} as never;

describe("chartSsr · v2 guard (Wave V0)", () => {
  it("renders a VISIBLE placeholder SVG for a v2 spec (not a silent null)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svg = renderChartSpecToSvg(v2 as any);
    assert.equal(typeof svg, "string");
    assert.match(svg as string, /not available in this export format/i);
    assert.match(svg as string, /^<svg/);
  });

  it("chartSpecToEchartsOption returns null for a v2 spec (option can't carry a placeholder)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(chartSpecToEchartsOption(v2 as any), null);
  });

  it("still renders a real SVG for a v1 spec (no regression)", () => {
    const svg = renderChartSpecToSvg(v1);
    assert.equal(typeof svg, "string");
    assert.doesNotMatch(svg as string, /not available in this export format/i);
  });
});
