/**
 * Wave WD2-wiring-rest-point · source-inspection tests for
 * PointRenderer (scatter / bubble) cross-filter wiring.
 *
 * PointRenderer is unique among the WD2-wiring-rest renderers: its
 * dispatch is CONDITIONAL on `colorCh` being non-null. Pure
 * quantitative (x, y) scatters have no categorical field to filter
 * on — `toFilterValue(<continuous number>)` would coerce to a stable
 * string but the resulting categorical filter would never match an
 * existing data row. When `colorCh` IS set, clicking any point in a
 * color group dispatches `{ column: colorCh.field, value:
 * toFilterValue(<raw color>), sourceTileId }`, toggling that group's
 * brush on the dashboard.
 *
 * Both the `<Circle>` (no `shape` encoding) and `<path>` (glyph
 * shape encoding) branches gain the same onClick + cursor style so
 * the wiring is uniform across the render path.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const pointSrc = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/PointRenderer.tsx"),
  "utf-8",
);

describe("WD2-wiring-rest-point · PointRenderer cross-filter wiring", () => {
  it("imports useDashboardTileContext from @/pages/Dashboard/lib/dashboardTileContext", () => {
    assert.match(
      pointSrc,
      /import \{ useDashboardTileContext \} from "@\/pages\/Dashboard\/lib\/dashboardTileContext"/,
    );
  });

  it("imports dispatchCrossFilter + toFilterValue from @/pages/Dashboard/lib/crossFilter", () => {
    assert.match(
      pointSrc,
      /import \{[\s\S]*?dispatchCrossFilter[\s\S]*?toFilterValue[\s\S]*?\} from "@\/pages\/Dashboard\/lib\/crossFilter"/,
    );
  });

  it("reads the dashboard-tile context once in the renderer body", () => {
    assert.match(pointSrc, /const dashboardTile = useDashboardTileContext\(\);/);
  });

  it("declares `crossFilterReady = !!dashboardTile && !!colorCh` so dispatch is conditional on colorCh", () => {
    // The colorCh gate is the load-bearing decision for this wave —
    // pure quant scatters have no filter target and must not dispatch.
    assert.match(
      pointSrc,
      /const crossFilterReady = !!dashboardTile && !!colorCh;/,
    );
  });

  it("dispatches CROSS_FILTER_EVENT with { column: colorCh!.field, value: toFilterValue(p.rawColor), sourceTileId }", () => {
    assert.match(
      pointSrc,
      /dispatchCrossFilter\(\{[\s\S]*?column: colorCh!\.field,[\s\S]*?value: toFilterValue\(p\.rawColor\),[\s\S]*?sourceTileId: dashboardTile!\.tileId,[\s\S]*?\}\);/,
    );
  });

  it("the onClick handler is the conditional `crossFilterReady ? () => { dispatch } : undefined`", () => {
    assert.match(pointSrc, /const onPointClick = crossFilterReady\s*\?[\s\S]*?dispatchCrossFilter/);
  });

  it("the cursor:pointer style is gated on `crossFilterReady`, not just `dashboardTile`", () => {
    assert.match(
      pointSrc,
      /const cursorStyle = crossFilterReady\s*\?\s*\{\s*cursor:\s*"pointer" as const\s*\}\s*:\s*undefined;/,
    );
  });

  it("the <Circle> render path gains `style={cursorStyle}` + `onClick={onPointClick}`", () => {
    assert.match(
      pointSrc,
      /<Circle[\s\S]*?style=\{cursorStyle\}[\s\S]*?onClick=\{onPointClick\}[\s\S]*?\/>/,
    );
  });

  it("the glyph <path> render path gains `style={cursorStyle}` + `onClick={onPointClick}`", () => {
    assert.match(
      pointSrc,
      /<path\s+key=\{`pt-\$\{p\.i\}`\}[\s\S]*?style=\{cursorStyle\}[\s\S]*?onClick=\{onPointClick\}[\s\S]*?\/>/,
    );
  });

  it("the existing onMouseMove + onMouseLeave handlers are preserved (cross-filter does not break the tooltip)", () => {
    // Pin both renderers (Circle + glyph path) so the tooltip pathway
    // doesn't regress when a future maintainer touches the cursor /
    // onClick block.
    assert.match(pointSrc, /<Circle[\s\S]*?onMouseMove=\{onPointMove\}[\s\S]*?onMouseLeave=\{hideTooltip\}/);
    assert.match(pointSrc, /<path[\s\S]*?onMouseMove=\{onPointMove\}[\s\S]*?onMouseLeave=\{hideTooltip\}/);
  });
});

describe("WD2-wiring-rest-point · raw color value is preserved on every point", () => {
  it("each point carries `rawColor` (type-original color accessor value or undefined)", () => {
    assert.match(pointSrc, /const rawColor = colorCh \? colorCh\.accessor\(r\) : undefined;/);
  });

  it("the stringified `colorKey` is derived from `rawColor` (one accessor call, not two)", () => {
    assert.match(pointSrc, /const colorKey = colorCh \? asString\(rawColor\) : "";/);
  });

  it("`rawColor` is included in the point object returned from the data.map", () => {
    assert.match(pointSrc, /colorKey,[\s\S]*?rawColor,/);
  });
});
