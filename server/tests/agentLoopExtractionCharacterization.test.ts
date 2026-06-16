import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

/**
 * Characterization test for the ARCH-1 / CQ-1 god-file decomposition of
 * `agentLoop.service.ts`. Cohesive low-coupling clusters were moved to sibling
 * modules:
 *   - agentLoopDeferredCharts.ts  (deferred build_chart materialisation)
 *   - agentLoopPlanner.ts         (planner-retry wiring)
 *   - agentLoopSynthesisPrep.ts   (pure pre-synthesis / dashboard-prep helpers)
 *   - agentLoop/synthesis.ts      (final-answer synthesizer + retries + schemas)
 *   - agentLoop/finalizeCharts.ts (final chart dedupe + 24-cap)
 *
 * This pins TWO invariants the extraction must preserve:
 *   1. The pure-helper BEHAVIOUR (template round-trip, frame-support gating, the
 *      mid-turn summary digest shape, the finalize dedupe+cap, the envelope
 *      schema shape) is byte-for-byte the same as the inlined versions.
 *   2. The RE-EXPORT seam: symbols that external code imported from the
 *      `agentLoop.service.js` path (deferred-chart helpers, the planner-retry fn,
 *      the synthesizer + its schemas, the finalize cap) still resolve through
 *      that path AND are identity-equal to the ones the new sibling modules
 *      export — so a missed re-export can't slip through.
 */

import {
  deferredTemplateFromBuiltChart,
  rowFrameSupportsDeferredTemplate,
  type DeferredBuildChartTemplate,
} from "../lib/agents/runtime/agentLoopDeferredCharts.js";
import { buildPreSynthesisMidTurnSummary } from "../lib/agents/runtime/agentLoopSynthesisPrep.js";
import {
  finalizeMergedCharts,
  DASHBOARD_CHART_HARD_CAP,
} from "../lib/agents/runtime/agentLoop/finalizeCharts.js";
import {
  finalAnswerEnvelopeSchema,
  magnitudeSchema,
} from "../lib/agents/runtime/agentLoop/synthesis.js";
import type { ChartSpec } from "../shared/schema.js";

describe("agentLoop decomposition · deferred-chart helpers (behaviour)", () => {
  it("deferredTemplateFromBuiltChart copies core + optional fields and provenance", () => {
    const chart = {
      type: "bar" as const,
      title: "Sales by region",
      x: "region",
      y: "sales",
      aggregate: "sum" as const,
      seriesColumn: "channel",
      barLayout: "stacked" as const,
      _agentEvidenceRef: "call-7",
      _agentTurnId: "turn-abc",
      // a field NOT carried by the template — must be dropped:
      data: [{ region: "East", sales: 10 }],
    };
    const tmpl = deferredTemplateFromBuiltChart(chart as never);
    assert.equal(tmpl.type, "bar");
    assert.equal(tmpl.title, "Sales by region");
    assert.equal(tmpl.x, "region");
    assert.equal(tmpl.y, "sales");
    assert.equal(tmpl.aggregate, "sum");
    assert.equal(tmpl.seriesColumn, "channel");
    assert.equal(tmpl.barLayout, "stacked");
    assert.equal(tmpl._agentEvidenceRef, "call-7");
    assert.equal(tmpl._agentTurnId, "turn-abc");
    // The non-template field must not leak through.
    assert.equal((tmpl as Record<string, unknown>).data, undefined);
  });

  it("deferredTemplateFromBuiltChart omits absent optionals (no undefined keys)", () => {
    const minimal = {
      type: "line" as const,
      title: "Trend",
      x: "month",
      y: "revenue",
    };
    const tmpl = deferredTemplateFromBuiltChart(minimal as never);
    assert.ok(!("seriesColumn" in tmpl));
    assert.ok(!("barLayout" in tmpl));
    assert.ok(!("y2" in tmpl));
    assert.ok(!("_agentEvidenceRef" in tmpl));
  });

  it("rowFrameSupportsDeferredTemplate requires every referenced column on the first row", () => {
    const tmpl: DeferredBuildChartTemplate = {
      type: "bar",
      title: "t",
      x: "region",
      y: "sales",
      seriesColumn: "channel",
    };
    assert.equal(
      rowFrameSupportsDeferredTemplate(
        { region: "East", sales: 10, channel: "GT" },
        tmpl
      ),
      true
    );
    // missing seriesColumn → unsupported
    assert.equal(
      rowFrameSupportsDeferredTemplate({ region: "East", sales: 10 }, tmpl),
      false
    );
    // undefined first row → unsupported
    assert.equal(rowFrameSupportsDeferredTemplate(undefined, tmpl), false);
  });
});

