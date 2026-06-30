/**
 * W2 · field-aware axis formatter parity for the chat fullscreen ChartModal.
 *
 * Background: ChartOnlyModal (the dashboard zoom view) was upgraded in Wave F3
 * to format axis ticks with the field-aware `makeAxisTickFormatter(field)` —
 * so a rate column renders "74.2%", currency renders "$1.2M", large counts
 * render "K/M/B". The chat ChartModal was left on the field-BLIND
 * `formatAxisLabelFieldBlind`, so the SAME chart showed raw "0.742" / "1200000"
 * in chat but formatted values on the dashboard. This wave closes that gap by
 * binding per-axis field-aware formatters in ChartModal too.
 *
 * Source-inspection (the modal is React/recharts-shaped — same testing style as
 * the sibling ChartTileBody.test.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const modalSrc = readFileSync(repoFile("./ChartModal.tsx"), "utf-8");

describe("W2 · ChartModal field-aware axis formatters", () => {
  it("imports makeAxisTickFormatter from the shared format module", () => {
    assert.match(
      modalSrc,
      /import \{ makeAxisTickFormatter \} from '@\/lib\/charts\/format'/,
    );
  });

  it("no longer imports the field-blind formatAxisLabelFieldBlind", () => {
    assert.doesNotMatch(modalSrc, /formatAxisLabelFieldBlind/);
    assert.doesNotMatch(modalSrc, /formatAxisLabel\b/);
  });

  it("binds y / y2 / x tick formatters from the chart's fields via useMemo", () => {
    assert.match(
      modalSrc,
      /const yTickFormatter = useMemo\(\(\) => makeAxisTickFormatter\(y\), \[y\]\);/,
    );
    assert.match(
      modalSrc,
      /const y2TickFormatter = useMemo\(\(\) => makeAxisTickFormatter\(chart\.y2\), \[chart\.y2\]\);/,
    );
    assert.match(
      modalSrc,
      /const xTickFormatter = useMemo\(\(\) => makeAxisTickFormatter\(x\), \[x\]\);/,
    );
  });

  it("routes the dual-axis RIGHT (y2) axis through y2TickFormatter", () => {
    assert.match(
      modalSrc,
      /orientation="right"[\s\S]*?stroke=\{rightAxisColor\}[\s\S]*?tickFormatter=\{y2TickFormatter\}/,
    );
  });

  it("routes the scatter numeric X axis through xTickFormatter", () => {
    assert.match(
      modalSrc,
      /domain=\{xDomain \|\| \['auto', 'auto'\]\}[\s\S]*?tickFormatter=\{xTickFormatter\}/,
    );
  });

  it("uses the field-aware y formatter for the main value axes (no field-blind ticks remain)", () => {
    // Every remaining axis formatter must be one of the three field-aware
    // bindings — there must be no un-bound / field-blind tickFormatter left.
    const tickFormatters = modalSrc.match(/tickFormatter=\{[^}]+\}/g) ?? [];
    assert.ok(tickFormatters.length >= 9, "expected the full set of axis tick formatters");
    for (const tf of tickFormatters) {
      assert.match(
        tf,
        /tickFormatter=\{(yTickFormatter|y2TickFormatter|xTickFormatter)\}/,
      );
    }
  });
});
