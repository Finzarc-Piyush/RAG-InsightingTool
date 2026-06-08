import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * RNK · answer-envelope layout fixes (source-inspection — these components
 * render Radix / charts that need a DOM, so we assert the load-bearing
 * structural decisions in the source text, matching this repo's convention
 * for DOM-heavy component tests).
 *
 * Covers:
 *  - chart → magnitudes → answer order (MessageBubble + dashboard path)
 *  - Investigation summary spacing + "Findings" block removal
 *  - second feedback control after the "what we knew" banner
 *  - suggestion pills cap at 5 and wrap (no overflow)
 */
const repoFile = (rel: string) => resolve(new URL(rel, import.meta.url).pathname);
const bubble = readFileSync(repoFile("./MessageBubble.tsx"), "utf-8");
const invest = readFileSync(repoFile("./InvestigationSummaryCard.tsx"), "utf-8");
const answer = readFileSync(repoFile("./AnswerCard.tsx"), "utf-8");
const dash = readFileSync(repoFile("./AnalyticalDashboardResponse.tsx"), "utf-8");

describe("RNK · MessageBubble answer order", () => {
  it("renders charts before the AnswerCard (RNK-order marker precedes <AnswerCard)", () => {
    const chartMarker = bubble.indexOf("RNK-order · charts lead the answer");
    const answerCard = bubble.indexOf("<AnswerCard");
    assert.ok(chartMarker > -1, "RNK-order chart marker present");
    assert.ok(answerCard > -1, "<AnswerCard present");
    assert.ok(chartMarker < answerCard, "charts must precede the answer card");
  });

  it("renders the magnitudes row before the AnswerCard", () => {
    const mag = bubble.indexOf("<MagnitudesRow");
    const answerCard = bubble.indexOf("<AnswerCard");
    assert.ok(mag > -1 && answerCard > -1);
    assert.ok(mag < answerCard, "magnitudes must precede the answer prose");
  });

  it("separates the Investigation summary with a top-margin wrapper", () => {
    assert.match(
      bubble,
      /<div className="mt-3">\s*<InvestigationSummaryCard/,
      "InvestigationSummaryCard should be wrapped in an mt-3 div"
    );
  });

  it("renders a second FeedbackButtons after the PriorInvestigationsBanner", () => {
    const banner = bubble.indexOf("<PriorInvestigationsBanner");
    const lastFeedback = bubble.lastIndexOf("<FeedbackButtons");
    assert.ok(banner > -1 && lastFeedback > -1);
    assert.ok(
      lastFeedback > banner,
      "a FeedbackButtons instance must follow the prior-investigations banner"
    );
    // two distinct feedback instances exist (answer-level + after the banner)
    assert.ok(
      bubble.split("<FeedbackButtons").length - 1 >= 2,
      "expected at least two FeedbackButtons instances"
    );
  });

  it("caps suggested-question chips at 5", () => {
    assert.match(bubble, /message\.suggestedQuestions\.slice\(0, 5\)/);
  });
});

describe("RNK · suggestion pills wrap (no overflow)", () => {
  it("MessageBubble follow-up pills allow wrapping", () => {
    assert.ok(bubble.includes("whitespace-normal break-words"));
  });
  it("AnswerCard 'Try next' pills allow wrapping", () => {
    assert.ok(answer.includes("whitespace-normal break-words"));
  });
});

describe("RNK · Investigation summary 'Findings' removed", () => {
  it("no longer renders a 'Findings' heading", () => {
    assert.ok(
      !/>\s*Findings\s*</.test(invest),
      "the Findings sub-section heading should be gone"
    );
  });
  it("dropped the now-dead SIG_DOT / findings significance map", () => {
    assert.ok(!invest.includes("SIG_DOT"), "SIG_DOT should be removed");
  });
  it("still renders Hypotheses tested and Open questions", () => {
    assert.ok(invest.includes("Hypotheses tested"));
    assert.ok(invest.includes("Open questions"));
  });
});

describe("RNK · dashboard path order (charts → magnitudes)", () => {
  it("renders the charts tabs before the magnitudes strip", () => {
    const charts = dash.indexOf('<Tabs defaultValue="charts">');
    const mag = dash.indexOf("<MagnitudesRow");
    assert.ok(charts > -1 && mag > -1);
    assert.ok(charts < mag, "charts must precede magnitudes in dashboard mode");
  });
});
