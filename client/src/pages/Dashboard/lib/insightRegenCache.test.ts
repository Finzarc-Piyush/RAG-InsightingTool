import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ActiveChartFilters } from "../../../lib/chartFilters";
import {
  buildCacheKey,
  createInsightRegenCache,
  hashGlobalFilters,
  type InsightRegenEntry,
} from "./insightRegenCache.js";

function makeEntry(text: string): InsightRegenEntry {
  return { text, regeneratedAt: "2026-05-18T12:00:00Z" };
}

describe("WI2-cache · hashGlobalFilters — byte stability", () => {
  it("returns the empty string for an empty filter map", () => {
    assert.equal(hashGlobalFilters({}), "");
  });

  it("produces identical hashes for identical maps", () => {
    const a: ActiveChartFilters = {
      region: { type: "categorical", values: ["North", "South"] },
    };
    const b: ActiveChartFilters = {
      region: { type: "categorical", values: ["North", "South"] },
    };
    assert.equal(hashGlobalFilters(a), hashGlobalFilters(b));
  });

  it("ignores column key order — different insertion order, same hash", () => {
    const a: ActiveChartFilters = {
      zone: { type: "categorical", values: ["A"] },
      brand: { type: "categorical", values: ["X"] },
    };
    const b: ActiveChartFilters = {
      brand: { type: "categorical", values: ["X"] },
      zone: { type: "categorical", values: ["A"] },
    };
    assert.equal(hashGlobalFilters(a), hashGlobalFilters(b));
  });

  it("ignores categorical value order — different value order, same hash", () => {
    const a: ActiveChartFilters = {
      region: { type: "categorical", values: ["South", "North"] },
    };
    const b: ActiveChartFilters = {
      region: { type: "categorical", values: ["North", "South"] },
    };
    assert.equal(hashGlobalFilters(a), hashGlobalFilters(b));
  });

  it("hashes date filters by start..end", () => {
    const g: ActiveChartFilters = {
      date: { type: "date", start: "2024-01-01", end: "2024-12-31" },
    };
    assert.equal(hashGlobalFilters(g), "date=d:2024-01-01..2024-12-31");
  });

  it("hashes numeric filters by min..max", () => {
    const g: ActiveChartFilters = {
      value: { type: "numeric", min: 0, max: 100 },
    };
    assert.equal(hashGlobalFilters(g), "value=n:0..100");
  });

  it("differentiates categorical vs date vs numeric on the same column name", () => {
    const cat = hashGlobalFilters({
      x: { type: "categorical", values: ["1"] },
    });
    const num = hashGlobalFilters({
      x: { type: "numeric", min: 1, max: 1 },
    });
    assert.notEqual(cat, num);
  });

  it("handles undefined min / max / start / end gracefully", () => {
    const g: ActiveChartFilters = {
      date: { type: "date" },
      val: { type: "numeric", min: 0 },
    };
    const h = hashGlobalFilters(g);
    assert.match(h, /date=d:\.\./);
    assert.match(h, /val=n:0\.\./);
  });
});

describe("WI2-cache · buildCacheKey", () => {
  it("composes tileId :: filterHash with the canonical delimiter", () => {
    assert.equal(buildCacheKey("tile_a", "region=c:North"), "tile_a::region=c:North");
  });

  it("emits a stable empty-filter key when filterHash is empty", () => {
    assert.equal(buildCacheKey("tile_a", ""), "tile_a::");
  });
});

describe("WI2-cache · createInsightRegenCache — basic get/set", () => {
  it("returns undefined for an unknown key", () => {
    const cache = createInsightRegenCache();
    assert.equal(cache.get("missing"), undefined);
    assert.equal(cache.has("missing"), false);
  });

  it("stores and retrieves an entry", () => {
    const cache = createInsightRegenCache();
    cache.set("k1", makeEntry("hello"));
    assert.deepEqual(cache.get("k1")?.text, "hello");
    assert.equal(cache.has("k1"), true);
    assert.equal(cache.size(), 1);
  });

  it("overwrites an existing entry on re-set", () => {
    const cache = createInsightRegenCache();
    cache.set("k1", makeEntry("first"));
    cache.set("k1", makeEntry("second"));
    assert.equal(cache.get("k1")?.text, "second");
    assert.equal(cache.size(), 1);
  });

  it("clears all entries", () => {
    const cache = createInsightRegenCache();
    cache.set("k1", makeEntry("a"));
    cache.set("k2", makeEntry("b"));
    cache.clear();
    assert.equal(cache.size(), 0);
    assert.equal(cache.has("k1"), false);
  });
});

