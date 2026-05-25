/**
 * Wave WHov-area-crosshair · source-inspection tests pinning the
 * AreaRenderer's hover-time vertical cross-hair indicator + tooltip.
 *
 * Pre-wave state: AreaRenderer had brush mechanics (WI4-wiring-area)
 * but NO hover tooltip and NO visual cross-hair indicator. This wave
 * adds the full tooltip infrastructure (useTooltip + nearest-x snap
 * onMouseMove) AND the vertical dashed cross-hair line at the snapped
 * x position — mirroring the LineRenderer WHov-line-crosshair pattern.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const areaSrc = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/AreaRenderer.tsx"),
  "utf-8",
);

describe("WHov-area-crosshair · AreaRenderer hover cross-hair indicator", () => {
  it("renders a <line> with x1={cx} x2={cx} y1={0} y2={innerHeight} where cx is the snapped nearest-x", () => {
    assert.match(
      areaSrc,
      /<line\s+x1=\{cx\}\s+x2=\{cx\}\s+y1=\{0\}\s+y2=\{innerHeight\}/,
    );
  });

  it("binds cx to xPx(tooltipData.xRaw) — the snapped nearest-x, NOT the raw cursor pixel", () => {
    assert.match(areaSrc, /const cx = xPx\(tooltipData\.xRaw\);/);
  });

  it("gates the indicator on tooltipOpen && tooltipData && brushStart === null", () => {
    assert.match(
      areaSrc,
      /\{tooltipOpen\s*&&\s*tooltipData\s*&&\s*brushStart === null\s*&&\s*\(\(\)\s*=>\s*\{/,
    );
  });

  it("carries pointerEvents=\"none\" on the cross-hair line", () => {
    const crosshairBlock = areaSrc.match(
      /WHov-area-crosshair · vertical cross-hair[\s\S]*?\}\)\(\)\}/,
    );
    assert.ok(
      crosshairBlock,
      "WHov-area-crosshair block not found in AreaRenderer source",
    );
    assert.match(crosshairBlock[0], /pointerEvents="none"/);
  });

  it("uses a dashed stroke style (visual contract — solid would be jarring)", () => {
    const crosshairBlock = areaSrc.match(
      /WHov-area-crosshair · vertical cross-hair[\s\S]*?\}\)\(\)\}/,
    );
    assert.ok(crosshairBlock);
    assert.match(crosshairBlock[0], /strokeDasharray="[\d\s]+"/);
  });

  it("returns null when xPx returns a non-finite value (defensive guard)", () => {
    const crosshairBlock = areaSrc.match(
      /WHov-area-crosshair · vertical cross-hair[\s\S]*?\}\)\(\)\}/,
    );
    assert.ok(crosshairBlock);
    assert.match(crosshairBlock[0], /if \(!Number\.isFinite\(cx\)\) return null;/);
  });

  it("Wave WHov-area-crosshair marker present at the indicator block", () => {
    assert.match(
      areaSrc,
      /Wave WHov-area-crosshair · vertical cross-hair at the/,
    );
  });

  it("has useTooltip hook with xRaw + rows shape", () => {
    assert.match(areaSrc, /useTooltip<\{/);
    assert.match(areaSrc, /xRaw:\s*unknown/);
    assert.match(areaSrc, /rows:\s*Array</);
  });

  it("onMouseMove scans series for nearest-x and calls showTooltip", () => {
    assert.match(areaSrc, /const onMouseMove = \(e:/);
    assert.match(areaSrc, /for \(const s of series\)/);
    assert.match(areaSrc, /showTooltip\(\{/);
    assert.match(areaSrc, /tooltipData:\s*\{\s*xRaw,\s*rows\s*\}/);
  });
});
