/**
 * Wave WI4-foundation · pure-function tests for the explain-this-slice
 * helper. Mirrors [`drillThrough.test.ts`](./drillThrough.test.ts) and
 * [`crossFilter.test.ts`](./crossFilter.test.ts) — actual import +
 * runtime assertions, not source-inspection (the helper has no React
 * dependency, so we can exercise it directly).
 *
 * Coverage:
 *   - EXPLAIN_SLICE_EVENT canonical name (so a rename breaks loudly).
 *   - BRUSH_MIN_PX value pin (parity with LineRenderer's inline `< 6`).
 *   - isBrushDrag: above / at / below threshold + null/undefined.
 *   - makeNumericRegion / makeTemporalRegion / makeCategoricalRegion:
 *     normalisation, zero-width rejection, NaN rejection.
 *   - filterRowsByBrushRegion: numeric / temporal / categorical
 *     predicates; null-row coercion; mutation-free contract.
 *   - dispatchExplainSlice returns false in a non-browser env.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  BRUSH_MIN_PX,
  EXPLAIN_SLICE_EVENT,
  dispatchExplainSlice,
  filterRowsByBrushRegion,
  isBrushDrag,
  makeBox2dRegion,
  makeCategoricalRegion,
  makeNumericRegion,
  makeTemporalRegion,
  type BrushRegion,
} from "./explainSlice.js";

describe("WI4-foundation · EXPLAIN_SLICE_EVENT constant", () => {
  it("is the canonical 'marico:explain-slice' string (rename breaks loudly)", () => {
    // The `marico:` prefix namespaces the event apart from anything a
    // chart library might dispatch on window — mirrors
    // `CROSS_FILTER_EVENT = "marico:cross-filter"` and
    // `DRILL_THROUGH_EVENT = "marico:drill-through"`.
    assert.equal(EXPLAIN_SLICE_EVENT, "marico:explain-slice");
  });
});

describe("WI4-foundation · BRUSH_MIN_PX threshold", () => {
  it("is 6 — matches LineRenderer's inline `Math.abs(hi - lo) < 6` click-vs-drag split", () => {
    // The 6-px constant is load-bearing: any WI4-wiring wave that
    // replaces a renderer's inline brush threshold MUST use this
    // helper so the click-vs-drag boundary stays uniform across the
    // 3 target renderers (Line / Area / Bar).
    assert.equal(BRUSH_MIN_PX, 6);
  });
});

describe("WI4-foundation · isBrushDrag — pixel-distance gate", () => {
  it("returns true when |end - start| >= BRUSH_MIN_PX (default 6)", () => {
    assert.equal(isBrushDrag(10, 16), true);
    assert.equal(isBrushDrag(16, 10), true); // direction-agnostic
    assert.equal(isBrushDrag(100, 200), true);
  });

  it("returns false when |end - start| < BRUSH_MIN_PX (treat as click)", () => {
    assert.equal(isBrushDrag(10, 15), false);
    assert.equal(isBrushDrag(10, 10), false); // zero-width
    assert.equal(isBrushDrag(10, 5), false);
  });

  it("honours a custom minPx threshold (caller-overrideable)", () => {
    // Future renderers with a denser mark may want a tighter
    // threshold; the helper supports it via the 3rd parameter.
    assert.equal(isBrushDrag(10, 13, 3), true);
    assert.equal(isBrushDrag(10, 12, 3), false);
  });

  it("returns false on null / undefined bounds (mid-reset defensive)", () => {
    // A renderer whose brush state is null between mouseUp and the
    // setState flush should not throw — the helper short-circuits to
    // false so the renderer falls through to the click path.
    assert.equal(isBrushDrag(null, 10), false);
    assert.equal(isBrushDrag(10, null), false);
    assert.equal(isBrushDrag(undefined, undefined), false);
    assert.equal(isBrushDrag(null, null), false);
  });
});

describe("WI4-foundation · makeNumericRegion", () => {
  it("normalises so start <= end regardless of input order", () => {
    const r = makeNumericRegion(50, 10);
    assert.deepEqual(r, { kind: "numeric", start: 10, end: 50 });
    const r2 = makeNumericRegion(10, 50);
    assert.deepEqual(r2, { kind: "numeric", start: 10, end: 50 });
  });

  it("returns null for a zero-width region (caller should fall back to click path)", () => {
    assert.equal(makeNumericRegion(10, 10), null);
  });

  it("returns null for non-finite inputs (NaN / Infinity)", () => {
    // A renderer whose brush math degenerates (e.g. zero-width axis)
    // should not dispatch a malformed region — defensive guard.
    assert.equal(makeNumericRegion(Number.NaN, 10), null);
    assert.equal(makeNumericRegion(10, Number.POSITIVE_INFINITY), null);
    assert.equal(makeNumericRegion(Number.NEGATIVE_INFINITY, 10), null);
  });
});

describe("WI4-foundation · makeTemporalRegion", () => {
  it("normalises so startMs <= endMs regardless of input order", () => {
    const r = makeTemporalRegion(2_000, 1_000);
    assert.deepEqual(r, { kind: "temporal", startMs: 1_000, endMs: 2_000 });
  });

  it("returns null for a zero-width region", () => {
    assert.equal(makeTemporalRegion(1_700_000_000_000, 1_700_000_000_000), null);
  });

  it("returns null for non-finite inputs", () => {
    assert.equal(makeTemporalRegion(Number.NaN, 1_000), null);
    assert.equal(makeTemporalRegion(1_000, Number.POSITIVE_INFINITY), null);
  });
});

describe("WI4-foundation · makeCategoricalRegion", () => {
  it("preserves the rendered order of x-axis labels", () => {
    // Renderers pass labels in their rendered (left-to-right) order
    // so downstream UI can show them naturally. Mutation-free copy.
    const r = makeCategoricalRegion(["A", "B", "C"]);
    assert.deepEqual(r, { kind: "categorical", values: ["A", "B", "C"] });
  });

  it("returns null for an empty list (no categories hit)", () => {
    // Empty brush → no slice → no dispatch. Symmetric with the
    // makeNumeric / makeTemporal zero-width guards.
    assert.equal(makeCategoricalRegion([]), null);
  });

  it("clones the input so subsequent mutation of the caller's array doesn't leak in", () => {
    const src = ["A", "B"];
    const r = makeCategoricalRegion(src) as Extract<
      BrushRegion,
      { kind: "categorical" }
    >;
    src.push("C");
    assert.deepEqual([...r.values], ["A", "B"]);
  });
});

describe("WI4-foundation-box2d · makeBox2dRegion", () => {
  it("normalises so xMin <= xMax AND yMin <= yMax regardless of input order", () => {
    // A mouseDown-at-(50,80) → mouseUp-at-(10,20) drag yields raw
    // coords (ax=50, bx=10, ay=80, by=20); the constructor sorts both
    // axes independently so the resulting bounds describe the same
    // rectangle regardless of drag direction.
    const r = makeBox2dRegion(50, 10, 80, 20, "price");
    assert.deepEqual(r, {
      kind: "box2d",
      xMin: 10,
      xMax: 50,
      yMin: 20,
      yMax: 80,
      yColumn: "price",
    });
  });

  it("returns null for a zero-width region (xMin === xMax)", () => {
    // A vertical-line brush (cursor moved only in y) is treated as a
    // click on the x-axis — degenerate to no slice. Symmetric with
    // makeNumericRegion's zero-width guard.
    assert.equal(makeBox2dRegion(10, 10, 0, 100, "y"), null);
  });

  it("returns null for a zero-height region (yMin === yMax)", () => {
    // A horizontal-line brush (cursor moved only in x) is the
    // symmetric degenerate — also no slice.
    assert.equal(makeBox2dRegion(0, 100, 50, 50, "y"), null);
  });

  it("returns null for non-finite inputs on any of the four bounds", () => {
    // PointRenderer's scale inversion can yield NaN for a brush that
    // starts outside the inner plot — defensive guard ensures no
    // malformed event ever dispatches.
    assert.equal(makeBox2dRegion(Number.NaN, 10, 0, 1, "y"), null);
    assert.equal(makeBox2dRegion(0, Number.NaN, 0, 1, "y"), null);
    assert.equal(makeBox2dRegion(0, 1, Number.NaN, 1, "y"), null);
    assert.equal(makeBox2dRegion(0, 1, 0, Number.NaN, "y"), null);
    assert.equal(makeBox2dRegion(Number.POSITIVE_INFINITY, 1, 0, 1, "y"), null);
    assert.equal(makeBox2dRegion(0, 1, 0, Number.NEGATIVE_INFINITY, "y"), null);
  });

  it("carries the y-column name on the region (NOT on the dispatch event)", () => {
    // Unlike numeric/temporal/categorical (where filter-time only
    // needs the x-column, passed via filterRowsByBrushRegion's third
    // arg), box2d filters on two columns. The y-column rides on the
    // region itself so the dispatch event's shape doesn't need to
    // widen — `column` stays the x-column.
    const r = makeBox2dRegion(0, 10, 0, 100, "revenue") as Extract<
      BrushRegion,
      { kind: "box2d" }
    >;
    assert.equal(r.yColumn, "revenue");
  });
});

describe("WI4-foundation-box2d · filterRowsByBrushRegion — box2d region", () => {
  it("keeps rows whose x AND y both fall inside [xMin,xMax] × [yMin,yMax]", () => {
    const rows = [
      { x: 5, y: 50 }, // x in [0,10] y in [0,100] → keep
      { x: 5, y: 150 }, // y out → drop
      { x: 50, y: 50 }, // x out → drop
      { x: 0, y: 0 }, // boundary → keep (inclusive)
      { x: 10, y: 100 }, // boundary → keep (inclusive)
    ];
    const out = filterRowsByBrushRegion(rows, "x", {
      kind: "box2d",
      xMin: 0,
      xMax: 10,
      yMin: 0,
      yMax: 100,
      yColumn: "y",
    });
    assert.deepEqual(out, [
      { x: 5, y: 50 },
      { x: 0, y: 0 },
      { x: 10, y: 100 },
    ]);
  });

  it("uses the region's yColumn (NOT the caller's `column` arg) for the y-axis", () => {
    // Pin the column-routing: the `column` arg is the x-axis only;
    // the y-axis column rides on the region. A future refactor that
    // tries to overload `column` for both axes would break this pin.
    const rows = [
      { revenue: 5, units: 50 },
      { revenue: 5, units: 200 },
      { revenue: 50, units: 50 },
    ];
    const out = filterRowsByBrushRegion(rows, "revenue", {
      kind: "box2d",
      xMin: 0,
      xMax: 10,
      yMin: 0,
      yMax: 100,
      yColumn: "units",
    });
    assert.deepEqual(out, [{ revenue: 5, units: 50 }]);
  });

  it("coerces string-typed numerics on BOTH axes (CSV/JSON-parsed rows match cleanly)", () => {
    // Symmetric with the numeric variant's same-shape coercion.
    // Real-world rows often arrive with stringified numerics from
    // backend serialisation; the box2d predicate matches them.
    const rows = [
      { x: "5", y: "50" },
      { x: "abc", y: "50" },
      { x: "5", y: "xyz" },
      { x: 7, y: 90 },
    ];
    const out = filterRowsByBrushRegion(rows, "x", {
      kind: "box2d",
      xMin: 0,
      xMax: 10,
      yMin: 0,
      yMax: 100,
      yColumn: "y",
    });
    assert.deepEqual(out, [
      { x: "5", y: "50" },
      { x: 7, y: 90 },
    ]);
  });

  it("drops rows whose x OR y column is missing / null / empty-string", () => {
    // The empty-string drop is symmetric with the numeric variant's
    // pre-coercion check — `Number("") === 0` would silently match a
    // [0, N] range without it.
    const rows = [
      { x: 5, y: 50 },
      { x: null, y: 50 },
      { x: 5, y: null },
      { x: undefined, y: 50 },
      { x: 5, y: undefined },
      { x: "", y: 50 },
      { x: 5, y: "" },
      { y: 50 }, // missing x entirely
      { x: 5 }, // missing y entirely
    ];
    const out = filterRowsByBrushRegion(rows, "x", {
      kind: "box2d",
      xMin: 0,
      xMax: 100,
      yMin: 0,
      yMax: 100,
      yColumn: "y",
    });
    assert.deepEqual(out, [{ x: 5, y: 50 }]);
  });

  it("returns an empty array when no row matches both bounds", () => {
    const rows = [
      { x: 5, y: 200 },
      { x: 50, y: 5 },
    ];
    const out = filterRowsByBrushRegion(rows, "x", {
      kind: "box2d",
      xMin: 0,
      xMax: 10,
      yMin: 0,
      yMax: 100,
      yColumn: "y",
    });
    assert.deepEqual(out, []);
  });
});

describe("WI4-foundation · filterRowsByBrushRegion — numeric region", () => {
  it("keeps rows whose column value is within [start, end] (inclusive)", () => {
    const rows = [
      { x: 1, y: "a" },
      { x: 5, y: "b" },
      { x: 10, y: "c" },
      { x: 15, y: "d" },
    ];
    const out = filterRowsByBrushRegion(rows, "x", {
      kind: "numeric",
      start: 5,
      end: 10,
    });
    assert.deepEqual(out, [
      { x: 5, y: "b" },
      { x: 10, y: "c" },
    ]);
  });

  it("coerces string-typed numerics (rows whose column is '5' match start=5)", () => {
    // Real-world rows often arrive with stringified numerics from
    // CSV / JSON parsing — the predicate should not silently drop
    // them.
    const rows = [{ x: "5" }, { x: "abc" }, { x: 7 }];
    const out = filterRowsByBrushRegion(rows, "x", {
      kind: "numeric",
      start: 4,
      end: 8,
    });
    assert.deepEqual(out, [{ x: "5" }, { x: 7 }]);
  });

  it("drops rows whose column is missing / null / NaN", () => {
    const rows = [
      { x: 5 },
      { x: null },
      { x: undefined },
      { x: "not a number" },
      { y: 5 }, // missing x entirely
    ];
    const out = filterRowsByBrushRegion(rows, "x", {
      kind: "numeric",
      start: 0,
      end: 100,
    });
    assert.deepEqual(out, [{ x: 5 }]);
  });
});

describe("WI4-foundation · filterRowsByBrushRegion — temporal region", () => {
  it("keeps rows whose column coerces (Date / ISO / ms) to [startMs, endMs]", () => {
    const startMs = Date.parse("2024-06-01");
    const endMs = Date.parse("2024-06-30");
    const rows = [
      { d: new Date("2024-05-15"), y: "before" },
      { d: "2024-06-15", y: "iso-mid" },
      { d: Date.parse("2024-06-20"), y: "ms-mid" },
      { d: new Date("2024-07-15"), y: "after" },
    ];
    const out = filterRowsByBrushRegion(rows, "d", {
      kind: "temporal",
      startMs,
      endMs,
    });
    assert.deepEqual(
      out.map((r) => r.y),
      ["iso-mid", "ms-mid"],
    );
  });

  it("drops rows whose date column is null / un-parseable", () => {
    const rows = [
      { d: "2024-06-15" },
      { d: null },
      { d: "not a date" },
      { d: undefined },
    ];
    const out = filterRowsByBrushRegion(rows, "d", {
      kind: "temporal",
      startMs: Date.parse("2024-01-01"),
      endMs: Date.parse("2024-12-31"),
    });
    assert.equal(out.length, 1);
  });
});

describe("WI4-foundation · filterRowsByBrushRegion — categorical region", () => {
  it("keeps rows whose column value (stringified) appears in values", () => {
    const rows = [
      { region: "North", y: 1 },
      { region: "South", y: 2 },
      { region: "East", y: 3 },
      { region: "West", y: 4 },
    ];
    const out = filterRowsByBrushRegion(rows, "region", {
      kind: "categorical",
      values: ["North", "East"],
    });
    assert.deepEqual(
      out.map((r) => r.region),
      ["North", "East"],
    );
  });

  it("coerces numbers / booleans to their String form for matching", () => {
    // Symmetric with crossFilter.toFilterValue's coercion: a brushed
    // x-axis category labelled "2024" should match rows whose
    // column value is the number 2024 if the renderer happens to
    // pass through a numeric label.
    const rows = [{ year: 2024 }, { year: 2025 }, { year: 2024 }];
    const out = filterRowsByBrushRegion(rows, "year", {
      kind: "categorical",
      values: ["2024"],
    });
    assert.equal(out.length, 2);
  });

  it("coerces null / undefined to the literal string 'null' (mirrors toFilterValue)", () => {
    // Pin the null-bucket symmetry. The cross-filter / drill-through
    // paths already store `"null"` as the canonical missing-value
    // key; the brush filter agrees.
    const rows = [{ region: "North" }, { region: null }, { region: undefined }];
    const out = filterRowsByBrushRegion(rows, "region", {
      kind: "categorical",
      values: ["null"],
    });
    assert.equal(out.length, 2);
  });

  it("returns an empty array when no row matches", () => {
    const rows = [{ region: "North" }, { region: "South" }];
    const out = filterRowsByBrushRegion(rows, "region", {
      kind: "categorical",
      values: ["East"],
    });
    assert.deepEqual(out, []);
  });
});

describe("WI4-foundation · filterRowsByBrushRegion — mutation-free contract", () => {
  it("returns a new array; never mutates the input rows", () => {
    const rows = [{ x: 1 }, { x: 5 }, { x: 10 }];
    const snapshot = rows.map((r) => ({ ...r }));
    const out = filterRowsByBrushRegion(rows, "x", {
      kind: "numeric",
      start: 2,
      end: 8,
    });
    // Input unchanged.
    assert.deepEqual(rows, snapshot);
    // Output is a fresh array (NOT the same reference as input).
    assert.notEqual(out, rows);
  });
});

describe("WI4-foundation · dispatchExplainSlice — SSR-safe behaviour", () => {
  it("returns false in a non-browser environment (no window — same SSR-safe contract as the WD2/WD3 dispatchers)", () => {
    // node:test runs without a DOM by default — `window` is
    // undefined. The helper short-circuits to false; renderers that
    // fire on the server (chart SSR, test harness) silently no-op
    // rather than throwing.
    assert.equal(typeof window, "undefined");
    const ok = dispatchExplainSlice({
      chartId: "chart-0",
      column: "month",
      region: { kind: "categorical", values: ["Jan", "Feb"] },
    });
    assert.equal(ok, false);
  });

  it("accepts the full event shape (sourceTileId + filters snapshot)", () => {
    // Pin the optional-field surface so future widenings stay
    // explicit. The `filters` snapshot lets the receiver narrow rows
    // by global + per-tile filters BEFORE applying the brush region.
    const ok = dispatchExplainSlice({
      chartId: "chart-0",
      column: "month",
      region: { kind: "temporal", startMs: 0, endMs: 1_000 },
      sourceTileId: "tile-2",
      filters: {
        category: { type: "categorical", values: ["A", "B"] },
      },
    });
    assert.equal(ok, false);
  });

  it("accepts all four BrushRegion variants on the event payload", () => {
    // Discriminated-union pin: any FURTHER widening (e.g. a 5th kind
    // for a polygon-lasso brush) MUST add a kind, not overload these
    // four. `box2d` was added in Wave WI4-foundation-box2d for
    // PointRenderer scatter brushes.
    const regions: BrushRegion[] = [
      { kind: "numeric", start: 0, end: 10 },
      { kind: "temporal", startMs: 0, endMs: 1_000 },
      { kind: "categorical", values: ["A"] },
      {
        kind: "box2d",
        xMin: 0,
        xMax: 10,
        yMin: 0,
        yMax: 100,
        yColumn: "y",
      },
    ];
    for (const region of regions) {
      const ok = dispatchExplainSlice({
        chartId: "c",
        column: "x",
        region,
      });
      assert.equal(ok, false);
    }
  });
});
