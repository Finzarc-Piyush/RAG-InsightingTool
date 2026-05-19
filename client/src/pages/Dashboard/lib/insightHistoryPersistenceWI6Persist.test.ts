/**
 * Wave WI6-persist · behavioural tests for the WI6 history store's
 * cross-session persistence layer (sessionStorage).
 *
 * Mirrors `insightHistory.test.ts` and `tileRecommendations.test.ts` —
 * real import + runtime assertions, NOT source-inspection. The
 * persistence adapter is fully injectable, so tests run under
 * `node --import tsx --test` with an in-memory fake.
 *
 * Coverage:
 *   - STORAGE_KEY_PREFIX constant pinned.
 *   - `storage: null` explicitly opts out (no adapter calls).
 *   - In-memory adapter round-trip: write on record, read on new store.
 *   - Hydrate ignores: empty storage, JSON parse error, version
 *     mismatch, missing `tiles`, malformed entries (per-entry filter
 *     keeps valid siblings).
 *   - `storageScope` distinguishes per-dashboard keys.
 *   - `clear(tileId)` and `clear()` write through (delete tile vs
 *     remove key).
 *   - Quota / serialisation failures swallowed — record and clear
 *     remain functional in-memory.
 *   - MRU + capacity invariants survive a write-read roundtrip.
 *   - Hydrated payloads support immediate `get` without a prior record.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ActiveChartFilters } from "../../../lib/chartFilters.js";
import type { InsightRegenEntry } from "./insightRegenCache.js";
import {
  STORAGE_KEY_PREFIX,
  createInsightHistoryStore,
  type InsightHistoryStorage,
} from "./insightHistory.js";

const TILE_A = "chart-0";
const TILE_B = "chart-1";

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

function makeEntry(text: string): InsightRegenEntry {
  return {
    text,
    regeneratedAt: "2026-05-20T10:00:00.000Z",
    confidenceTier: "medium",
  };
}

interface FakeStorage {
  adapter: InsightHistoryStorage;
  read: () => string | null;
  writes: string[];
  removeCount: () => number;
}

/** In-memory adapter mirroring the sessionStorage interface for tests. */
function makeFakeStorage(initial?: string): FakeStorage {
  let value: string | null = initial ?? null;
  const writes: string[] = [];
  let removes = 0;
  return {
    adapter: {
      read() {
        return value;
      },
      write(data) {
        value = data;
        writes.push(data);
      },
      remove() {
        value = null;
        removes += 1;
      },
    },
    read: () => value,
    writes,
    removeCount: () => removes,
  };
}

describe("WI6-persist · pinned constants", () => {
  it("STORAGE_KEY_PREFIX = 'marico-insight-history-v1' (v1 is load-bearing)", () => {
    assert.equal(STORAGE_KEY_PREFIX, "marico-insight-history-v1");
  });
});

describe("WI6-persist · explicit opt-out", () => {
  it("storage: null disables persistence — record does not touch any adapter", () => {
    const store = createInsightHistoryStore({ storage: null });
    // No adapter to assert on, but mustn't throw.
    store.record(TILE_A, FILTERS_REGION_A, makeEntry("A"));
    assert.equal(store.get(TILE_A).length, 1);
  });

  it("default storage in a non-window env (node) is null — record still works in-memory", () => {
    // Without an opts.storage, the factory tries window.sessionStorage;
    // in node `window` is undefined, so the default falls back to null.
    const store = createInsightHistoryStore();
    store.record(TILE_A, FILTERS_REGION_A, makeEntry("A"));
    assert.equal(store.get(TILE_A).length, 1);
  });
});