describe("agentLoop decomposition · pre-synthesis summary (behaviour)", () => {
  it("buildPreSynthesisMidTurnSummary assembles the labelled digest blocks", () => {
    const ctx = { question: "Why did East sales drop?" } as never;
    const trace = {
      planRationale: "Break down sales by region then by month.",
      toolCalls: [
        { name: "execute_query_plan", ok: true },
        { name: "run_correlation", ok: false },
      ],
    } as never;
    const summary = buildPreSynthesisMidTurnSummary(
      ctx,
      trace,
      ["obs one", "obs two"],
      [{ title: "Sales", x: "region", y: "sales" }]
    );
    assert.match(summary, /Question: Why did East sales drop\?/);
    assert.match(summary, /planRationale: Break down sales by region/);
    assert.match(summary, /tools: execute_query_plan:true, run_correlation:false/);
    assert.match(summary, /chartsSoFar: Sales\(region\/sales\)/);
    assert.match(summary, /recentObservations:\nobs one\n\n---\n\nobs two/);
  });

  it("buildPreSynthesisMidTurnSummary uses (none) sentinels when empty", () => {
    const ctx = { question: "q" } as never;
    const trace = { planRationale: "", toolCalls: [] } as never;
    const summary = buildPreSynthesisMidTurnSummary(ctx, trace, [], []);
    assert.match(summary, /tools: \(none\)/);
    assert.match(summary, /chartsSoFar: \(none\)/);
  });
});

describe("agentLoop decomposition · finalizeMergedCharts (behaviour)", () => {
  const mkChart = (x: string, rows: number): ChartSpec =>
    ({
      type: "bar",
      title: `Chart ${x}`,
      x,
      y: "sales",
      data: Array.from({ length: rows }, (_, i) => ({ [x]: `r${i}`, sales: i })),
    }) as unknown as ChartSpec;

  it("DASHBOARD_CHART_HARD_CAP is 24 (schema-matched ceiling)", () => {
    assert.equal(DASHBOARD_CHART_HARD_CAP, 24);
  });

  it("dedupes by axis-signature, first-seen wins", () => {
    const charts = [mkChart("region", 5), mkChart("region", 9), mkChart("month", 3)];
    finalizeMergedCharts(charts);
    // Two distinct signatures survive (region|sales, month|sales); the second
    // `region` chart is a signature collision and is dropped first-seen-wins.
    assert.equal(charts.length, 2);
    assert.deepEqual(
      charts.map((c) => c.x),
      ["region", "month"]
    );
    // First-seen wins: the surviving `region` chart is the 5-row original.
    assert.equal((charts[0] as unknown as { data: unknown[] }).data.length, 5);
  });

  it("caps at 24 distinct charts, keeping the most-rows charts (ties → emission order)", () => {
    // 30 distinct signatures; row counts ascending with index so the top-24 by
    // rows are indices 6..29. Final array must be in original emission order.
    const charts = Array.from({ length: 30 }, (_, i) => mkChart(`dim${i}`, i));
    finalizeMergedCharts(charts);
    assert.equal(charts.length, 24);
    // The six smallest (dim0..dim5, rows 0..5) are dropped; dim6 is the first kept.
    assert.equal(charts[0].x, "dim6");
    assert.equal(charts[charts.length - 1].x, "dim29");
    // Emission order preserved among survivors (monotonic dim index).
    const order = charts.map((c) => Number(String(c.x).replace("dim", "")));
    for (let i = 1; i < order.length; i++) {
      assert.ok(order[i] > order[i - 1], "survivors keep emission order");
    }
  });

  it("no-ops on an empty array", () => {
    const charts: ChartSpec[] = [];
    finalizeMergedCharts(charts);
    assert.equal(charts.length, 0);
  });
});

