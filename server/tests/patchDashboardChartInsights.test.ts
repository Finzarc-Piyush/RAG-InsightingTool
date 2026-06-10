import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { patchDashboardChartInsights } from "../lib/patchDashboardChartInsights.js";
import type { ChartSpec, Dashboard } from "../shared/schema.js";

const chart = (over: Partial<ChartSpec>): ChartSpec =>
  ({ type: "bar", x: "Cluster Name", y: "pjp_adherence_rate", ...over }) as ChartSpec;

function makeDashboard(): Dashboard {
  const bare = chart({ title: "pjp_adherence_rate by Cluster Name" });
  return {
    id: "dash1",
    username: "u@x.com",
    name: "PJP Adherence",
    createdAt: 1,
    updatedAt: 1,
    charts: [bare],
    sheets: [
      { id: "sheet_summary", name: "Executive Summary", charts: [bare], order: 0 },
      { id: "sheet_all", name: "All Artefacts", charts: [bare], order: 1 },
    ],
  } as Dashboard;
}

function makeDeps(store: { dashboard: Dashboard | null; updated: number }) {
  return {
    getDashboardById: async () => store.dashboard,
    updateDashboard: async (d: Dashboard) => {
      store.updated += 1;
      store.dashboard = d;
      return d;
    },
  };
}

describe("patchDashboardChartInsights", () => {
  it("copies chat insights onto the flat charts array AND every sheet", async () => {
    const store = { dashboard: makeDashboard(), updated: 0 };
    const enriched = [chart({ keyInsight: "Cluster 2 WEST lags at 16%." })];

    const res = await patchDashboardChartInsights({
      dashboardId: "dash1",
      username: "u@x.com",
      charts: enriched,
      deps: makeDeps(store),
    });

    assert.equal(res.ok, true);
    // 1 flat + 2 sheets = 3 charts patched.
    assert.equal(res.patchedCount, 3);
    assert.equal(store.updated, 1);
    assert.equal(store.dashboard!.charts![0].keyInsight, "Cluster 2 WEST lags at 16%.");
    for (const sheet of store.dashboard!.sheets!) {
      assert.equal(sheet.charts[0].keyInsight, "Cluster 2 WEST lags at 16%.");
    }
  });

  it("returns early without writing when there are no enriched charts", async () => {
    const store = { dashboard: makeDashboard(), updated: 0 };
    const res = await patchDashboardChartInsights({
      dashboardId: "dash1",
      username: "u@x.com",
      charts: [],
      deps: makeDeps(store),
    });
    assert.equal(res.ok, true);
    assert.equal(res.reason, "empty");
    assert.equal(store.updated, 0);
  });

  it("does not write when nothing matches (no signature overlap)", async () => {
    const store = { dashboard: makeDashboard(), updated: 0 };
    const res = await patchDashboardChartInsights({
      dashboardId: "dash1",
      username: "u@x.com",
      charts: [chart({ x: "ASM", keyInsight: "no match" })],
      deps: makeDeps(store),
    });
    assert.equal(res.ok, true);
    assert.equal(res.patchedCount, 0);
    assert.equal(store.updated, 0);
  });

  it("reports dashboard_not_found when the dashboard is missing", async () => {
    const store = { dashboard: null as Dashboard | null, updated: 0 };
    const res = await patchDashboardChartInsights({
      dashboardId: "missing",
      username: "u@x.com",
      charts: [chart({ keyInsight: "x" })],
      deps: makeDeps(store),
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "dashboard_not_found");
    assert.equal(store.updated, 0);
  });
});
