/**
 * Wave W61-references-dashboards · pure-function tests for the
 * cross-dashboard reference counter. Pairs with the W61-references-scan
 * tests (`semanticModelReferencesW61ReferencesScan.test.ts`): the
 * chat-doc scanner is exhaustively pinned there; this file pins the
 * dashboard-shape walker — sheets vs legacy charts fallback, v1 + v2
 * inside dashboards, per-dashboard aggregation, defensive guards on
 * malformed Cosmos rows.
 *
 * The two scanners share the same per-chart counting primitives
 * (`countReferencesInChartSpec` / `countReferencesInChartSpecV2`); these
 * tests do NOT re-exercise field-level walking beyond a smoke check —
 * the field-walk is owned by the W61-references-scan test file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { countDashboardReferences } from "../lib/semantic/semanticModelDashboardReferences.js";
import type {
  ChartSpec,
  ChartSpecV2,
  Dashboard,
  DashboardSheet,
} from "../shared/schema.js";

const NAME = "net_sales_value";

function makeV1(overrides: Partial<ChartSpec> = {}): ChartSpec {
  return {
    type: "bar",
    title: "Sales by region",
    x: "region",
    y: "sales",
    ...overrides,
  };
}

function makeV2(overrides: Partial<ChartSpecV2> = {}): ChartSpecV2 {
  return {
    version: 2,
    mark: "bar",
    encoding: {},
    source: { kind: "session-ref", sessionId: "s1" },
    ...overrides,
  };
}

function makeSheet(
  charts: ChartSpec[],
  overrides: Partial<DashboardSheet> = {},
): DashboardSheet {
  return {
    id: "sheet_1",
    name: "Overview",
    charts,
    order: 0,
    ...overrides,
  };
}

function makeDashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    id: "dash-1",
    username: "alice@example.com",
    name: "Sales overview",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    charts: [],
    sheets: [],
    ...overrides,
  };
}

// ─── Top-level guards ────────────────────────────────────────────────

test("W61-references-dashboards · empty name returns zero counts", () => {
  const out = countDashboardReferences("", [
    makeDashboard({ sheets: [makeSheet([makeV1({ y: NAME })])] }),
  ]);
  assert.deepEqual(out, { dashboardCount: 0, dashboardTileCount: 0 });
});

test("W61-references-dashboards · empty dashboards array returns zero counts", () => {
  const out = countDashboardReferences(NAME, []);
  assert.deepEqual(out, { dashboardCount: 0, dashboardTileCount: 0 });
});

test("W61-references-dashboards · non-object dashboards are silently skipped", () => {
  // Defensive: a stray null / primitive / undefined in the lister's
  // output must not throw. Only the well-formed dashboard contributes.
  const dashboards: unknown[] = [
    null,
    undefined,
    42,
    "string",
    makeDashboard({ sheets: [makeSheet([makeV1({ y: NAME })])] }),
  ];
  const out = countDashboardReferences(NAME, dashboards);
  assert.deepEqual(out, { dashboardCount: 1, dashboardTileCount: 1 });
});

test("W61-references-dashboards · dashboard with neither sheets nor charts contributes zero", () => {
  const dash = makeDashboard({ sheets: undefined, charts: [] });
  const out = countDashboardReferences(NAME, [dash]);
  assert.deepEqual(out, { dashboardCount: 0, dashboardTileCount: 0 });
});

// ─── Modern dashboards · sheets[].charts[] walk ──────────────────────

test("W61-references-dashboards · single dashboard · single sheet · single tile hit", () => {
  const dash = makeDashboard({
    sheets: [makeSheet([makeV1({ y: NAME })])],
    charts: [makeV1({ y: NAME })], // union — must NOT double-count
  });
  const out = countDashboardReferences(NAME, [dash]);
  assert.deepEqual(out, { dashboardCount: 1, dashboardTileCount: 1 });
});

test("W61-references-dashboards · single dashboard · single sheet · multiple tile hits sum to that dashboard's tile count", () => {
  // 3 charts on one sheet, 2 of which reference the entry. Same
  // dashboard → dashboardCount=1, dashboardTileCount=2.
  const dash = makeDashboard({
    sheets: [
      makeSheet([
        makeV1({ y: NAME }),
        makeV1({ x: NAME, y: NAME }), // 2 field positions, but counted as 1 tile
        makeV1({ x: "region", y: "volume" }),
      ]),
    ],
  });
  const out = countDashboardReferences(NAME, [dash]);
  assert.deepEqual(out, { dashboardCount: 1, dashboardTileCount: 2 });
});

test("W61-references-dashboards · single dashboard · multiple sheets · tiles aggregate across sheets", () => {
  const dash = makeDashboard({
    sheets: [
      makeSheet([makeV1({ y: NAME })], { id: "summary", name: "Summary" }),
      makeSheet([makeV1({ y: NAME }), makeV1({ y: "other" })], {
        id: "evidence",
        name: "Evidence",
        order: 1,
      }),
    ],
  });
  const out = countDashboardReferences(NAME, [dash]);
  // 1 hit on summary + 1 hit on evidence = 2 tiles in 1 dashboard.
  assert.deepEqual(out, { dashboardCount: 1, dashboardTileCount: 2 });
});

test("W61-references-dashboards · multiple dashboards · each contributes independently", () => {
  const dashes: Dashboard[] = [
    makeDashboard({ id: "a", sheets: [makeSheet([makeV1({ y: NAME })])] }),
    makeDashboard({ id: "b", sheets: [makeSheet([makeV1({ y: NAME })])] }),
    makeDashboard({
      id: "c",
      sheets: [makeSheet([makeV1({ y: "unrelated" })])],
    }),
  ];
  const out = countDashboardReferences(NAME, dashes);
  // a + b each contribute 1 tile; c contributes none.
  assert.deepEqual(out, { dashboardCount: 2, dashboardTileCount: 2 });
});

test("W61-references-dashboards · sheet without charts array is silently skipped", () => {
  // A narrative-only sheet has no `charts` field — must not throw and
  // must not be miscounted.
  const dash = makeDashboard({
    sheets: [
      // Force the type narrow with a cast — the schema allows the
      // optional charts field at runtime, but the type insists.
      { id: "narr", name: "Narrative", order: 0 } as unknown as DashboardSheet,
      makeSheet([makeV1({ y: NAME })], { id: "charts", order: 1 }),
    ],
  });
  const out = countDashboardReferences(NAME, [dash]);
  assert.deepEqual(out, { dashboardCount: 1, dashboardTileCount: 1 });
});

// ─── Legacy dashboards · top-level charts[] fallback ─────────────────

test("W61-references-dashboards · legacy dashboard (sheets absent) walks top-level charts[]", () => {
  // Pre-sheets dashboards only populated `dashboard.charts[]` —
  // sheets was absent / empty. The walker must fall back to the
  // top-level array so legacy rows still contribute.
  const dash = makeDashboard({
    sheets: undefined,
    charts: [makeV1({ y: NAME }), makeV1({ y: "other" })],
  });
  const out = countDashboardReferences(NAME, [dash]);
  assert.deepEqual(out, { dashboardCount: 1, dashboardTileCount: 1 });
});

test("W61-references-dashboards · legacy dashboard (sheets empty array) walks top-level charts[]", () => {
  // Same as above but with `sheets: []` rather than undefined — both
  // shapes must fall back to the top-level array.
  const dash = makeDashboard({
    sheets: [],
    charts: [makeV1({ y: NAME }), makeV1({ y: NAME }), makeV1({ y: "other" })],
  });
  const out = countDashboardReferences(NAME, [dash]);
  assert.deepEqual(out, { dashboardCount: 1, dashboardTileCount: 2 });
});

test("W61-references-dashboards · modern dashboard with both sheets AND legacy charts does NOT double-count", () => {
  // Modern dashboards keep `dashboard.charts[]` in sync as the union of
  // sheet charts (see `patchDashboard` in dashboard.model.ts). If the
  // walker visited both arrays it would double-count every tile —
  // sheets are the source of truth when present.
  const tile = makeV1({ y: NAME });
  const dash = makeDashboard({
    sheets: [makeSheet([tile])],
    charts: [tile], // union copy — must not contribute a second time
  });
  const out = countDashboardReferences(NAME, [dash]);
  assert.deepEqual(out, { dashboardCount: 1, dashboardTileCount: 1 });
});

// ─── v1 + v2 chart interop ───────────────────────────────────────────

test("W61-references-dashboards · v2 ChartSpecV2 tiles inside a dashboard are walked via the v2 channel set", () => {
  // The scanner discriminates v1 vs v2 per chart via isChartSpecV2
  // before counting. A dashboard with a single v2 tile whose encoding.y
  // field === NAME must contribute one tile.
  const v2Tile = makeV2({
    encoding: { y: { field: NAME, type: "quantitative" } },
  });
  const dash = makeDashboard({
    sheets: [makeSheet([v2Tile as unknown as ChartSpec])],
  });
  const out = countDashboardReferences(NAME, [dash]);
  assert.deepEqual(out, { dashboardCount: 1, dashboardTileCount: 1 });
});

test("W61-references-dashboards · mixed v1 + v2 tiles on the same sheet are both walked", () => {
  const v1Tile = makeV1({ y: NAME });
  const v2Tile = makeV2({
    encoding: { x: { field: NAME, type: "nominal" } },
  });
  const dash = makeDashboard({
    sheets: [
      makeSheet([v1Tile, v2Tile as unknown as ChartSpec, makeV1({ y: "other" })]),
    ],
  });
  const out = countDashboardReferences(NAME, [dash]);
  // 2 tiles match (one v1 + one v2); 1 dashboard.
  assert.deepEqual(out, { dashboardCount: 1, dashboardTileCount: 2 });
});

test("W61-references-dashboards · a dashboard whose only matching tile is on the legacy charts[] fallback contributes once", () => {
  // Exotic edge case: a dashboard with sheets that contain no matching
  // tiles plus a legacy charts[] array that does. Because sheets is
  // non-empty, the walker prefers sheets and never reaches the legacy
  // array — so this dashboard contributes zero. Pins the
  // sheets-prefer-over-legacy invariant explicitly.
  const dash = makeDashboard({
    sheets: [makeSheet([makeV1({ y: "unrelated" })])],
    charts: [makeV1({ y: NAME })], // ignored because sheets is non-empty
  });
  const out = countDashboardReferences(NAME, [dash]);
  assert.deepEqual(out, { dashboardCount: 0, dashboardTileCount: 0 });
});
