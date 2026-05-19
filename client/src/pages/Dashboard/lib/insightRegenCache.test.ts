import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ActiveChartFilters } from "../../../lib/chartFilters";
import type { BrushRegion } from "./explainSlice.js";
import {
  buildCacheKey,
  createInsightRegenCache,
  hashBrushRegion,
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

describe("WI4-cache-key · hashBrushRegion — byte stability", () => {
  it("returns the empty string when no region is supplied", () => {
    assert.equal(hashBrushRegion(undefined), "");
  });

  it("hashes numeric regions as n:start..end", () => {
    const r: BrushRegion = { kind: "numeric", start: 10, end: 50 };
    assert.equal(hashBrushRegion(r), "n:10..50");
  });

  it("hashes temporal regions as t:startMs..endMs", () => {
    const r: BrushRegion = {
      kind: "temporal",
      startMs: 1_700_000_000_000,
      endMs: 1_700_086_400_000,
    };
    assert.equal(
      hashBrushRegion(r),
      "t:1700000000000..1700086400000",
    );
  });

  it("hashes categorical regions as c:v1|v2|...", () => {
    const r: BrushRegion = {
      kind: "categorical",
      values: ["Mar", "Apr", "May"],
    };
    assert.equal(hashBrushRegion(r), "c:Mar|Apr|May");
  });

  it("preserves categorical value order — order is meaningful", () => {
    // Categorical regions come from the renderer's `xs.slice(i0, i1)`
    // band-scale slice, which is itself ordered. We deliberately do
    // NOT sort here — different orders represent different brush
    // dispatches in principle, though in practice the upstream
    // band-scale order is fixed so identical brushes yield identical
    // value arrays. The negative pin catches a future drift to
    // accidental sorting.
    const a: BrushRegion = { kind: "categorical", values: ["Mar", "Apr"] };
    const b: BrushRegion = { kind: "categorical", values: ["Apr", "Mar"] };
    assert.notEqual(hashBrushRegion(a), hashBrushRegion(b));
  });

  it("produces identical hashes for identical regions of each kind", () => {
    const n1: BrushRegion = { kind: "numeric", start: 0, end: 100 };
    const n2: BrushRegion = { kind: "numeric", start: 0, end: 100 };
    assert.equal(hashBrushRegion(n1), hashBrushRegion(n2));

    const t1: BrushRegion = { kind: "temporal", startMs: 1, endMs: 2 };
    const t2: BrushRegion = { kind: "temporal", startMs: 1, endMs: 2 };
    assert.equal(hashBrushRegion(t1), hashBrushRegion(t2));

    const c1: BrushRegion = { kind: "categorical", values: ["A", "B"] };
    const c2: BrushRegion = { kind: "categorical", values: ["A", "B"] };
    assert.equal(hashBrushRegion(c1), hashBrushRegion(c2));
  });

  it("differentiates the three kinds even at the same numeric bounds", () => {
    const n: BrushRegion = { kind: "numeric", start: 0, end: 1 };
    const t: BrushRegion = { kind: "temporal", startMs: 0, endMs: 1 };
    assert.notEqual(hashBrushRegion(n), hashBrushRegion(t));
  });

  it("differentiates numeric bounds — distinct ranges, distinct hashes", () => {
    const a: BrushRegion = { kind: "numeric", start: 0, end: 100 };
    const b: BrushRegion = { kind: "numeric", start: 0, end: 101 };
    assert.notEqual(hashBrushRegion(a), hashBrushRegion(b));
  });
});

describe("WI4-cache-key · buildCacheKey with regionHash — backwards compat", () => {
  it("omits the third segment entirely when regionHash is undefined (2-arg call shape)", () => {
    assert.equal(buildCacheKey("tile_a", "f"), "tile_a::f");
  });

  it("omits the third segment when regionHash is the empty string", () => {
    assert.equal(buildCacheKey("tile_a", "f", ""), "tile_a::f");
  });

  it("2-arg and 3-arg-empty calls produce byte-identical keys (WI2 footer compat)", () => {
    // The WI2 per-tile footer never passes a region — its cached
    // entries must remain reachable byte-for-byte after this widening.
    const filters: ActiveChartFilters = {
      region: { type: "categorical", values: ["North"] },
    };
    const fh = hashGlobalFilters(filters);
    assert.equal(
      buildCacheKey("tile_1", fh),
      buildCacheKey("tile_1", fh, ""),
    );
    assert.equal(
      buildCacheKey("tile_1", fh),
      buildCacheKey("tile_1", fh, hashBrushRegion(undefined)),
    );
  });

  it("appends the third segment when regionHash is non-empty", () => {
    assert.equal(
      buildCacheKey("tile_a", "f", "n:0..1"),
      "tile_a::f::n:0..1",
    );
  });
});

describe("WI4-cache-key · buildCacheKey collision avoidance — same tile, same filters, different regions", () => {
  it("two numeric brushes on the same tile+filters do NOT collide", () => {
    const cache = createInsightRegenCache();
    const tile = "tile_chart_42";
    const fh = hashGlobalFilters({});
    const k1 = buildCacheKey(
      tile,
      fh,
      hashBrushRegion({ kind: "numeric", start: 0, end: 50 }),
    );
    const k2 = buildCacheKey(
      tile,
      fh,
      hashBrushRegion({ kind: "numeric", start: 50, end: 100 }),
    );
    cache.set(k1, makeEntry("first-half insight"));
    cache.set(k2, makeEntry("second-half insight"));
    assert.notEqual(k1, k2);
    assert.equal(cache.get(k1)?.text, "first-half insight");
    assert.equal(cache.get(k2)?.text, "second-half insight");
  });

  it("two temporal brushes on the same tile+filters do NOT collide", () => {
    const tile = "tile_chart_42";
    const fh = hashGlobalFilters({});
    const k1 = buildCacheKey(
      tile,
      fh,
      hashBrushRegion({
        kind: "temporal",
        startMs: 1_700_000_000_000,
        endMs: 1_700_086_400_000,
      }),
    );
    const k2 = buildCacheKey(
      tile,
      fh,
      hashBrushRegion({
        kind: "temporal",
        startMs: 1_700_086_400_000,
        endMs: 1_700_172_800_000,
      }),
    );
    assert.notEqual(k1, k2);
  });

  it("two categorical brushes on the same tile+filters do NOT collide", () => {
    const tile = "tile_chart_42";
    const fh = hashGlobalFilters({});
    const k1 = buildCacheKey(
      tile,
      fh,
      hashBrushRegion({ kind: "categorical", values: ["Q1", "Q2"] }),
    );
    const k2 = buildCacheKey(
      tile,
      fh,
      hashBrushRegion({ kind: "categorical", values: ["Q3", "Q4"] }),
    );
    assert.notEqual(k1, k2);
  });

  it("a region-bearing brush does NOT collide with the no-region (footer) entry on the same tile+filters", () => {
    // Pre-WI4-cache-key this would collide: the footer's
    // `buildCacheKey(tile, fh)` and the panel's `buildCacheKey(tile, fh,
    // <regionHash>)` would have shared the same slot and the panel
    // would have served the footer's prose for every brush. After the
    // widening they live in distinct slots.
    const tile = "tile_chart_42";
    const fh = hashGlobalFilters({
      region: { type: "categorical", values: ["North"] },
    });
    const footerKey = buildCacheKey(tile, fh);
    const panelKey = buildCacheKey(
      tile,
      fh,
      hashBrushRegion({ kind: "numeric", start: 10, end: 20 }),
    );
    assert.notEqual(footerKey, panelKey);
  });

  it("identical brushes on the same tile+filters share a cache hit", () => {
    const cache = createInsightRegenCache();
    const tile = "tile_chart_42";
    const fh = hashGlobalFilters({});
    const region: BrushRegion = { kind: "numeric", start: 0, end: 50 };
    const k1 = buildCacheKey(tile, fh, hashBrushRegion(region));
    const k2 = buildCacheKey(tile, fh, hashBrushRegion({ ...region }));
    cache.set(k1, makeEntry("first-half insight"));
    assert.equal(k1, k2);
    assert.equal(cache.get(k2)?.text, "first-half insight");
  });
});
