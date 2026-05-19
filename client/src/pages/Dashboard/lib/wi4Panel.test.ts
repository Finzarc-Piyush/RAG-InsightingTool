/**
 * Wave WI4-panel · source-inspection tests for ExplainSlicePanel +
 * the DashboardView listener that mounts it.
 *
 * Mirrors `wd3Sheet.test.ts`'s source-inspection approach: assertions
 * against the file source text, not runtime rendering. JSX-based
 * component tests live in vitest in this repo; the node:test harness
 * exercises shape-and-contract pins via regex against the source
 * because they're cheap, deterministic, and live in the same harness
 * as every other Dashboard / lib test.
 *
 * Coverage:
 *  - ExplainSlicePanel imports the Radix Sheet primitives + the
 *    foundation's BrushRegion / ExplainSliceEvent types.
 *  - The panel renders three sections: "Pinned slice" / "Filter
 *    context at brush time" / "Regenerated insight" (with the
 *    WI4-wire placeholder).
 *  - The "Pinned slice" body renders chartId / column / region (with
 *    a region.kind chip).
 *  - The region formatter discriminates on `region.kind`:
 *    numeric → [start, end]; temporal → ISO range; categorical →
 *    comma-joined with a MAX_CATEGORY_PREVIEW cap.
 *  - The panel opens on `event !== null` (single-source-of-truth);
 *    closes via `onOpenChange(false)` → parent clears event back to
 *    null.
 *  - DashboardView imports EXPLAIN_SLICE_EVENT + ExplainSliceEvent
 *    + ExplainSlicePanel; declares explainSliceEvent state; mounts
 *    a listener that validates chartId / column / region; renders
 *    the panel at the bottom of the JSX tree.
 *  - WI4-panel wave marker present in both files (greppable lineage).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const panelSrc = readFileSync(
  repoFile("../Components/ExplainSlicePanel.tsx"),
  "utf-8",
);
const dashSrc = readFileSync(
  repoFile("../Components/DashboardView.tsx"),
  "utf-8",
);

// ── ExplainSlicePanel · imports ────────────────────────────────────

describe("WI4-panel · ExplainSlicePanel imports", () => {
  it("imports Sheet primitives from the Radix wrapper", () => {
    // The panel reuses the same Radix-Sheet primitives as
    // DrillThroughSheet — the two click-intent receivers are
    // structurally parallel.
    assert.match(
      panelSrc,
      /import\s*\{\s*Sheet,\s*SheetContent,\s*SheetDescription,\s*SheetHeader,\s*SheetTitle,?\s*\}\s*from\s*["']@\/components\/ui\/sheet["']/,
    );
  });

  it("imports BrushRegion + ExplainSliceEvent types from the foundation", () => {
    // Type-only imports (`type` prefix) so the build doesn't drag
    // the foundation's runtime helpers in for the type-shape pin.
    assert.match(
      panelSrc,
      /import\s+type\s*\{\s*[\s\S]*?BrushRegion[\s\S]*?ExplainSliceEvent[\s\S]*?\}\s*from\s*["']\.\.\/lib\/explainSlice["']/,
    );
  });
});

// ── ExplainSlicePanel · props shape ─────────────────────────────────

describe("WI4-panel · ExplainSlicePanel props shape", () => {
  it("accepts `event: ExplainSliceEvent | null` + `onOpenChange: (open: boolean) => void`", () => {
    // Mirrors DrillThroughSheet's prop shape so the two receivers
    // can be swapped in parent code without a signature change.
    assert.match(panelSrc, /event:\s*ExplainSliceEvent\s*\|\s*null/);
    assert.match(
      panelSrc,
      /onOpenChange:\s*\(open:\s*boolean\)\s*=>\s*void/,
    );
  });

  it("derives `open` from `event !== null` (single source of truth)", () => {
    // No second `isOpen` prop — open-state is fully determined by
    // whether `event` is non-null. Avoids the two-prop-drift bug
    // class.
    assert.match(panelSrc, /const\s+open\s*=\s*event\s*!==\s*null/);
  });
});

// ── ExplainSlicePanel · section structure ──────────────────────────

describe("WI4-panel · ExplainSlicePanel section structure", () => {
  it("renders a 'Pinned slice' section as the FIRST body section", () => {
    // The pin metadata leads — the user wants to know WHAT was
    // brushed before reading the regenerated prose.
    assert.match(panelSrc, /Pinned slice/);
  });

  it("renders a 'Filter context at brush time' section", () => {
    // Symmetric with WD3-sheet's "Filter context at click time" —
    // both receivers surface the captured global filter snapshot
    // so the user can verify the slice was generated with the
    // intended dashboard state.
    assert.match(panelSrc, /Filter context at brush time/);
  });

  it("renders a 'Regenerated insight' section with a WI4-wire placeholder", () => {
    // The WI4-wire follow-on wave swaps the placeholder for a
    // `useInsightRegen` integration. Until then, the placeholder
    // pins the pipeline shape (applyChartFilters →
    // filterRowsByBrushRegion → useInsightRegen).
    assert.match(panelSrc, /Regenerated insight/);
    assert.match(panelSrc, /applyChartFilters/);
    assert.match(panelSrc, /filterRowsByBrushRegion/);
    assert.match(panelSrc, /useInsightRegen/);
  });
});

// ── ExplainSlicePanel · pinned-slice details ───────────────────────

describe("WI4-panel · ExplainSlicePanel pinned-slice details", () => {
  it("renders chartId / column / region rows in the Pinned slice <dl>", () => {
    // Three rows — chart, column, region — pinning the three
    // load-bearing fields of the event.
    assert.match(panelSrc, /event\.chartId/);
    assert.match(panelSrc, /event\.column/);
    assert.match(panelSrc, /event\.region/);
  });

  it("renders region.kind as a label chip alongside the formatted region", () => {
    // The kind (numeric / temporal / categorical) is visually
    // distinct from the bounds — the chip lets the user scan the
    // region type at a glance.
    assert.match(panelSrc, /event\.region\.kind/);
  });

  it("calls formatRegion(event.region) to render the bounds", () => {
    // The formatter discriminates on kind — pinned via the regex
    // for the call site.
    assert.match(panelSrc, /formatRegion\(\s*event\.region\s*\)/);
  });
});

// ── ExplainSlicePanel · formatRegion discrimination ─────────────────

describe("WI4-panel · formatRegion discriminates on region.kind", () => {
  it("numeric region → `[start, end]` string", () => {
    // Pin the numeric format so a future widening (e.g. open vs
    // closed intervals) is an explicit edit.
    assert.match(
      panelSrc,
      /region\.kind\s*===\s*["']numeric["'][\s\S]{0,200}?\$\{region\.start\},\s*\$\{region\.end\}/,
    );
  });

  it("temporal region → ISO string range via `new Date(startMs).toISOString()`", () => {
    // Full ISO (NOT a localised short date) so the canonical form
    // survives copy-paste into logs / debug tooling.
    assert.match(
      panelSrc,
      /new Date\(\s*region\.startMs\s*\)\.toISOString\(\)/,
    );
    assert.match(
      panelSrc,
      /new Date\(\s*region\.endMs\s*\)\.toISOString\(\)/,
    );
  });

  it("categorical region → comma-joined values with a MAX_CATEGORY_PREVIEW cap", () => {
    // The cap prevents a 50-category brush from blowing the panel
    // layout. The "… +N more" suffix communicates the remainder.
    assert.match(panelSrc, /MAX_CATEGORY_PREVIEW\s*=\s*10/);
    assert.match(
      panelSrc,
      /values\.slice\(\s*0\s*,\s*MAX_CATEGORY_PREVIEW\s*\)\.join\(\s*["'], ["']\s*\)/,
    );
    assert.match(panelSrc, /…\s*\+\$\{more\} more/);
  });
});

// ── ExplainSlicePanel · null event (closed) branch ─────────────────

describe("WI4-panel · ExplainSlicePanel closed-state behaviour", () => {
  it("renders no body content when event === null (the `event ? ... : null` gate)", () => {
    // The body sits inside an `event ? (<...>) : null` gate so
    // closing the sheet doesn't leave residual content visible
    // during the slide-out animation.
    assert.match(panelSrc, /\{event \? \([\s\S]*?\) : null\}/);
  });
});

// ── DashboardView wiring ────────────────────────────────────────────

describe("WI4-panel · DashboardView imports", () => {
  it("imports EXPLAIN_SLICE_EVENT + ExplainSliceEvent from the foundation", () => {
    // Same import pattern as the WD3-sheet wiring (DRILL_THROUGH_EVENT
    // + DrillThroughEvent).
    assert.match(
      dashSrc,
      /import\s*\{\s*EXPLAIN_SLICE_EVENT,\s*type\s+ExplainSliceEvent,?\s*\}\s*from\s*["']\.\.\/lib\/explainSlice["']/,
    );
  });

  it("imports ExplainSlicePanel from the Components dir", () => {
    assert.match(
      dashSrc,
      /import\s*\{\s*ExplainSlicePanel\s*\}\s*from\s*["']\.\/ExplainSlicePanel["']/,
    );
  });
});

describe("WI4-panel · DashboardView state + listener", () => {
  it("declares `explainSliceEvent` useState<ExplainSliceEvent | null>(null)", () => {
    // Independent state from drillThroughEvent — the two captured
    // events live as siblings so a future wave can hold both
    // panels open at once.
    assert.match(
      dashSrc,
      /const\s*\[\s*explainSliceEvent\s*,\s*setExplainSliceEvent\s*\]\s*=\s*useState<ExplainSliceEvent\s*\|\s*null>\(\s*null\s*\)/,
    );
  });

  it("mounts a useEffect that subscribes to EXPLAIN_SLICE_EVENT on window", () => {
    // Single useEffect with cleanup; matches the DRILL_THROUGH_EVENT
    // listener's shape (SSR-safe `typeof window === 'undefined'`
    // guard + addEventListener + return-cleanup).
    assert.match(
      dashSrc,
      /window\.addEventListener\(\s*EXPLAIN_SLICE_EVENT,\s*handler as EventListener\s*\)/,
    );
    assert.match(
      dashSrc,
      /window\.removeEventListener\(\s*EXPLAIN_SLICE_EVENT,\s*handler as EventListener\s*\)/,
    );
  });

  it("validates the event detail's chartId / column / region before setting state", () => {
    // STRICTER than the cross-filter listener (3 fields vs 2)
    // because a missing region would mean a malformed dispatch
    // (the foundation's makeXRegion helpers already short-circuit
    // on zero-width).
    assert.match(
      dashSrc,
      /typeof detail\.chartId !== 'string'\s*\|\|\s*typeof detail\.column !== 'string'\s*\|\|\s*!detail\.region/,
    );
  });

  it("calls setExplainSliceEvent(detail) after the validation passes", () => {
    // The captured detail (not a clone / not a partial) flows into
    // state — the panel renders directly from it.
    assert.match(dashSrc, /setExplainSliceEvent\(detail\)/);
  });
});

describe("WI4-panel · DashboardView mounts the panel", () => {
  it("renders <ExplainSlicePanel event={explainSliceEvent} ... /> with onOpenChange → setExplainSliceEvent(null)", () => {
    // 2-prop mount mirroring DrillThroughSheet's shape. The
    // onOpenChange contract: parent flips state back to null on
    // close (no second isOpen prop).
    assert.match(
      dashSrc,
      /<ExplainSlicePanel[\s\S]*?event=\{explainSliceEvent\}[\s\S]*?onOpenChange=\{\(open\)\s*=>\s*\{\s*if\s*\(\!open\)\s*setExplainSliceEvent\(null\);\s*\}\}/,
    );
  });
});

// ── wave marker present ─────────────────────────────────────────────

describe("WI4-panel · wave marker present", () => {
  it("ExplainSlicePanel.tsx carries the WI4-panel wave marker", () => {
    assert.match(panelSrc, /Wave\s*WI4-panel/);
  });

  it("DashboardView.tsx carries the WI4-panel wave marker for the listener + mount", () => {
    assert.match(dashSrc, /Wave\s*WI4-panel/);
  });
});