describe("WI2-cache · createInsightRegenCache — LRU eviction", () => {
  it("evicts the least-recently-used entry when full", () => {
    const cache = createInsightRegenCache({ maxEntries: 3 });
    cache.set("a", makeEntry("A"));
    cache.set("b", makeEntry("B"));
    cache.set("c", makeEntry("C"));
    cache.set("d", makeEntry("D")); // a should evict
    assert.equal(cache.has("a"), false);
    assert.equal(cache.has("b"), true);
    assert.equal(cache.has("c"), true);
    assert.equal(cache.has("d"), true);
    assert.equal(cache.size(), 3);
  });

  it("refreshes LRU recency on get — accessed entry survives later evictions", () => {
    const cache = createInsightRegenCache({ maxEntries: 3 });
    cache.set("a", makeEntry("A"));
    cache.set("b", makeEntry("B"));
    cache.set("c", makeEntry("C"));
    cache.get("a"); // a is now most-recent
    cache.set("d", makeEntry("D")); // b should evict (oldest now)
    assert.equal(cache.has("a"), true);
    assert.equal(cache.has("b"), false);
    assert.equal(cache.has("c"), true);
    assert.equal(cache.has("d"), true);
  });
});

describe("WI2-cache · createInsightRegenCache — TTL expiry", () => {
  it("returns undefined for entries past their TTL", () => {
    let t = 1_000_000;
    const cache = createInsightRegenCache({ ttlMs: 5000, now: () => t });
    cache.set("k1", makeEntry("fresh"));
    t += 1000;
    assert.equal(cache.get("k1")?.text, "fresh");
    t += 5001;
    assert.equal(cache.get("k1"), undefined);
    assert.equal(cache.has("k1"), false);
  });

  it("evictExpired drops only stale entries and reports the count", () => {
    let t = 1_000_000;
    const cache = createInsightRegenCache({ ttlMs: 1000, now: () => t });
    cache.set("a", makeEntry("A"));
    t += 1500;
    cache.set("b", makeEntry("B"));
    t += 200;
    const evicted = cache.evictExpired();
    assert.equal(evicted, 1);
    assert.equal(cache.has("a"), false);
    assert.equal(cache.has("b"), true);
    assert.equal(cache.size(), 1);
  });

  it("has() returns false for expired entries and deletes them lazily", () => {
    let t = 1_000_000;
    const cache = createInsightRegenCache({ ttlMs: 100, now: () => t });
    cache.set("k", makeEntry("x"));
    t += 200;
    assert.equal(cache.has("k"), false);
    assert.equal(cache.size(), 0);
  });
});

describe("WI2-cache · integration — tile + filter scenario", () => {
  it("two clients of the same tile with identical filters share a cache hit", () => {
    const cache = createInsightRegenCache();
    const filters: ActiveChartFilters = {
      region: { type: "categorical", values: ["North"] },
    };
    const key = buildCacheKey("tile_1", hashGlobalFilters(filters));
    cache.set(key, makeEntry("North insight"));
    const filtersSameOrderless: ActiveChartFilters = {
      region: { type: "categorical", values: ["North"] },
    };
    const key2 = buildCacheKey(
      "tile_1",
      hashGlobalFilters(filtersSameOrderless),
    );
    assert.equal(key, key2);
    assert.equal(cache.get(key2)?.text, "North insight");
  });

  it("changing one filter value invalidates the cache hit (different key)", () => {
    const cache = createInsightRegenCache();
    const before: ActiveChartFilters = {
      region: { type: "categorical", values: ["North"] },
    };
    const after: ActiveChartFilters = {
      region: { type: "categorical", values: ["South"] },
    };
    const k1 = buildCacheKey("tile_1", hashGlobalFilters(before));
    const k2 = buildCacheKey("tile_1", hashGlobalFilters(after));
    cache.set(k1, makeEntry("North insight"));
    assert.notEqual(k1, k2);
    assert.equal(cache.has(k2), false);
  });
});
