/**
 * Wave WD3-sheet-fetch · source-inspection tests for the consumer-side
 * swap that replaces the WD3-sheet's dashed placeholder body with a
 * TanStack-Query-fetched row list.
 *
 * Three artifacts under test:
 *   1. `useDrillThroughRows` hook — wraps TanStack Query with the
 *      WD3-server fetch shape (POST to /api/dashboards/:id/drill with
 *      query params chartId/column/value + body filters+extraPins).
 *   2. `DrillThroughRowTable` component — pure render of the
 *      `DrillThroughResponse.rows` array as a compact <table>.
 *   3. `DrillThroughSheet` consumer — drops the placeholder section
 *      and renders the table inside an "Underlying rows" section,
 *      gated on the hook's loading / error / data states. New required
 *      `dashboardId: string` prop threaded from `DashboardView`.
 *
 * Tests pin: the hook's queryKey shape (covers full payload); enabled
 * gate (idle when event is null); fetch shape (POST + body + URL
 * params); the table component's empty / non-empty branches + the
 * cap-applied affordance; the sheet's hook call + table mount; the
 * `dashboardId` prop threading from DashboardView.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const hookSrc = readFileSync(
  repoFile("../hooks/useDrillThroughRows.ts"),
  "utf-8",
);
const tableSrc = readFileSync(
  repoFile("../Components/DrillThroughRowTable.tsx"),
  "utf-8",
);
const sheetSrc = readFileSync(
  repoFile("../Components/DrillThroughSheet.tsx"),
  "utf-8",
);
const dashboardViewSrc = readFileSync(
  repoFile("../Components/DashboardView.tsx"),
  "utf-8",
);

// ── useDrillThroughRows hook ───────────────────────────────────────

describe("WD3-sheet-fetch · useDrillThroughRows imports + shape", () => {
  it("imports useQuery from @tanstack/react-query", () => {
    // The codebase already uses TanStack Query elsewhere (Dashboard.tsx);
    // the hook follows that convention rather than rolling a fresh
    // fetch+useState pattern.
    assert.match(
      hookSrc,
      /import \{ useQuery, type UseQueryResult \} from "@tanstack\/react-query";/,
    );
  });

  it("imports DrillThroughEvent + DrillThroughPin types from ../lib/drillThrough", () => {
    assert.match(
      hookSrc,
      /import type \{\s*DrillThroughEvent,\s*DrillThroughPin,?\s*\} from "\.\.\/lib\/drillThrough";/,
    );
  });

  it("exports a DrillThroughResponse interface mirroring the server response shape", () => {
    // The hook's return data type must match the server's
    // DrillThroughResponse byte-for-byte so the consumer reads
    // `data` directly without transformation.
    assert.match(
      hookSrc,
      /export interface DrillThroughResponse \{[\s\S]*?rows: Array<Record<string, unknown>>;[\s\S]*?totalMatched: number;[\s\S]*?capApplied: boolean;[\s\S]*?chart: \{ title: string; tileId: string \};[\s\S]*?\}/,
    );
  });
});

describe("WD3-sheet-fetch · useDrillThroughRows queryKey covers full event payload", () => {
  it("queryKey includes dashboardId, chartId, column, stringified value, extraPins, filters", () => {
    // Without each piece in the key, two distinct drill requests
    // (e.g. different cell clicks on a heatmap) would share a cache
    // slot. Pin all six pieces — gaps allow comments between entries.
    assert.match(
      hookSrc,
      /queryKey: \[[\s\S]*?"drill",[\s\S]*?dashboardId,[\s\S]*?event\?\.chartId \?\? "",[\s\S]*?event\?\.column \?\? "",[\s\S]*?stringifyForKey\(event\?\.value\),[\s\S]*?JSON\.stringify\(event\?\.extraPins \?\? \[\]\),[\s\S]*?JSON\.stringify\(event\?\.filters \?\? \{\}\),?[\s\S]*?\]/,
    );
  });

  it("the fetch is gated `enabled: !!event && !!dashboardId`", () => {
    // Without the gate, a render with event=null would still fire
    // the network — wasteful AND would NaN through the server's
    // required-field validation.
    assert.match(
      hookSrc,
      /enabled: !!event && !!dashboardId,/,
    );
  });
});

describe("WD3-sheet-fetch · useDrillThroughRows queryFn shape", () => {
  it("POSTs to /api/dashboards/:id/drill with credentials: include", () => {
    assert.match(
      hookSrc,
      /new URL\(\s*`\/api\/dashboards\/\$\{encodeURIComponent\(dashboardId\)\}\/drill`,/,
    );
    assert.match(hookSrc, /method: "POST",/);
    assert.match(hookSrc, /credentials: "include",/);
  });

  it("sets chartId / column / value as URL search params", () => {
    assert.match(hookSrc, /url\.searchParams\.set\("chartId", event\.chartId\);/);
    assert.match(hookSrc, /url\.searchParams\.set\("column", event\.column\);/);
    assert.match(hookSrc, /url\.searchParams\.set\("value", stringifyForKey\(event\.value\)\);/);
  });

  it("body carries { filters, extraPins } as JSON", () => {
    assert.match(
      hookSrc,
      /body: JSON\.stringify\(\{\s*filters: event\.filters \?\? \{\},\s*extraPins: \(event\.extraPins \?\? \[\]\) as DrillThroughPin\[\],?\s*\}\),/,
    );
  });

  it("throws `drill_failed:<status>:<body>` on non-2xx response", () => {
    // The error surfaces in TanStack Query's `error` state; the
    // sheet shows it via role=alert. Pin the message shape so the
    // sheet's display logic can rely on the prefix.
    assert.match(
      hookSrc,
      /if \(!response\.ok\) \{[\s\S]*?throw new Error\(`drill_failed:\$\{response\.status\}:\$\{text\}`\);/,
    );
  });
});

describe("WD3-sheet-fetch · useDrillThroughRows stringifyForKey mirrors server semantics", () => {
  it("stringifyForKey handles null / undefined → 'null', Date → ISO, other → String(v)", () => {
    // Same wire-storage canonicalisation as the server's
    // stringifyForComparison. Pin the four branches.
    assert.match(
      hookSrc,
      /function stringifyForKey\(value: unknown\): string \{[\s\S]*?if \(value === null \|\| value === undefined\) return "null";[\s\S]*?if \(typeof value === "string"\) return value;[\s\S]*?if \(value instanceof Date\) return value\.toISOString\(\);[\s\S]*?return String\(value\);[\s\S]*?\}/,
    );
  });
});

// ── DrillThroughRowTable component ─────────────────────────────────

describe("WD3-sheet-fetch · DrillThroughRowTable renders the response shape", () => {
  it("imports the DrillThroughResponse type from the hook (single source of truth)", () => {
    assert.match(
      tableSrc,
      /import type \{ DrillThroughResponse \} from "\.\.\/hooks\/useDrillThroughRows";/,
    );
  });

  it("renders an empty-state message when rows.length === 0", () => {
    // Pin the empty-state copy so a future-Claude doesn't accidentally
    // render an empty <table> body (visually confusing).
    assert.match(
      tableSrc,
      /if \(rows\.length === 0\) \{\s*return \(\s*<p[\s\S]*?No rows match/,
    );
  });

  it("renders a 'Showing X of Y matching rows' affordance when capApplied is true", () => {
    // The 1000-row cap is invisible without this affordance — users
    // would think the drill returned 1000 rows exactly.
    assert.match(
      tableSrc,
      /capApplied[\s\S]*?Showing \$\{rows\.length\} of \$\{totalMatched\} matching rows/,
    );
  });

  it("renders 'N matching row(s)' when capApplied is false with singular/plural handling", () => {
    assert.match(
      tableSrc,
      /\$\{rows\.length\} matching row\$\{rows\.length === 1 \? "" : "s"\}/,
    );
  });

  it("derives columns from the first row's keys + maps rows.map to <tr>", () => {
    assert.match(tableSrc, /const columns = Object\.keys\(rows\[0\] \?\? \{\}\);/);
    assert.match(tableSrc, /\{rows\.map\(\(row, rowIdx\) =>/);
  });

  it("wraps the table in an overflow-x-auto container so narrow sheets scroll horizontally", () => {
    // The Radix Sheet is sm:max-w-md (28rem) — many real datasets
    // have wider rows than that. Horizontal scroll is the right
    // affordance.
    assert.match(tableSrc, /overflow-x-auto/);
  });

  it("formatCell handles null/undefined → '—', Date → ISO, other → String", () => {
    assert.match(
      tableSrc,
      /function formatCell\(value: unknown\): string \{[\s\S]*?if \(value === null \|\| value === undefined\) return "—";[\s\S]*?if \(value instanceof Date\) return value\.toISOString\(\);[\s\S]*?return String\(value\);[\s\S]*?\}/,
    );
  });
});

// ── DrillThroughSheet integration ──────────────────────────────────

describe("WD3-sheet-fetch · DrillThroughSheet consumes the hook + table", () => {
  it("imports useDrillThroughRows + DrillThroughRowTable", () => {
    assert.match(
      sheetSrc,
      /import \{ useDrillThroughRows \} from "\.\.\/hooks\/useDrillThroughRows";/,
    );
    assert.match(
      sheetSrc,
      /import \{ DrillThroughRowTable \} from "\.\/DrillThroughRowTable";/,
    );
  });

  it("declares a required `dashboardId: string` prop in DrillThroughSheetProps", () => {
    assert.match(
      sheetSrc,
      /interface DrillThroughSheetProps \{[\s\S]*?dashboardId: string;/,
    );
  });

  it("destructures `dashboardId` from the function-component props", () => {
    assert.match(
      sheetSrc,
      /export function DrillThroughSheet\(\{\s*dashboardId,\s*event,\s*onOpenChange,?\s*\}: DrillThroughSheetProps\)/,
    );
  });

  it("invokes useDrillThroughRows({ dashboardId, event })", () => {
    assert.match(
      sheetSrc,
      /const rowsQuery = useDrillThroughRows\(\{ dashboardId, event \}\);/,
    );
  });

  it("renders a 'Loading rows…' message while rowsQuery.isLoading", () => {
    assert.match(
      sheetSrc,
      /rowsQuery\.isLoading \?[\s\S]*?Loading rows…/,
    );
  });

  it("renders the error message with role='alert' when rowsQuery.isError", () => {
    // role=alert ensures screen readers announce the failure
    // immediately rather than at the next polite-region scan.
    assert.match(
      sheetSrc,
      /rowsQuery\.isError \?[\s\S]*?role="alert"[\s\S]*?rowsQuery\.error\?\.message/,
    );
  });

  it("renders <DrillThroughRowTable response={rowsQuery.data} /> on success", () => {
    assert.match(
      sheetSrc,
      /rowsQuery\.data \?[\s\S]*?<DrillThroughRowTable response=\{rowsQuery\.data\} \/>/,
    );
  });

  it("the new 'Underlying rows' section replaces the prior dashed-border placeholder", () => {
    // Negative pin: the dashed placeholder text "Row fetch lands with
    // the WD3-server endpoint" should NO LONGER appear in the sheet
    // body — it's been replaced by the real fetched table. A
    // refactor that re-adds the placeholder would break the sheet's
    // user-visible promise.
    assert.doesNotMatch(sheetSrc, /Row fetch lands with the WD3-server endpoint/);
    assert.doesNotMatch(sheetSrc, /Until then this panel summarises/);
  });

  it("renders an 'Underlying rows' section header", () => {
    assert.match(sheetSrc, /Underlying rows/);
  });
});

// ── DashboardView prop threading ───────────────────────────────────

describe("WD3-sheet-fetch · DashboardView threads dashboardId to the sheet", () => {
  it("the <DrillThroughSheet> mount carries `dashboardId={dashboard.id}`", () => {
    assert.match(
      dashboardViewSrc,
      /<DrillThroughSheet[\s\S]*?dashboardId=\{dashboard\.id\}[\s\S]*?event=\{drillThroughEvent\}/,
    );
  });

  it("the prior 2-prop mount (event + onOpenChange) is preserved (additive change)", () => {
    // Regression-pin: the WD3-sheet wave's onOpenChange contract is
    // unchanged. A refactor that dropped onOpenChange would break
    // the close-on-overlay-click path.
    assert.match(
      dashboardViewSrc,
      /<DrillThroughSheet[\s\S]*?event=\{drillThroughEvent\}[\s\S]*?onOpenChange=\{\(open\) => \{\s*if \(!open\) setDrillThroughEvent\(null\);[\s\S]*?\}\}[\s\S]*?\/>/,
    );
  });
});

// ── Cross-cutting contracts ─────────────────────────────────────────

describe("WD3-sheet-fetch · cross-cutting contracts", () => {
  it("the WD3-sheet-fetch marker appears in the hook, the table, and the sheet", () => {
    assert.match(hookSrc, /WD3-sheet-fetch/);
    assert.match(tableSrc, /WD3-sheet-fetch/);
    assert.match(sheetSrc, /WD3-sheet-fetch/);
  });

  it("the hook's response shape and the table's response prop type are the same import", () => {
    // The table imports DrillThroughResponse from the hook so the
    // type stays in one place. A future refactor that extracts the
    // type to a shared types module is fine, but it shouldn't
    // duplicate the type definition.
    const hookExportsResponse = /export interface DrillThroughResponse/.test(hookSrc);
    const tableImportsResponse = /import type \{ DrillThroughResponse \} from "\.\.\/hooks\/useDrillThroughRows"/.test(tableSrc);
    assert.ok(hookExportsResponse, "hook must export DrillThroughResponse");
    assert.ok(tableImportsResponse, "table must import DrillThroughResponse from the hook");
  });
});
