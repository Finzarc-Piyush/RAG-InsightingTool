import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

/**
 * Characterization test for the ARCH-1 / CQ-1 god-file decomposition of
 * `agentLoop.service.ts`. Three cohesive low-coupling clusters were moved to
 * sibling modules:
 *   - agentLoopDeferredCharts.ts  (deferred build_chart materialisation)
 *   - agentLoopPlanner.ts         (planner-retry wiring)
 *   - agentLoopSynthesisPrep.ts   (pure pre-synthesis / dashboard-prep helpers)
 *
 * This pins TWO invariants the extraction must preserve:
 *   1. The pure-helper BEHAVIOUR (template round-trip, frame-support gating, the
 *      mid-turn summary digest shape) is byte-for-byte the same as the inlined
 *      versions.
 *   2. The RE-EXPORT seam: symbols that external code imported from the
 *      `agentLoop.service.js` path (deferred-chart helpers, the planner-retry fn)
 *      still resolve through that path AND are identity-equal to the ones the
 *      new sibling modules export — so a missed re-export can't slip through.
 */

import {
  deferredTemplateFromBuiltChart,
  rowFrameSupportsDeferredTemplate,
  type DeferredBuildChartTemplate,
} from "../lib/agents/runtime/agentLoopDeferredCharts.js";
import { buildPreSynthesisMidTurnSummary } from "../lib/agents/runtime/agentLoopSynthesisPrep.js";

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

describe("agentLoop decomposition · re-export seam (no missed re-export)", () => {
  it("agentLoop.service.js re-exports the moved symbols identity-equal to the sibling modules", async () => {
    const svc = await import("../lib/agents/runtime/agentLoop.service.js");
    const deferred = await import(
      "../lib/agents/runtime/agentLoopDeferredCharts.js"
    );
    const planner = await import("../lib/agents/runtime/agentLoopPlanner.js");

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
    // The entry point itself is still exported unchanged.
    assert.equal(typeof svc.runAgentTurn, "function");
  });
});