describe("WI6-persist · round-trip via in-memory adapter", () => {
  it("record writes through and a fresh store hydrates the same payload", () => {
    const fake = makeFakeStorage();
    const writer = createInsightHistoryStore({ storage: fake.adapter });
    writer.record(TILE_A, FILTERS_REGION_A, makeEntry("hello"));
    assert.ok(fake.writes.length >= 1, "record should trigger a write");

    const reader = createInsightHistoryStore({ storage: fake.adapter });
    const list = reader.get(TILE_A);
    assert.equal(list.length, 1);
    assert.equal(list[0].entry.text, "hello");
    assert.deepEqual(list[0].filters, FILTERS_REGION_A);
  });

  it("multi-tile state persists across mounts", () => {
    const fake = makeFakeStorage();
    const writer = createInsightHistoryStore({ storage: fake.adapter });
    writer.record(TILE_A, FILTERS_REGION_A, makeEntry("A"));
    writer.record(TILE_B, FILTERS_REGION_B, makeEntry("B"));

    const reader = createInsightHistoryStore({ storage: fake.adapter });
    assert.equal(reader.get(TILE_A).length, 1);
    assert.equal(reader.get(TILE_B).length, 1);
    assert.equal(reader.get(TILE_A)[0].entry.text, "A");
    assert.equal(reader.get(TILE_B)[0].entry.text, "B");
  });

  it("MRU bubble survives a write-read roundtrip", () => {
    const fake = makeFakeStorage();
    let t = 1000;
    const writer = createInsightHistoryStore({
      storage: fake.adapter,
      now: () => t,
    });
    writer.record(TILE_A, FILTERS_REGION_A, makeEntry("A"));
    t = 2000;
    writer.record(TILE_A, FILTERS_REGION_B, makeEntry("B"));
    t = 3000;
    writer.record(TILE_A, FILTERS_REGION_A, makeEntry("A-refresh"));

    const reader = createInsightHistoryStore({ storage: fake.adapter });
    const list = reader.get(TILE_A);
    assert.equal(list.length, 2);
    assert.equal(list[0].entry.text, "A-refresh");
    assert.deepEqual(list[0].filters, FILTERS_REGION_A);
    assert.equal(list[1].entry.text, "B");
  });

  it("capacity cap is respected by the persisted payload", () => {
    const fake = makeFakeStorage();
    const writer = createInsightHistoryStore({ storage: fake.adapter });
    writer.record(TILE_A, FILTERS_REGION_A, makeEntry("A"));
    writer.record(TILE_A, FILTERS_REGION_B, makeEntry("B"));
    writer.record(TILE_A, FILTERS_REGION_C, makeEntry("C"));
    writer.record(TILE_A, FILTERS_REGION_D, makeEntry("D"));

    const reader = createInsightHistoryStore({ storage: fake.adapter });
    const list = reader.get(TILE_A);
    assert.equal(list.length, 3);
    assert.equal(list[0].entry.text, "D");
    assert.equal(list[2].entry.text, "B");
    assert.ok(
      !list.some((e) => e.entry.text === "A"),
      "oldest entry was evicted before persistence",
    );
  });
});

describe("WI6-persist · defensive hydration", () => {
  it("empty storage hydrates to an empty store", () => {
    const fake = makeFakeStorage();
    const store = createInsightHistoryStore({ storage: fake.adapter });
    assert.deepEqual(store.get(TILE_A), []);
  });

  it("JSON parse error discards the payload", () => {
    const fake = makeFakeStorage("not valid json {{{");
    const store = createInsightHistoryStore({ storage: fake.adapter });
    assert.deepEqual(store.get(TILE_A), []);
  });

  it("version mismatch discards the payload", () => {
    const fake = makeFakeStorage(
      JSON.stringify({
        version: 999,
        tiles: {
          [TILE_A]: [
            {
              filterHash: "x",
              filters: FILTERS_REGION_A,
              entry: makeEntry("from the future"),
              recordedAt: 1,
            },
          ],
        },
      }),
    );
    const store = createInsightHistoryStore({ storage: fake.adapter });
    assert.deepEqual(store.get(TILE_A), []);
  });

  it("missing `tiles` field discards the payload", () => {
    const fake = makeFakeStorage(JSON.stringify({ version: 1 }));
    const store = createInsightHistoryStore({ storage: fake.adapter });
    assert.deepEqual(store.get(TILE_A), []);
  });

  it("malformed entry filters out per-entry, keeps valid siblings", () => {
    const fake = makeFakeStorage(
      JSON.stringify({
        version: 1,
        tiles: {
          [TILE_A]: [
            {
              filterHash: "good",
              filters: FILTERS_REGION_A,
              entry: makeEntry("good entry"),
              recordedAt: 1,
            },
            { filterHash: 42, filters: {}, entry: makeEntry("bad-hash"), recordedAt: 2 },
            { filterHash: "missing-entry", filters: FILTERS_REGION_B, recordedAt: 3 },
            "not even an object",
          ],
        },
      }),
    );
    const store = createInsightHistoryStore({ storage: fake.adapter });
    const list = store.get(TILE_A);
    assert.equal(list.length, 1);
    assert.equal(list[0].entry.text, "good entry");
  });

  it("non-array tile slot is dropped", () => {
    const fake = makeFakeStorage(
      JSON.stringify({
        version: 1,
        tiles: { [TILE_A]: "not an array" },
      }),
    );
    const store = createInsightHistoryStore({ storage: fake.adapter });
    assert.deepEqual(store.get(TILE_A), []);
  });

  it("hydrated entries are immediately readable without a prior record", () => {
    const seed = {
      version: 1,
      tiles: {
        [TILE_A]: [
          {
            filterHash: "hash-A",
            filters: FILTERS_REGION_A,
            entry: makeEntry("pre-existing"),
            recordedAt: 10,
          },
        ],
      },
    };
    const fake = makeFakeStorage(JSON.stringify(seed));
    const store = createInsightHistoryStore({ storage: fake.adapter });
    const list = store.get(TILE_A);
    assert.equal(list.length, 1);
    assert.equal(list[0].entry.text, "pre-existing");
    assert.equal(list[0].recordedAt, 10);
  });
});

