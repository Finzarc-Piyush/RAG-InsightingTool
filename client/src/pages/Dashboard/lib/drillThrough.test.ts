/**
 * Wave WD3-foundation · pure-function tests for the drill-through
 * helper. Mirrors [`crossFilter.test.ts`](./crossFilter.test.ts)'s
 * approach — actual import + runtime assertions, not source-inspection
 * (the helper has no React dependency, so we can exercise it directly).
 *
 * Coverage:
 *   - DRILL_THROUGH_EVENT canonical name (so a rename breaks loudly).
 *   - isModifierClick cross-platform behaviour: metaKey (⌘ on macOS),
 *     ctrlKey (Windows / Linux), both, neither, null / undefined event.
 *   - dispatchDrillThrough returns false in a non-browser environment
 *     (node:test runs without a DOM).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  DRILL_THROUGH_EVENT,
  dispatchDrillThrough,
  isModifierClick,
} from "./drillThrough.js";

describe("WD3-foundation · DRILL_THROUGH_EVENT constant", () => {
  it("is the canonical 'marico:drill-through' string (rename should break loudly)", () => {
    // The `marico:` prefix namespaces our custom events apart from
    // anything chart libraries (recharts / echarts) might dispatch on
    // window — mirrors `CROSS_FILTER_EVENT = "marico:cross-filter"`.
    assert.equal(DRILL_THROUGH_EVENT, "marico:drill-through");
  });
});

describe("WD3-foundation · isModifierClick — cross-platform modifier check", () => {
  it("returns true on metaKey held (macOS ⌘-click)", () => {
    assert.equal(isModifierClick({ metaKey: true }), true);
  });

  it("returns true on ctrlKey held (Windows / Linux ctrl-click)", () => {
    assert.equal(isModifierClick({ ctrlKey: true }), true);
  });

  it("returns true when BOTH flags fire (Safari occasionally synthesises both)", () => {
    // Defensive: some browsers report both metaKey + ctrlKey on
    // certain synthetic events. OR-truth is the contract.
    assert.equal(isModifierClick({ metaKey: true, ctrlKey: true }), true);
  });

  it("returns false on plain click (neither modifier held)", () => {
    assert.equal(isModifierClick({}), false);
    assert.equal(isModifierClick({ metaKey: false, ctrlKey: false }), false);
  });

  it("returns false on null / undefined event (defensive — no throw)", () => {
    // A renderer that loses its event in a test / SSR path falls
    // back to the safe cross-filter intent rather than dispatching
    // a malformed drill-through.
    assert.equal(isModifierClick(null), false);
    assert.equal(isModifierClick(undefined), false);
  });

  it("ignores unrelated event flags (shiftKey / altKey don't trip drill-through)", () => {
    // The drill-through contract is strictly cmd / ctrl. shift / alt
    // are reserved for other modifier intents (multi-select, etc.).
    // Pin against a future "any-modifier" widening.
    assert.equal(
      isModifierClick({
        // @ts-expect-error — exercise the runtime contract; the helper
        // signature deliberately accepts only metaKey + ctrlKey, but
        // a real DOM event carries shiftKey / altKey too. The body
        // must ignore them.
        shiftKey: true,
        altKey: true,
      }),
      false,
    );
  });
});

describe("WD3-foundation · dispatchDrillThrough — runtime behaviour", () => {
  it("returns false in a non-browser environment (no window — same SSR-safe contract as dispatchCrossFilter)", () => {
    // node:test runs without a DOM by default — `window` is undefined.
    // The helper short-circuits to false; renderers that fire on the
    // server (chart SSR, test harness) silently no-op rather than
    // throwing.
    assert.equal(typeof window, "undefined");
    const ok = dispatchDrillThrough({
      chartId: "chart-0",
      column: "region",
      value: "North",
    });
    assert.equal(ok, false);
  });

  it("returns false when CustomEvent is undefined (older runtime, defensive)", () => {
    // Belt-and-braces: even in an env that exposes `window` but lacks
    // `CustomEvent`, the helper short-circuits. (Currently same path
    // as the no-window branch since node:test lacks both — pin
    // against a future split.)
    const ok = dispatchDrillThrough({
      chartId: "chart-1",
      column: "category",
      value: 42,
      sourceTileId: "tile-0",
    });
    assert.equal(ok, false);
  });
});

describe("WD3-foundation · DrillThroughEvent — shape contract", () => {
  it("accepts a minimal event (chartId + column + value) without filters / sourceTileId", () => {
    // The required-vs-optional split is part of the contract. A
    // renderer with no enclosing dashboard tile (chat / explorer)
    // still passes typecheck — they just won't dispatch the event
    // anyway because the modifier branch is gated on the
    // `dashboardTile` context.
    const ok = dispatchDrillThrough({
      chartId: "chart-0",
      column: "region",
      value: null, // unknown widening — null / Date / number / string all valid
    });
    assert.equal(ok, false);
  });

  it("accepts the full event shape (filters snapshot + sourceTileId)", () => {
    // Pin the full optional-field surface so future widenings are
    // explicit. The `filters` snapshot carries the dashboard-wide
    // active filter context so the server can apply it before
    // pinning (column, value).
    const ok = dispatchDrillThrough({
      chartId: "chart-0",
      column: "region",
      value: "North",
      sourceTileId: "tile-2",
      filters: {
        date: { type: "date", start: "2024-01-01", end: "2024-12-31" },
        category: { type: "categorical", values: ["A", "B"] },
      },
    });
    assert.equal(ok, false);
  });
});
