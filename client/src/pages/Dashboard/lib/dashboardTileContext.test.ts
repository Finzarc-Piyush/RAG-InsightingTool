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
const barRendererSrc = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/BarRenderer.tsx"),
  "utf-8",
);
const chartTileBodySrc = readFileSync(
  repoFile("../Components/ChartTileBody.tsx"),
  "utf-8",
);
const dashboardViewSrc = readFileSync(
  repoFile("../Components/DashboardView.tsx"),
  "utf-8",
);

describe("WD2-wiring-bar · dashboardTileContext module shape", () => {
  it("exports DashboardTileProvider + useDashboardTileContext + DashboardTileContext", () => {
    assert.match(tileContextSrc, /export function DashboardTileProvider/);
    assert.match(tileContextSrc, /export function useDashboardTileContext/);
    assert.match(tileContextSrc, /export const DashboardTileContext/);
  });

  it("default context value is null (so consumers outside dashboard tiles take a no-op path)", () => {
    assert.match(
      tileContextSrc,
      /createContext<DashboardTileContextValue \| null>\(null\)/,
    );
  });

  it("DashboardTileProvider memoises the {tileId} value", () => {
    assert.match(
      tileContextSrc,
      /useMemo<DashboardTileContextValue>\([\s\S]*?\(\) => \(\{ tileId \}\),[\s\S]*?\[tileId\]/,
    );
  });

  it("useDashboardTileContext returns the context's null default when no provider is mounted", () => {
    // Source-level pin — the helper does NOT wrap in a no-op fallback.
    // Outside a provider it returns null and renderers branch on the null.
    assert.match(
      tileContextSrc,
      /return useContext\(Ctx\);/,
    );
  });
});

describe("WD2-wiring-bar · BarRenderer cross-filter wiring", () => {
  it("imports useDashboardTileContext from @/pages/Dashboard/lib/dashboardTileContext", () => {
    assert.match(
      barRendererSrc,
      /import \{ useDashboardTileContext \} from "@\/pages\/Dashboard\/lib\/dashboardTileContext"/,
    );
  });

  it("imports dispatchCrossFilter + toFilterValue from @/pages/Dashboard/lib/crossFilter", () => {
    assert.match(
      barRendererSrc,
      /import \{[\s\S]*?dispatchCrossFilter[\s\S]*?toFilterValue[\s\S]*?\} from "@\/pages\/Dashboard\/lib\/crossFilter"/,
    );
  });

  it("reads the dashboard-tile context once at the top of the renderer body", () => {
    assert.match(
      barRendererSrc,
      /const dashboardTile = useDashboardTileContext\(\);/,
    );
  });

  it("`interactive` flag is true when in ChartGrid OR a dashboard tile context is present", () => {
    assert.match(
      barRendererSrc,
      /const interactive = grid\.inGrid \|\| !!dashboardTile;/,
    );
  });

  it("onClick dispatches CROSS_FILTER_EVENT via dispatchCrossFilter when in a dashboard tile", () => {
    assert.match(
      barRendererSrc,
      /if \(dashboardTile\) \{[\s\S]*?dispatchCrossFilter\(\{[\s\S]*?column: enc\.x\.field,[\s\S]*?value: toFilterValue\(c\.outerRaw\),[\s\S]*?sourceTileId: dashboardTile\.tileId,[\s\S]*?\}\);[\s\S]*?\}/,
    );
  });

  it("the existing grid.toggleFilter path is preserved when inside a ChartGrid", () => {
    assert.match(
      barRendererSrc,
      /if \(grid\.inGrid\) \{[\s\S]*?grid\.toggleFilter\(\{[\s\S]*?field: enc\.x\.field,[\s\S]*?value: c\.outerRaw,[\s\S]*?\}\);[\s\S]*?\}/,
    );
  });
});

describe("WD2-wiring-bar · ChartTileBody wraps its chart in DashboardTileProvider", () => {
  it("imports DashboardTileProvider from the new module", () => {
    assert.match(
      chartTileBodySrc,
      /import \{ DashboardTileProvider \} from "\.\.\/lib\/dashboardTileContext"/,
    );
  });

  it("wraps the pivot / chart body in <DashboardTileProvider tileId={tile.id}>", () => {
    assert.match(
      chartTileBodySrc,
      /<DashboardTileProvider tileId=\{tile\.id\}>/,
    );
    assert.match(chartTileBodySrc, /<\/DashboardTileProvider>/);
  });
});

describe("WD2-wiring-bar · DashboardView subscribes to CROSS_FILTER_EVENT", () => {
  it("imports CROSS_FILTER_EVENT + applyCrossFilter from the WD2 helper", () => {
    assert.match(
      dashboardViewSrc,
      /import \{[\s\S]*?CROSS_FILTER_EVENT,[\s\S]*?applyCrossFilter,[\s\S]*?\} from '\.\.\/lib\/crossFilter'/,
    );
  });

  it("attaches a window listener for CROSS_FILTER_EVENT inside a useEffect", () => {
    assert.match(
      dashboardViewSrc,
      /window\.addEventListener\(CROSS_FILTER_EVENT,\s*handler as EventListener\)/,
    );
  });

  it("detaches the listener on cleanup", () => {
    assert.match(
      dashboardViewSrc,
      /window\.removeEventListener\(CROSS_FILTER_EVENT,\s*handler as EventListener\)/,
    );
  });

  it("dispatches the brushed (column, value) into globalFilters via applyCrossFilter", () => {
    assert.match(
      dashboardViewSrc,
      /setGlobalFilters\(\(prev\) => applyCrossFilter\(prev, detail\)\)/,
    );
  });

  it("ignores malformed events that lack a string column", () => {
    assert.match(
      dashboardViewSrc,
      /if \(!detail \|\| typeof detail\.column !== 'string'\) return;/,
    );
  });

  it("guards on typeof window === 'undefined' for SSR / test safety", () => {
    assert.match(
      dashboardViewSrc,
      /if \(typeof window === 'undefined'\) return;/,
    );
  });
});
