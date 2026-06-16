/**
 * Behavioral coverage for the shared collision-safe composite-key helpers
 * (server/lib/compositeKey.ts). Pure module, zero deps — hermetic.
 *
 * Asserts the round-trip property compositeKey ↔ splitCompositeKey holds,
 * that the U+001F separator is used (so real field values can't collide),
 * and edge cases (single part, numeric coercion, empty strings).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  KEY_SEP,
  compositeKey,
  splitCompositeKey,
} from "../lib/compositeKey.js";

describe("compositeKey", () => {
  it("uses the ASCII Unit Separator (U+001F) as delimiter", () => {
    assert.equal(KEY_SEP, "\u001f");
    // The separator must not be a printable char that could appear in data.
    assert.equal(KEY_SEP.charCodeAt(0), 0x1f);
  });

  it("joins parts with the separator", () => {
    assert.equal(compositeKey("a", "b"), `a${KEY_SEP}b`);
    assert.equal(compositeKey("x", "y", "z"), `x${KEY_SEP}y${KEY_SEP}z`);
  });

  it("coerces numeric parts to strings", () => {
    assert.equal(compositeKey("region", 2024), `region${KEY_SEP}2024`);
    assert.equal(compositeKey(1, 2, 3), `1${KEY_SEP}2${KEY_SEP}3`);
  });

  it("round-trips: splitCompositeKey is the exact inverse of compositeKey", () => {
    const parts = ["North America", "Q3", "Haircare"];
    const key = compositeKey(...parts);
    assert.deepEqual(splitCompositeKey(key), parts);
  });

  it("round-trips a single part", () => {
    const key = compositeKey("solo");
    assert.deepEqual(splitCompositeKey(key), ["solo"]);
  });

  it("does NOT collide when a field value contains the visible separators others might pick", () => {
    // A field literally containing a comma/dash/space must not break decomposition,
    // because the real delimiter is the non-printable U+001F.
    const key = compositeKey("Brand-A, West", "2024");
    assert.deepEqual(splitCompositeKey(key), ["Brand-A, West", "2024"]);
  });

  it("preserves empty-string parts on the round-trip", () => {
    const key = compositeKey("", "b", "");
    assert.deepEqual(splitCompositeKey(key), ["", "b", ""]);
  });
});