describe("agentLoop decomposition · final-answer envelope schema (behaviour)", () => {
  it("rejects an empty body (the silent-empty-body guard)", () => {
    const empty = finalAnswerEnvelopeSchema.safeParse({
      body: "",
      ctas: ["Investigate region performance"],
    });
    assert.equal(empty.success, false);
  });

  it("accepts a non-empty body and the decision-grade extension fields", () => {
    const ok = finalAnswerEnvelopeSchema.safeParse({
      body: "West led at $710K, ahead of East's $670K.",
      keyInsight: null,
      ctas: ["Drill into West by channel"],
      magnitudes: [{ label: "West", value: "$710K", confidence: "high" }],
      implications: [{ statement: "West is the growth engine", soWhat: "Protect West shelf space" }],
      recommendations: [{ action: "Shift spend to West", rationale: "Highest ROI region", horizon: "now" }],
      domainLens: "FMCG shelf dynamics favour the leading region.",
    });
    assert.equal(ok.success, true);
  });

  it("magnitudeSchema enforces non-empty label/value", () => {
    assert.equal(magnitudeSchema.safeParse({ label: "", value: "x" }).success, false);
    assert.equal(magnitudeSchema.safeParse({ label: "West", value: "$1M" }).success, true);
  });
});

describe("agentLoop decomposition · re-export seam (no missed re-export)", () => {
  it("agentLoop.service.js re-exports the moved symbols identity-equal to the sibling modules", async () => {
    const svc = await import("../lib/agents/runtime/agentLoop.service.js");
    const deferred = await import(
      "../lib/agents/runtime/agentLoopDeferredCharts.js"
    );
    const planner = await import("../lib/agents/runtime/agentLoopPlanner.js");
    const synthesis = await import("../lib/agents/runtime/agentLoop/synthesis.js");
    const finalize = await import(
      "../lib/agents/runtime/agentLoop/finalizeCharts.js"
    );

    assert.equal(
      svc.deferredTemplateFromBuiltChart,
      deferred.deferredTemplateFromBuiltChart,
      "deferredTemplateFromBuiltChart must re-export from the service path"
    );
    assert.equal(
      svc.rowFrameSupportsDeferredTemplate,
      deferred.rowFrameSupportsDeferredTemplate,
      "rowFrameSupportsDeferredTemplate must re-export from the service path"
    );
    assert.equal(
      svc.materializeDeferredBuildCharts,
      deferred.materializeDeferredBuildCharts,
      "materializeDeferredBuildCharts must re-export from the service path"
    );
    assert.equal(
      svc.runPlannerWithOneRetry,
      planner.runPlannerWithOneRetry,
      "runPlannerWithOneRetry must re-export from the service path"
    );
    // Wave (ARCH-1/CQ-1, deepened) · synthesizer cluster re-exports.
    assert.equal(
      svc.synthesizeFinalAnswerEnvelope,
      synthesis.synthesizeFinalAnswerEnvelope,
      "synthesizeFinalAnswerEnvelope must re-export from the service path"
    );
    assert.equal(
      svc.runNarrativeRetry,
      synthesis.runNarrativeRetry,
      "runNarrativeRetry must re-export from the service path"
    );
    assert.equal(
      svc.runPlainTextRetry,
      synthesis.runPlainTextRetry,
      "runPlainTextRetry must re-export from the service path"
    );
    assert.equal(
      svc.finalAnswerEnvelopeSchema,
      synthesis.finalAnswerEnvelopeSchema,
      "finalAnswerEnvelopeSchema must re-export from the service path"
    );
    assert.equal(
      svc.magnitudeSchema,
      synthesis.magnitudeSchema,
      "magnitudeSchema must re-export from the service path"
    );
    // Wave (ARCH-1/CQ-1, deepened) · finalize-charts cluster re-exports.
    assert.equal(
      svc.finalizeMergedCharts,
      finalize.finalizeMergedCharts,
      "finalizeMergedCharts must re-export from the service path"
    );
    assert.equal(
      svc.DASHBOARD_CHART_HARD_CAP,
      finalize.DASHBOARD_CHART_HARD_CAP,
      "DASHBOARD_CHART_HARD_CAP must re-export from the service path"
    );
    assert.equal(svc.DASHBOARD_CHART_HARD_CAP, 24);
    // The entry point itself is still exported unchanged.
    assert.equal(typeof svc.runAgentTurn, "function");
  });
});
