import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ensureDashboardInsights } from "../lib/ensureDashboardInsights.js";
import type {
  EnsureDashboardInsightsDeps,
} from "../lib/ensureDashboardInsights.js";
import { applyChartInsightsBySignature } from "../lib/applyChartInsightsBySignature.js";
import type { ChartEnrichmentContext } from "../lib/generateInsightForCharts.js";
import type { ChartSpec, Dashboard } from "../shared/schema.js";

const chart = (over: Partial<ChartSpec>): ChartSpec =>
  ({ type: "bar", x: "Cluster Name", y: "pjp_adherence_rate", ...over }) as ChartSpec;

function makeDashboard(charts: ChartSpec[], over?: Partial<Dashboard>): Dashboard {
  return {
    id: "dash1",
    username: "u@x.com",
    name: "PJP",
    createdAt: 1,
    updatedAt: 1,
    sessionId: "sess1",
    charts,
    sheets: [{ id: "s_all", name: "All Artefacts", charts, order: 0 }],
    ...over,
  } as Dashboard;
}

type Calls = {
  generate: number;
  patch: number;
  generateInput?: ChartSpec[];
  generateContext?: ChartEnrichmentContext;
  lastPool?: ChartSpec[];
};

function makeDeps(opts: {
  dashboard: Dashboard | null;
  chatCharts?: ChartSpec[];
  hasSession?: boolean;
  /** keyInsight that generation produces for an orphan; "" → generation fails. */
  genResult?: string;
  /** when set, wires `loadDomainContext` to return this (context-parity test). */
  domainText?: string;
}): { deps: EnsureDashboardInsightsDeps; calls: Calls } {
  const calls: Calls = { generate: 0, patch: 0 };
  let dash = opts.dashboard;
  const deps: EnsureDashboardInsightsDeps = {
    getDashboardById: async () => dash,
    getChatBySessionIdForUser: async () =>
      opts.chatCharts ? { charts: opts.chatCharts } : null,
    patchDashboardChartInsights: async ({ charts }) => {
      calls.patch += 1;
      calls.lastPool = charts;
      if (!dash) return { ok: false, reason: "dashboard_not_found" };
      // Mirror the real patcher: apply by signature to flat + sheet charts.
      let patchedCount = 0;
      const flat = applyChartInsightsBySignature(dash.charts ?? [], charts);
      patchedCount += flat.patchedCount;
      const sheets = (dash.sheets ?? []).map((sh) => {
        const r = applyChartInsightsBySignature(sh.charts ?? [], charts);
        patchedCount += r.patchedCount;
        return { ...sh, charts: r.charts };
      });
      dash = { ...dash, charts: flat.charts, sheets };
      return { ok: true, patchedCount };
    },
    generateInsightForCharts: async (charts, genDeps) => {
      calls.generate += 1;
      calls.generateInput = charts;
      calls.generateContext = genDeps?.context;
      return charts.map((c) => ({
        ...c,
        keyInsight: opts.genResult ?? "",
      }));
    },
  };
  if (opts.domainText !== undefined) {
    deps.loadDomainContext = async () => opts.domainText;
  }
  return { deps, calls };
}

describe("ensureDashboardInsights", () => {
  it("REUSES the chat insight by signature without calling the LLM", async () => {
    const bare = chart({ title: "rate by Cluster Name" });
    const { deps, calls } = makeDeps({
      dashboard: makeDashboard([bare]),
      chatCharts: [chart({ keyInsight: "Cluster 2 WEST lags at 16%." })],
    });

    const res = await ensureDashboardInsights({ dashboardId: "dash1", username: "u@x.com", deps });

    assert.equal(calls.generate, 0, "no generation when a chat twin exists");
    assert.equal(calls.patch, 1);
    assert.ok((res.patchedCount ?? 0) > 0);
    assert.equal(res.dashboard!.charts![0].keyInsight, "Cluster 2 WEST lags at 16%.");
    assert.equal(res.dashboard!.sheets![0].charts[0].keyInsight, "Cluster 2 WEST lags at 16%.");
  });

  it("GENERATES for an orphan chart with no chat twin, then persists", async () => {
    const orphan = chart({ x: "ASM", title: "rate by ASM" }); // no matching chat chart
    const { deps, calls } = makeDeps({
      dashboard: makeDashboard([orphan]),
      chatCharts: [chart({ keyInsight: "different signature" })], // x: Cluster Name → no match
      genResult: "ASM-level adherence varies widely.",
    });

    const res = await ensureDashboardInsights({ dashboardId: "dash1", username: "u@x.com", deps });

    assert.equal(calls.generate, 1, "orphan routed through generation");
    assert.equal(calls.generateInput!.length, 1);
    assert.equal(calls.generateInput![0].x, "ASM");
    assert.ok((res.patchedCount ?? 0) > 0);
    assert.equal(res.dashboard!.charts![0].keyInsight, "ASM-level adherence varies widely.");
  });

  it("feeds orphan generation the question (dashboard name) + domain pack — parity with chat", async () => {
    const orphan = chart({ x: "ASM", title: "rate by ASM" }); // no chat twin
    const { deps, calls } = makeDeps({
      dashboard: makeDashboard([orphan], { name: "PJP adherence by ASM" }),
      chatCharts: [chart({ keyInsight: "different signature" })],
      genResult: "ASM-level adherence varies widely.",
      domainText: "FMCG/Marico domain pack…",
    });

    await ensureDashboardInsights({ dashboardId: "dash1", username: "u@x.com", deps });

    assert.equal(calls.generate, 1);
    assert.equal(
      calls.generateContext?.userQuestion,
      "PJP adherence by ASM",
      "the question-derived dashboard name must steer orphan insight generation"
    );
    assert.equal(
      calls.generateContext?.domainContext,
      "FMCG/Marico domain pack…",
      "the FMCG/Marico domain pack must be recomposed for orphan generation"
    );
  });

  it("is idempotent: an already-insighted dashboard does nothing", async () => {
    const filled = chart({ keyInsight: "already here" });
    const { deps, calls } = makeDeps({ dashboard: makeDashboard([filled]) });

    const res = await ensureDashboardInsights({ dashboardId: "dash1", username: "u@x.com", deps });

    assert.equal(res.patchedCount, 0);
    assert.equal(res.reason, "already_insighted");
    assert.equal(calls.patch, 0);
    assert.equal(calls.generate, 0);
  });

  it("reports dashboard_not_found when the dashboard is missing", async () => {
    const { deps } = makeDeps({ dashboard: null });
    const res = await ensureDashboardInsights({ dashboardId: "missing", username: "u@x.com", deps });
    assert.equal(res.reason, "dashboard_not_found");
    assert.equal(res.dashboard, null);
  });

  it("degrades gracefully when no insight can be sourced (no twin, generation empty)", async () => {
    const orphan = chart({ x: "ASM" });
    const { deps, calls } = makeDeps({
      dashboard: makeDashboard([orphan], { sessionId: undefined }),
      genResult: "", // generation yields nothing usable
    });

    const res = await ensureDashboardInsights({ dashboardId: "dash1", username: "u@x.com", deps });

    assert.equal(calls.generate, 1);
    assert.equal(calls.patch, 0, "nothing to persist when no insight was produced");
    assert.equal(res.patchedCount, 0);
    assert.equal(res.reason, "no_insights_available");
  });
});
