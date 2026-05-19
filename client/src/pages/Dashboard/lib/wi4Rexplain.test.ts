/**
 * Wave WI4-rexplain · source-inspection pins for the explicit
 * bypass-cache button on the ExplainSlicePanel.
 *
 * The panel auto-fires `regen.regenerate(specLite, narrowedRows)` once
 * per fresh event (WI4-wire), then serves from cache for re-opens of
 * the identical (chartId, filters, region) slice (WI4-cache-key).
 * The button shipped here gives the user a way to force a fresh
 * regeneration of the same slice by calling
 * `regen.regenerate(specLite, narrowedRows, { bypassCache: true })`
 * at the call site — the hook already supports the bypass option
 * since WI2-wire; this wave is purely the call-site surface.
 *
 * Shape mirrors the WI2 footer's "✦ Re-explain this view" button so
 * the two regen surfaces stay structurally parallel (same icons,
 * same disabled / loading state, same stopPropagation guard, same
 * variant=outline + size=sm + h-7 + text-[11px] sizing).
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

describe("WI4-rexplain · ExplainSlicePanel imports for the bypass-cache button", () => {
  it("imports Loader2 + Sparkles from lucide-react", () => {
    assert.match(
      panelSrc,
      /import \{ Loader2, Sparkles \} from "lucide-react";/,
    );
  });

  it("imports Button from the canonical UI module", () => {
    assert.match(
      panelSrc,
      /import \{ Button \} from "@\/components\/ui\/button";/,
    );
  });
});

describe("WI4-rexplain · button render shape", () => {
  it("button block is gated on regen.entry?.text && chart && specLite", () => {
    // Three-way gate: only appears once a regeneration has actually
    // landed (so the button never shows mid-loading or in the no-event
    // idle state), and only when the panel has a resolved chart + spec
    // (so the onClick can supply real args to regen.regenerate).
    assert.match(
      panelSrc,
      /\{regen\.entry\?\.text && chart && specLite \? \(/,
    );
  });

  it("button uses variant=outline + size=sm + h-7 + text-[11px] sizing (mirrors WI2 footer)", () => {
    assert.match(
      panelSrc,
      /<Button[\s\S]*?variant="outline"[\s\S]*?size="sm"[\s\S]*?className="h-7 px-2 text-\[11px\]"/,
    );
  });

  it("button carries aria-label=\"Re-explain this slice\" for a11y", () => {
    assert.match(panelSrc, /aria-label="Re-explain this slice"/);
  });

  it("button is disabled while regen.loading", () => {
    assert.match(panelSrc, /disabled=\{regen\.loading\}/);
  });

  it("button onClick stops propagation + calls regenerate with bypassCache: true", () => {
    assert.match(
      panelSrc,
      /onClick=\{\(e\) => \{\s*e\.stopPropagation\(\);\s*void regen\.regenerate\(specLite, narrowedRows, \{\s*bypassCache: true,?\s*\}\);\s*\}\}/,
    );
  });

  it("button label toggles between Sparkles (idle) and Loader2 spin (loading)", () => {
    // Sparkles in the idle branch; Loader2 with animate-spin in the
    // loading branch. The two-line label "Re-explain this slice" /
    // "Re-explaining…" mirrors the WI2 footer's pair.
    assert.match(panelSrc, /\{regen\.loading \? \(\s*<Loader2 className="mr-1 h-3 w-3 animate-spin"/);
    assert.match(panelSrc, /<Sparkles className="mr-1 h-3 w-3" aria-hidden="true" \/>/);
    assert.match(
      panelSrc,
      /\{regen\.loading \? "Re-explaining…" : "Re-explain this slice"\}/,
    );
  });

  it("Wave WI4-rexplain marker present in the panel comment block", () => {
    // The marker survives future refactors that move the block around;
    // grep for "WI4-rexplain" finds the design rationale in one place.
    assert.match(panelSrc, /Wave WI4-rexplain/);
  });
});

describe("WI4-rexplain · structural composition with the WI4-wire surface", () => {
  it("button is rendered inside the same `Regenerated insight` section as the prose (sibling, not parent)", () => {
    // The button is a sibling of the prose <div> — sits below it within
    // the same <section>, NOT inside the prose <div>. Pin via the
    // ordering of "Regenerated insight" → prose paragraph → button.
    const sectionStart = panelSrc.indexOf("Regenerated insight");
    const proseDiv = panelSrc.indexOf("regen.entry?.text ? (", sectionStart);
    const buttonGate = panelSrc.indexOf("regen.entry?.text && chart && specLite", sectionStart);
    assert.ok(sectionStart > 0, "Regenerated insight section header must be present");
    assert.ok(
      proseDiv > 0 && buttonGate > proseDiv,
      "button gate must appear AFTER the prose render — sibling below the prose <div>",
    );
  });

  it("does NOT widen the props interface — uses the in-scope regen / specLite / narrowedRows from the hook + memo", () => {
    // The WI2 footer passes a 4-key `regen` prop; the panel owns the
    // hook directly, so the button reads from the closure-local
    // `regen`, `specLite`, `narrowedRows`. ExplainSlicePanelProps must
    // NOT acquire a new prop for this wave (negative pin — a future
    // refactor that lifts regen control to the parent would surface
    // here).
    assert.doesNotMatch(panelSrc, /onRegenerate\?:/);
    assert.doesNotMatch(panelSrc, /bypassCache\?:/);
  });
});
