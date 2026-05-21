/**
 * Wave WD3-server-sheetId-resolution · server + client tests for the
 * optional `sheetId` field on the WD3 drill-through resolver path.
 *
 * Closes the user-facing collision that the prior WD3-WI4-sheetId-
 * telemetry wave only made observable: the server-side
 * `findChartByTileId` previously walked across sheets and returned the
 * first chart-N match, so DrillThroughSheet rendered the WRONG sheet's
 * chart-0 when the user clicked Sheet 1's chart-0 after navigating
 * between sheets. With sheetId plumbed end-to-end (client capture at
 * click time → URL query param → service-layer scoped lookup), the
 * resolver disambiguates correctly.
 *
 * Backwards-compat invariant: callers that omit sheetId (legacy
 * shareable URLs predating this wave; single-sheet dashboards from
 * pre-this-wave clients) get the legacy walk-across-sheets behaviour.
 * Pin both the scoped + legacy paths so a future edit can't accidentally
 * tighten the resolver into an always-scoped shape that would break
 * old share-links.
 *
 * Pins six layers:
 *  1. Pure-fn `findChartByTileId(sheetId)` scoped lookup (positive case).
 *  2. `findChartByTileId(undefined)` legacy walk preserved.
 *  3. Stale / unknown sheetId → null (predictable failure beats silent
 *     mis-resolution).
 *  4. `resolveDrillThrough` threads sheetId into the chart lookup.
 *  5. Controller reads sheetId from req.query (optional string) and
 *     passes it in the resolveDrillThrough request.
 *  6. Client surfaces: DrillThroughEvent.sheetId optional field;
 *     useDrillThroughRows queryKey + URL-param plumbing; DashboardView
 *     listener injects activeSheetId at click time.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  findChartByTileId,
  resolveDrillThrough,
} from "../services/dashboardDrillThrough.service.ts";
import type { Dashboard, ChartSpec } from "../shared/schema.js";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const serviceSrc = readFileSync(
  repoFile("../services/dashboardDrillThrough.service.ts"),
  "utf-8",
);
const controllerSrc = readFileSync(
  repoFile("../controllers/dashboardDrillThroughController.ts"),
  "utf-8",
);
const drillThroughLibSrc = readFileSync(
  repoFile("../../client/src/pages/Dashboard/lib/drillThrough.ts"),
  "utf-8",
);
const hookSrc = readFileSync(
  repoFile("../../client/src/pages/Dashboard/hooks/useDrillThroughRows.ts"),
  "utf-8",
);
const dashboardViewSrc = readFileSync(
  repoFile("../../client/src/pages/Dashboard/Components/DashboardView.tsx"),
  "utf-8",
);

// ── Fixtures ────────────────────────────────────────────────────────

const rowsSheet1: Array<Record<string, unknown>> = [
  { region: "North", units: 100 },
  { region: "South", units: 80 },
];

const rowsSheet2: Array<Record<string, unknown>> = [
  { brand: "A", spend: 500 },
  { brand: "B", spend: 700 },
];

function chart(title: string, data: Array<Record<string, unknown>>): ChartSpec {
  return {
    type: "bar",
    title,
    x: data[0] && "region" in data[0] ? "region" : "brand",
    y: data[0] && "units" in data[0] ? "units" : "spend",
    data,
  } as ChartSpec;
}

/**
 * Multi-sheet fixture where BOTH sheets have a chart-0 (collision
 * surface). The titles encode the sheet so the wrong-resolution
 * failure mode is obvious from the assertion.
 */
function multiSheetDashboard(): Dashboard {
  return {
    id: "dash-multi",
    name: "Multi-sheet dashboard",
    sheets: [
      {
        id: "sheet-sales",
        name: "Sales by region",
        charts: [
          chart("Sheet1 chart-0 (Sales)", rowsSheet1),
          chart("Sheet1 chart-1 (Sales)", rowsSheet1),
        ],
        tables: [],
      },
      {
        id: "sheet-spend",
        name: "Brand spend",
        charts: [chart("Sheet2 chart-0 (Spend)", rowsSheet2)],
        tables: [],
      },
    ],
  } as unknown as Dashboard;
}

// ── findChartByTileId with sheetId scoping ─────────────────────────