describe("WI6-persist · storage scope isolation", () => {
  it("different scopes use isolated payloads even on a shared adapter map", () => {
    // Simulate sessionStorage by wrapping a single Map and exposing
    // per-key adapters — the way `defaultSessionStorageAdapter` would
    // see two distinct keys.
    const backing = new Map<string, string>();
    function adapterFor(key: string): InsightHistoryStorage {
      return {
        read: () => backing.get(key) ?? null,
        write: (data) => {
          backing.set(key, data);
        },
        remove: () => {
          backing.delete(key);
        },
      };
    }

    const storeAlpha = createInsightHistoryStore({
      storage: adapterFor(`${STORAGE_KEY_PREFIX}::dash-alpha`),
    });
    const storeBeta = createInsightHistoryStore({
      storage: adapterFor(`${STORAGE_KEY_PREFIX}::dash-beta`),
    });
    storeAlpha.record(TILE_A, FILTERS_REGION_A, makeEntry("alpha-A"));
    storeBeta.record(TILE_A, FILTERS_REGION_B, makeEntry("beta-B"));

    const reAlpha = createInsightHistoryStore({
      storage: adapterFor(`${STORAGE_KEY_PREFIX}::dash-alpha`),
    });
    const reBeta = createInsightHistoryStore({
      storage: adapterFor(`${STORAGE_KEY_PREFIX}::dash-beta`),
    });
    assert.equal(reAlpha.get(TILE_A)[0].entry.text, "alpha-A");
    assert.equal(reBeta.get(TILE_A)[0].entry.text, "beta-B");
  });
});

describe("WI6-persist · clear writes through", () => {
  it("clear(tileId) writes a payload missing that tile", () => {
    const fake = makeFakeStorage();
    const store = createInsightHistoryStore({ storage: fake.adapter });
    store.record(TILE_A, FILTERS_REGION_A, makeEntry("A"));
    store.record(TILE_B, FILTERS_REGION_B, makeEntry("B"));
    store.clear(TILE_A);

    const reader = createInsightHistoryStore({ storage: fake.adapter });
    assert.deepEqual(reader.get(TILE_A), []);
    assert.equal(reader.get(TILE_B).length, 1);
  });

  it("clear() with no arg removes the storage key entirely", () => {
    const fake = makeFakeStorage();
    const store = createInsightHistoryStore({ storage: fake.adapter });
    store.record(TILE_A, FILTERS_REGION_A, makeEntry("A"));
    store.clear();
    assert.equal(fake.read(), null);

    const reader = createInsightHistoryStore({ storage: fake.adapter });
    assert.deepEqual(reader.get(TILE_A), []);
  });
});

describe("WI6-persist · adapter failure tolerance", () => {
  it("quota-exceeded on write does not crash record", () => {
    const throwing: InsightHistoryStorage = {
      read: () => null,
      write: () => {
        throw new Error("QuotaExceededError");
      },
      remove: () => {},
    };
    const store = createInsightHistoryStore({ storage: throwing });
    assert.doesNotThrow(() => {
      store.record(TILE_A, FILTERS_REGION_A, makeEntry("A"));
    });
    // In-memory state still updates.
    assert.equal(store.get(TILE_A).length, 1);
  });

  it("throwing remove does not crash clear()", () => {
    const throwing: InsightHistoryStorage = {
      read: () => null,
      write: () => {},
      remove: () => {
        throw new Error("storage locked");
      },
    };
    const store = createInsightHistoryStore({ storage: throwing });
    store.record(TILE_A, FILTERS_REGION_A, makeEntry("A"));
    assert.doesNotThrow(() => {
      store.clear();
    });
    assert.deepEqual(store.get(TILE_A), []);
  });

  it("throwing read at construction yields an empty store (not a thrown error)", () => {
    const throwingRead: InsightHistoryStorage = {
      read: () => {
        throw new Error("read failed");
      },
      write: () => {},
      remove: () => {},
    };
    assert.doesNotThrow(() => {
      const store = createInsightHistoryStore({ storage: throwingRead });
      assert.deepEqual(store.get(TILE_A), []);
    });
  });
});
