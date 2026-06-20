import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sanitizeChartWhyLane } from "../lib/insightGenerator.js";
import {
  splitChartInsightLanes,
  joinChartInsightLanes,
} from "../shared/chartInsightLanes.js";
import { buildPatternDrivenFallbackShort } from "../lib/insightGenerator/deterministicNarratives.js";
import type { PivotPatterns } from "../lib/insightGenerator/pivotPatterns.js";

/**
 * Chart-insight convergence (Wave 2) · the per-chart insight is now short and
 * manager-grade: a HEADLINE line, an OPTIONAL hedged `WHY:` line, and an
 * OPTIONAL `DO:` line — replacing the old 2200-char, 3–5-sentence prose blob
 * (HEADLINE + verbose SHAPE + reason + action). These pin: (1) the WHY lane is
 * hedge-gated with the SAME rail as the envelope, (2) the deterministic fallback
 * emits the short HEADLINE+DO shape with no verbose driver/risk wall, and
 * (3) the prompt dropped the SHAPE lane and the length cap fell to 550.
 */

const formatY = (n: number): string => {
  if (!isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
};

const HEADLINE = "West leads on Sales at 600 vs 200 for East.";

describe("sanitizeChartWhyLane · hedge-gates the WHY lane", () => {
  it("drops an unhedged WHY but keeps the headline", () => {
    const out = sanitizeChartWhyLane(`${HEADLINE}\nWHY: prices fell in the East.`);
    const lanes = splitChartInsightLanes(out);
    assert.equal(lanes.why, undefined);
    assert.match(lanes.headline, /West leads/);
  });

  it("drops a WHY that smuggles a statistic-shaped number", () => {
    const out = sanitizeChartWhyLane(`${HEADLINE}\nWHY: likely up 12% on festive demand.`);
    assert.equal(splitChartInsightLanes(out).why, undefined);
  });

  it("keeps a clean hedged, number-free WHY", () => {
    const why = "likely stronger metro distribution in the West";
    const out = sanitizeChartWhyLane(`${HEADLINE}\nWHY: ${why}.`);
    assert.match(splitChartInsightLanes(out).why ?? "", /metro distribution/);
  });

  it("drops a bad WHY but preserves the DO lane", () => {
    const out = sanitizeChartWhyLane(
      `${HEADLINE}\nWHY: prices fell.\nDO: audit East shelf presence this quarter.`
    );
    const lanes = splitChartInsightLanes(out);
    assert.equal(lanes.why, undefined);
    assert.match(lanes.do ?? "", /audit East shelf/);
  });

  it("is a no-op on a headline-only / untagged legacy string", () => {
    assert.equal(sanitizeChartWhyLane(HEADLINE), HEADLINE);
    const legacy = "Some older multi-sentence prose. With no lane markers at all.";
    assert.equal(sanitizeChartWhyLane(legacy), legacy);
  });
});

describe("splitChartInsightLanes / joinChartInsightLanes round-trip", () => {
  it("parses inline markers (post whitespace-collapse) into lanes", () => {
    const lanes = splitChartInsightLanes(
      "West leads at 74% vs 19%. WHY: likely metro reach. DO: audit East shelf."
    );
    assert.match(lanes.headline, /West leads at 74% vs 19%/);
    assert.match(lanes.why ?? "", /likely metro reach/);
    assert.match(lanes.do ?? "", /audit East shelf/);
  });

  it("treats an untagged string as headline-only (back-compat)", () => {
    const lanes = splitChartInsightLanes("Just a plain old insight with no tags.");
    assert.match(lanes.headline, /plain old insight/);
    assert.equal(lanes.why, undefined);
    assert.equal(lanes.do, undefined);
  });

  it("join drops empty lanes", () => {
    assert.equal(joinChartInsightLanes({ headline: "H", do: "act" }), "H\nDO: act");
  });
});

describe("buildPatternDrivenFallbackShort · short HEADLINE + DO, no SHAPE wall", () => {
  const patterns: PivotPatterns = {
    rowCount: 5,
    total: 1000,
    isCategoricalX: true,
    isTemporal: false,
    dualAxis: false,
    hhi: 0.42,
    top1Share: 0.6,
    cv: 0.2,
    topPerformers: [
      { x: "West", y: 600, share: 0.6 },
      { x: "East", y: 200, share: 0.2 },
    ],
    bottomPerformers: [{ x: "Central", y: 40, share: 0.04 }],
    segmentsAboveP75: ["West"],
    segmentsBelowP25: ["Central"],
  };

  const { text } = buildPatternDrivenFallbackShort({
    patterns,
    chartSpec: { x: "Region", y: "Sales", seriesColumn: undefined, seriesKeys: undefined },
    dimensionLabel: "Region",
    formatY,
  });

  it("emits a DO lane and never a speculative WHY lane", () => {
    const lanes = splitChartInsightLanes(text);
    assert.ok(lanes.headline.length > 0);
    assert.equal(lanes.why, undefined, "fallbacks must not speculate");
    assert.match(lanes.do ?? "", /\S/);
  });

  it("strips the 'Next:' prefix from the action", () => {
    assert.doesNotMatch(text, /DO:\s*Next:/i);
  });

  it("is far shorter than the old 4-claim wall", () => {
    // headline + one action — comfortably under the new 550 cap.
    assert.ok(text.length <= 550, `expected <=550 chars, got ${text.length}`);
  });
});

describe("source · prompt dropped SHAPE and tightened the length cap", () => {
  const src = readFileSync(
    resolve(new URL("../lib/insightGenerator.ts", import.meta.url).pathname),
    "utf-8"
  );

  it("cuts the keyInsight cap to 550", () => {
    assert.match(src, /KEY_INSIGHT_MAX_CHARS = 550/);
  });

  it("no longer instructs a verbose SHAPE lane", () => {
    assert.doesNotMatch(src, /2\.\s*SHAPE —/);
  });

  it("instructs the tagged HEADLINE / WHY: / DO: lanes", () => {
    assert.match(src, /Line 1 — HEADLINE \(REQUIRED\)/);
    assert.match(src, /start the line literally with "WHY: "/);
    assert.match(src, /start the line literally with "DO: "/);
  });
});