describe("WD3-server-sheetId-resolution · findChartByTileId scoped lookup", () => {
  it("scopes chart-0 lookup to the named sheet (returns Sheet 2's chart-0, not Sheet 1's)", () => {
    // The load-bearing positive case. Pre-wave, calling
    // findChartByTileId(dash, "chart-0") would return Sheet 1's
    // chart-0 (first-match walk). Post-wave, passing sheetId="sheet-
    // spend" scopes to Sheet 2 → returns Sheet 2's chart-0.
    const dash = multiSheetDashboard();
    const found = findChartByTileId(dash, "chart-0", "sheet-spend");
    assert.ok(found);
    assert.equal(found?.title, "Sheet2 chart-0 (Spend)");
    // Sanity-check the same input WITHOUT sheetId returns Sheet 1's.
    const legacyFound = findChartByTileId(dash, "chart-0");
    assert.equal(legacyFound?.title, "Sheet1 chart-0 (Sales)");
  });

  it("finds chart-1 in Sheet 1 only (scoped lookup honors the sheet boundary)", () => {
    // Sheet 1 has chart-0 + chart-1; Sheet 2 has only chart-0. A
    // request for chart-1 with sheetId=sheet-sales must find Sheet
    // 1's chart-1; with sheetId=sheet-spend it must return null
    // (chart-1 doesn't exist in Sheet 2 even though chart-1 exists
    // in another sheet).
    const dash = multiSheetDashboard();
    const inSheet1 = findChartByTileId(dash, "chart-1", "sheet-sales");
    assert.equal(inSheet1?.title, "Sheet1 chart-1 (Sales)");
    const inSheet2 = findChartByTileId(dash, "chart-1", "sheet-spend");
    assert.equal(inSheet2, null);
  });

  it("returns null when sheetId doesn't match any sheet in the dashboard", () => {
    // Stale-sheetId case (sheet deleted since the click was made, or
    // a hand-crafted URL with a wrong sheet id). Predictable failure
    // beats silent fallback to a different sheet — a future-Claude
    // tempted to "be helpful" by falling back to the legacy walk
    // here would silently mis-resolve clicks from deleted sheets.
    const dash = multiSheetDashboard();
    const found = findChartByTileId(dash, "chart-0", "sheet-does-not-exist");
    assert.equal(found, null);
  });

  it("returns null when sheetId matches but chart-N is out of range in that sheet", () => {
    // Sheet 2 has only one chart. A request for chart-5 scoped to
    // Sheet 2 must return null even though Sheet 1 has many charts.
    // The scoping is strict — no spillover into other sheets.
    const dash = multiSheetDashboard();
    const found = findChartByTileId(dash, "chart-5", "sheet-spend");
    assert.equal(found, null);
  });

  it("validates the tileId format even when a valid sheetId is provided", () => {
    // The tileId regex check happens BEFORE the sheet-scoping
    // branch — malformed tileIds reject regardless of sheetId.
    const dash = multiSheetDashboard();
    assert.equal(findChartByTileId(dash, "table-0", "sheet-sales"), null);
    assert.equal(findChartByTileId(dash, "chart-abc", "sheet-sales"), null);
    assert.equal(findChartByTileId(dash, "", "sheet-sales"), null);
  });

  it("preserves the legacy walk-across-sheets when sheetId is undefined", () => {
    // Backwards-compat pin: a caller that doesn't pass sheetId (e.g.
    // an old shareable URL or a single-sheet dashboard client) gets
    // the pre-wave behaviour — first match wins across all sheets.
    // Pin both `findChartByTileId(dash, "chart-0")` (omit 3rd arg)
    // and the legacy walk traversal contract.
    const dash = multiSheetDashboard();
    const found = findChartByTileId(dash, "chart-0");
    assert.equal(found?.title, "Sheet1 chart-0 (Sales)");
  });
});

// ── resolveDrillThrough threading ──────────────────────────────────

