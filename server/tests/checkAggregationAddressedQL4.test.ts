/**
 * Wave QL4 · `checkAggregationQuestionAddressed` is the "not-computable"
 * envelope gate of last resort. Fires ONLY when:
 *   - the narrator text contains a give-up phrase ("not computable", etc.),
 *   - aggregation intent was detected for the question, AND
 *   - zero `execute_query_plan` tool calls ran in the trace.
 * Otherwise passes — false positives are explicitly avoided.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkAggregationQuestionAddressed } from "../lib/agents/runtime/checkEnvelopeCompleteness.js";
import type { Message } from "../shared/schema.js";

type Env = NonNullable<Message["answerEnvelope"]>;

function notComputableEnvelope(): Env {
  return {
    tldr:
      "The average number of compliance visits per day across all clusters is not computable from the provided observations.",
    findings: [
      {
        headline: "Aggregation results are missing",
        evidence: "No execute_query_plan ran during this turn.",
      },
    ],
    methodology: "",
    caveats: [],
    recommendations: [],
  } as Env;
}

function groundedEnvelope(): Env {
  return {
    tldr: "Cluster A averages 4.2 daily compliance visits, leading by 1.1 over Cluster B.",
    findings: [
      {
        headline: "Cluster A leads at 4.2 avg/day",
        evidence: "Computed via SUM(visits) per (cluster, day) then AVG.",
        magnitude: "4.2 visits/day",
      },
    ],
    magnitudes: [{ label: "Cluster A daily mean", value: "4.2 visits/day" }],
  } as Env;
}

describe("Wave QL4 · checkAggregationQuestionAddressed", () => {
  it("fires on (not-computable narration + aggregation intent + zero queries)", () => {
    const result = checkAggregationQuestionAddressed(notComputableEnvelope(), {
      question:
        "What is the average compliance visits per day across all clusters?",
      ranExecuteQueryPlan: false,
      hasAggregationIntent: true,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "AGGREGATION_QUESTION_NOT_ADDRESSED");
      assert.match(result.description, /not computable/i);
      assert.match(result.courseCorrection, /execute_query_plan/);
      assert.match(result.courseCorrection, /groupBy/);
    }
  });

  it("passes when the trace ran an execute_query_plan (even if narrator wording is unfortunate)", () => {
    const result = checkAggregationQuestionAddressed(notComputableEnvelope(), {
      question:
        "What is the average compliance visits per day across all clusters?",
      ranExecuteQueryPlan: true,
      hasAggregationIntent: true,
    });
    assert.equal(result.ok, true);
  });

  it("passes when no aggregation intent is detected (why-question)", () => {
    const result = checkAggregationQuestionAddressed(notComputableEnvelope(), {
      question: "Why are compliance visits falling in Q3?",
      ranExecuteQueryPlan: false,
      hasAggregationIntent: false,
    });
    assert.equal(result.ok, true);
  });

  it("passes when the narrator delivered an actual number (no give-up phrase)", () => {
    const result = checkAggregationQuestionAddressed(groundedEnvelope(), {
      question:
        "What is the average compliance visits per day across all clusters?",
      ranExecuteQueryPlan: false, // contrived to isolate the regex check
      hasAggregationIntent: true,
    });
    assert.equal(result.ok, true);
  });

  it("passes when envelope is undefined (synthesizer fallback path)", () => {
    const result = checkAggregationQuestionAddressed(undefined, {
      question: "Average X per day",
      ranExecuteQueryPlan: false,
      hasAggregationIntent: true,
    });
    assert.equal(result.ok, true);
  });

  it("scans recommendations and caveats too (narrator might bury the admission there)", () => {
    const env = {
      tldr: "Here is what we found.",
      findings: [{ headline: "Observed pattern", evidence: "..." }],
      caveats: [
        "The exact daily average is not computable without additional aggregation queries.",
      ],
    } as Env;
    const result = checkAggregationQuestionAddressed(env, {
      question: "Average compliance visits per day across all clusters",
      ranExecuteQueryPlan: false,
      hasAggregationIntent: true,
    });
    assert.equal(result.ok, false);
  });

  it("matches alternate phrasings: 'cannot compute', 'unable to determine', 'lack of aggregation'", () => {
    const phrases = [
      "Cannot compute the average without further aggregation.",
      "We are unable to determine the daily mean from observations.",
      "Lack of direct aggregation results prevents a single number.",
      "Insufficient aggregation to answer the question.",
    ];
    for (const phrase of phrases) {
      const env = { tldr: phrase, findings: [] } as Env;
      const result = checkAggregationQuestionAddressed(env, {
        question: "Average X per day",
        ranExecuteQueryPlan: false,
        hasAggregationIntent: true,
      });
      assert.equal(
        result.ok,
        false,
        `should fire on phrase: "${phrase}"`
      );
    }
  });

  it("does not false-fire on benign 'not' phrases", () => {
    const env = {
      tldr: "Cluster A leads at 4.2 daily visits — not insignificant.",
      findings: [{ headline: "Lead", evidence: "Computed via groupby." }],
      magnitudes: [{ label: "x", value: "4.2" }],
    } as Env;
    const result = checkAggregationQuestionAddressed(env, {
      question: "Average X per day across clusters",
      ranExecuteQueryPlan: false,
      hasAggregationIntent: true,
    });
    assert.equal(result.ok, true);
  });
});
