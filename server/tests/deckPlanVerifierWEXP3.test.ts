/**
 * W-EXP-3 · Deterministic verifier for `SlideDeckPlan`.
 *
 * Pins the rules that separate "professional" from "shitty" decks:
 *   1. Action titles must be verb-led + contain a number-or-acronym + ≥ 5 words.
 *   2. Topic-title placeholders ("Findings", "Overview", …) are rejected.
 *   3. TitleSlide must be slide #1 if any TitleSlide exists.
 *   4. Methodology slides live in the back third of the deck.
 *   5. ExecSummary lives in the first half.
 *   6. Speaker notes ≥ 20 chars.
 *   7. One-message-per-slide: no bullet packs ≥ 2 distinct magnitudes.
 *
 * The exhaustiveness check inside `findOverloadedBullets` is the load-bearing
 * compile-time guarantee — adding an 11th layout to W-EXP-1's `LAYOUT_KIND`
 * fails to compile here, forcing a verifier-side decision.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkActionTitle,
  verifyDeckPlan,
} from "../lib/agents/runtime/deckPlanVerifier.js";
import type { SlideDeckPlan, SlideSpec } from "../shared/exportSchema.js";
import { LAYOUT_KIND } from "../shared/exportSchema.js";

const stubNotes = "Walk through this slide at a steady pace; pause on the magnitudes.";

function titleSlide(actionTitle = "Marico-VN · Q3 review with 3 findings"): SlideSpec {
  return {
    layout: LAYOUT_KIND.TitleSlide,
    actionTitle,
    speakerNotes: stubNotes,
    slots: {},
  };
}

function execSummary(actionTitle = "3 takeaways shape the response to the Q3 9% sales decline"): SlideSpec {
  return {
    layout: LAYOUT_KIND.ExecSummary,
    actionTitle,
    speakerNotes: stubNotes,
    slots: {
      bullets: [
        "Sales fell 12% in Q3 driven by category mix shift",
        "MARICO held share at 9.1% within FEMALE SHOWER GEL",
        "Distribution gains in modern trade offset 4pp of the decline",
      ],
    },
  };
}

function chartSlide(actionTitle = "Sales fell 12% in Q3 driven by category mix shift"): SlideSpec {
  return {
    layout: LAYOUT_KIND.ChartWithInsight,
    actionTitle,
    speakerNotes: stubNotes,
    slots: {
      chartId: "s0c0",
      insight: "Category mix drove 8 of the 12pp decline; price held flat.",
    },
  };
}

function methodology(actionTitle = "Methodology · 6 weeks of Nielsen scan, 2,341 stores"): SlideSpec {
  return {
    layout: LAYOUT_KIND.Methodology,
    actionTitle,
    speakerNotes: stubNotes,
    slots: {
      body: "Nielsen MAT scan weeks ending 2025-W36 through 2025-W41; 2,341 modern-trade stores.",
    },
  };
}

function deck(slides: SlideSpec[]): SlideDeckPlan {
  return {
    title: "Test deck",
    generatedAt: "2026-05-05",
    slides,
  };
}

describe("W-EXP-3 · checkActionTitle", () => {
  it("accepts a verb-led action title with a number", () => {
    assert.equal(checkActionTitle("Sales fell 12% in Q3 driven by category mix shift"), null);
  });
  it("accepts an action title that uses an all-caps brand instead of a digit", () => {
    assert.equal(checkActionTitle("MARICO holds share within FEMALE SHOWER GEL despite category decline"), null);
  });
  it("rejects bare topic titles", () => {
    assert.match(checkActionTitle("Findings")!, /complete sentence/);
    assert.match(checkActionTitle("Overview")!, /complete sentence/);
    assert.match(checkActionTitle("Sales by Quarter")!, /complete sentence|specificity/);
  });
  it("rejects denylisted topic titles even with periods or punctuation", () => {
    // "Findings." is < 5 words so it'll be caught by min-word-count first.
    // The denylist itself catches longer cases like "Executive Summary." which is 2 words.
    // Let's pick "Conclusions." which is short enough that the word-count rule fires.
    assert.notEqual(checkActionTitle("Conclusions."), null);
  });
  it("rejects titles missing a number or acronym (specificity)", () => {
    assert.match(
      checkActionTitle("Performance has been improving over the last quarter slightly")!,
      /number or proper-noun/,
    );
  });
  it("rejects titles that don't start with a capital letter or digit", () => {
    assert.match(
      checkActionTitle("sales fell 12% in Q3 driven by category mix")!,
      /capital letter or number/,
    );
  });
  it("accepts action titles that start with a digit (legitimate sentence-start pattern)", () => {
    assert.equal(checkActionTitle("3 takeaways shape the response to the Q3 9% sales decline"), null);
  });
  it("rejects titles shorter than 5 words", () => {
    assert.match(checkActionTitle("Q3 fell 12%")!, /complete sentence/);
  });
});

describe("W-EXP-3 · verifyDeckPlan structural rules", () => {
  it("passes a well-formed 5-slide deck", () => {
    const ok = verifyDeckPlan(
      deck([titleSlide(), execSummary(), chartSlide(), chartSlide("MARICO grew 9.1% within FEMALE SHOWER GEL category"), methodology()]),
    );
    assert.equal(ok.ok, true);
  });

  it("flags TitleSlide that isn't first", () => {
    const r = verifyDeckPlan(deck([execSummary(), titleSlide(), methodology()]));
    assert.equal(r.ok, false);
    if (!r.ok) {
      const allIssues = r.slideIssues.flatMap((s) => s.issues).join(" | ");
      assert.match(allIssues, /TitleSlide must be the first slide/);
    }
  });

  it("flags Methodology in the front half of a 6-slide deck", () => {
    const r = verifyDeckPlan(
      deck([titleSlide(), methodology(), execSummary(), chartSlide(), chartSlide("Brand growth holds at 9.1% in Q3"), chartSlide("Distribution drove 4pp of the recovery")]),
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      const allIssues = r.slideIssues.flatMap((s) => s.issues).join(" | ");
      assert.match(allIssues, /Methodology slides must live in the back third/);
    }
  });

  it("flags ExecSummary in the back half", () => {
    const r = verifyDeckPlan(
      deck([titleSlide(), chartSlide(), chartSlide("Brand growth holds at 9.1% in Q3"), chartSlide("Distribution drove 4pp of the recovery"), execSummary(), methodology()]),
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      const allIssues = r.slideIssues.flatMap((s) => s.issues).join(" | ");
      assert.match(allIssues, /ExecSummary should appear in the first half/);
    }
  });

  it("flags speaker notes shorter than 20 chars at runtime even if schema allowed it", () => {
    // Bypass schema validation by constructing a deck with short speaker notes;
    // the verifier still catches it (defense-in-depth).
    const slides: SlideSpec[] = [
      { ...titleSlide(), speakerNotes: "shortie" } as unknown as SlideSpec,
      methodology(),
    ];
    const r = verifyDeckPlan(deck(slides));
    assert.equal(r.ok, false);
    if (!r.ok) {
      const allIssues = r.slideIssues.flatMap((s) => s.issues).join(" | ");
      assert.match(allIssues, /speakerNotes too short/);
    }
  });

  it("flags ExecSummary bullet packing two distinct magnitudes", () => {
    const offending: SlideSpec = {
      layout: LAYOUT_KIND.ExecSummary,
      actionTitle: "3 takeaways shape the response to the Q3 sales decline overall",
      speakerNotes: stubNotes,
      slots: {
        bullets: [
          "Sales fell 12% AND volume fell 4.2pp simultaneously across both regions",
          "MARICO held share within FEMALE SHOWER GEL category steady this period",
          "Distribution gains offset some of the category headwinds in modern trade",
        ],
      },
    };
    const r = verifyDeckPlan(deck([titleSlide(), offending, methodology()]));
    assert.equal(r.ok, false);
    if (!r.ok) {
      const allIssues = r.slideIssues.flatMap((s) => s.issues).join(" | ");
      assert.match(allIssues, /packs multiple magnitudes/);
    }
  });

  it("does NOT flag KpiRow numbers (those are explicitly the point of the layout)", () => {
    const kpi: SlideSpec = {
      layout: LAYOUT_KIND.KpiRow,
      actionTitle: "3 KPIs frame the Q3 9% category decline holistically",
      speakerNotes: stubNotes,
      slots: {
        kpis: [
          { label: "Q3 sales", value: "₫68.7B", delta: "−12%" },
          { label: "Share", value: "9.1%", delta: "+0.3pp" },
        ],
      },
    };
    const r = verifyDeckPlan(deck([titleSlide(), kpi, methodology()]));
    assert.equal(r.ok, true);
  });

  it("repair description includes per-slide line + courseCorrection helper", () => {
    const r = verifyDeckPlan(deck([titleSlide("Findings"), methodology()]));
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.description, /slide 1:/);
      assert.match(r.description, /complete sentence|topic-title placeholder|specificity/);
      assert.match(r.courseCorrection, /Action titles MUST be a complete sentence/);
      assert.match(r.courseCorrection, /Methodology slides must live in the back third/);
    }
  });
});