describe("WD3-server-sheetId-resolution · resolveDrillThrough threads sheetId", () => {
  it("scopes the chart lookup to the request's sheetId (Sheet 2 wins)", () => {
    const dash = multiSheetDashboard();
    const response = resolveDrillThrough(dash, "chart-0", {
      column: "brand",
      value: "A",
      sheetId: "sheet-spend",
    });
    assert.equal(response.chart.title, "Sheet2 chart-0 (Spend)");
    assert.equal(response.chart.tileId, "chart-0");
    // Sheet 2's data → "A" row matches.
    assert.equal(response.rows.length, 1);
    assert.equal(response.rows[0]?.spend, 500);
  });

  it("falls back to legacy walk when request omits sheetId", () => {
    // Backwards-compat for shareable URLs predating this wave. The
    // legacy walk returns Sheet 1's chart-0, so filtering on
    // region=North picks Sheet 1's data.
    const dash = multiSheetDashboard();
    const response = resolveDrillThrough(dash, "chart-0", {
      column: "region",
      value: "North",
    });
    assert.equal(response.chart.title, "Sheet1 chart-0 (Sales)");
    assert.equal(response.rows.length, 1);
    assert.equal(response.rows[0]?.units, 100);
  });

  it("throws chart_not_found:<id> when sheetId is stale (unknown sheet)", () => {
    // The 404 mapping happens upstream in the controller; the
    // service-layer throw shape stays the same as the pre-wave miss.
    const dash = multiSheetDashboard();
    assert.throws(
      () =>
        resolveDrillThrough(dash, "chart-0", {
          column: "region",
          value: "North",
          sheetId: "sheet-deleted-yesterday",
        }),
      /chart_not_found:chart-0/,
    );
  });
});

// ── Service source-inspection (signature + doc) ────────────────────

describe("WD3-server-sheetId-resolution · service source contract", () => {
  it("findChartByTileId signature accepts an optional third `sheetId` param", () => {
    // Pin the exported signature shape so a future edit that
    // accidentally drops the optional argument fails fast at
    // source-inspection time rather than silently breaking the
    // controller's scoped lookup.
    assert.match(
      serviceSrc,
      /export function findChartByTileId\(\s*dashboard: Dashboard,\s*tileId: string,\s*sheetId\?: string,?\s*\): ChartSpec \| null/,
    );
  });

  it("findChartByTileId scoped branch returns null on unknown sheet (no fallback)", () => {
    // The explicit-null-on-miss invariant: a stale sheetId returns
    // null rather than silently walking. Pin the early-return shape
    // so a future "fallback to legacy walk for resilience" edit
    // can't slip in unnoticed.
    assert.match(
      serviceSrc,
      /if \(sheetId !== undefined\) \{[\s\S]*?const targetSheet = sheets\.find\(\(sheet\) => sheet\.id === sheetId\);[\s\S]*?if \(!targetSheet\) return null;[\s\S]*?return \(targetSheet\.charts \|\| \[\]\)\[idx\] \?\? null;[\s\S]*?\}/,
    );
  });

  it("DrillThroughRequest exposes optional sheetId field", () => {
    // The request-shape source of truth. Pin the field's presence
    // and its optional + string typing.
    assert.match(
      serviceSrc,
      /export interface DrillThroughRequest \{[\s\S]*?sheetId\?: string;[\s\S]*?\}/,
    );
  });

  it("resolveDrillThrough threads request.sheetId into findChartByTileId", () => {
    // The two-layer plumbing: controller → request.sheetId →
    // findChartByTileId's third arg. Pin both legs so a future edit
    // can't drop one and leave the request shape carrying sheetId
    // that nothing reads.
    assert.match(
      serviceSrc,
      /const chart = findChartByTileId\(dashboard, chartId, request\.sheetId\);/,
    );
  });
});

// ── Controller source-inspection ───────────────────────────────────

