import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * CI7 / CI9 / CI10 · the remaining per-chart insight surfaces render their prose
 * through the SHARED <ChartInsightBody> (the same component the chat bubble +
 * dashboard tile footer already use), instead of each owning private
 * MarkdownRenderer markup.
 *
 * Source-inspection (matching this repo's convention for chart/Radix-heavy
 * components — see answerLayoutRNK.test.ts / TileInsightFooterWI3.test.ts): the
 * components mount recharts + Radix dialogs that need a DOM, so we assert the
 * load-bearing wiring decisions in the source text. The actual prose/commentary
 * rendering is behavior-tested in ChartInsightBody.vitest.test.tsx.
 */
const src = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url).pathname, "utf-8");

const chartOnlyModal = src(
  "../../pages/Dashboard/Components/ChartOnlyModal.tsx",
);
const analyticalDash = src(
  "../../pages/Home/Components/AnalyticalDashboardResponse.tsx",
);
const chartModal = src("../../pages/Home/Components/ChartModal.tsx");

const importsSharedBody = (s: string) =>
  /import \{ ChartInsightBody \} from ['"]@\/components\/charts\/ChartInsightBody['"]/.test(
    s,
  );

describe("CI7 · ChartOnlyModal (dashboard zoom) shows insight via shared body", () => {
  it("imports the shared <ChartInsightBody>", () => {
    assert.ok(importsSharedBody(chartOnlyModal));
  });
  it("renders <ChartInsightBody> with the chart's keyInsight (previously showed none)", () => {
    assert.match(chartOnlyModal, /<ChartInsightBody[\s\S]*?keyInsight=\{chart\.keyInsight\}/);
  });
});

describe("CI9 · AnalyticalDashboardResponse multi-chart footer uses shared body", () => {
  it("imports the shared <ChartInsightBody>", () => {
    assert.ok(importsSharedBody(analyticalDash));
  });
  it("renders <ChartInsightBody> with the chart's keyInsight", () => {
    assert.match(analyticalDash, /<ChartInsightBody[\s\S]*?keyInsight=\{chart\.keyInsight\}/);
  });
  it("PRESERVES the suppressKeyInsight anti-plethora gate wrapping the insight (invariant #12)", () => {
    const gate = analyticalDash.indexOf("!suppressKeyInsight");
    const body = analyticalDash.indexOf("<ChartInsightBody");
    assert.ok(gate > -1, "suppressKeyInsight gate must remain");
    assert.ok(body > gate, "the insight body must render INSIDE the suppress gate");
  });
});

describe("CI10 · ChartModal (chat zoom) insight body uses shared body, keeps 'Next' chip", () => {
  it("imports the shared <ChartInsightBody>", () => {
    assert.ok(importsSharedBody(chartModal));
  });
  it("renders <ChartInsightBody> for the prose", () => {
    assert.match(chartModal, /<ChartInsightBody[\s\S]*?keyInsight=\{nextStep \? body : displayKeyInsight\}/);
  });
  it("keeps splitTrailingNextStep + the 'Next' follow-up chip as surface chrome", () => {
    assert.match(chartModal, /splitTrailingNextStep\(displayKeyInsight\)/);
    assert.match(chartModal, /nextStep && onSuggestedQuestionClick && composerText/);
  });
  it("does NOT push the chip wiring into the shared body (separation of concerns)", () => {
    // ChartInsightBody must stay pure prose+commentary — onSuggestedQuestionClick
    // is chat-only chrome and must not leak into the shared component's props.
    // Scope to the ChartInsightBody tag itself (up to its self-closing />),
    // since the chip's onSuggestedQuestionClick legitimately appears AFTER it.
    const tag = chartModal.match(/<ChartInsightBody[\s\S]*?\/>/);
    assert.ok(tag, "ChartInsightBody tag present");
    assert.ok(
      !tag![0].includes("onSuggestedQuestionClick"),
      "ChartInsightBody props must not carry chat-only chip wiring",
    );
  });
});
