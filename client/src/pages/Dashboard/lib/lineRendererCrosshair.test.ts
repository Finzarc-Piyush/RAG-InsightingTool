/**
 * Wave WHov-line-crosshair · source-inspection tests pinning the
 * LineRenderer's hover-time vertical cross-hair indicator.
 *
 * Pre-wave state: LineRenderer surfaced a hover tooltip with the
 * nearest-x snap (onMouseMove finds the closest series point, sets
 * tooltipData.xRaw), but there was no visual indicator on the line
 * surface itself showing WHICH x the tooltip was reporting against.
 * Users had to mentally project from the tooltip's title down to the
 * x-axis to locate the bucket. This wave adds a vertical dashed line
 * at the snapped x position so the indicator visually aligns with
 * the tooltip's row values — the standard financial-chart pattern.
 *
 * The pinned invariants:
 *
 *  1. The cross-hair `<line>` element is present inside the Group,
 *     spans the full innerHeight (y1=0 → y2=innerHeight), with x1
 *     and x2 both bound to xPx(tooltipData.xRaw) — the SNAPPED
 *     nearest-x position from the existing tooltip state, NOT the
 *     raw cursor pixel.
 *  2. The cross-hair is gated on `tooltipOpen && tooltipData` — no
 *     stray indicator line when hover isn't active.
 *  3. The cross-hair is gated on `brushStart === null` — during an
 *     active brush drag the brush rectangle owns the visual; the
 *     cross-hair must NOT cross it.
 *  4. The cross-hair carries `pointerEvents="none"` so it can't
 *     capture the mouse events that drive the hover/brush surface.
 *  5. Wave marker `Wave WHov-line-crosshair ·` is present at the
 *     indicator block for greppable lineage.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const lineSrc = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/LineRenderer.tsx"),
  "utf-8",
);

describe("WHov-line-crosshair · LineRenderer hover cross-hair indicator", () => {
  it("renders a <line> with x1={cx} x2={cx} y1={0} y2={innerHeight} where cx is the snapped nearest-x", () => {
    // The cross-hair must span the full inner-height vertical extent
    // (y1=0 → y2=innerHeight) at a single x position (x1 === x2 === cx).
    // The cx binding is the snapped xPx of tooltipData.xRaw — verified
    // separately. This regex pins the full line-shape together so a
    // future refactor that splits cx into separate x1/x2 bindings or
    // changes y1/y2 to anything other than 0/innerHeight will trip.
    assert.match(
      lineSrc,
      /<line\s+x1=\{cx\}\s+x2=\{cx\}\s+y1=\{0\}\s+y2=\{innerHeight\}/,
    );
  });

  it("binds cx to xPx(tooltipData.xRaw) — the snapped nearest-x, NOT the raw cursor pixel", () => {
    // The tooltip already snaps to the nearest data point via the
    // onMouseMove handler's nearest-x scan. The cross-hair MUST reuse
    // that same snap (via tooltipData.xRaw) so the indicator aligns
    // with the tooltip's row values. If a future refactor binds cx
    // to tooltipLeft or pt.x (the raw cursor pixel), the indicator
    // would drift away from the tooltip's reported x — that's the
    // failure mode this test defends against.
    assert.match(lineSrc, /const cx = xPx\(tooltipData\.xRaw\);/);
  });

  it("gates the indicator on tooltipOpen && tooltipData && brushStart === null", () => {
    // Three guards in conjunction:
    //   - tooltipOpen: indicator only renders during active hover
    //   - tooltipData: required for the xRaw read (TS narrowing)
    //   - brushStart === null: during a drag, the brush rect owns
    //     the visual; the indicator MUST step aside
    // Whitespace-tolerant on the && separators so prettier reflow
    // doesn't false-fail.
    assert.match(
      lineSrc,
      /\{tooltipOpen\s*&&\s*tooltipData\s*&&\s*brushStart === null\s*&&\s*\(\(\)\s*=>\s*\{/,
    );
  });

  it("carries pointerEvents=\"none\" on the cross-hair line", () => {
    // The cross-hair sits inside the SVG hover/brush surface. Without
    // pointerEvents="none" it would intercept onMouseMove / onMouseUp
    // events whenever the cursor passed across it, breaking the
    // snap-to-nearest-x scan (the scan reads localPoint(e) against
    // the line surface, not against the indicator line). The brush
    // rectangle uses the same guard for the same reason — this test
    // pins the convention.
    // Match within the cross-hair block specifically (the brush rect
    // also has pointerEvents="none" — we want to confirm the
    // indicator block carries it independently).
    const crosshairBlock = lineSrc.match(
      /WHov-line-crosshair[\s\S]*?\}\)\(\)\}/,
    );
    assert.ok(
      crosshairBlock,
      "WHov-line-crosshair block not found in LineRenderer source",
    );
    assert.match(crosshairBlock[0], /pointerEvents="none"/);
  });

  it("uses a dashed stroke style (visual contract — solid would be jarring)", () => {
    // The cross-hair is a subtle hint, not a hard visual divider. A
    // solid stroke at full opacity would over-assert against the data
    // lines underneath. Pin the strokeDasharray presence (the exact
    // dash pattern is intentionally not pinned — future visual-design
    // tweaks may tune it). Source-inspect within the cross-hair
    // block so this test doesn't false-pass on an unrelated dashed
    // element (e.g., the brush rect's strokeDasharray="3 3").
    const crosshairBlock = lineSrc.match(
      /WHov-line-crosshair[\s\S]*?\}\)\(\)\}/,
    );
    assert.ok(crosshairBlock);
    assert.match(crosshairBlock[0], /strokeDasharray="[\d\s]+"/);
  });

  it("returns null when xPx returns a non-finite value (defensive guard)", () => {
    // xPx can return NaN if the snapped xRaw isn't in the current
    // scale's domain (e.g., a zoom-range narrowed the domain mid-
    // hover). The cross-hair guards against rendering at NaN by
    // returning null. Without this guard, React would emit `<line
    // x1="NaN" x2="NaN" ...>` which is a visual no-op but pollutes
    // the DOM. Pin the explicit Number.isFinite check.
    const crosshairBlock = lineSrc.match(
      /WHov-line-crosshair[\s\S]*?\}\)\(\)\}/,
    );
    assert.ok(crosshairBlock);
    assert.match(crosshairBlock[0], /if \(!Number\.isFinite\(cx\)\) return null;/);
  });

  it("Wave WHov-line-crosshair marker present at the indicator block", () => {
    // Greppable lineage. The marker comment block explains the
    // financial-chart pattern + the snap-vs-cursor invariant + the
    // brush-exclusion rationale + the layering choice. Pin the
    // wave-name phrase so a future readability cleanup doesn't
    // accidentally strip the lineage marker.
    assert.match(
      lineSrc,
      /Wave WHov-line-crosshair · vertical cross-hair at the/,
    );
  });
});
