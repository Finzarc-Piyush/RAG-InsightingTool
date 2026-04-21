import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { Layout } from 'react-grid-layout';

import {
  findOverlapsForTile,
  resolveDropBySwap,
  stablePlaceTiles,
} from './dashboardGridLogic.js';

const tile = (i: string, x: number, y: number, w = 6, h = 4): Layout => ({
  i,
  x,
  y,
  w,
  h,
});

describe('findOverlapsForTile', () => {
  it('returns no overlap when tiles are disjoint', () => {
    const layout = [tile('a', 0, 0), tile('b', 6, 0)];
    assert.deepEqual(findOverlapsForTile(layout, 'a'), { ambiguous: false });
  });

  it('detects a single full overlap ≥ 50%', () => {
    const layout = [tile('a', 0, 0, 6, 4), tile('b', 0, 0, 6, 4)];
    const result = findOverlapsForTile(layout, 'a');
    assert.equal(result.ambiguous, false);
    assert.equal(result.swapTargetId, 'b');
  });

  it('ignores overlaps under the threshold', () => {
    // Dragged 6x4, target shares only a 1x1 corner → 1/24 < 0.5.
    const layout = [tile('a', 0, 0, 6, 4), tile('b', 5, 3, 3, 3)];
    const result = findOverlapsForTile(layout, 'a');
    assert.equal(result.ambiguous, false);
    assert.equal(result.swapTargetId, undefined);
  });

  it('flags ambiguous overlap with multiple targets', () => {
    // Dragged 6x4 fully overlaps both b and c.
    const layout = [
      tile('a', 0, 0, 6, 4),
      tile('b', 0, 0, 3, 4),
      tile('c', 3, 0, 3, 4),
    ];
    const result = findOverlapsForTile(layout, 'a');
    assert.equal(result.ambiguous, true);
  });
});

describe('resolveDropBySwap', () => {
  it('accepts a clean drop onto empty space', () => {
    const before = [tile('a', 0, 0), tile('b', 6, 0)];
    const after = [tile('a', 0, 8), tile('b', 6, 0)];
    const result = resolveDropBySwap(before, after, 'a');
    assert.deepEqual(
      result.find((l) => l.i === 'a'),
      { i: 'a', x: 0, y: 8, w: 6, h: 4 }
    );
    assert.deepEqual(
      result.find((l) => l.i === 'b'),
      { i: 'b', x: 6, y: 0, w: 6, h: 4 }
    );
  });

  it('swaps the target into the dragged tile\'s previous slot', () => {
    // a at (0,0), b at (6,0). User drops a on top of b.
    const before = [tile('a', 0, 0), tile('b', 6, 0)];
    const after = [tile('a', 6, 0), tile('b', 6, 0)];
    const result = resolveDropBySwap(before, after, 'a');
    assert.deepEqual(
      result.find((l) => l.i === 'a'),
      { i: 'a', x: 6, y: 0, w: 6, h: 4 }
    );
    assert.deepEqual(
      result.find((l) => l.i === 'b'),
      { i: 'b', x: 0, y: 0, w: 6, h: 4 }
    );
  });

  it('cancels cascade pushes on non-dragged tiles', () => {
    // Library pushed b downward during drag; we should restore b.
    const before = [tile('a', 0, 0), tile('b', 0, 4), tile('c', 6, 0)];
    const after = [tile('a', 0, 8), tile('b', 0, 12), tile('c', 6, 0)];
    const result = resolveDropBySwap(before, after, 'a');
    assert.deepEqual(
      result.find((l) => l.i === 'a'),
      { i: 'a', x: 0, y: 8, w: 6, h: 4 }
    );
    assert.deepEqual(
      result.find((l) => l.i === 'b'),
      { i: 'b', x: 0, y: 4, w: 6, h: 4 }
    );
  });

  it('reverts the drag when the drop overlaps two tiles', () => {
    const before = [
      tile('a', 0, 0, 6, 4),
      tile('b', 0, 4, 3, 4),
      tile('c', 3, 4, 3, 4),
    ];
    const after = [
      tile('a', 0, 4, 6, 4),
      tile('b', 0, 4, 3, 4),
      tile('c', 3, 4, 3, 4),
    ];
    const result = resolveDropBySwap(before, after, 'a');
    assert.deepEqual(
      result.find((l) => l.i === 'a'),
      { i: 'a', x: 0, y: 0, w: 6, h: 4 }
    );
    assert.deepEqual(
      result.find((l) => l.i === 'b'),
      { i: 'b', x: 0, y: 4, w: 3, h: 4 }
    );
  });
});

describe('stablePlaceTiles', () => {
  const config = {
    a: { w: 6, h: 4, minW: 3, minH: 2 },
    b: { w: 6, h: 4, minW: 3, minH: 2 },
    c: { w: 6, h: 4, minW: 3, minH: 2 },
  };

  it('keeps existing positions when only the list order changes', () => {
    const prev = [tile('a', 0, 0), tile('b', 6, 0)];
    const out = stablePlaceTiles(['b', 'a'], config, 12, prev);
    assert.deepEqual(
      out.find((l) => l.i === 'a'),
      { i: 'a', x: 0, y: 0, w: 6, h: 4, minW: 3, minH: 2 }
    );
    assert.deepEqual(
      out.find((l) => l.i === 'b'),
      { i: 'b', x: 6, y: 0, w: 6, h: 4, minW: 3, minH: 2 }
    );
  });

  it('bottom-fills only for genuinely new tiles', () => {
    const prev = [tile('a', 0, 0), tile('b', 6, 0)];
    const out = stablePlaceTiles(['a', 'b', 'c'], config, 12, prev);
    const c = out.find((l) => l.i === 'c');
    assert.ok(c, 'c should be placed');
    assert.equal(c!.y, 4, 'c should land below the first row');
  });

  it('does not re-stack existing tiles when a tile is removed', () => {
    const prev = [tile('a', 0, 0), tile('b', 6, 0), tile('c', 0, 4)];
    const out = stablePlaceTiles(['a', 'c'], config, 12, prev);
    // c keeps y=4 — NO cascade back upward.
    assert.deepEqual(
      out.find((l) => l.i === 'c'),
      { i: 'c', x: 0, y: 4, w: 6, h: 4, minW: 3, minH: 2 }
    );
  });
});
