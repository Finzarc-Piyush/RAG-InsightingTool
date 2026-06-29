/**
 * Wave W-EXP-DECK2 · Keystone — the deck verifier is ADVISORY, never fatal.
 *
 * The export bug was that ANY verifier nit on ANY slide collapsed the whole
 * multi-slide deck into a 3-slide stub (`buildDeck.verifierFailedAfterRepair`
 * → null → fallback). These tests pin the new contract:
 *   - A schema-valid but verifier-FAILING plan (a rule-1 title nit auto-repair
 *     can't fix), still failing after repair, is SHIPPED with > 3 slides and
 *     logs `buildDeck.shippedWithResidualIssues` — never `verifierFailedAfterRepair`.
 *   - A plan whose only defect is positional (Methodology mis-ordered) passes
 *     after deterministic auto-repair alone, logs `buildDeck.planReady`, and
 *     spends NO LLM repair call.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildAndVerifyDeckPlan } from "../lib/exports/buildDashboardDeck.js";
import { LLM_PURPOSE } from "../lib/agents/runtime/llmCallPurpose.js";
import { installLlmStub, clearLlmStub } from "./helpers/llmStub.js";
import type { Dashboard } from "../shared/schema.js";

const NOTES = "Walk through this slide at a steady pace; pause on the magnitudes.";

const dash = {
  id: "dash_keystone",
  name: "Keystone Test",
  username: "u@example.com",
  sheets: [
    { id: "s0", name: "Sheet", charts: [{ type: "bar", title: "Chart A", x: "x", y: "y", data: [] }] },
  ],
} as unknown as Dashboard;

/** Capture console.log lines so we can assert which agentLog events fired. */
function withLogCapture<T>(fn: (lines: string[]) => Promise<T>): Promise<T> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  return fn(lines).finally(() => {
    console.log = original;
  });
}

afterEach(() => clearLlmStub());

describe("W-EXP-DECK2 · keystone ships a renderable plan despite verifier nits", () => {
  it("returns the full deck (>3 slides) and logs shippedWithResidualIssues, never verifierFailedAfterRepair", async () => {
    let calls = 0;
    // Schema-valid but verifier-failing: slide 4's actionTitle "Findings" is a
    // denylisted topic-title (rule 1) that auto-repair cannot fix. Ordering is
    // already correct so auto-repair is a no-op; the title nit survives repair.
    const failingPlan = {
      title: "Keystone deck",
      generatedAt: "2026-06-29",
      slides: [
        { layout: "TitleSlide", actionTitle: "Keystone deck · Q3 review with 3 findings", speakerNotes: NOTES, slots: {} },
        {
          layout: "ExecSummary",
          actionTitle: "3 takeaways shape the response to the Q3 9% decline",
          speakerNotes: NOTES,
          slots: { bullets: ["Sales fell 12% in Q3 overall", "MARICO held share at 9.1% steady", "Distribution gained in modern trade"] },
        },
        { layout: "ChartWithInsight", actionTitle: "Sales fell 12% in Q3 driven by mix shift", speakerNotes: NOTES, slots: { chartId: "s0c0", insight: "Category mix drove the decline; price held flat." } },
        { layout: "ChartWithInsight", actionTitle: "Findings", speakerNotes: NOTES, slots: { chartId: "s0c1", insight: "This caption is fine but the title is a placeholder." } },
        { layout: "ChartWithInsight", actionTitle: "Distribution drove 4pp of the Q3 recovery", speakerNotes: NOTES, slots: { chartId: "s0c2", insight: "Modern-trade gains offset part of the decline." } },
        { layout: "Methodology", actionTitle: "Methodology · 6 weeks of Nielsen scan data", speakerNotes: NOTES, slots: { body: "Nielsen MAT scan, weeks 2025-W36 to 2025-W41, 2,341 stores." } },
      ],
    };
    installLlmStub({ [LLM_PURPOSE.DECK_PLANNER]: () => { calls++; return failingPlan; } });

    const result = await withLogCapture(async (lines) => {
      const plan = await buildAndVerifyDeckPlan(dash, { turnId: "t1" });
      return { plan, lines };
    });

    assert.ok(result.plan, "expected a non-null plan");
    assert.ok(result.plan!.slides.length > 3, `expected > 3 slides, got ${result.plan!.slides.length}`);
    const joined = result.lines.join("\n");
    assert.match(joined, /agent\.buildDeck\.shippedWithResidualIssues/);
    assert.doesNotMatch(joined, /agent\.buildDeck\.verifierFailedAfterRepair/);
    assert.equal(calls, 2, "expected one initial + one repair LLM call");
  });

  it("passes after deterministic auto-repair alone (no LLM repair call)", async () => {
    let calls = 0;
    // Only defect is positional: Methodology at index 1. Auto-repair moves it to
    // the back third → verifier passes → no repair round.
    const misorderedPlan = {
      title: "Auto-repair deck",
      generatedAt: "2026-06-29",
      slides: [
        { layout: "TitleSlide", actionTitle: "Auto-repair deck · Q3 review with 3 findings", speakerNotes: NOTES, slots: {} },
        { layout: "Methodology", actionTitle: "Methodology · 6 weeks of Nielsen scan data", speakerNotes: NOTES, slots: { body: "Nielsen MAT scan, weeks 2025-W36 to 2025-W41, 2,341 stores." } },
        {
          layout: "ExecSummary",
          actionTitle: "3 takeaways shape the response to the Q3 9% decline",
          speakerNotes: NOTES,
          slots: { bullets: ["Sales fell 12% in Q3 overall", "MARICO held share at 9.1% steady", "Distribution gained in modern trade"] },
        },
        { layout: "ChartWithInsight", actionTitle: "Sales fell 12% in Q3 driven by mix shift", speakerNotes: NOTES, slots: { chartId: "s0c0", insight: "Category mix drove the decline; price held flat." } },
        { layout: "ChartWithInsight", actionTitle: "MARICO grew 9.1% within FEMALE SHOWER GEL", speakerNotes: NOTES, slots: { chartId: "s0c1", insight: "Brand outgrew the category this period." } },
        { layout: "ChartWithInsight", actionTitle: "Distribution drove 4pp of the Q3 recovery", speakerNotes: NOTES, slots: { chartId: "s0c2", insight: "Modern-trade gains offset part of the decline." } },
      ],
    };
    installLlmStub({ [LLM_PURPOSE.DECK_PLANNER]: () => { calls++; return misorderedPlan; } });

    const result = await withLogCapture(async (lines) => {
      const plan = await buildAndVerifyDeckPlan(dash, { turnId: "t2" });
      return { plan, lines };
    });

    assert.ok(result.plan, "expected a non-null plan");
    assert.equal(result.plan!.slides[result.plan!.slides.length - 1]!.layout, "Methodology");
    assert.match(result.lines.join("\n"), /agent\.buildDeck\.planReady/);
    assert.equal(calls, 1, "expected exactly one LLM call (no repair round)");
  });
});
