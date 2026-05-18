/**
 * Wave WD2-wiring-rest-cat · source-inspection tests for the 5
 * categorical visx renderers wired to `dispatchCrossFilter`.
 *
 * Pattern (already proven on BarRenderer in WD2-wiring-bar):
 *   1. Import `useDashboardTileContext` + `dispatchCrossFilter` + `toFilterValue`.
 *   2. Read the dashboard-tile context once at the top of render.
 *   3. Add an `onClick` on the categorical mark that dispatches
 *      `CROSS_FILTER_EVENT` with `{ column: <xField>, value:
 *      toFilterValue(<rawValue>), sourceTileId: dashboardTile.tileId }`
 *      when `dashboardTile` is non-null. Outside a dashboard tile
 *      (chat / explorer / share preview) the click is a no-op.
 *
 * Source-level pins keep the pattern from regressing as the renderers
 * evolve. Behaviour is exercised by the integration round-trip already
 * pinned by `dashboardTileContext.test.ts` (which lives on
 * BarRenderer); the other four marks share the same dispatch shape.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const arcSrc = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/ArcRenderer.tsx"),
  "utf-8",
);
const funnelSrc = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/FunnelRenderer.tsx"),
  "utf-8",
);
const boxSrc = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/BoxRenderer.tsx"),
  "utf-8",
);
const waterfallSrc = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/WaterfallRenderer.tsx"),
  "utf-8",
);
const comboSrc = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/ComboRenderer.tsx"),
  "utf-8",
);

interface RendererPin {
  name: string;
  src: string;
  /** The encoding-field expression used as `column:` in the dispatch. */
  columnExpr: string;
  /** The raw-value expression passed to `toFilterValue`. */
  rawValueExpr: string;
  /**
   * The expression that gates the onClick (the ternary's predicate).
   * Most renderers use `dashboardTile` directly; WaterfallRenderer
   * adds an `!b.isTotal` clause via an intermediate `clickable` local.
   */
  clickGate: string;
}

const renderers: RendererPin[] = [
  {
    name: "ArcRenderer",
    src: arcSrc,
    columnExpr: "labelCh.field",
    rawValueExpr: "arc.data.rawKey",
    clickGate: "dashboardTile",
  },
  {
    name: "FunnelRenderer",
    src: funnelSrc,
    columnExpr: "enc.x.field",
    rawValueExpr: "s.rawLabel",
    clickGate: "dashboardTile",
  },
  {
    name: "BoxRenderer",
    src: boxSrc,
    columnExpr: "enc.x.field",
    rawValueExpr: "s.rawCategory",
    clickGate: "dashboardTile",
  },
  {
    name: "WaterfallRenderer",
    src: waterfallSrc,
    columnExpr: "enc.x.field",
    rawValueExpr: "b.rawCategory",
    clickGate: "clickable",
  },
  {
    name: "ComboRenderer",
    src: comboSrc,
    columnExpr: "xCh.field",
    rawValueExpr: "rawX",
    clickGate: "dashboardTile",
  },
];

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

for (const r of renderers) {
  describe(`WD2-wiring-rest-cat · ${r.name} cross-filter wiring`, () => {
    it("imports useDashboardTileContext from @/pages/Dashboard/lib/dashboardTileContext", () => {
      assert.match(
        r.src,
        /import \{ useDashboardTileContext \} from "@\/pages\/Dashboard\/lib\/dashboardTileContext"/,
      );
    });

    it("imports dispatchCrossFilter + toFilterValue from @/pages/Dashboard/lib/crossFilter", () => {
      assert.match(
        r.src,
        /import \{[\s\S]*?dispatchCrossFilter[\s\S]*?toFilterValue[\s\S]*?\} from "@\/pages\/Dashboard\/lib\/crossFilter"/,
      );
    });

    it("reads the dashboard-tile context once in the renderer body", () => {
      assert.match(
        r.src,
        /const dashboardTile = useDashboardTileContext\(\);/,
      );
    });

    it("dispatches CROSS_FILTER_EVENT via dispatchCrossFilter when in a dashboard tile", () => {
      // The dispatch shape varies per renderer but the column / value
      // shape is byte-stable: `column: <field>, value: toFilterValue(<raw>)`.
      const dispatchRe = new RegExp(
        "dispatchCrossFilter\\(\\{[\\s\\S]*?" +
          `column: ${esc(r.columnExpr)},[\\s\\S]*?` +
          `value: toFilterValue\\(${esc(r.rawValueExpr)}\\),[\\s\\S]*?` +
          "sourceTileId: dashboardTile[!]?\\.tileId,[\\s\\S]*?" +
          "\\}\\);",
      );
      assert.match(r.src, dispatchRe);
    });

    it("the dispatch is gated on a dashboard-tile predicate (not always fired)", () => {
      // The onClick branch must check the context, not always fire —
      // that keeps the chat / explorer no-op invariant intact. The
      // gate is either `dashboardTile` directly or a local that
      // narrows it (e.g. WaterfallRenderer's `clickable` which adds
      // `!b.isTotal`).
      const gateRe = new RegExp(`${esc(r.clickGate)}\\s*\\?[\\s\\S]*?dispatchCrossFilter`);
      assert.match(r.src, gateRe);
    });

    it("sets cursor:pointer only when the click gate is satisfied", () => {
      const cursorRe = new RegExp(
        `style=\\{${esc(r.clickGate)}[^?]*\\?\\s*\\{\\s*cursor:\\s*"pointer"\\s*\\}\\s*:\\s*undefined\\}`,
      );
      assert.match(r.src, cursorRe);
    });
  });
}

describe("WD2-wiring-rest-cat · WaterfallRenderer skips totals", () => {
  it("running-total bars (`b.isTotal === true`) are NOT clickable for cross-filter", () => {
    // Totals are synthetic summary rows — there's no category to filter
    // to. The renderer must explicitly skip them when wiring the dispatch.
    assert.match(
      waterfallSrc,
      /const clickable = dashboardTile && !b\.isTotal;/,
    );
  });
});

describe("WD2-wiring-rest-cat · raw category values are preserved on every renderer", () => {
  it("ArcRenderer.Slice carries `rawKey: unknown` alongside the stringified `key`", () => {
    assert.match(arcSrc, /rawKey: unknown;/);
    // The aggregation captures the first row's raw value when a key is
    // first seen; subsequent rows merge into the same slice.
    assert.match(arcSrc, /totals\.set\(k, \{ value: v, rawKey \}\)/);
  });

  it("FunnelRenderer stages carry `rawLabel` (type-original x value)", () => {
    assert.match(funnelSrc, /rawLabel: enc\.x\.accessor\(r\),/);
  });

  it("BoxRenderer.BoxStats carries `rawCategory: unknown`", () => {
    assert.match(boxSrc, /rawCategory: unknown;/);
    assert.match(boxSrc, /rawCategory: rows\[0\]\?\.\[enc\.x\.field\],/);
  });

  it("WaterfallRenderer.WaterfallBar carries `rawCategory: unknown`", () => {
    assert.match(waterfallSrc, /rawCategory: unknown;/);
    assert.match(waterfallSrc, /const rawCategory = enc\.x\.accessor\(r\);/);
  });

  it("ComboRenderer preserves `rawX` from `xCh.accessor(row)` before stringifying", () => {
    assert.match(comboSrc, /const rawX = xCh\.accessor\(row\);/);
    assert.match(comboSrc, /const xRaw = asString\(rawX\);/);
  });
});
