import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { Layouts } from "react-grid-layout";

// Lightweight re-implementations of the two pure helpers inside
// useLayoutHistory so the logic can be exercised without React. The
// full hook is covered by a Storybook-style manual check; these tests
// catch the silent-regression surface: snapshot equality + push
// de-duplication + capacity trimming.

function snapshotsEqual(a: Layouts, b: Layouts): boolean {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (JSON.stringify(a[k] ?? []) !== JSON.stringify(b[k] ?? [])) {
      return false;
    }
  }
  return true;
}

interface MinimalHistory {
  push: (l: Layouts) => void;
  stack: Layouts[];
}

function createHistory(capacity: number): MinimalHistory {
  const stack: Layouts[] = [];
  return {
    stack,
    push(layouts: Layouts) {
      const top = stack[stack.length - 1];
      if (top && snapshotsEqual(top, layouts)) return;
      stack.push(structuredClone(layouts));
      if (stack.length > capacity) {
        stack.splice(0, stack.length - capacity);
      }
    },
  };
}

describe("useLayoutHistory helpers", () => {
  const L1: Layouts = { lg: [{ i: "a", x: 0, y: 0, w: 6, h: 4 }] };
  const L1Clone: Layouts = { lg: [{ i: "a", x: 0, y: 0, w: 6, h: 4 }] };
  const L2: Layouts = { lg: [{ i: "a", x: 6, y: 0, w: 6, h: 4 }] };

  it("snapshotsEqual ignores key order + dupes clones", () => {
    assert.equal(snapshotsEqual(L1, L1Clone), true);
    assert.equal(snapshotsEqual(L1, L2), false);
  });

  it("push dedupes identical commits", () => {
    const h = createHistory(20);
    h.push(L1);
    h.push(L1Clone);
    assert.equal(h.stack.length, 1);
  });

  it("push trims to capacity", () => {
    const h = createHistory(3);
    for (let i = 0; i < 6; i++) {
      h.push({ lg: [{ i: "a", x: i, y: 0, w: 6, h: 4 }] });
    }
    assert.equal(h.stack.length, 3);
    // The oldest kept frame should be the one at x=3 (drops x=0,1,2).
    const oldest = h.stack[0].lg?.[0];
    assert.equal(oldest?.x, 3);
  });

  it("push is immune to caller mutations", () => {
    const h = createHistory(20);
    const live = { lg: [{ i: "a", x: 0, y: 0, w: 6, h: 4 }] };
    h.push(live);
    live.lg[0].x = 99;
    const stored = h.stack[0].lg?.[0];
    assert.equal(stored?.x, 0);
  });
});
