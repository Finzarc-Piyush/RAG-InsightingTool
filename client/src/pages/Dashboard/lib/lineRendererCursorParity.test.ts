/**
 * Wave WD2-line-cursor-parity · source-inspection tests pinning the
 * LineRenderer svg-level cursor's parity with AreaRenderer's WI4-
 * wiring-area shape.
 *
 * Pre-wave failure mode (now defended against): the LineRenderer svg
 * had `style={{ cursor: brushStart !== null ? "ew-resize" : "default" }}`
 * even though its onClick was gated on `dashboardTile` and dispatched
 * cross-filter / drill-through. Outside a brush, the cursor read
 * `default` — the user got no visual signal that clicking the line
 * surface would do anything, breaking the affordance parity with the
 * other WD2-wired renderers (Arc/Bar/Box/Funnel/Combo/Rect/Waterfall/
 * Area, all of which surface `cursor: pointer` when mounted inside a
 * dashboard tile). AreaRenderer was updated to the richer 3-branch
 * ternary `brushStart ? ew-resize : dashboardTile ? pointer : undefined`
 * in Wave WI4-wiring-area; LineRenderer was missed by that wave because
 * it pre-existed brush mechanics (its brush was added pre-WI4) and the
 * cursor was a pre-WD2 holdover that nobody touched when the WD2
 * onClick wiring landed.
 *
 * This wave brings LineRenderer to parity. The two pinned invariants:
 *
 *  1. LineRenderer's svg cursor uses the same 3-branch ternary as
 *     AreaRenderer (brush > dashboardTile > undefined), with `pointer`
 *     as the dashboardTile-true branch.
 *  2. AreaRenderer's parity-source pattern is still present (drift
 *     defense: if AreaRenderer ever changes its cursor shape, this
 *     test surfaces the drift before the two renderers re-diverge).
 *
 * Negative pin:
 *
 *  3. LineRenderer source does NOT contain the pre-wave hardcoded
 *     `cursor: "default"` shape — the pre-wave failure mode can't
 *     silently return via a refactor that reverts the ternary.
 *
 * Wave marker pinned for greppable lineage.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoFile = (rel: string) =>
  resolve(new URL(rel, import.meta.url).pathname);

const lineSrc = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/LineRenderer.tsx"),
  "utf-8",
);
const areaSrc = readFileSync(
  repoFile("../../../lib/charts/visxRenderers/AreaRenderer.tsx"),
  "utf-8",
);

// ── LineRenderer · 3-branch cursor ternary mirrors AreaRenderer ─────

describe("WD2-line-cursor-parity · LineRenderer svg cursor 3-branch ternary", () => {
  it("LineRenderer source contains the brush > dashboardTile > undefined ternary on style", () => {
    // Pin the full ternary shape. Whitespace-tolerant on indentation
    // so a prettier-formatting reflow doesn't false-fail this test.
    // The three branches in order: brushStart !== null → ew-resize,
    // dashboardTile → pointer, else undefined.
    assert.match(
      lineSrc,
      /style=\{\s*brushStart !== null\s*\?\s*\{ cursor: "ew-resize" \}\s*:\s*dashboardTile\s*\?\s*\{ cursor: "pointer" \}\s*:\s*undefined,?\s*\}/,
    );
  });

  it("LineRenderer source does NOT contain the pre-wave `cursor: \"default\"` shape (negative pin)", () => {
    // Defense against a future refactor that reverts the ternary back
    // to the pre-wave hardcoded `cursor: "default"` shape. If this
    // negative pin starts failing, someone has dropped the dashboardTile
    // pointer affordance and the WD2 click affordance parity is broken.
    assert.doesNotMatch(
      lineSrc,
      /cursor: brushStart !== null \? "ew-resize" : "default"/,
    );
  });

  it("Wave WD2-line-cursor-parity marker present at the cursor style", () => {
    // Greppable lineage for future-Claude. The wave marker sits inline
    // on the cursor style so the rationale stays adjacent to the code
    // it explains (matching the WI4-wiring-area comment shape on
    // AreaRenderer's mirror-source pattern).
    assert.match(
      lineSrc,
      /Wave WD2-line-cursor-parity · cursor reflects the active/,
    );
  });
});

// ── AreaRenderer · parity-source pattern still present ──────────────

describe("WD2-line-cursor-parity · AreaRenderer parity-source pattern preserved", () => {
  it("AreaRenderer source still contains the same 3-branch cursor ternary (drift defense)", () => {
    // The WI4-wiring-area wave introduced the 3-branch ternary on the
    // AreaRenderer svg style; LineRenderer mirrors it byte-for-byte
    // (modulo whitespace). If AreaRenderer's cursor ever changes shape,
    // this assertion surfaces the drift BEFORE LineRenderer
    // accidentally falls behind again. Treat any failure here as a
    // signal that the two renderers' cursor patterns need a re-sync
    // wave, not as a bug in this test.
    assert.match(
      areaSrc,
      /style=\{\s*brushStart !== null\s*\?\s*\{ cursor: "ew-resize" \}\s*:\s*dashboardTile\s*\?\s*\{ cursor: "pointer" \}\s*:\s*undefined,?\s*\}/,
    );
  });

  it("AreaRenderer still carries the WI4-wiring-area cursor comment (source-pattern marker)", () => {
    // The WI4-wiring-area comment on AreaRenderer's cursor style is the
    // grep anchor that lets future readers find the canonical source
    // for the pattern this wave mirrors. Pin the key phrase so a
    // refactor doesn't silently strip the marker (which would orphan
    // LineRenderer's parity reference).
    assert.match(
      areaSrc,
      /Wave WI4-wiring-area · cursor reflects the active brush/,
    );
  });
});
