/**
 * Wave WI6 · behavioural tests for the per-tile insight history store.
 *
 * Mirrors `tileRecommendations.test.ts` and `explainSlice.test.ts` —
 * real import + runtime assertions, NOT source-inspection (the store
 * is a pure data-plumbing module with no React / DOM dependency).
 *
 * Coverage:
 *   - MAX_HISTORY_PER_TILE constant pinned (renames break loudly).
 *   - Empty store: `get(unknownTile)` → `[]`.
 *   - Single record: length 1, expected shape.
 *   - Two distinct combos: length 2, newest first.
 *   - Same combo recorded twice: length 1, entry + recordedAt updated.
 *   - Three distinct combos: length 3, newest first.
 *   - Four distinct combos: length 3, oldest dropped.
 *   - Same combo re-recorded after newer combos: MRU bubble to top.
 *   - Empty filters vs non-empty filters: distinct slots.
 *   - Different tiles isolated.
 *   - `clear(tileId)`: scoped, leaves other tiles.
 *   - `clear()` (no arg): all tiles cleared.
 *   - Defensive copy on `get`: mutating returned array does not poison store.
 *   - Injectable `now` for deterministic timestamps.
 *   - Custom `maxPerTile` option respected.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ActiveChartFilters } from "../../../lib/chartFilters.js";
import type { InsightRegenEntry } from "./insightRegenCache.js";
import {
  MAX_HISTORY_PER_TILE,
  createInsightHistoryStore,
  type InsightHistoryEntry,
} from "./insightHistory.js";

const TILE_A = "chart-0";
const TILE_B = "chart-1";

const FILTERS_BASELINE: ActiveChartFilters = {};
const FILTERS_REGION_A: ActiveChartFilters = {
  region: { type: "categorical", values: ["A"] },
};
const FILTERS_REGION_B: ActiveChartFilters = {
  region: { type: "categorical", values: ["B"] },
};
const FILTERS_REGION_C: ActiveChartFilters = {
  region: { type: "categorical", values: ["C"] },
};
const FILTERS_REGION_D: ActiveChartFilters = {
  region: { type: "categorical", values: ["D"] },
};

function makeEntry(text: string, regeneratedAt?: string): InsightRegenEntry {
  return {
    text,
    regeneratedAt: regeneratedAt ?? "2026-05-20T10:00:00.000Z",
    confidenceTier: "medium",
  };
}

describe("WI6 · pinned constants", () => {
  it("MAX_HISTORY_PER_TILE = 3 (matches the brief's 'last 3 insights')", () => {
    assert.equal(MAX_HISTORY_PER_TILE, 3);
  });
});

describe("WI6 · empty store", () => {
  it("get() on an unknown tile returns []", () => {
    const store = createInsightHistoryStore();
    assert.deepEqual(store.get("chart-unknown"), []);
  });
});

describe("WI6 · record + shape", () => {
  it("single record: length 1; entry exposes filterHash + filters + entry + recordedAt", () => {
    let t = 1000;
    const store = createInsightHistoryStore({ now: () => t });
    store.record(TILE_A, FILTERS_REGION_A, makeEntry("insight A"));
    const list = store.get(TILE_A);
    assert.equal(list.length, 1);
    assert.equal(typeof list[0].filterHash, "string");
    assert.ok(list[0].filterHash.length > 0, "filterHash should be non-empty for non-empty filters");
    assert.deepEqual(list[0].filters, FILTERS_REGION_A);
    assert.equal(list[0].entry.text, "insight A");
    assert.equal(list[0].recordedAt, 1000);
  });

  it("empty filters: filterHash is the empty-string sentinel", () => {
    const store = createInsightHistoryStore();
    store.record(TILE_A, FILTERS_BASELINE, makeEntry("baseline insight"));
    const list = store.get(TILE_A);
    assert.equal(list.length, 1);
    assert.equal(list[0].filterHash, "");
  });
});

describe("WI6 · distinct combos newest-first", () => {
  it("two distinct combos → length 2, second-recorded at index 0", () => {
    let t = 1000;
    const store = createInsightHistoryStore({ now: () => t });
    store.record(TILE_A, FILTERS_REGION_A, makeEntry("A"));
    t = 2000;
    store.record(TILE_A, FILTERS_REGION_B, makeEntry("B"));
    const list = store.get(TILE_A);
    assert.equal(list.length, 2);
    assert.deepEqual(list[0].filters, FILTERS_REGION_B);
    assert.deepEqual(list[1].filters, FILTERS_REGION_A);
    assert.equal(list[0].recordedAt, 2000);
    assert.equal(list[1].recordedAt, 1000);
  });

  it("three distinct combos → length 3, fully ordered newest-first", () => {
    let t = 1000;
    const store = createInsightHistoryStore({ now: () => t });
    store.record(TILE_A, FILTERS_REGION_A, makeEntry("A"));
    t = 2000;
    store.record(TILE_A, FILTERS_REGION_B, makeEntry("B"));
    t = 3000;
    store.record(TILE_A, FILTERS_REGION_C, makeEntry("C"));
    const list = store.get(TILE_A);
    assert.equal(list.length, 3);
    assert.equal(list[0].entry.text, "C");
    assert.equal(list[1].entry.text, "B");
    assert.equal(list[2].entry.text, "A");
  });

  it("empty filters and non-empty filters occupy distinct slots", () => {
    const store = createInsightHistoryStore();
    store.record(TILE_A, FILTERS_BASELINE, makeEntry("baseline"));
    store.record(TILE_A, FILTERS_REGION_A, makeEntry("A"));
    const list = store.get(TILE_A);
    assert.equal(list.length, 2);
    assert.ok(
      list.some((e) => e.filterHash === "" && e.entry.text === "baseline"),
      "baseline slot present",
    );
    assert.ok(
      list.some((e) => e.filterHash !== "" && e.entry.text === "A"),
      "filtered slot present",
    );
  });
});

describe("WI6 · de-dup + MRU bubble", () => {
  it("same combo recorded twice → length 1, entry + recordedAt updated", () => {
    let t = 1000;
    const store = createInsightHistoryStore({ now: () => t });
    store.record(TILE_A, FILTERS_REGION_A, makeEntry("first"));
    t = 2000;
    store.record(TILE_A, FILTERS_REGION_A, makeEntry("second"));
    const list = store.get(TILE_A);
    assert.equal(list.length, 1);
    assert.equal(list[0].entry.text, "second");
    assert.equal(list[0].recordedAt, 2000);
  });

  it("same combo re-recorded after newer combos bubbles back to index 0 (MRU)", () => {
    let t = 1000;
    const store = createInsightHistoryStore({ now: () => t });
    store.record(TILE_A, FILTERS_REGION_A, makeEntry("A"));
    t = 2000;
    store.record(TILE_A, FILTERS_REGION_B, makeEntry("B"));
    t = 3000;
    store.record(TILE_A, FILTERS_REGION_C, makeEntry("C"));
    t = 4000;
    store.record(TILE_A, FILTERS_REGION_A, makeEntry("A-refreshed"));
    const list = store.get(TILE_A);
    assert.equal(list.length, 3, "no duplicate slot for combo A");
    assert.deepEqual(list[0].filters, FILTERS_REGION_A);
    assert.equal(list[0].entry.text, "A-refreshed");
    assert.equal(list[0].recordedAt, 4000);
    assert.deepEqual(list[1].filters, FILTERS_REGION_C);
    assert.deepEqual(list[2].filters, FILTERS_REGION_B);
  });

  it("filterHash stays stable across re-records of the same combo", () => {
    const store = createInsightHistoryStore();
    store.record(TILE_A, FILTERS_REGION_A, makeEntry("first"));
    const h1 = store.get(TILE_A)[0].filterHash;
    store.record(TILE_A, FILTERS_REGION_A, makeEntry("second"));
    const h2 = store.get(TILE_A)[0].filterHash;
    assert.equal(h1, h2);
  });
});

describe("WI6 · capacity cap", () => {
  it("four distinct combos → length 3, oldest dropped", () => {
    let t = 1000;
    const store = createInsightHistoryStore({ now: () => t });
    store.record(TILE_A, FILTERS_REGION_A, makeEntry("A"));
    t = 2000;
    store.record(TILE_A, FILTERS_REGION_B, makeEntry("B"));
    t = 3000;
    store.record(TILE_A, FILTERS_REGION_C, makeEntry("C"));
    t = 4000;
    store.record(TILE_A, FILTERS_REGION_D, makeEntry("D"));
    const list = store.get(TILE_A);
    assert.equal(list.length, 3);
    assert.equal(list[0].entry.text, "D");
    assert.equal(list[1].entry.text, "C");
    assert.equal(list[2].entry.text, "B");
    assert.ok(
      !list.some((e) => e.entry.text === "A"),
      "oldest combo A evicted",
    );
  });

  it("custom maxPerTile option respected", () => {
    const store = createInsightHistoryStore({ maxPerTile: 2 });
    store.record(TILE_A, FILTERS_REGION_A, makeEntry("A"));
    store.record(TILE_A, FILTERS_REGION_B, makeEntry("B"));
    store.record(TILE_A, FILTERS_REGION_C, makeEntry("C"));
    const list = store.get(TILE_A);
    assert.equal(list.length, 2);
    assert.equal(list[0].entry.text, "C");
    assert.equal(list[1].entry.text, "B");
  });
});

describe("WI6 · multi-tile isolation", () => {
  it("recording on TILE_A does not affect TILE_B.get()", () => {
    const store = createInsightHistoryStore();
    store.record(TILE_A, FILTERS_REGION_A, makeEntry("A on tile A"));
    store.record(TILE_A, FILTERS_REGION_B, makeEntry("B on tile A"));
    assert.equal(store.get(TILE_B).length, 0);
    store.record(TILE_B, FILTERS_REGION_C, makeEntry("C on tile B"));
    assert.equal(store.get(TILE_A).length, 2);
    assert.equal(store.get(TILE_B).length, 1);
    assert.equal(store.get(TILE_B)[0].entry.text, "C on tile B");
  });
});

describe("WI6 · clear semantics", () => {
  it("clear(tileId) drops one tile, leaves others", () => {
    const store = createInsightHistoryStore();
    store.record(TILE_A, FILTERS_REGION_A, makeEntry("A"));
    store.record(TILE_B, FILTERS_REGION_B, makeEntry("B"));
    store.clear(TILE_A);
    assert.deepEqual(store.get(TILE_A), []);
    assert.equal(store.get(TILE_B).length, 1);
  });

  it("clear() with no arg drops every tile", () => {
    const store = createInsightHistoryStore();
    store.record(TILE_A, FILTERS_REGION_A, makeEntry("A"));
    store.record(TILE_B, FILTERS_REGION_B, makeEntry("B"));
    store.clear();
    assert.deepEqual(store.get(TILE_A), []);
    assert.deepEqual(store.get(TILE_B), []);
  });

  it("clear(unknownTileId) is a no-op", () => {
    const store = createInsightHistoryStore();
    store.record(TILE_A, FILTERS_REGION_A, makeEntry("A"));
    store.clear("chart-unknown");
    assert.equal(store.get(TILE_A).length, 1);
  });
});

describe("WI6 · defensive copy on get", () => {
  it("mutating the returned array does not poison subsequent reads", () => {
    const store = createInsightHistoryStore();
    store.record(TILE_A, FILTERS_REGION_A, makeEntry("A"));
    store.record(TILE_A, FILTERS_REGION_B, makeEntry("B"));
    const list = store.get(TILE_A);
    list.length = 0;
    list.push({
      filterHash: "tampered",
      filters: {},
      entry: makeEntry("tampered"),
      recordedAt: 0,
    } satisfies InsightHistoryEntry);
    const fresh = store.get(TILE_A);
    assert.equal(fresh.length, 2);
    assert.equal(fresh[0].entry.text, "B");
    assert.equal(fresh[1].entry.text, "A");
    assert.ok(
      !fresh.some((e) => e.filterHash === "tampered"),
      "no tampered slot leaked into the store",
    );
  });
});

describe("WI6 · injectable now() for deterministic timestamps", () => {
  it("recordedAt sources from the injected clock, not Date.now", () => {
    const ticks = [10, 20, 30];
    let i = 0;
    const store = createInsightHistoryStore({ now: () => ticks[i++] });
    store.record(TILE_A, FILTERS_REGION_A, makeEntry("A"));
    store.record(TILE_A, FILTERS_REGION_B, makeEntry("B"));
    store.record(TILE_A, FILTERS_REGION_C, makeEntry("C"));
    const list = store.get(TILE_A);
    assert.equal(list[0].recordedAt, 30);
    assert.equal(list[1].recordedAt, 20);
    assert.equal(list[2].recordedAt, 10);
  });
});
