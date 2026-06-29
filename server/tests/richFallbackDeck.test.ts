/**
 * Wave W-EXP-DECK3 · Rich deterministic fallback.
 *
 * When the planner produces no usable plan, `buildFallbackDeckPlan` must emit a
 * REAL deck — one ChartWithInsight per chart (with render-resolvable ids) plus
 * envelope-derived chrome — not the old 3-slide inventory stub. Pins:
 *   - 32-chart dashboard → > 3 slides, capped at 30, overflow → Appendix.
 *   - Every ChartWithInsight chartId resolves via resolveChartIdToSpec.
 *   - The plan always satisfies slideDeckPlanSchema.
 *   - Envelope chrome (ExecSummary/KpiRow/Recommendations/Methodology) appears
 *     when derivable; Methodology is last.
 *   - Legacy charts[]-only dashboards resolve; empty dashboards don't throw.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFallbackDeckPlan } from "../lib/exports/buildDashboardDeck.js";
import { resolveChartIdToSpec } from "../lib/agents/runtime/deckPlanner.js";
import { slideDeckPlanSchema, LAYOUT_KIND } from "../shared/exportSchema.js";
import type { Dashboard } from "../shared/schema.js";

function chart(i: number) {
  return { type: "bar", title: `Chart ${i}`, x: "x", y: "y", data: [] };
}

describe("W-EXP-DECK3 · rich fallback deck", () => {
  it("renders one chart slide per chart for a 32-chart dashboard, capped at 30 with overflow → Appendix", () => {
    const dash = {
      id: "d32",
      name: "Big Dashboard",
      username: "u@e.com",
      sheets: [{ id: "s0", name: "Sheet", charts: Array.from({ length: 32 }, (_, i) => chart(i)) }],
    } as unknown as Dashboard;

    const plan = buildFallbackDeckPlan(dash);
    assert.ok(plan.slides.length > 3);
    assert.ok(plan.slides.length <= 30, `expected ≤ 30 slides, got ${plan.slides.length}`);
    // schema-valid
    assert.doesNotThrow(() => slideDeckPlanSchema.parse(plan));

    const chartSlides = plan.slides.filter((s) => s.layout === LAYOUT_KIND.ChartWithInsight);
    assert.ok(chartSlides.length >= 25, `expected many chart slides, got ${chartSlides.length}`);
    // overflow folded into exactly one Appendix
    const appendix = plan.slides.filter((s) => s.layout === LAYOUT_KIND.Appendix);
    assert.equal(appendix.length, 1, "expected one Appendix slide for the overflow");

    // every chart slide's id resolves back to a real chart
    for (const s of chartSlides) {
      const id = (s.slots as { chartId: string }).chartId;
      assert.ok(resolveChartIdToSpec(dash, id), `chartId ${id} did not resolve`);
    }
  });

  it("includes ExecSummary, KpiRow, Recommendations and a last-position Methodology when the envelope is rich", () => {
    const dash = {
      id: "drich",
      name: "Rich Dashboard",
      username: "u@e.com",
      sheets: [{ id: "s0", name: "Sheet", charts: [chart(0), chart(1)] }],
      answerEnvelope: {
        tldr: "Sales fell 12% in Q3 driven by category mix shift across modern trade.",
        findings: [
          { headline: "Category mix drove 8 of the 12pp decline", evidence: "ev1", magnitude: "−8pp" },
          { headline: "MARICO held share at 9.1% within the category", evidence: "ev2" },
          { headline: "Modern-trade distribution gained 4pp", evidence: "ev3" },
        ],
        magnitudes: [
          { label: "Q3 sales", value: "₫68.7B" },
          { label: "Share", value: "9.1%" },
        ],
        recommendations: [
          { action: "Reallocate 18% of trade spend to MARICO in Q4", rationale: "Hold share against the category decline.", horizon: "now" },
        ],
        methodology: "Nielsen MAT scan weeks 2025-W36 to 2025-W41; 2,341 modern-trade stores in HCMC and Hanoi.",
        caveats: ["Modern trade only."],
      },
    } as unknown as Dashboard;

    const plan = buildFallbackDeckPlan(dash);
    assert.doesNotThrow(() => slideDeckPlanSchema.parse(plan));
    const layouts = plan.slides.map((s) => s.layout);
    assert.ok(layouts.includes(LAYOUT_KIND.ExecSummary));
    assert.ok(layouts.includes(LAYOUT_KIND.KpiRow));
    assert.ok(layouts.includes(LAYOUT_KIND.Recommendations));
    assert.equal(plan.slides[plan.slides.length - 1]!.layout, LAYOUT_KIND.Methodology);
  });

  it("resolves chart ids for a legacy charts[]-only dashboard (no sheets)", () => {
    const dash = {
      id: "dlegacy",
      name: "Legacy Dashboard",
      username: "u@e.com",
      charts: [chart(0), chart(1), chart(2)],
    } as unknown as Dashboard;

    const plan = buildFallbackDeckPlan(dash);
    assert.doesNotThrow(() => slideDeckPlanSchema.parse(plan));
    const chartSlides = plan.slides.filter((s) => s.layout === LAYOUT_KIND.ChartWithInsight);
    assert.equal(chartSlides.length, 3);
    const ids = chartSlides.map((s) => (s.slots as { chartId: string }).chartId);
    assert.deepEqual(ids, ["s0c0", "s0c1", "s0c2"]);
    for (const id of ids) assert.ok(resolveChartIdToSpec(dash, id), `chartId ${id} did not resolve`);
  });

  it("does not throw on an empty dashboard (no charts, no envelope)", () => {
    const dash = { id: "dempty", name: "Empty", username: "u@e.com", sheets: [] } as unknown as Dashboard;
    const plan = buildFallbackDeckPlan(dash);
    assert.ok(plan.slides.length >= 2);
    assert.doesNotThrow(() => slideDeckPlanSchema.parse(plan));
  });
});
