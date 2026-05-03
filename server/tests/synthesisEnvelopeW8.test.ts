import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { messageSchema } from "../shared/schema.js";

/**
 * W8 · decision-grade envelope contract.
 *
 * Pins the new persisted-message envelope fields so the AnswerCard (W9) can
 * rely on them, and so the narrator/synthesizer output schemas stay in sync
 * with the storage schema. Both the narrator and synthesizer are wired to
 * produce these fields; this test guards the *persisted* shape.
 */
describe("W8 · answerEnvelope.implications", () => {
  it("accepts 1–4 entries with statement + soWhat", () => {
    const m = {
      role: "assistant",
      content: "Saffola lost share in MT this quarter.",
      timestamp: Date.now(),
      answerEnvelope: {
        implications: [
          {
            statement: "Saffola edible oils share dropped 1.8 ppt MoM in Modern Trade.",
            soWhat:
              "MT erosion typically signals price-pack misalignment versus private-label entrants — likely a pricing or pack-size response.",
            confidence: "high" as const,
          },
        ],
      },
    };
    const parsed = messageSchema.parse(m);
    assert.equal(parsed.answerEnvelope?.implications?.length, 1);
    assert.equal(parsed.answerEnvelope?.implications?.[0].confidence, "high");
  });

  it("rejects more than 6 implications (WTL3 · cap raised 4 → 6)", () => {
    const tooMany = {
      role: "assistant",
      content: "x",
      timestamp: Date.now(),
      answerEnvelope: {
        implications: Array.from({ length: 7 }, () => ({
          statement: "s",
          soWhat: "w",
        })),
      },
    };
    assert.throws(() => messageSchema.parse(tooMany));
  });
});

describe("W8 · answerEnvelope.recommendations", () => {
  it("accepts entries with horizon enum", () => {
    const m = {
      role: "assistant",
      content: "x",
      timestamp: Date.now(),
      answerEnvelope: {
        recommendations: [
          {
            action: "Review MT pack-size mix vs private label",
            rationale: "Share loss concentrated in 1L SKUs which now overlap top private-label price points.",
            horizon: "this_quarter" as const,
          },
          {
            action: "Tighten promo-depth rules in MT",
            rationale: "Promo elasticity slipped 12% vs benchmark — depth is no longer driving units.",
            horizon: "now" as const,
          },
        ],
      },
    };
    const parsed = messageSchema.parse(m);
    assert.equal(parsed.answerEnvelope?.recommendations?.length, 2);
    assert.equal(parsed.answerEnvelope?.recommendations?.[1].horizon, "now");
  });

  it("rejects an unknown horizon value", () => {
    const bad = {
      role: "assistant",
      content: "x",
      timestamp: Date.now(),
      answerEnvelope: {
        recommendations: [
          { action: "a", rationale: "r", horizon: "next_year" },
        ],
      },
    };
    assert.throws(() => messageSchema.parse(bad));
  });
});

describe("W8 · answerEnvelope.domainLens", () => {
  it("accepts a paragraph under 500 chars", () => {
    const m = {
      role: "assistant",
      content: "x",
      timestamp: Date.now(),
      answerEnvelope: {
        domainLens:
          "Per `marico-haircare-portfolio`, Parachute is the cash engine and any MT share loss disproportionately hits the franchise's overall trading profile because MT carries higher GM than GT.",
      },
    };
    const parsed = messageSchema.parse(m);
    assert.match(parsed.answerEnvelope!.domainLens!, /marico-haircare-portfolio/);
  });

  it("rejects a domainLens over 900 chars (WTL3 · cap raised 500 → 900)", () => {
    const bad = {
      role: "assistant",
      content: "x",
      timestamp: Date.now(),
      answerEnvelope: { domainLens: "x".repeat(901) },
    };
    assert.throws(() => messageSchema.parse(bad));
  });
});

describe("W8 · backwards compatibility", () => {
  it("existing messages without W8 fields parse cleanly (no required fields added)", () => {
    const legacy = {
      role: "assistant",
      content: "Pre-W8 message.",
      timestamp: Date.now(),
      answerEnvelope: {
        tldr: "Headline only.",
        findings: [
          { headline: "h", evidence: "e", magnitude: "+5%" },
        ],
      },
    };
    const parsed = messageSchema.parse(legacy);
    assert.equal(parsed.answerEnvelope?.implications, undefined);
    assert.equal(parsed.answerEnvelope?.recommendations, undefined);
    assert.equal(parsed.answerEnvelope?.domainLens, undefined);
    assert.equal(parsed.answerEnvelope?.tldr, "Headline only.");
  });
});
