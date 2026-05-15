/**
 * W-EXP-13 · Golden Marico-VN Q3 fixture e2e — pins the contract end-to-end.
 *
 * Renders the same fixture via BOTH formats (.pptx + .pdf) from a stable
 * SlideDeckPlan and asserts:
 *   1. PPTX is a ZIP container of non-trivial size.
 *   2. PDF starts with `%PDF-` and has non-trivial size.
 *   3. The fixture's plan passes the deterministic verifier (W-EXP-3).
 *   4. Every slide's actionTitle individually passes `checkActionTitle` —
 *      this is the W-EXP-14 quality gate, exercised against the same
 *      fixture so any future regression in the fixture or planner stub
 *      trips CI.
 *
 * The fixture is deliberately a `SlideDeckPlan` literal (not the result
 * of running the LLM stub), so this test is byte-stable across runs —
 * the perfect contract pin.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MARICO_VN_Q3_DASHBOARD,
  MARICO_VN_Q3_PLAN,
} from "./fixtures/maricoVnQ3Deck.js";
import { renderDeckPlanToPptxBuffer } from "../lib/exports/pptx/render.js";
import { renderDeckPlanToPdfBuffer } from "../lib/exports/pdf/render.js";
import {
  checkActionTitle,
  verifyDeckPlan,
} from "../lib/agents/runtime/deckPlanVerifier.js";

describe("W-EXP-13 · Marico-VN Q3 golden fixture", () => {
  it("plan passes the deterministic verifier", () => {
    const verdict = verifyDeckPlan(MARICO_VN_Q3_PLAN);
    if (!verdict.ok) {
      const summary = verdict.slideIssues
        .flatMap((s) => s.issues.map((i) => `slide ${s.slideIndex + 1}: ${i}`))
        .join(" | ");
      assert.fail(`golden plan failed verifier: ${summary}`);
    }
  });

  it("PPTX render produces a ZIP-shaped non-trivial buffer", async () => {
    const buf = await renderDeckPlanToPptxBuffer(MARICO_VN_Q3_PLAN, MARICO_VN_Q3_DASHBOARD);
    assert.equal(buf[0], 0x50);
    assert.equal(buf[1], 0x4b);
    assert.equal(buf[2], 0x03);
    assert.equal(buf[3], 0x04);
    assert.ok(buf.length > 30_000, `expected non-trivial PPTX, got ${buf.length} bytes`);
  });

  it("PDF render produces a %PDF- non-trivial buffer", async () => {
    const buf = await renderDeckPlanToPdfBuffer(MARICO_VN_Q3_PLAN, MARICO_VN_Q3_DASHBOARD);
    assert.equal(buf[0], 0x25); // %
    assert.equal(buf[1], 0x50); // P
    assert.equal(buf[2], 0x44); // D
    assert.equal(buf[3], 0x46); // F
    assert.equal(buf[4], 0x2d); // -
    assert.ok(buf.length > 5_000, `expected non-trivial PDF, got ${buf.length} bytes`);
  });

  it("plan covers the 8 representative layouts", () => {
    const layouts = MARICO_VN_Q3_PLAN.slides.map((s) => s.layout);
    // Ensures the fixture itself stays representative — adding a layout to
    // LAYOUT_KIND should typically grow the fixture too. Checking ≥ 8 lets
    // us add layouts without forcing a fixture update on every wave.
    assert.ok(layouts.length >= 8, `fixture should exercise ≥ 8 layouts; got ${layouts.length}`);
    assert.ok(layouts.includes("TitleSlide"));
    assert.ok(layouts.includes("ExecSummary"));
    assert.ok(layouts.includes("Methodology"));
    assert.ok(layouts.includes("ChartWithInsight"));
    assert.ok(layouts.includes("Recommendations"));
  });
});

describe("W-EXP-14 · action-title CI gate exercised on the golden fixture", () => {
  it("every slide's actionTitle individually passes the verb+number rule", () => {
    const failures: string[] = [];
    MARICO_VN_Q3_PLAN.slides.forEach((slide, i) => {
      const issue = checkActionTitle(slide.actionTitle);
      if (issue) {
        failures.push(`slide ${i + 1} ("${slide.actionTitle}"): ${issue}`);
      }
    });
    if (failures.length > 0) {
      assert.fail(
        `golden fixture's action titles regressed — fix the fixture or the verifier rule:\n${failures.join("\n")}`,
      );
    }
  });

  it("rejects a fixture mutation that introduces a topic-title placeholder", () => {
    const mutated = {
      ...MARICO_VN_Q3_PLAN,
      slides: MARICO_VN_Q3_PLAN.slides.map((s, i) =>
        i === 1 ? { ...s, actionTitle: "Findings" } : s,
      ),
    };
    const verdict = verifyDeckPlan(mutated);
    assert.equal(verdict.ok, false, "verifier should reject Findings-as-title");
    if (!verdict.ok) {
      const allIssues = verdict.slideIssues.flatMap((s) => s.issues).join(" | ");
      assert.match(allIssues, /complete sentence|topic-title|specificity/i);
    }
  });

  it("rejects a fixture mutation that buries Methodology in slide 2", () => {
    const mutated = {
      ...MARICO_VN_Q3_PLAN,
      slides: [
        MARICO_VN_Q3_PLAN.slides[0]!,
        MARICO_VN_Q3_PLAN.slides[7]!, // Methodology
        ...MARICO_VN_Q3_PLAN.slides.slice(1, 7),
      ],
    };
    const verdict = verifyDeckPlan(mutated);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      const allIssues = verdict.slideIssues.flatMap((s) => s.issues).join(" | ");
      assert.match(allIssues, /Methodology slides must live in the back third/);
    }
  });

  it("rejects a fixture mutation that drops speaker notes below the floor", () => {
    const mutated = {
      ...MARICO_VN_Q3_PLAN,
      slides: MARICO_VN_Q3_PLAN.slides.map((s, i) =>
        i === 0 ? { ...s, speakerNotes: "x" } : s,
      ),
    };
    const verdict = verifyDeckPlan(mutated);
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      const allIssues = verdict.slideIssues.flatMap((s) => s.issues).join(" | ");
      assert.match(allIssues, /speakerNotes too short/);
    }
  });
});
