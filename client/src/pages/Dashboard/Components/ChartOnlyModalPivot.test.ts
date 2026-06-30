/**
 * W9 · the dashboard fullscreen ChartOnlyModal gains the Chart ↔ pivot toggle
 * the chat ChartModal already had. Source-inspection (recharts + dialog-heavy
 * modal — same testing style as the sibling ChartTileBody.test.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const modalSrc = readFileSync(repoFile("./ChartOnlyModal.tsx"), "utf-8");

describe("W9 · ChartOnlyModal pivot toggle", () => {
  it("imports the shared ChartTilePivotView + chartSpecToPivotConfig", () => {
    assert.match(
      modalSrc,
      /import \{ ChartTilePivotView \} from '@\/components\/charts\/ChartTilePivotView'/,
    );
    assert.match(
      modalSrc,
      /import \{ chartSpecToPivotConfig \} from '@\/components\/charts\/chartSpecToPivotConfig'/,
    );
  });

  it("keeps a view state that resets to 'chart' on open (per-open, like Show dots)", () => {
    assert.match(modalSrc, /const \[view, setView\] = useState<'chart' \| 'pivot'>\('chart'\)/);
    assert.match(
      modalSrc,
      /useEffect\(\(\) => \{\s*if \(isOpen\) setView\('chart'\);\s*\}, \[isOpen\]\)/,
    );
  });

  it("derives canPivot from chartSpecToPivotConfig + non-empty data, gated to effectiveView", () => {
    assert.match(modalSrc, /if \(chartSpecToPivotConfig\(chart\) === null\) return false;/);
    assert.match(
      modalSrc,
      /const effectiveView: 'chart' \| 'pivot' = canPivot \? view : 'chart';/,
    );
  });

  it("renders the toggle group in the header", () => {
    assert.match(modalSrc, /data-testid="chart-only-modal-pivot-toggle"/);
  });

  it("renders ChartTilePivotView in the body when the pivot view is active", () => {
    assert.match(
      modalSrc,
      /effectiveView === 'pivot' \? \([\s\S]*?data-testid="chart-only-modal-pivot-body"[\s\S]*?<ChartTilePivotView[\s\S]*?\) : \(\s*renderChart\(\)\s*\)/,
    );
  });

  it("hides the chart-only controls (sort / limit / scatter) while in pivot view", () => {
    assert.match(modalSrc, /effectiveView === 'chart' && showSortControl &&/);
    assert.match(
      modalSrc,
      /effectiveView === 'chart' && showSortControl && showLimitControl &&/,
    );
    assert.match(modalSrc, /effectiveView === 'chart' && type === 'scatter' &&/);
  });
});

describe("W11 · ChartOnlyModal on-demand Key-Insight fetch", () => {
  it("declares the optional keyInsightSessionId prop", () => {
    assert.match(modalSrc, /keyInsightSessionId\?: string \| null;/);
    assert.match(modalSrc, /keyInsightSessionId = null,/);
  });

  it("fetches only when the chart is bare AND a session id is present", () => {
    // Guards: skip if an inline insight already exists, and skip if no sid.
    assert.match(modalSrc, /if \(existing\) return;/);
    assert.match(modalSrc, /const sid = keyInsightSessionId\?\.trim\(\);\s*if \(!sid\) return;/);
    assert.match(
      modalSrc,
      /api\.post<\{ keyInsight: string \}>\(\s*`\/api\/sessions\/\$\{sid\}\/chart-key-insight`/,
    );
  });

  it("renders the fetched insight via the shared ChartInsightBody (displayKeyInsight fallback)", () => {
    assert.match(
      modalSrc,
      /const displayKeyInsight =\s*\(typeof chart\.keyInsight === 'string' && chart\.keyInsight\.trim\(\)\) \|\|\s*fetchedKeyInsight;/,
    );
    assert.match(modalSrc, /<ChartInsightBody keyInsight=\{displayKeyInsight\}/);
  });
});
