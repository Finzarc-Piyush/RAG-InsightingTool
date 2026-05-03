import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  duckDateWrapperToJsDate,
  normalizeDuckValueExported,
} from "../lib/columnarStorage.js";

const MS_PER_DAY = 86400000;

describe("duckDateWrapperToJsDate", () => {
  it("returns null for plain empty object", () => {
    // Plain `{}` has no recognised shape; rejection is fine here. The
    // higher-level normalizeDuckValueExported re-routes empty wrappers to
    // dateFromObjectWrapper-style detection only when toString looks dateish.
    assert.equal(duckDateWrapperToJsDate({}), null);
  });

  it("parses DuckDB DATE-shaped wrappers via .days (number)", () => {
    const out = duckDateWrapperToJsDate({ days: 19723 });
    assert.ok(out instanceof Date);
    assert.equal(out!.getTime(), 19723 * MS_PER_DAY);
    assert.equal(out!.getUTCFullYear(), 2024);
  });

  it("parses DuckDB DATE-shaped wrappers via .days (bigint)", () => {
    const out = duckDateWrapperToJsDate({ days: 19723n });
    assert.ok(out instanceof Date);
    assert.equal(out!.getTime(), 19723 * MS_PER_DAY);
  });

  it("parses DuckDB TIMESTAMP-shaped wrappers via .micros (bigint)", () => {
    const ms = Date.UTC(2025, 5, 15);
    const out = duckDateWrapperToJsDate({ micros: BigInt(ms) * 1000n });
    assert.ok(out instanceof Date);
    assert.equal(out!.getTime(), ms);
  });

  it("parses wrappers exposing toISOString()", () => {
    const wrapper = {
      toISOString() {
        return "2024-09-01T00:00:00.000Z";
      },
    };
    const out = duckDateWrapperToJsDate(wrapper);
    assert.ok(out instanceof Date);
    assert.equal(out!.getUTCFullYear(), 2024);
    assert.equal(out!.getUTCMonth(), 8);
  });
});

describe("normalizeDuckValueExported", () => {
  it("passes primitives through unchanged", () => {
    assert.equal(normalizeDuckValueExported(null), null);
    assert.equal(normalizeDuckValueExported(undefined), undefined);
    assert.equal(normalizeDuckValueExported("hello"), "hello");
    assert.equal(normalizeDuckValueExported(42), 42);
    assert.equal(normalizeDuckValueExported(true), true);
  });

  it("converts safe bigints to numbers, large bigints to strings", () => {
    assert.equal(normalizeDuckValueExported(123n), 123);
    assert.equal(
      normalizeDuckValueExported(99999999999999999999n),
      "99999999999999999999"
    );
  });

  it("preserves JS Date instances", () => {
    const d = new Date("2024-01-01T00:00:00Z");
    const out = normalizeDuckValueExported(d);
    assert.ok(out instanceof Date);
    assert.equal((out as Date).getTime(), d.getTime());
  });

  it("converts row with empty-object date wrapper to a JS Date inside the row", () => {
    // The production bug: DuckDB returns DATE columns as opaque wrappers with
    // no enumerable properties. `JSON.stringify` of such a row used to render
    // as { "Ship Date": {} } — which `parseRowDate` could not parse, so
    // `add_computed_columns` produced null for every row.
    //
    // After the fix, an empty wrapper exposed via `toISOString()` is converted
    // to a JS Date when normalised. Plain `{}` (no toISOString) is allowed
    // through to the recursive object copy path — the guard above won't crash.
    const row = {
      "Ship Mode": "Standard Class",
      "Ship Date": {
        toISOString() {
          return "2017-11-11T00:00:00.000Z";
        },
      },
      "Order Date": { days: 19723 },
    };
    const out = normalizeDuckValueExported(row) as Record<string, unknown>;
    assert.equal(out["Ship Mode"], "Standard Class");
    assert.ok(out["Ship Date"] instanceof Date);
    assert.equal((out["Ship Date"] as Date).getUTCFullYear(), 2017);
    assert.ok(out["Order Date"] instanceof Date);
  });

  it("recurses into arrays and nested objects without breaking non-date payloads", () => {
    const row = {
      tags: ["a", "b"],
      meta: { type: "Furniture", count: 5n },
    };
    const out = normalizeDuckValueExported(row) as Record<string, unknown>;
    assert.deepEqual(out.tags, ["a", "b"]);
    assert.deepEqual(out.meta, { type: "Furniture", count: 5 });
  });

  it("does not over-eagerly convert arbitrary objects to dates", () => {
    const row = { settings: { theme: "dark", retries: 3 } };
    const out = normalizeDuckValueExported(row) as Record<string, unknown>;
    assert.deepEqual(out.settings, { theme: "dark", retries: 3 });
  });
});
