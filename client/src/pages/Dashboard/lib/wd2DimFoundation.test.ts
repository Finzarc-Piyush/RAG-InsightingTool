/**
 * Wave WD2-dim-foundation · source-inspection tests for the
 * `dashboardTileContext` extension that carries `filters`. The WD2
 * cross-filter wiring family (WD2-wiring-bar through
 * WD2-wiring-echarts) lets users click a mark to brush a dashboard-
 * wide filter. The visual feedback half of that loop — dim
 * non-matching marks on other tiles instead of removing them — needs
 * each renderer to read the active filter for its `enc.x.field` (or
 * equivalent encoding field) and decide if the mark it's about to
 * render matches. The `isCrossFilterActive` helper is already shipped
 * (`crossFilter.ts:67`), but pre-WD2-dim the renderer had no
 * `ActiveChartFilters` map to call it against.
 *
 * This foundation wave extends `DashboardTileContextValue` with an
 * optional `filters?: ActiveChartFilters` slot so future WD2-dim-bar /
 * dim-cat / dim-rect / dim-trend / dim-point / dim-echarts waves can
 * read it via `useDashboardTileContext()` without re-plumbing through
 * every renderer's prop set.
 *
 * Tests pin: the exported value type's new optional field, the
 * provider's new optional prop, the memoised value carrying it
 * conditionally (spread-conditional so non-passing callers don't
 * sneak `undefined` into the object), `ChartTileBody` passing
 * `filters={filters}` to the provider, and the `ActiveChartFilters`
 * type-only import (so the extension doesn't bloat the runtime
 * bundle).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const tileContextSrc = readFileSync(
  repoFile("./dashboardTileContext.tsx"),
  "utf-8",
);
const chartTileBodySrc = readFileSync(
  repoFile("../Components/ChartTileBody.tsx"),
  "utf-8",
);

describe("WD2-dim-foundation · DashboardTileContextValue extension", () => {
  it("imports the ActiveChartFilters type from chartFilters as a type-only import", () => {
    // Type-only import keeps the runtime bundle untouched — important
    // because dashboardTileContext is mounted on every dashboard tile
    // and changes to its bundle ripple through SplitView code-splitting.
    assert.match(
      tileContextSrc,
      /import type \{ ActiveChartFilters \} from "\.\.\/\.\.\/\.\.\/lib\/chartFilters"/,
    );
  });

  it("extends DashboardTileContextValue with an optional filters?: ActiveChartFilters field", () => {
    assert.match(
      tileContextSrc,
      /export interface DashboardTileContextValue \{[\s\S]*?tileId: string;[\s\S]*?filters\?: ActiveChartFilters;[\s\S]*?\}/,
    );
  });

  it("extends DashboardTileProviderProps with an optional filters?: ActiveChartFilters prop", () => {
    assert.match(
      tileContextSrc,
      /export interface DashboardTileProviderProps \{[\s\S]*?tileId: string;[\s\S]*?filters\?: ActiveChartFilters;[\s\S]*?children: ReactNode;[\s\S]*?\}/,
    );
  });

  it("destructures the new filters prop in the function signature", () => {
    assert.match(
      tileContextSrc,
      /export function DashboardTileProvider\(\{[\s\S]*?tileId,[\s\S]*?filters,[\s\S]*?children,[\s\S]*?\}: DashboardTileProviderProps\)/,
    );
  });
});

describe("WD2-dim-foundation · DashboardTileProvider memoisation shape", () => {
  it("includes filters in the useMemo dependency array (alongside tileId)", () => {
    assert.match(
      tileContextSrc,
      /useMemo<DashboardTileContextValue>\([\s\S]*?\[tileId,\s*filters\]/,
    );
  });

  it("spreads filters into the value conditionally (undefined → omit, defined → include)", () => {
    // Spread-conditional shape pins that we don't ship `filters: undefined`
    // into the object — keeps the memoised value byte-identical for
    // callers that omit filters (e.g. tests, legacy mounts) and the
    // upcoming dim-renderer guard can rely on `value.filters !== undefined`
    // as a "dashboard-side context" sentinel.
    assert.match(
      tileContextSrc,
      /\(\) => \(\{ tileId,\s*\.\.\.\(filters !== undefined \? \{ filters \} : \{\}\) \}\)/,
    );
  });

  it("default context value is still null (pre-existing invariant for chat / explorer / share surfaces)", () => {
    assert.match(
      tileContextSrc,
      /createContext<DashboardTileContextValue \| null>\(null\)/,
    );
  });
});

describe("WD2-dim-foundation · ChartTileBody passes filters through to the provider", () => {
  it("passes filters={filters} on the <DashboardTileProvider> JSX", () => {
    // The existing `filters: ActiveChartFilters | undefined` prop on
    // ChartTileBody (already threaded from DashboardTiles) is just
    // forwarded — no new prop added on the chart-tile body itself.
    assert.match(
      chartTileBodySrc,
      /<DashboardTileProvider tileId=\{tile\.id\} filters=\{filters\}>/,
    );
  });

  it("the ChartTileBody filters prop type is unchanged (still ActiveChartFilters | undefined)", () => {
    // Sanity pin so a future refactor that strips `| undefined` on
    // the prop doesn't silently break the dim-foundation forward.
    assert.match(
      chartTileBodySrc,
      /filters: ActiveChartFilters \| undefined;/,
    );
  });
});

describe("WD2-dim-foundation · documentation comment names the dim follow-on family", () => {
  it("the file header references WD2-dim-foundation and isCrossFilterActive consumption", () => {
    // The comment is load-bearing for future Claude: it names *why*
    // the context grew this field, which keeps WD2-dim-bar etc. from
    // re-litigating the foundation in a wider rewrite.
    assert.match(tileContextSrc, /WD2-dim-foundation/);
    assert.match(tileContextSrc, /isCrossFilterActive/);
  });

  it("the file header names the grid.inGrid / dashboardTile mutual exclusion (so the chat/explorer dim path stays untouched)", () => {
    assert.match(
      tileContextSrc,
      /grid\.inGrid[\s\S]*?dashboardTile[\s\S]*?mutually exclusive/,
    );
  });
});
