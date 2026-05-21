/**
 * Wave WD3-server · tests for `/api/dashboards/:id/drill`.
 *
 * Covers the pure-fn service layer (filter + chart-lookup + resolver)
 * plus a source-inspection pass on the controller + route registration.
 * The Cosmos `getDashboardById` call is the only side-effect surface;
 * source-inspection captures the auth + 4xx mapping shape without
 * needing a real Cosmos mock.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  filterChartRowsForDrill,
  findChartByTileId,
  resolveDrillThrough,
  DRILL_ROW_CAP,
  type DrillThroughRequest,
} from "../services/dashboardDrillThrough.service.ts";
import type { Dashboard, ChartSpec } from "../shared/schema.js";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

// Use the test build's pwd-relative paths.
const controllerSrc = readFileSync(
  repoFile("../controllers/dashboardDrillThroughController.ts"),
  "utf-8",
);
const routesSrc = readFileSync(
  repoFile("../routes/dashboards.ts"),
  "utf-8",
);

// ── Fixtures ────────────────────────────────────────────────────────

const rows: Array<Record<string, unknown>> = [
  { region: "North", quarter: "Q1", units: 100, date: "2026-01-15" },
  { region: "North", quarter: "Q2", units: 150, date: "2026-04-15" },
  { region: "South", quarter: "Q1", units: 80, date: "2026-01-20" },
  { region: "South", quarter: "Q2", units: 120, date: "2026-04-20" },
  { region: "North", quarter: "Q3", units: 90, date: "2026-07-15" },
  { region: null, quarter: "Q1", units: 50, date: "2026-01-30" },
];

function chart(title: string, data = rows): ChartSpec {
  return {
    type: "bar",
    title,
    x: "region",
    y: "units",
    data,
  } as ChartSpec;
}

function dashboard(charts: ChartSpec[]): Dashboard {
  return {
    id: "dash-1",
    name: "Test dashboard",
    sheets: [{ id: "s-1", name: "Sheet 1", charts, tables: [] }],
  } as unknown as Dashboard;
}

// ── filterChartRowsForDrill ─────────────────────────────────────────

describe("WD3-server · filterChartRowsForDrill primary pin", () => {
  it("returns only rows where the primary pin's column equals its value", () => {
    const result = filterChartRowsForDrill(rows, {
      column: "region",
      value: "North",
    });
    assert.equal(result.rows.length, 3);
    assert.deepEqual(
      result.rows.map((r) => r.quarter),
      ["Q1", "Q2", "Q3"],
    );
    assert.equal(result.totalMatched, 3);
    assert.equal(result.capApplied, false);
  });

  it("matches stringified primary values consistently (number vs. string)", () => {
    // Mirrors the client's toFilterValue stringification semantics so
    // a drill payload carrying `value: 100` matches a row's
    // `units: 100`. Pin a numeric-column drill to lock the behavior.
    const result = filterChartRowsForDrill(rows, {
      column: "units",
      value: 100,
    });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.region, "North");
  });

  it("treats null values as the literal `null` string (matches client wire-storage)", () => {
    const result = filterChartRowsForDrill(rows, {
      column: "region",
      value: null,
    });
    // The null-region row is the 6th in the fixture.
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.quarter, "Q1");
    assert.equal(result.rows[0]?.region, null);
  });
});

describe("WD3-server · filterChartRowsForDrill with categorical filter", () => {
  it("applies the categorical filter BEFORE pinning the primary", () => {
    // Active filter says "only Q1 and Q2"; drill on region=North.
    // Should return North-Q1 + North-Q2 only (NOT North-Q3 which
    // doesn't pass the active filter).
    const result = filterChartRowsForDrill(rows, {
      column: "region",
      value: "North",
      filters: {
        quarter: { type: "categorical", values: ["Q1", "Q2"] },
      },
    });
    assert.equal(result.rows.length, 2);
    assert.deepEqual(
      result.rows.map((r) => r.quarter),
      ["Q1", "Q2"],
    );
  });

  it("empty categorical values filter is a no-op (matches all)", () => {
    // An empty `values` array means the filter is structurally
    // present but inert — same semantic as the client's
    // applyChartFilters.
    const result = filterChartRowsForDrill(rows, {
      column: "region",
      value: "North",
      filters: {
        quarter: { type: "categorical", values: [] },
      },
    });
    assert.equal(result.rows.length, 3); // all North rows pass
  });
});

describe("WD3-server · filterChartRowsForDrill with numeric filter", () => {
  it("applies a numeric range filter (min + max)", () => {
    // Drill region=North; active filter units >= 100; should drop
    // North-Q3 (units=90).
    const result = filterChartRowsForDrill(rows, {
      column: "region",
      value: "North",
      filters: {
        units: { type: "numeric", min: 100 },
      },
    });
    assert.equal(result.rows.length, 2);
    assert.deepEqual(
      result.rows.map((r) => r.units),
      [100, 150],
    );
  });

  it("numeric filter excludes non-numeric values", () => {
    const result = filterChartRowsForDrill(rows, {
      column: "region",
      value: "North",
      filters: {
        quarter: { type: "numeric", min: 0 }, // quarter is a string
      },
    });
    assert.equal(result.rows.length, 0);
  });
});

describe("WD3-server · filterChartRowsForDrill with date filter", () => {
  it("applies a date range filter (ISO prefix comparison)", () => {
    // Drill region=North; active filter date in [2026-04-01, 2026-12-31];
    // should keep North-Q2 + North-Q3.
    const result = filterChartRowsForDrill(rows, {
      column: "region",
      value: "North",
      filters: {
        date: { type: "date", start: "2026-04-01", end: "2026-12-31" },
      },
    });
    assert.equal(result.rows.length, 2);
    assert.deepEqual(
      result.rows.map((r) => r.quarter),
      ["Q2", "Q3"],
    );
  });
});

describe("WD3-server · filterChartRowsForDrill with extraPins (multi-dim drill)", () => {
  it("AND-intersects primary + extraPins", () => {
    // Heatmap-style drill: row=North AND col=Q1. Should return only
    // the single matching cell.
    const result = filterChartRowsForDrill(rows, {
      column: "region",
      value: "North",
      extraPins: [{ column: "quarter", value: "Q1" }],
    });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.units, 100);
    assert.equal(result.rows[0]?.region, "North");
    assert.equal(result.rows[0]?.quarter, "Q1");
  });

  it("extraPins compose with active filters (filter first, then pin chain)", () => {
    // Active filter `units < 200`; primary region=North; extraPin
    // quarter=Q2. Should return only North-Q2.
    const result = filterChartRowsForDrill(rows, {
      column: "region",
      value: "North",
      extraPins: [{ column: "quarter", value: "Q2" }],
      filters: {
        units: { type: "numeric", max: 200 },
      },
    });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.quarter, "Q2");
  });

  it("empty extraPins array is a no-op (primary alone)", () => {
    const result = filterChartRowsForDrill(rows, {
      column: "region",
      value: "North",
      extraPins: [],
    });
    assert.equal(result.rows.length, 3);
  });
});

describe("WD3-server · filterChartRowsForDrill row cap", () => {
  it(`caps rows at DRILL_ROW_CAP (${DRILL_ROW_CAP}) with capApplied=true when overrun`, () => {
    // Generate a 5000-row fixture all matching the same primary pin
    // (region=X). Expect the response to cap at DRILL_ROW_CAP and
    // report the true totalMatched.
    const bigRows = Array.from({ length: 5000 }, (_, i) => ({
      region: "X",
      units: i,
    }));
    const result = filterChartRowsForDrill(bigRows, {
      column: "region",
      value: "X",
    });
    assert.equal(result.rows.length, DRILL_ROW_CAP);
    assert.equal(result.totalMatched, 5000);
    assert.equal(result.capApplied, true);
  });

  it("capApplied=false when totalMatched <= DRILL_ROW_CAP", () => {
    const result = filterChartRowsForDrill(rows, {
      column: "region",
      value: "North",
    });
    assert.equal(result.capApplied, false);
  });
});

// ── findChartByTileId ──────────────────────────────────────────────

describe("WD3-server · findChartByTileId", () => {
  it("finds chart-0 in a single-sheet dashboard", () => {
    const dash = dashboard([chart("First"), chart("Second")]);
    const found = findChartByTileId(dash, "chart-0");
    assert.ok(found);
    assert.equal(found?.title, "First");
  });

  it("finds chart-1 in a single-sheet dashboard", () => {
    const dash = dashboard([chart("First"), chart("Second")]);
    const found = findChartByTileId(dash, "chart-1");
    assert.equal(found?.title, "Second");
  });

  it("walks across sheets to find the first match (multi-sheet dashboards)", () => {
    // chart-0 should be found in the first sheet that has one.
    const dash = {
      ...dashboard([]),
      sheets: [
        { id: "s-1", name: "Sheet 1", charts: [chart("A")], tables: [] },
        { id: "s-2", name: "Sheet 2", charts: [chart("B")], tables: [] },
      ],
    } as unknown as Dashboard;
    const found = findChartByTileId(dash, "chart-0");
    assert.equal(found?.title, "A");
  });

  it("returns null for a malformed tileId", () => {
    const dash = dashboard([chart("First")]);
    assert.equal(findChartByTileId(dash, "table-0"), null);
    assert.equal(findChartByTileId(dash, "chart-"), null);
    assert.equal(findChartByTileId(dash, ""), null);
    assert.equal(findChartByTileId(dash, "chart-abc"), null);
  });

  it("returns null for an out-of-range index", () => {
    const dash = dashboard([chart("First")]);
    assert.equal(findChartByTileId(dash, "chart-5"), null);
  });
});

// ── resolveDrillThrough ────────────────────────────────────────────

describe("WD3-server · resolveDrillThrough", () => {
  it("returns the response with chart metadata + filtered rows", () => {
    const dash = dashboard([chart("Sales by region")]);
    const response = resolveDrillThrough(dash, "chart-0", {
      column: "region",
      value: "North",
    });
    assert.equal(response.rows.length, 3);
    assert.equal(response.totalMatched, 3);
    assert.equal(response.capApplied, false);
    assert.equal(response.chart.title, "Sales by region");
    assert.equal(response.chart.tileId, "chart-0");
  });

  it("throws chart_not_found:<id> when the chart is missing", () => {
    const dash = dashboard([chart("First")]);
    assert.throws(
      () => resolveDrillThrough(dash, "chart-99", { column: "region", value: "North" }),
      /chart_not_found:chart-99/,
    );
  });

  it("returns an empty rows array when no row matches (not an error)", () => {
    const dash = dashboard([chart("First")]);
    const response = resolveDrillThrough(dash, "chart-0", {
      column: "region",
      value: "DoesNotExist",
    });
    assert.equal(response.rows.length, 0);
    assert.equal(response.totalMatched, 0);
    assert.equal(response.capApplied, false);
  });
});

// ── Controller source-inspection ───────────────────────────────────

describe("WD3-server · controller source contract", () => {
  it("auth-gates via getAuthenticatedEmail (401 when missing)", () => {
    assert.match(
      controllerSrc,
      /const userEmail = getAuthenticatedEmail\(req\);\s*if \(!userEmail\) \{\s*res\.status\(401\)\.json\(\{ error: "auth_required" \}\);/,
    );
  });

  it("requires chartId AND column in the query (400 missing_chart_id_or_column)", () => {
    // Pin both must be present — the future fetch logic depends on
    // chartId. value is intentionally lenient (null is valid).
    assert.match(
      controllerSrc,
      /if \(!chartId \|\| !column\) \{\s*res\.status\(400\)\.json\(\{ error: "missing_chart_id_or_column" \}\);/,
    );
  });

  it("reads filters + extraPins from the POST body", () => {
    assert.match(
      controllerSrc,
      /const body = \(req\.body \?\? \{\}\) as \{[\s\S]*?filters\?: DrillThroughRequest\["filters"\];[\s\S]*?extraPins\?: DrillThroughRequest\["extraPins"\];[\s\S]*?\};/,
    );
  });

  it("maps chart_not_found errors to 404", () => {
    assert.match(
      controllerSrc,
      /if \(msg\.startsWith\("chart_not_found:"\)\) \{\s*res\.status\(404\)\.json\(\{ error: msg \}\);/,
    );
  });

  it("maps dashboard-not-found to 404", () => {
    assert.match(
      controllerSrc,
      /if \(!dashboard\) \{\s*res\.status\(404\)\.json\(\{ error: "dashboard_not_found" \}\);/,
    );
  });

  it("delegates to resolveDrillThrough with the full request shape", () => {
    // Wave WD3-server-sheetId-resolution · the request now also
    // carries the optional `sheetId` field (scopes chartId lookup to
    // a specific sheet on multi-sheet dashboards). Pin its presence in
    // the resolveDrillThrough call so a future edit can't accidentally
    // drop it.
    assert.match(
      controllerSrc,
      /resolveDrillThrough\(dashboard, chartId, \{\s*column,\s*value,\s*extraPins: body\.extraPins,\s*filters: body\.filters,\s*sheetId,?\s*\}\);/,
    );
  });
});

// ── Route registration ────────────────────────────────────────────

describe("WD3-server · route registration", () => {
  it("registers POST /dashboards/:id/drill", () => {
    // POST (not GET) because the body can carry a non-trivial
    // ActiveChartFilters object — query-string encoding would force
    // JSON-in-URL escapes.
    assert.match(
      routesSrc,
      /router\.post\('\/dashboards\/:id\/drill', drillDashboardController\);/,
    );
  });

  it("imports drillDashboardController from the WD3-server controller", () => {
    assert.match(
      routesSrc,
      /import \{ drillDashboardController \} from "\.\.\/controllers\/dashboardDrillThroughController\.js";/,
    );
  });

  it("carries the WD3-server marker comment for future-Claude grep", () => {
    assert.match(routesSrc, /Wave WD3-server/);
  });
});
