/**
 * Wave WD3-sheet · source-inspection tests for the receiving end of
 * the WD3 drill-through event family. Two artifacts under test:
 *   1. DashboardView's new `DRILL_THROUGH_EVENT` listener +
 *      `drillThroughEvent` state slice.
 *   2. The new `<DrillThroughSheet>` Radix-Sheet component that
 *      renders the captured event.
 *
 * Source-inspection (not behavioural / DOM) because:
 *   - DashboardView is a 1000+-LOC React component that's expensive
 *     to mount under jsdom without a wide set of context-provider
 *     mocks (auth, query-client, dashboard, edit-mode, etc.) — the
 *     load-bearing shape lives in the listener body + the prop
 *     wiring, both of which read clearly off the source.
 *   - The sheet component's body is JSX with `event.column`,
 *     `event.value`, and `event.filters` reads — the wiring contract
 *     is "does the JSX consume the right fields and pass them to the
 *     right Radix primitives", which source-inspection captures.
 *
 * Tests pin: the import additions on DashboardView (drillThrough
 * named imports + the new DrillThroughSheet component); the
 * `drillThroughEvent` state slice; the listener's
 * `addEventListener(DRILL_THROUGH_EVENT, ...)` subscription with
 * cleanup; the detail validation guard (chartId AND column must be
 * strings); the JSX mount near the existing dialogs; the
 * `onOpenChange(false)` → clear-event close contract. Sheet
 * component: import shape (Radix Sheet primitives); prop signature;
 * the `open = event !== null` derivation; the `summariseFilters`
 * helper covers all three filter types.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const dashboardViewSrc = readFileSync(
  repoFile("../Components/DashboardView.tsx"),
  "utf-8",
);

const sheetSrc = readFileSync(
  repoFile("../Components/DrillThroughSheet.tsx"),
  "utf-8",
);

// ── DashboardView: listener + state + mount ─────────────────────────

describe("WD3-sheet · DashboardView imports drillThrough surfaces", () => {
  it("named-imports DRILL_THROUGH_EVENT + DrillThroughEvent type from ../lib/drillThrough", () => {
    // Mirrors the existing CROSS_FILTER_EVENT import shape (named
    // event constant + type from the same module).
    assert.match(
      dashboardViewSrc,
      /import \{\s*DRILL_THROUGH_EVENT,\s*type DrillThroughEvent,?\s*\} from '\.\.\/lib\/drillThrough';/,
    );
  });

  it("imports the DrillThroughSheet component from ./DrillThroughSheet", () => {
    assert.match(
      dashboardViewSrc,
      /import \{\s*DrillThroughSheet,?\s*\} from '\.\/DrillThroughSheet';/,
    );
  });
});

describe("WD3-sheet · DashboardView holds drillThroughEvent state", () => {
  it("declares the drillThroughEvent state slice with the right type signature", () => {
    // The state shape is `DrillThroughEvent | null` — null = closed
    // sheet. The setter clears to null on close so a re-open with
    // the same payload re-fires the slide-in animation.
    assert.match(
      dashboardViewSrc,
      /const \[drillThroughEvent, setDrillThroughEvent\] = useState<DrillThroughEvent \| null>\(null\);/,
    );
  });
});

describe("WD3-sheet · DashboardView subscribes to DRILL_THROUGH_EVENT with cleanup", () => {
  it("registers a window listener for DRILL_THROUGH_EVENT with a return-cleanup", () => {
    // The listener mirrors the existing CROSS_FILTER_EVENT
    // subscription's shape (addEventListener + return-cleanup that
    // removeEventListener-s the same handler).
    assert.match(
      dashboardViewSrc,
      /window\.addEventListener\(DRILL_THROUGH_EVENT, handler as EventListener\);[\s\S]*?return \(\) => \{\s*window\.removeEventListener\(DRILL_THROUGH_EVENT, handler as EventListener\);\s*\};/,
    );
  });

  it("guards on chartId AND column being strings (stricter than cross-filter)", () => {
    // Cross-filter validates only column-is-string; drill-through
    // also requires chartId because the (future) server fetch needs
    // it. A malformed event without chartId would otherwise show an
    // empty drill sheet with no row source.
    assert.match(
      dashboardViewSrc,
      /if \(\s*!detail \|\|\s*typeof detail\.chartId !== 'string' \|\|\s*typeof detail\.column !== 'string'\s*\) \{\s*return;\s*\}/,
    );
  });

  it("sets drillThroughEvent to the detail payload on a valid event", () => {
    // The state setter receives the full event, not a derived
    // shape — so the sheet has access to chartId / column / value /
    // sourceTileId / filters all at once.
    //
    // Wave WD3-server-sheetId-resolution · the setter now wraps
    // `detail` in a conditional spread that injects `sheetId:
    // activeSheetId` when a sheet is active at click time, so the
    // server-side chartId resolution can scope to the correct sheet
    // on multi-sheet dashboards. The injection is at click time (not
    // panel-open time) so the resolution context is stable across
    // subsequent sheet navigation. When no sheet is active the bare
    // `detail` is set unchanged (pre-wave shape preserved).
    assert.match(
      dashboardViewSrc,
      /setDrillThroughEvent\(\s*activeSheetId \? \{ \.\.\.detail, sheetId: activeSheetId \} : detail,?\s*\);/,
    );
  });

  it("guards the listener with the SSR-safe typeof window check (mirrors cross-filter)", () => {
    // The drill listener and cross-filter listener share the same
    // SSR-safe pattern. Pin both effects use the same guard so a
    // future SSR rendering path doesn't trip.
    const drillEffectMatch = dashboardViewSrc.match(
      /useEffect\(\(\) => \{\s*if \(typeof window === 'undefined'\) return;[\s\S]*?DRILL_THROUGH_EVENT/,
    );
    assert.ok(
      drillEffectMatch,
      "drill listener must be inside a useEffect guarded by typeof window check",
    );
  });
});

describe("WD3-sheet · DashboardView mounts DrillThroughSheet with the right props", () => {
  it("renders <DrillThroughSheet event={drillThroughEvent} onOpenChange={...}>", () => {
    // The prop signature: `event` carries the captured drill event
    // (null = closed); `onOpenChange` receives Radix's open-bool and
    // clears the event back to null when the sheet closes (overlay
    // click, Escape, close button).
    assert.match(
      dashboardViewSrc,
      /<DrillThroughSheet[\s\S]*?event=\{drillThroughEvent\}[\s\S]*?onOpenChange=\{[\s\S]*?\(open\) =>[\s\S]*?if \(!open\) setDrillThroughEvent\(null\);[\s\S]*?\}[\s\S]*?\/>/,
    );
  });

  it("mounts the sheet after the ShareDashboardDialog (dialog cluster locality)", () => {
    // Pin the JSX placement so the sheet stays grouped with the
    // other Radix dialogs at the bottom of the component (not e.g.
    // accidentally hoisted inside the active-section render branch).
    // The Share dialog is the last pre-WD3 dialog in the cluster.
    const shareIdx = dashboardViewSrc.indexOf("<ShareDashboardDialog");
    const drillIdx = dashboardViewSrc.indexOf("<DrillThroughSheet");
    assert.ok(shareIdx > 0, "must find ShareDashboardDialog mount");
    assert.ok(drillIdx > 0, "must find DrillThroughSheet mount");
    assert.ok(
      drillIdx > shareIdx,
      "DrillThroughSheet must mount after ShareDashboardDialog",
    );
  });
});

// ── DrillThroughSheet: render shape ─────────────────────────────────

describe("WD3-sheet · DrillThroughSheet imports + prop signature", () => {
  it("imports the Radix Sheet primitives from @/components/ui/sheet", () => {
    assert.match(
      sheetSrc,
      /import \{\s*Sheet,\s*SheetContent,\s*SheetDescription,\s*SheetHeader,\s*SheetTitle,?\s*\} from "@\/components\/ui\/sheet";/,
    );
  });

  it("imports DrillThroughEvent type from ../lib/drillThrough (event-shape source of truth)", () => {
    assert.match(
      sheetSrc,
      /import type \{ DrillThroughEvent \} from "\.\.\/lib\/drillThrough";/,
    );
  });

  it("imports toFilterValue from ../lib/crossFilter for value display canonicalisation", () => {
    // The clicked value lands in the sheet header / body as a
    // string — toFilterValue is the canonical client-side
    // stringifier (handles null / Date / number / boolean).
    assert.match(
      sheetSrc,
      /import \{ toFilterValue \} from "\.\.\/lib\/crossFilter";/,
    );
  });

  it("declares the props interface with event + onOpenChange", () => {
    assert.match(
      sheetSrc,
      /interface DrillThroughSheetProps \{[\s\S]*?event: DrillThroughEvent \| null;[\s\S]*?onOpenChange: \(open: boolean\) => void;[\s\S]*?\}/,
    );
  });
});

describe("WD3-sheet · DrillThroughSheet render contract", () => {
  it("derives `open` from `event !== null` (no separate open prop)", () => {
    // The "single source of truth" shape: parent passes the event,
    // open is derived. Two-prop parents (`open` + `event`) are an
    // anti-pattern because they can drift (open=true with
    // event=null would render an empty sheet).
    assert.match(sheetSrc, /const open = event !== null;/);
  });

  it("passes side=\"right\" to SheetContent (slide-in from the right edge)", () => {
    // Right-side is the standard "inspector" panel position — same
    // pattern as DashboardSummaryDrawer.
    assert.match(sheetSrc, /<SheetContent side="right"/);
  });

  it("reads event.chartId / event.column / event.value for the pinned-slice display", () => {
    // Pin all three fields render in the body — a refactor that
    // accidentally drops one would silently hide the data.
    assert.match(sheetSrc, /event\.chartId/);
    assert.match(sheetSrc, /event\.column/);
    assert.match(sheetSrc, /event\.value/);
  });

  it("canonicalises value display via toFilterValue (Date / number / null → string)", () => {
    // Calling toFilterValue twice (once for the description, once
    // for the body table) is fine — both call sites stringify the
    // same `event.value`. Pin at least one call to verify the
    // canonicalisation path.
    assert.match(sheetSrc, /toFilterValue\(event\.value\)/);
  });

  it("references the WD3-server endpoint somewhere (now consumed via the fetch hook; markers preserved in comments for future-Claude grep)", () => {
    // Originally pinned the dashed-border placeholder body that
    // showed the endpoint name. WD3-sheet-fetch replaced the
    // placeholder with the real fetched row list, but the
    // `WD3-server` + endpoint markers survive in the file's comments
    // so a grep for either still finds the sheet.
    assert.match(sheetSrc, /WD3-server/);
    assert.match(sheetSrc, /\/api\/dashboards\/:id\/drill/);
  });
});

describe("WD3-sheet · summariseFilters covers all three ActiveChartFilters types", () => {
  it("formats categorical filters as `column ∈ {v1, v2}`", () => {
    assert.match(sheetSrc, /sel\.type === "categorical"[\s\S]*?\$\{sel\.values\.join\(", "\)\}/);
  });

  it("formats date filters as `column between start and end`", () => {
    assert.match(sheetSrc, /sel\.type === "date"[\s\S]*?\$\{sel\.start\}[\s\S]*?\$\{sel\.end\}/);
  });

  it("formats numeric filters as `column in [min, max]`", () => {
    assert.match(sheetSrc, /sel\.type === "numeric"[\s\S]*?\$\{sel\.min\}[\s\S]*?\$\{sel\.max\}/);
  });
});
