/**
 * Wave WI2-wire-bind · source-inspection tests for the
 * ChartTileBody / DashboardTiles / DashboardView wiring that closes
 * the WI2 trilogy end-to-end.
 *
 * The pieces:
 *   - DashboardView mounts a single shared `createInsightRegenCache()`
 *     via `useMemo(..., [])` and threads it down through DashboardTiles
 *     into every ChartTileBody (so re-exploring filter combo A after
 *     B paints from cache rather than re-firing the LLM).
 *   - DashboardTiles accepts an optional `insightRegenCache` prop and
 *     forwards it to ChartTileBody without modification.
 *   - ChartTileBody calls `useInsightRegen({ tileId, filters, cache })`,
 *     derives an `InsightChartSpecLite` from `tile.chart`, applies the
 *     tile's active filters to `tile.chart.data ?? []` via
 *     `applyChartFilters`, binds a no-arg `handleRegenerate` callback
 *     that fires `regen.regenerate(specLite, filteredRows)`, and
 *     passes `regen={{ entry, loading, error, onRegenerate }}` to
 *     `TileInsightFooter`.
 *
 * These pieces are React-shaped (hooks + JSX) so we don't render them
 * through node:test. Instead we pin the load-bearing decisions at the
 * source level — the WI2-cache + WI2-server + WI2-wire layers already
 * have their own behavioural tests, and the binding wave is a wiring
 * proof, not a new behaviour.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const bodySrc = readFileSync(repoFile("./ChartTileBody.tsx"), "utf-8");
const tilesSrc = readFileSync(repoFile("./DashboardTiles.tsx"), "utf-8");
const viewSrc = readFileSync(repoFile("./DashboardView.tsx"), "utf-8");

describe("WI2-wire-bind · ChartTileBody hooks + filtered-data binding", () => {
  it("imports useInsightRegen + its InsightChartSpecLite / InsightRegenRow types from the hook module", () => {
    assert.match(
      bodySrc,
      /import \{[\s\S]*?useInsightRegen,[\s\S]*?type InsightChartSpecLite,[\s\S]*?type InsightRegenRow,[\s\S]*?\} from "\.\.\/hooks\/useInsightRegen"/,
    );
  });

  it("imports the InsightRegenCache type from the WI2-cache module (type-only)", () => {
    assert.match(
      bodySrc,
      /import type \{ InsightRegenCache \} from "\.\.\/lib\/insightRegenCache"/,
    );
  });

  it("imports applyChartFilters alongside ActiveChartFilters from @/lib/chartFilters", () => {
    assert.match(
      bodySrc,
      /import \{ applyChartFilters, type ActiveChartFilters \} from "@\/lib\/chartFilters"/,
    );
  });

  it("declares insightRegenCache as an optional InsightRegenCache prop", () => {
    assert.match(bodySrc, /insightRegenCache\?: InsightRegenCache;/);
  });

  it("destructures insightRegenCache from props", () => {
    assert.match(bodySrc, /^\s*insightRegenCache,\s*$/m);
  });

  it("memoises the InsightChartSpecLite over tile.chart's load-bearing fields", () => {
    // The dep array MUST include type / title / x / y so the lite spec
    // recomputes when the chart's identity changes; series + aggregate
    // are optional so they round out the dep array for stability.
    assert.match(
      bodySrc,
      /const specLite: InsightChartSpecLite = useMemo\(\s*\(\) => \(\{[\s\S]*?type: tile\.chart\.type,[\s\S]*?title: tile\.chart\.title,[\s\S]*?x: tile\.chart\.x,[\s\S]*?y: tile\.chart\.y,[\s\S]*?\}\),\s*\[[\s\S]*?tile\.chart\.type,[\s\S]*?tile\.chart\.x,[\s\S]*?tile\.chart\.y,[\s\S]*?\],\s*\);/,
    );
  });

  it("spreads seriesColumn + aggregate conditionally so undefined optionals don't ship", () => {
    // The hook's request body is built with spread-conditional optionals
    // for the same reason — keep the strict zod schema happy.
    assert.match(
      bodySrc,
      /\.\.\.\(tile\.chart\.seriesColumn \? \{ seriesColumn: tile\.chart\.seriesColumn \} : \{\}\)/,
    );
    assert.match(
      bodySrc,
      /\.\.\.\(tile\.chart\.aggregate \? \{ aggregate: tile\.chart\.aggregate \} : \{\}\)/,
    );
  });

  it("filters the chart's embedded rows with applyChartFilters + a `?? []` / `?? {}` fall-through", () => {
    // `tile.chart.data` is optional on the ChartSpec schema; `?? []`
    // makes the empty-data branch a no-op rather than throwing. The
    // filters prop is also optional → `?? {}` keeps applyChartFilters
    // pure when no global filter is active.
    assert.match(
      bodySrc,
      /const filteredRows = useMemo<InsightRegenRow\[\]>\(\s*\(\) =>\s*applyChartFilters\(\s*\(tile\.chart\.data \?\? \[\]\) as Array<Record<string, string \| number \| null>>,\s*filters \?\? \{\},\s*\) as InsightRegenRow\[\],\s*\[tile\.chart\.data, filters\],\s*\);/,
    );
  });

  it("mounts useInsightRegen with { tileId, filters ?? {}, cache: insightRegenCache }", () => {
    assert.match(
      bodySrc,
      /const regen = useInsightRegen\(\{\s*tileId: tile\.id,\s*filters: filters \?\? \{\},\s*cache: insightRegenCache,\s*\}\);/,
    );
  });

  it("binds handleRegenerate via useCallback closing over regen + specLite + filteredRows", () => {
    // `void` discards the promise — fire-and-forget; the hook is
    // responsible for the loading/error state surfaced through props.
    assert.match(
      bodySrc,
      /const handleRegenerate = useCallback\(\(\) => \{\s*void regen\.regenerate\(specLite, filteredRows\);\s*\},\s*\[regen, specLite, filteredRows\]\);/,
    );
  });

  it("passes the regen prop to TileInsightFooter with the four-key contract", () => {
    assert.match(
      bodySrc,
      /<TileInsightFooter[\s\S]*?regen=\{\{\s*entry: regen\.entry,\s*loading: regen\.loading,\s*error: regen\.error,\s*onRegenerate: handleRegenerate,\s*\}\}[\s\S]*?\/>/,
    );
  });

  it("always renders the footer, driving the empty/generate state via resolveInsightFooterMode (Wave Z3)", () => {
    // Wave Z3 superseded the pre-binding `tile.chart.keyInsight ? (...) : null`
    // guard: the footer now ALWAYS renders so auto-built dashboard charts (whose
    // insight is patched in asynchronously by the server) still show the
    // collapsible chrome + a "Generate insight" CTA in the meantime. The old
    // gate must be gone, and the empty state must be derived from the mode.
    assert.doesNotMatch(bodySrc, /tile\.chart\.keyInsight \? \(\s*<TileInsightFooter/);
    assert.match(bodySrc, /<TileInsightFooter/);
    assert.match(bodySrc, /emptyState=\{[\s\S]*?resolveInsightFooterMode\(/);
  });
});

describe("WI2-wire-bind · DashboardTiles forwards the cache without modification", () => {
  it("imports the InsightRegenCache type (type-only) from the WI2-cache module", () => {
    assert.match(
      tilesSrc,
      /import type \{ InsightRegenCache \} from '\.\.\/lib\/insightRegenCache'/,
    );
  });

  it("declares insightRegenCache as an optional prop on DashboardTilesProps", () => {
    assert.match(tilesSrc, /insightRegenCache\?: InsightRegenCache;/);
  });

  it("destructures insightRegenCache from props", () => {
    assert.match(tilesSrc, /^\s*insightRegenCache,\s*$/m);
  });

  it("forwards insightRegenCache to ChartTileBody verbatim", () => {
    // The component is just a pass-through — no shape change between
    // the DashboardView mount and the ChartTileBody consumer.
    assert.match(
      tilesSrc,
      /<ChartTileBody[\s\S]*?insightRegenCache=\{insightRegenCache\}[\s\S]*?\/>/,
    );
  });
});

describe("WI2-wire-bind · DashboardView mounts a single shared cache", () => {
  it("imports createInsightRegenCache from the WI2-cache module", () => {
    assert.match(
      viewSrc,
      /import \{ createInsightRegenCache \} from '\.\.\/lib\/insightRegenCache'/,
    );
  });

  it("creates the cache via useMemo with an empty dep array (one instance per DashboardView mount)", () => {
    // The empty deps are load-bearing — they pin a single cache
    // instance for the dashboard session. A stale dep would churn
    // the cache on every re-render and defeat the warm-cache hit.
    assert.match(
      viewSrc,
      /const insightRegenCache = useMemo\(\(\) => createInsightRegenCache\(\), \[\]\);/,
    );
  });

  it("threads the cache through to DashboardTiles as `insightRegenCache={insightRegenCache}`", () => {
    assert.match(
      viewSrc,
      /<DashboardTiles[\s\S]*?insightRegenCache=\{insightRegenCache\}[\s\S]*?\/>/,
    );
  });
});
