import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { answerToMarkdown } from "./copyAnswer.js";
import type { Message } from "../../shared/schema.js";

/**
 * W7 · copyAnswer serializer.
 *
 * Pins the contract between AnswerCard's visual order and the markdown that
 * lands on a user's clipboard. If we add a new envelope section to AnswerCard
 * we should add it here too — drift surfaces as a copy-vs-render mismatch.
 */

const baseMessage: Message = {
  role: "assistant",
  content: "Sales fell 12% in the West region in Q3.",
  timestamp: 1_700_000_000_000,
};

describe("answerToMarkdown", () => {
  it("falls back to message.content when answerEnvelope is absent", () => {
    const md = answerToMarkdown(baseMessage);
    assert.match(md, /Sales fell 12%/);
    assert.doesNotMatch(md, /TL;DR/);
  });

  it("emits TL;DR pill, findings, methodology, caveats, next steps in order", () => {
    const md = answerToMarkdown({
      ...baseMessage,
      answerEnvelope: {
        tldr: "West region sales -12.4% YoY in Q3.",
        findings: [
          {
            headline: "West Q3 sales -12.4% YoY",
            evidence: "Q3 revenue ₹4.2B vs Q3'25 ₹4.8B.",
            magnitude: "-12.4% YoY",
          },
          {
            headline: "Tier-2 stores account for 78% of the gap",
            evidence: "Tier-2 -₹0.47B vs total gap ₹0.60B.",
          },
        ],
        methodology: "Compared Q3 2026 vs Q3 2025 on closed-month transactions.",
        caveats: ["Two tier-2 stores reported partial data."],
        nextSteps: ["Drill into which SKUs drove the tier-2 decline."],
      },
    });

    // Order matters — visual hierarchy must match clipboard order.
    const tldrIdx = md.indexOf("TL;DR");
    const findingsIdx = md.indexOf("### Findings");
    const methodologyIdx = md.indexOf("### Methodology");
    const caveatsIdx = md.indexOf("### Caveats");
    const nextStepsIdx = md.indexOf("### Next steps");

    assert.ok(tldrIdx >= 0, "TL;DR should be present");
    assert.ok(findingsIdx > tldrIdx, "Findings should follow TL;DR");
    assert.ok(methodologyIdx > findingsIdx, "Methodology should follow Findings");
    assert.ok(caveatsIdx > methodologyIdx, "Caveats should follow Methodology");
    assert.ok(nextStepsIdx > caveatsIdx, "Next steps should follow Caveats");
    assert.match(md, /-12\.4% YoY/);
    assert.match(md, /Drill into which SKUs/);
  });

  it("does NOT duplicate body content when content equals tldr", () => {
    const md = answerToMarkdown({
      ...baseMessage,
      content: "Same line",
      answerEnvelope: { tldr: "Same line" },
    });
    // The body section should appear only once (as TL;DR), not twice.
    const occurrences = md.match(/Same line/g)?.length ?? 0;
    assert.strictEqual(occurrences, 1);
  });

  it("renders findings without crashing when evidence is empty", () => {
    const md = answerToMarkdown({
      ...baseMessage,
      answerEnvelope: {
        findings: [{ headline: "Bare finding", evidence: "" }],
      },
    });
    assert.match(md, /Bare finding/);
  });
});
