/**
 * Wave WR5 (incremental refresh) · axis-aware dashboard-draft chart rebind.
 *
 * WR5 switched the replay's dashboard-draft rebind from title-only to the
 * axis-aware `chartIdentityKey`. The load-bearing case (L-010): two charts that
 * share a TITLE but differ in breakdown must each rebind to their OWN fresh
 * data — title-only would give them both the same (wrong) data. This shared
 * helper drives BOTH automation replay AND the new refresh, so a regression
 * here silently corrupts dashboard chart data for every replay.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rebindDashboardDraftCharts } from "../lib/automations/replayLoop.service.js";
import type { ChartSpec, Message } from "../shared/schema.js";

const fresh = (over: Partial<ChartSpec>): ChartSpec =>
  ({ type: "bar", title: "Adherence Rate", data: [], ...over }) as ChartSpec;

describe("WR5 · rebindDashboardDraftCharts", () => {
  it("rebinds two same-title/different-breakdown charts to their OWN data (L-010)", () => {
    const finalCharts = [
      fresh({ title: "Adherence Rate", seriesColumn: "Cluster", data: [{ v: "cluster" }] }),
      fresh({ title: "Adherence Rate", seriesColumn: "ASM", data: [{ v: "asm" }] }),
    ];
    const draft = {
      name: "D",
      sheets: [
        {
          id: "s0",
          name: "Sheet",
          charts: [
            { type: "bar", title: "Adherence Rate", seriesColumn: "Cluster", data: [{ v: "OLD-cluster" }] },
            { type: "bar", title: "Adherence Rate", seriesColumn: "ASM", data: [{ v: "OLD-asm" }] },
          ],
        },
      ],
    } as unknown as Message["dashboardDraft"];

    const out = rebindDashboardDraftCharts(draft, finalCharts) as unknown as {
      sheets: { charts: { seriesColumn: string; data: { v: string }[] }[] }[];
    };
    const charts = out.sheets[0]!.charts;
    const cluster = charts.find((c) => c.seriesColumn === "Cluster")!;
    const asm = charts.find((c) => c.seriesColumn === "ASM")!;
    // Each kept its OWN fresh data — no cross-contamination.
    assert.equal(cluster.data[0]?.v, "cluster");
    assert.equal(asm.data[0]?.v, "asm");
  });

  it("rebinds top-level draft.charts too", () => {
    const finalCharts = [fresh({ title: "Sales", x: "Month", data: [{ v: "new" }] })];
    const draft = {
      name: "D",
      charts: [{ type: "bar", title: "Sales", x: "Month", data: [{ v: "old" }] }],
    } as unknown as Message["dashboardDraft"];
    const out = rebindDashboardDraftCharts(draft, finalCharts) as unknown as {
      charts: { data: { v: string }[] }[];
    };
    assert.equal(out.charts[0]?.data[0]?.v, "new");
  });

  it("falls back to title match when the title is UNIQUE among fresh charts", () => {
    // Draft chart lacks the seriesColumn the fresh chart has → keys differ, but
    // the title is unique so the safe fallback still rebinds it.
    const finalCharts = [fresh({ title: "Total Sales", seriesColumn: "Region", data: [{ v: "new" }] })];
    const draft = {
      name: "D",
      charts: [{ type: "bar", title: "Total Sales", data: [{ v: "old" }] }],
    } as unknown as Message["dashboardDraft"];
    const out = rebindDashboardDraftCharts(draft, finalCharts) as unknown as {
      charts: { data: { v: string }[] }[];
    };
    assert.equal(out.charts[0]?.data[0]?.v, "new");
  });

  it("does NOT fall back to title when the title is ambiguous (keeps old data over a wrong rebind)", () => {
    const finalCharts = [
      fresh({ title: "Rate", seriesColumn: "A", data: [{ v: "A" }] }),
      fresh({ title: "Rate", seriesColumn: "B", data: [{ v: "B" }] }),
    ];
    // Draft chart has the same title but NO seriesColumn → no key match, and the
    // title is ambiguous → must NOT guess; keeps its old data.
    const draft = {
      name: "D",
      charts: [{ type: "bar", title: "Rate", data: [{ v: "OLD" }] }],
    } as unknown as Message["dashboardDraft"];
    const out = rebindDashboardDraftCharts(draft, finalCharts) as unknown as {
      charts: { data: { v: string }[] }[];
    };
    assert.equal(out.charts[0]?.data[0]?.v, "OLD");
  });

  it("returns the draft unchanged when there are no fresh charts", () => {
    const draft = { name: "D", charts: [] } as unknown as Message["dashboardDraft"];
    assert.equal(rebindDashboardDraftCharts(draft, undefined), draft);
    assert.equal(rebindDashboardDraftCharts(draft, []), draft);
  });
});
