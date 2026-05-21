/**
 * Wave WI4-client-sheetId-resolution · source-inspection tests for
 * the optional `sheetId` field on the WI4 explain-slice path.
 *
 * Direct mirror of `dashboardDrillThroughWD3SheetIdResolution.test.ts`
 * but on the explain-slice surface. Closes the chartId-collision
 * concern end-to-end on BOTH click-intent paths (drill-through +
 * explain-slice). Promotes the click-time-context-capture soft
 * pattern to its second instance.
 *
 * Pre-wave failure mode (now defended against): user brushes Sheet
 * 1's chart-0 (region: spend > 500) → setExplainSliceEvent fires with
 * `{chartId: "chart-0", region: ..., ...}` — no sheet context on the
 * event → user navigates to Sheet 2 → panel reads
 * `activeSheet.charts[idx]` → Sheet 2's chart-0 → regen fires against
 * Sheet 2's data with Sheet 1's brush region (silently wrong).
 *
 * Backwards-compat invariant: an event without sheetId (a panel mount
 * that pre-dates this wave, or the degenerate no-sheets-yet mount)
 * gets the legacy `activeSheet.charts[idx]` lookup verbatim. Pin both
 * the scoped + legacy paths so a future edit can't accidentally
 * tighten the resolver into an always-scoped shape that would break
 * older event shapes.
 *
 * Predictable-failure on stale sheetId (sheet deleted between brush
 * and panel render): the resolver returns null rather than silently
 * falling back to activeSheet — the panel then surfaces "Could not
 * resolve the chart for..." through the existing no-chart branch of
 * ExplainSlicePanel. Mirrors the server-side WD3 resolver's
 * `chart_not_found` contract.
 *
 * Pins five layers:
 *  1. ExplainSliceEvent gains `sheetId?: string` (interface case).
 *  2. DashboardView WI4 listener injects activeSheetId on the event
 *     detail at brush time via a conditional spread.
 *  3. Negative-pin: listener does NOT call `setExplainSliceEvent(detail)`
 *     unconditionally (the pre-wave shape).
 *  4. Panel resolver scopes on `explainSliceEvent.sheetId` via
 *     `sheets.find(s => s.id === explainSliceEvent.sheetId)`.
 *  5. Legacy fallback preserved: source still contains
 *     `activeSheet.charts[idx]` for the sheetId-undefined branch.
 *  6. Wave marker present in both touched files.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const explainSliceLibSrc = readFileSync(
  repoFile("./explainSlice.ts"),
  "utf-8",
);
const dashSrc = readFileSync(
  repoFile("../Components/DashboardView.tsx"),
  "utf-8",
);

// ── ExplainSliceEvent.sheetId interface field ───────────────────────

describe("WI4-client-sheetId-resolution · ExplainSliceEvent.sheetId field", () => {
  it("declares `sheetId?: string` on the ExplainSliceEvent interface", () => {
    // Optional string mirroring DrillThroughEvent.sheetId's shape; the
    // optionality preserves backwards-compat for any caller that
    // builds an event without the sheet context.
    assert.match(
      explainSliceLibSrc,
      /export interface ExplainSliceEvent \{[\s\S]*?sheetId\?:\s*string;[\s\S]*?\}/,
    );
  });

  it("carries a JSDoc block on the sheetId field pinning the brush-time-vs-render-time invariant", () => {
    // The JSDoc is load-bearing: future readers must understand the
    // brush-time capture invariant (capture on the LISTENER, never
    // re-resolve at panel-render time). Pin the key phrase.
    assert.match(
      explainSliceLibSrc,
      /Captured at brush time \(not panel-render time\)/,
    );
  });

  it("documents the predictable-failure contract on stale sheetId", () => {
    // Stale sheetId (sheet deleted between brush and panel render)
    // returns null rather than silently falling back. The JSDoc cross-
    // references the server-side WD3 resolver's chart_not_found
    // contract so the symmetry across click-intent paths is greppable.
    assert.match(
      explainSliceLibSrc,
      /Predictable-failure on stale sheetId/,
    );
  });
});

// ── DashboardView WI4 listener · conditional spread injection ───────

describe("WI4-client-sheetId-resolution · DashboardView WI4 listener injects sheetId", () => {
  it("calls setExplainSliceEvent with `activeSheetId ? { ...detail, sheetId: activeSheetId } : detail` (conditional spread)", () => {
    // The conditional injection captures the user's intent at brush
    // time (activeSheetId was already in scope from the WD3-WI4-
    // sheetId-telemetry wave's effect-deps widening, so no new state
    // plumbing). The omit branch (no sheet active) preserves the pre-
    // wave shape verbatim for the degenerate "no sheets yet" mount.
    assert.match(
      dashSrc,
      /setExplainSliceEvent\(\s*activeSheetId \? \{ \.\.\.detail, sheetId: activeSheetId \} : detail,?\s*\);/,
    );
  });

  it("the WI4 listener's effect deps include activeSheetId (closure-fresh)", () => {
    // activeSheetId is read inside the listener's body, so it MUST be
    // in the deps array. Without this, the listener captures a stale
    // activeSheetId from the mount-time closure. The WD3-WI4-sheetId-
    // telemetry wave widened both listeners' deps to [dashboard.id,
    // activeSheetId]; this wave continues to depend on that shape.
    // Pin the WI4 effect's deps array specifically: find the
    // EXPLAIN_SLICE_EVENT subscribe block and assert its closing deps
    // array includes activeSheetId.
    const explainEffectMatch = dashSrc.match(
      /window\.addEventListener\(EXPLAIN_SLICE_EVENT[\s\S]*?\}, \[([^\]]+)\]\)/,
    );
    assert.ok(
      explainEffectMatch,
      "WI4 listener useEffect with deps array must be present",
    );
    const deps = explainEffectMatch[1];
    assert.match(
      deps,
      /activeSheetId/,
      `WI4 listener effect deps must include activeSheetId, got: ${deps}`,
    );
  });

  it("Wave WI4-client-sheetId-resolution marker present at the listener body", () => {
    // Greppable lineage for future-Claude. The wave marker sits inline
    // on the setExplainSliceEvent call so the rationale stays adjacent
    // to the code it explains.
    assert.match(
      dashSrc,
      /Wave WI4-client-sheetId-resolution · inject activeSheetId/,
    );
  });
});

// ── Negative pin: no unconditional setExplainSliceEvent(detail) ─────

describe("WI4-client-sheetId-resolution · negative pins", () => {
  it("source does NOT call setExplainSliceEvent(detail) unconditionally (pre-wave shape removed)", () => {
    // Defense against a future refactor that accidentally reverts the
    // conditional spread back to the pre-wave plain `detail`. If this
    // negative pin starts failing, someone has dropped the sheetId
    // injection — the user-facing collision would silently return.
    assert.doesNotMatch(dashSrc, /setExplainSliceEvent\(detail\);/);
  });
});

// ── Panel resolver · scoped lookup on explainSliceEvent.sheetId ─────

describe("WI4-client-sheetId-resolution · panel resolver scopes on event.sheetId", () => {
  it("branches on `explainSliceEvent.sheetId` for the scoped lookup", () => {
    // The IIFE that resolves the chart from the event reads
    // `explainSliceEvent.sheetId` and, when present, looks up the
    // named sheet from `sheets`. Pin the branch keyword + the field
    // access so a refactor that drops one or the other surfaces.
    assert.match(
      dashSrc,
      /if \(explainSliceEvent\.sheetId\) \{\s*const targetSheet = sheets\.find\(\s*\(s\) => s\.id === explainSliceEvent\.sheetId,?\s*\);/,
    );
  });

  it("indexes the scoped sheet via `targetSheet?.charts[idx] ?? null` (returns null on stale sheetId)", () => {
    // The optional-chain on `targetSheet?` is load-bearing: a stale
    // sheetId (sheet deleted between brush and panel render) makes
    // `find` return undefined and the optional-chain short-circuits to
    // null — predictable-failure rather than silent fallback to
    // activeSheet.
    assert.match(
      dashSrc,
      /return targetSheet\?\.charts\[idx\] \?\? null;/,
    );
  });

  it("preserves the legacy `activeSheet.charts[idx] ?? null` fallback when sheetId is absent (backwards compat)", () => {
    // Negative-pin for the always-scoped failure mode: even after the
    // wave, the legacy branch MUST still appear in source so panel
    // mounts that pre-date this wave (or the degenerate no-sheets-yet
    // mount) still resolve correctly. wi4Wire.test.ts also pins this
    // same substring; the two checks are intentionally redundant
    // because the cost of a silent regression here is high.
    assert.match(dashSrc, /activeSheet\.charts\[idx\] \?\? null;/);
  });

  it("the panel resolver's outer guard is `!explainSliceEvent` only (NOT `!explainSliceEvent || !activeSheet`)", () => {
    // The pre-wave guard short-circuited on `!activeSheet`, which
    // meant the resolver bailed before checking event.sheetId. After
    // the wave, the outer guard must let an event with a valid sheetId
    // through even if activeSheet is null/undefined (degenerate
    // mid-mount state). The activeSheet null-check moves into the
    // fallback branch.
    assert.match(
      dashSrc,
      /if \(!explainSliceEvent\) return null;\s*const m = \/\^chart-\(\\d\+\)\$\/\.exec\(explainSliceEvent\.chartId\);/,
    );
  });

  it("Wave WI4-client-sheetId-resolution marker present at the resolver", () => {
    // Greppable lineage — the wave marker sits inline on the resolver
    // so the rationale stays adjacent.
    assert.match(
      dashSrc,
      /Wave WI4-client-sheetId-resolution · when the brush/,
    );
  });
});
