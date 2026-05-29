/**
 * Wave W-GMK6 · tests for `placeLabelsNoOverlap` — the shared label-
 * placement helper used by every visx mark renderer (Bar, Line, Area,
 * Point). Verifies the no-overlap contract: data labels appear on by
 * default but drop silently when their bounding boxes collide.
 */
import { describe, it, expect } from "vitest";
import {
  placeLabelsNoOverlap,
  filterCollidingRects,
} from "./labelCollision";

// Shim node:test/assert API → vitest expect so the test body stays terse.
const assert = {
  equal: (a: unknown, b: unknown) => expect(a).toBe(b),
  ok: (cond: unknown, msg?: string) => expect(cond, msg).toBeTruthy(),
  deepEqual: (a: unknown, b: unknown) => expect(a).toEqual(b),
};

describe("placeLabelsNoOverlap", () => {
  it("returns empty when no candidates", () => {
    assert.deepEqual(placeLabelsNoOverlap([]), []);
  });

  it("keeps all labels when widely spaced", () => {
    const placed = placeLabelsNoOverlap([
      { cx: 10, cy: 100, text: "A" },
      { cx: 100, cy: 100, text: "B" },
      { cx: 200, cy: 100, text: "C" },
    ]);
    assert.equal(placed.length, 3);
  });

  it("drops labels that overlap horizontally", () => {
    const placed = placeLabelsNoOverlap([
      { cx: 50, cy: 100, text: "first label" },
      { cx: 55, cy: 100, text: "second label" },
    ]);
    assert.equal(placed.length, 1);
    assert.equal(placed[0]!.text, "first label");
  });

  it("priority desc determines who wins when overlapping", () => {
    const placed = placeLabelsNoOverlap([
      { cx: 50, cy: 100, text: "low", priority: 1 },
      { cx: 55, cy: 100, text: "high", priority: 10 },
    ]);
    assert.equal(placed.length, 1);
    assert.equal(placed[0]!.text, "high");
  });

  it("computed bounding box is centered above the anchor", () => {
    const placed = placeLabelsNoOverlap(
      [{ cx: 100, cy: 50, text: "X" }],
      { fontSize: 10 }
    );
    assert.equal(placed.length, 1);
    const { x, y, w, h, cx } = placed[0]!;
    // Box is horizontally centered: x + w/2 ≈ cx
    assert.ok(Math.abs(x + w / 2 - cx) < 1);
    // Box is above the anchor (y < cy with default offset).
    assert.ok(y + h <= 50);
  });

  it("drops labels that fall outside provided bounds", () => {
    const placed = placeLabelsNoOverlap(
      [
        { cx: 5, cy: 100, text: "longish-label-A" },
        { cx: 500, cy: 100, text: "B" },
      ],
      { bounds: { x: 0, y: 0, w: 200, h: 200 } }
    );
    // 'longish-label-A' extends past x=0 leftward → drop;
    // 'B' at cx=500 is past x=200 rightward → drop.
    assert.equal(placed.length, 0);
  });

  it("keeps labels that fit inside bounds", () => {
    const placed = placeLabelsNoOverlap(
      [{ cx: 100, cy: 100, text: "A" }],
      { bounds: { x: 0, y: 0, w: 200, h: 200 } }
    );
    assert.equal(placed.length, 1);
  });

  it("non-finite anchor coords are skipped silently", () => {
    const placed = placeLabelsNoOverlap([
      { cx: NaN, cy: 100, text: "A" },
      { cx: 100, cy: Infinity, text: "B" },
      { cx: 200, cy: 100, text: "C" },
    ]);
    assert.equal(placed.length, 1);
    assert.equal(placed[0]!.text, "C");
  });

  it("padding makes the overlap check stricter", () => {
    const widelySpaced = placeLabelsNoOverlap(
      [
        { cx: 0, cy: 100, text: "AB" },
        { cx: 20, cy: 100, text: "CD" },
      ],
      { fontSize: 10, padding: 0 }
    );
    const tightlySpaced = placeLabelsNoOverlap(
      [
        { cx: 0, cy: 100, text: "AB" },
        { cx: 20, cy: 100, text: "CD" },
      ],
      { fontSize: 10, padding: 30 }
    );
    assert.ok(widelySpaced.length >= tightlySpaced.length);
  });

  it("scales bounding box width with font size", () => {
    const small = placeLabelsNoOverlap(
      [{ cx: 100, cy: 100, text: "ABCDEF" }],
      { fontSize: 8 }
    );
    const big = placeLabelsNoOverlap(
      [{ cx: 100, cy: 100, text: "ABCDEF" }],
      { fontSize: 20 }
    );
    assert.ok(big[0]!.w > small[0]!.w);
    assert.ok(big[0]!.h > small[0]!.h);
  });

  it("dense series — keeps a thinned subset", () => {
    const cands = Array.from({ length: 20 }, (_, i) => ({
      cx: i * 8,
      cy: 100,
      text: `${i * 100}K`,
    }));
    const placed = placeLabelsNoOverlap(cands, { fontSize: 10 });
    // Every label is ~6px wide; with 8px spacing they overlap → only a
    // fraction survive. Exact count is rendering-arithmetic dependent;
    // we just verify the system thinned them.
    assert.ok(placed.length > 0);
    assert.ok(placed.length < cands.length);
  });

  it("placements preserve original cx, cy and text", () => {
    const placed = placeLabelsNoOverlap([
      { cx: 50, cy: 100, text: "hello" },
    ]);
    assert.equal(placed[0]!.cx, 50);
    assert.equal(placed[0]!.cy, 100);
    assert.equal(placed[0]!.text, "hello");
  });

  it("anchorOffsetY shifts label placement", () => {
    const above = placeLabelsNoOverlap(
      [{ cx: 100, cy: 50, text: "X" }],
      { anchorOffsetY: -20 }
    );
    const veryAbove = placeLabelsNoOverlap(
      [{ cx: 100, cy: 50, text: "X" }],
      { anchorOffsetY: -50 }
    );
    assert.ok(veryAbove[0]!.y < above[0]!.y);
  });
});

describe("filterCollidingRects", () => {
  it("keeps widely-spaced rects", () => {
    const kept = filterCollidingRects([
      { x: 0, y: 0, w: 10, h: 10, payload: "A" },
      { x: 100, y: 0, w: 10, h: 10, payload: "B" },
    ]);
    assert.equal(kept.length, 2);
  });

  it("drops overlapping rects (keeps higher-priority)", () => {
    const kept = filterCollidingRects([
      { x: 0, y: 0, w: 20, h: 10, payload: "low", priority: 1 },
      { x: 5, y: 0, w: 20, h: 10, payload: "high", priority: 10 },
    ]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.payload, "high");
  });

  it("respects bounds", () => {
    const kept = filterCollidingRects(
      [
        { x: -5, y: 0, w: 20, h: 10, payload: "outside" },
        { x: 50, y: 50, w: 20, h: 10, payload: "inside" },
      ],
      { bounds: { x: 0, y: 0, w: 200, h: 200 } }
    );
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.payload, "inside");
  });

  it("non-finite rect coords are skipped", () => {
    const kept = filterCollidingRects([
      { x: NaN, y: 0, w: 10, h: 10, payload: "bad" },
      { x: 100, y: 0, w: 10, h: 10, payload: "good" },
    ]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.payload, "good");
  });
});
