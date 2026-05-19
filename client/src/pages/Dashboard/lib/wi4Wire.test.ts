/**
 * Wave WI4-wire · source-inspection tests for the ExplainSlicePanel
 * useInsightRegen integration + the DashboardView chart-resolution
 * that threads the brushed tile's spec into the panel.
 *
 * Swaps the WI4-panel placeholder body for a real regen call. The
 * panel narrows rows through the WI2 pipeline:
 *   global filters → applyChartFilters → brush region →
 *     filterRowsByBrushRegion → useInsightRegen.regenerate.
 *
 * Tests pin: the four hook-and-helper imports added to the panel;
 * the two new props (chart + insightRegenCache) on the panel
 * interface; the specLite useMemo's field-for-field shape (mirrors
 * WI2-wire-bind's ChartTileBody shape); the narrowedRows compose-AND
 * via applyChartFilters → filterRowsByBrushRegion; the unconditional
 * useInsightRegen call with the IDLE_TILE_ID fallback for the
 * no-event case (React rules of hooks); the useEffect-driven
 * regenerate firing on event/spec change with the eslint-disable
 * comment marking the deliberate omission of `regen` from deps;
 * the four-branch render (no chart → "Could not resolve …"; loading
 * → "Regenerating …"; error → role="alert" + regen.error string;
 * data → whitespace-pre-wrap entry text); the placeholder text
 * negative pin (the WI4-panel placeholder body is GONE); the
 * DashboardView chart resolution from event.chartId via the
 * `chart-(\d+)` regex pointing at `activeSheet.charts[idx]`; the
 * insightRegenCache prop threaded through; the WI4-wire wave marker.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const panelSrc = readFileSync(
  repoFile("../Components/ExplainSlicePanel.tsx"),
  "utf-8",
);
const dashSrc = readFileSync(
  repoFile("../Components/DashboardView.tsx"),
  "utf-8",
);

// ── Panel imports ──────────────────────────────────────────────────

describe("WI4-wire · ExplainSlicePanel imports", () => {
  it("imports applyChartFilters + ActiveChartFilters from @/lib/chartFilters", () => {
    // applyChartFilters is the first half of the narrowing pipeline
    // (global filters → narrowed rows). The named-export shape
    // mirrors the ChartTileBody WI2-wire-bind pattern.
    assert.match(
      panelSrc,
      /import\s*\{\s*applyChartFilters,\s*type\s+ActiveChartFilters,?\s*\}\s*from\s*["']@\/lib\/chartFilters["']/,
    );
  });

  it("imports ChartSpec from @/shared/schema (typed prop)", () => {
    // The new `chart?: ChartSpec | null` prop needs the type; the
    // import is type-only so the build doesn't pull the schema's
    // runtime zod.
    assert.match(
      panelSrc,
      /import\s+type\s*\{\s*ChartSpec\s*\}\s*from\s*["']@\/shared\/schema["']/,
    );
  });

  it("imports useInsightRegen + InsightChartSpecLite + InsightRegenRow from the hooks dir", () => {
    // The regen pipeline's load-bearing trio: the hook itself, the
    // strict spec shape it accepts, and the row cell type.
    assert.match(
      panelSrc,
      /import\s*\{\s*useInsightRegen,\s*type\s+InsightChartSpecLite,\s*type\s+InsightRegenRow,?\s*\}\s*from\s*["']\.\.\/hooks\/useInsightRegen["']/,
    );
  });

  it("imports InsightRegenCache as a type from the lib dir", () => {
    // The shared LRU+TTL cache is threaded in as a prop so panel
    // re-opens within the same dashboard session hit cached entries.
    assert.match(
      panelSrc,
      /import\s+type\s*\{\s*InsightRegenCache\s*\}\s*from\s*["']\.\.\/lib\/insightRegenCache["']/,
    );
  });

  it("imports filterRowsByBrushRegion alongside the existing BrushRegion + ExplainSliceEvent types", () => {
    // The second half of the narrowing pipeline. Single combined
    // import block — the foundation module is the single source of
    // truth for all WI4 helpers.
    assert.match(
      panelSrc,
      /import\s*\{\s*filterRowsByBrushRegion,\s*type\s+BrushRegion,\s*type\s+ExplainSliceEvent,?\s*\}\s*from\s*["']\.\.\/lib\/explainSlice["']/,
    );
  });
});

// ── Panel props expansion ──────────────────────────────────────────

describe("WI4-wire · ExplainSlicePanel new optional props", () => {
  it("accepts an optional `chart?: ChartSpec | null` prop", () => {
    // Optional + nullable so a missing resolution (tile removed,
    // chart id mismatched) falls back to the no-chart render branch.
    assert.match(panelSrc, /chart\?:\s*ChartSpec\s*\|\s*null/);
  });

  it("accepts an optional `insightRegenCache?: InsightRegenCache` prop", () => {
    // Optional so unit tests can mount the panel without a cache; the
    // hook's per-mount fallback covers the gap.
    assert.match(
      panelSrc,
      /insightRegenCache\?:\s*InsightRegenCache/,
    );
  });

  it("destructures both new props in the component signature", () => {
    // The signature gain — guards against future props that
    // accidentally drop these.
    assert.match(
      panelSrc,
      /export function ExplainSlicePanel\(\{[\s\S]*?chart,[\s\S]*?insightRegenCache,[\s\S]*?\}: ExplainSlicePanelProps\)/,
    );
  });
});

// ── specLite derivation ────────────────────────────────────────────

describe("WI4-wire · specLite derivation mirrors WI2-wire-bind", () => {
  it("declares specLite via useMemo, returning null when chart is null", () => {
    // useMemo so the panel re-renders without re-allocating the spec
    // object when chart hasn't changed.
    assert.match(
      panelSrc,
      /const\s+specLite:\s*InsightChartSpecLite\s*\|\s*null\s*=\s*useMemo\(/,
    );
    assert.match(panelSrc, /if\s*\(\s*!chart\s*\)\s*return\s+null;/);
  });

  it("maps type / title / x / y unconditionally and seriesColumn / aggregate spread-conditionally", () => {
    // Field-for-field subset of ChartSpec — mirrors ChartTileBody's
    // WI2-wire-bind shape so the two consumers stay parallel. The
    // spread-conditional shape avoids shipping `undefined` to the
    // strict zod request schema.
    assert.match(panelSrc, /type:\s*chart\.type/);
    assert.match(panelSrc, /title:\s*chart\.title/);
    assert.match(panelSrc, /x:\s*chart\.x/);
    assert.match(panelSrc, /y:\s*chart\.y/);
    assert.match(
      panelSrc,
      /\.\.\.\(chart\.seriesColumn\s*\?\s*\{\s*seriesColumn:\s*chart\.seriesColumn\s*\}\s*:\s*\{\}\)/,
    );
    assert.match(
      panelSrc,
      /\.\.\.\(chart\.aggregate\s*\?\s*\{\s*aggregate:\s*chart\.aggregate\s*\}\s*:\s*\{\}\)/,
    );
  });
});

// ── narrowedRows compose-AND pipeline ──────────────────────────────

describe("WI4-wire · narrowedRows composes applyChartFilters → filterRowsByBrushRegion", () => {
  it("uses useMemo to memoise the narrowing across re-renders", () => {
    // Without the memo, a brushed slice with thousands of rows
    // would re-filter on every render (panel state changes during
    // regen would trigger that).
    assert.match(
      panelSrc,
      /const\s+narrowedRows\s*=\s*useMemo<InsightRegenRow\[\]>/,
    );
  });

  it("applies applyChartFilters FIRST with the captured event.filters", () => {
    // applyChartFilters compose-AND-commutes with the brush filter,
    // but ordering matches the WI2-wire-bind ChartTileBody pipeline
    // for consistency.
    assert.match(
      panelSrc,
      /applyChartFilters\(\s*\(chart\.data\s*\?\?\s*\[\]\)\s*as\s+Array<Record<string,\s*string\s*\|\s*number\s*\|\s*null>>,\s*event\.filters\s*\?\?\s*\{\},?\s*\)/,
    );
  });

  it("applies filterRowsByBrushRegion SECOND with event.column + event.region", () => {
    // The brush is the load-bearing narrowing for this panel — it
    // turns "the chart's filtered data" into "the chart's filtered
    // data within the brush region".
    assert.match(
      panelSrc,
      /filterRowsByBrushRegion\(\s*filteredByGlobal,\s*event\.column,\s*event\.region,?\s*\)/,
    );
  });

  it("returns [] when chart OR event is null (the regen effect short-circuits on null)", () => {
    // Defensive empty-array return so downstream consumers
    // (specLite, regen.regenerate) get a typed empty input rather
    // than a runtime undefined.
    assert.match(panelSrc, /if\s*\(\s*!chart\s*\|\|\s*!event\s*\)\s*return\s+\[\]/);
  });
});

// ── useInsightRegen hook call ──────────────────────────────────────

describe("WI4-wire · useInsightRegen hook call (unconditional)", () => {
  it("calls useInsightRegen with event-derived tileId + filters + injected cache", () => {
    // Always called (React rules of hooks); fields fall back to
    // safe defaults when event is null.
    assert.match(
      panelSrc,
      /const\s+regen\s*=\s*useInsightRegen\(\s*\{\s*tileId:\s*event\?\.\bchartId\s*\?\?\s*IDLE_TILE_ID,\s*filters:\s*event\?\.\bfilters\s*\?\?\s*\{\},\s*cache:\s*insightRegenCache,?\s*\}\s*\)/,
    );
  });

  it("declares an IDLE_TILE_ID stable fallback constant", () => {
    // Stable identifier so the hook's cache slot is deterministic
    // in the no-event case (and never accidentally collides with a
    // real tile id).
    assert.match(
      panelSrc,
      /const\s+IDLE_TILE_ID\s*=\s*["']__wi4_idle__["']/,
    );
  });
});

// ── useEffect-driven regenerate ────────────────────────────────────

describe("WI4-wire · useEffect-driven regenerate firing", () => {
  it("fires regen.regenerate inside a useEffect when event + specLite are non-null", () => {
    // Auto-fire on event change so the user doesn't have to click a
    // second button — the brush IS the action that opens the panel.
    assert.match(
      panelSrc,
      /useEffect\(\s*\(\)\s*=>\s*\{\s*if\s*\(\s*!event\s*\|\|\s*!specLite\s*\)\s*return;\s*void regen\.regenerate\(\s*specLite,\s*narrowedRows\s*\);/,
    );
  });

  it("intentionally omits `regen` from the effect deps with an eslint-disable comment", () => {
    // The hook captures `regenerate` via useRef internally so the
    // function reference is stable; including it in deps would
    // create a render loop. The comment documents the deliberate
    // omission.
    assert.match(panelSrc, /eslint-disable-next-line react-hooks\/exhaustive-deps/);
    assert.match(
      panelSrc,
      /\}, \[event, specLite, narrowedRows\]\)/,
    );
  });
});

// ── Regenerated insight render branches ────────────────────────────

describe("WI4-wire · Regenerated insight section render branches", () => {
  it("removes the WI4-panel placeholder text (negative pin)", () => {
    // The WI4-panel placeholder ("will appear here once the WI4-wire
    // wave lands") is GONE. If a future refactor restores it,
    // future-Claude knows the wave was reverted.
    assert.doesNotMatch(
      panelSrc,
      /will appear here once the WI4-wire wave lands/,
    );
  });

  it("renders 'Could not resolve …' when chart is null", () => {
    // The tile-removed / event-mismatched case — surface the
    // failure rather than render an empty panel.
    assert.match(panelSrc, /Could not resolve the chart for/);
  });

  it("renders 'Regenerating …' with the brushed-row count when regen.loading", () => {
    // Loading copy includes the row count so the user knows the
    // brush captured a non-empty set.
    assert.match(panelSrc, /Regenerating insight for /);
    assert.match(panelSrc, /narrowedRows\.length/);
    assert.match(panelSrc, /narrowedRows\.length === 1\s*\?\s*["']["']\s*:\s*["']s["']/);
  });

  it("renders the error message with role='alert' when regen.error is set", () => {
    // role=alert ensures screen readers announce the failure. The
    // hook's `error` field is a `string | null` so we render it
    // directly (no .message).
    assert.match(
      panelSrc,
      /<p role="alert" className="text-destructive">\s*Failed to regenerate: \{regen\.error\}/,
    );
  });

  it("renders the entry text with whitespace-pre-wrap when regen.entry.text is present", () => {
    // The regen prose may contain multi-line content (lists,
    // structured callouts). whitespace-pre-wrap preserves line
    // breaks from the model output.
    assert.match(panelSrc, /whitespace-pre-wrap/);
    assert.match(panelSrc, /\{regen\.entry\.text\}/);
  });

  it("falls back to 'Waiting for the first regeneration…' as the default branch", () => {
    // Between effect-fire and resolve there's a brief window where
    // loading is false AND entry is null. The default branch
    // communicates the in-flight state.
    assert.match(
      panelSrc,
      /Waiting for the first regeneration…/,
    );
  });
});

// ── DashboardView chart resolution ─────────────────────────────────

describe("WI4-wire · DashboardView chart resolution + prop threading", () => {
  it("derives the chart from explainSliceEvent.chartId via a `chart-(\\d+)` regex", () => {
    // The chart id pattern `chart-${idx}` is the tile-id convention
    // established by DashboardView's tile derivation around the
    // baseTiles map. The regex parses idx out of the captured event.
    assert.match(
      dashSrc,
      /\/\^chart-\(\\d\+\)\$\/\.exec\(explainSliceEvent\.chartId\)/,
    );
  });

  it("indexes into activeSheet.charts[idx] (falls back to null on miss)", () => {
    // The lookup is `activeSheet.charts[idx] ?? null` — defensive
    // against a stale event whose chart was deleted between brush-
    // up and the panel mount.
    assert.match(
      dashSrc,
      /activeSheet\.charts\[idx\]\s*\?\?\s*null/,
    );
  });

  it("threads insightRegenCache={insightRegenCache} into the panel", () => {
    // The shared cache lifted at line 125 of DashboardView; the
    // same instance is threaded into every per-tile ChartTileBody
    // for WI2 regen, so a brushed slice can hit a cache slot
    // populated by the per-tile re-explain (if filter hashes match).
    assert.match(
      dashSrc,
      /<ExplainSlicePanel[\s\S]*?insightRegenCache=\{insightRegenCache\}/,
    );
  });

  it("Wave WI4-wire marker present in the DashboardView mount comment", () => {
    // Greppable lineage for future-Claude.
    assert.match(dashSrc, /Wave\s*WI4-wire/);
  });
});

// ── ExplainSlicePanel wave marker ──────────────────────────────────

describe("WI4-wire · ExplainSlicePanel wave marker", () => {
  it("carries the Wave WI4-wire marker in the regen comment block", () => {
    assert.match(panelSrc, /Wave\s*WI4-wire/);
  });
});
