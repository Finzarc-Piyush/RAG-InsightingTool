/**
 * bar-limit · source-inspection for ChartRenderer's `chart.limit` wiring.
 *
 * ChartRenderer is a ~1,800-line recharts component (ResponsiveContainer needs a
 * measured width, so it doesn't render meaningfully under node:test/jsdom). The
 * BEHAVIOUR of the selection itself — `applyChartSort(..., { limit })` picking the
 * top/bottom-N by value — is pinned in `server/tests/chartSort.test.ts`. Here we
 * pin the load-bearing INTEGRATION decisions in the renderer at the source level:
 *
 *   - a `limitedBarData` memo applies `chart.limit` (via the shared applyChartSort)
 *     to `chartData` BEFORE the width-based compaction;
 *   - the compaction (`shouldCompactView` / `compactBarData` / `visibleBarData`)
 *     reads `limitedBarData`, not the raw `chartData`, so the bars the chart shows
 *     are the limit-selected ones even on a dashboard tile (fillParent);
 *   - the width cap is FLOORED at `chart.limit.n`, so it only thins labels and
 *     never head-slices away a deliberately-selected category.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) => resolve(new URL(rel, import.meta.url).pathname);
const src = readFileSync(repoFile("./ChartRenderer.tsx"), "utf-8");

describe("ChartRenderer · chart.limit selection wiring", () => {
  it("imports the shared applyChartSort authority", () => {
    assert.match(src, /import \{ applyChartSort \} from ['"]@\/shared\/chartSort['"]/);
  });

  it("computes limitedBarData from chart.limit via applyChartSort (bar only)", () => {
    assert.match(src, /const limitedBarData = useMemo\(/);
    assert.match(src, /type !== 'bar' \|\|\s*!chart\.limit/);
    assert.match(
      src,
      /applyChartSort\(\s*chartData[\s\S]*?limit: chart\.limit[\s\S]*?\)/,
    );
  });

  it("floors the width-based compact limit at chart.limit.n (thin labels, never drop selected bars)", () => {
    assert.match(src, /if \(type === 'bar' && chart\.limit\) return Math\.max\(widthFloor, chart\.limit\.n\)/);
  });

  it("feeds limitedBarData (not raw chartData) into the compaction + visible bar data", () => {
    assert.match(src, /shouldCompactView = type === 'bar'[\s\S]*?limitedBarData\.length > compactBarLimit/);
    assert.match(src, /const visibleBarData = shouldCompactView \? compactBarData : limitedBarData;/);
  });
});