describe("WD3-server-sheetId-resolution · controller source contract", () => {
  it("reads sheetId from req.query as an optional string", () => {
    // Mirrors the chartId / column / value `typeof === "string"`
    // guard shape — three other query params follow the same
    // pattern, so this fits the existing controller idiom.
    assert.match(
      controllerSrc,
      /const sheetId =\s*typeof req\.query\.sheetId === "string" \? req\.query\.sheetId : undefined;/,
    );
  });

  it("does NOT 400 on missing sheetId (it's optional)", () => {
    // The 400-on-missing guard is for chartId + column only. A
    // future edit that accidentally adds sheetId to the
    // `!chartId || !column` check would break legacy share-link
    // backwards-compat. Pin that the guard stays narrow.
    assert.match(
      controllerSrc,
      /if \(!chartId \|\| !column\) \{\s*res\.status\(400\)\.json\(\{ error: "missing_chart_id_or_column" \}\);/,
    );
    // Negative pin: the 400 guard MUST NOT mention sheetId.
    const guardMatch = controllerSrc.match(
      /if \(!chartId \|\| !column[^)]*\) \{[\s\S]*?missing_chart_id_or_column/,
    );
    assert.ok(guardMatch);
    assert.equal(guardMatch?.[0].includes("sheetId"), false);
  });

  it("includes sheetId in the resolveDrillThrough request object", () => {
    // Pin the exact call shape including sheetId so the source-
    // inspection in the parent test file (the existing "delegates
    // to resolveDrillThrough with the full request shape") matches.
    assert.match(
      controllerSrc,
      /resolveDrillThrough\(dashboard, chartId, \{\s*column,\s*value,\s*extraPins: body\.extraPins,\s*filters: body\.filters,\s*sheetId,?\s*\}\);/,
    );
  });
});

// ── Client surface: DrillThroughEvent.sheetId ──────────────────────

describe("WD3-server-sheetId-resolution · DrillThroughEvent.sheetId", () => {
  it("DrillThroughEvent interface has an optional sheetId field", () => {
    // The event-shape source of truth on the client. The listener
    // injects sheetId before storing into state, and the hook reads
    // it for queryKey + URL params. Pin its presence on the
    // exported interface.
    assert.match(
      drillThroughLibSrc,
      /export interface DrillThroughEvent \{[\s\S]*?sheetId\?: string;[\s\S]*?\}/,
    );
  });
});

// ── Client surface: useDrillThroughRows ────────────────────────────

describe("WD3-server-sheetId-resolution · useDrillThroughRows plumbs sheetId", () => {
  it("queryKey includes event?.sheetId so distinct sheets get distinct cache slots", () => {
    // Without sheetId in the key, a click on Sheet 1's chart-0
    // followed by a click on Sheet 2's chart-0 (same chartId) would
    // share a cache slot. The `?? ""` collapse matches the empty-
    // string convention used by chartId / column above so the key's
    // shape stays consistent across all six pieces.
    assert.match(
      hookSrc,
      /queryKey: \[[\s\S]*?event\?\.sheetId \?\? "",[\s\S]*?\]/,
    );
  });

  it("URL param `sheetId` is set conditionally (only when event.sheetId is truthy)", () => {
    // The conditional set keeps the wire shape byte-identical to the
    // pre-wave URL for legacy share-links and pre-wave clients.
    // Server treats a missing sheetId query param as "no scoping;
    // walk across sheets" via its `typeof === "string"` guard.
    assert.match(
      hookSrc,
      /if \(event\.sheetId\) \{\s*url\.searchParams\.set\("sheetId", event\.sheetId\);\s*\}/,
    );
  });

  it("URL param `sheetId` is NOT set unconditionally (preserves legacy URL shape)", () => {
    // Negative pin: a future refactor that sets sheetId
    // unconditionally (e.g. with an empty-string fallback) would
    // change the wire shape and could confuse server-side log
    // grep / analytics that rely on the URL's presence as a "post-
    // resolution-wave client" marker. Pin via a non-match.
    assert.doesNotMatch(
      hookSrc,
      /url\.searchParams\.set\("sheetId", event\.sheetId \?\? ""\)/,
    );
    assert.doesNotMatch(
      hookSrc,
      /url\.searchParams\.set\("sheetId", String\(event\.sheetId\)\)/,
    );
  });
});

// ── Client surface: DashboardView listener injects sheetId ────────

describe("WD3-server-sheetId-resolution · DashboardView listener injects sheetId", () => {
  it("setDrillThroughEvent receives detail with sheetId injected from activeSheetId", () => {
    // The injection happens at the listener layer (NOT inside the
    // renderer's dispatchDrillThrough call) because activeSheetId is
    // a DashboardView-owned state slice that's not in renderer scope.
    // Captured at click time (not panel-render time) so subsequent
    // sheet navigation while the side-sheet is open doesn't re-
    // resolve to a different chart.
    assert.match(
      dashboardViewSrc,
      /setDrillThroughEvent\(\s*activeSheetId \? \{ \.\.\.detail, sheetId: activeSheetId \} : detail,?\s*\);/,
    );
  });

  it("listener's useEffect deps include activeSheetId (already pinned by WD3-WI4-sheetId-telemetry)", () => {
    // The dep widening from [dashboard.id] to [dashboard.id,
    // activeSheetId] landed in the prior WD3-WI4-sheetId-telemetry
    // wave for the telemetry side. The resolution wave doesn't
    // change deps (the listener still depends on the same two), but
    // pin them here too so a future refactor that touches deps
    // can't drop activeSheetId without failing both this test and
    // the prior telemetry wave's pin.
    assert.match(
      dashboardViewSrc,
      /window\.addEventListener\(DRILL_THROUGH_EVENT, handler as EventListener\);[\s\S]*?\}, \[dashboard\.id, activeSheetId\]\);/,
    );
  });
});
