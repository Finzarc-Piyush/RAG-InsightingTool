/**
 * Behavioural tests for the client-side deterministic "Do" lane fallback.
 *
 * Mirrors the (replaced) `tileRecommendations.test.ts` style — actual import +
 * runtime assertions against a pure function with no React / DOM dependency.
 *
 * Coverage:
 *   - Empty rows → null (no Do).
 *   - <3 buckets → null.
 *   - Flat distribution (no gap) → null.
 *   - Non-categorical chart types (line / area / scatter) → null.
 *   - A clear leader vs laggard → a concrete Do naming BOTH, with bold markers.
 *   - Aggregator skips nullish / empty-string x and non-numeric y rows.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  deriveTileDoLane,
  type TileDoFallbackRow,
  type TileDoFallbackSpec,
} from "./tileDoFallback.js";

const BAR_SPEC: TileDoFallbackSpec = { type: "bar", x: "brand", y: "sales" };

describe("deriveTileDoLane · no-fire cases", () => {
  it("returns null for zero rows", () => {
    assert.equal(deriveTileDoLane(BAR_SPEC, []), null);
  });

  it("returns null for fewer than 3 buckets", () => {
    const rows: TileDoFallbackRow[] = [
      { brand: "A", sales: 100 },
      { brand: "B", sales: 10 },
    ];
    assert.equal(deriveTileDoLane(BAR_SPEC, rows), null);
  });

  it("returns null for a flat distribution (no leader/laggard gap)", () => {
    const rows: TileDoFallbackRow[] = [
      { brand: "A", sales: 50 },
      { brand: "B", sales: 50 },
      { brand: "C", sales: 50 },
    ];
    assert.equal(deriveTileDoLane(BAR_SPEC, rows), null);
  });

  it("returns null for non-categorical chart types", () => {
    const rows: TileDoFallbackRow[] = [
      { brand: "A", sales: 100 },
      { brand: "B", sales: 50 },
      { brand: "C", sales: 5 },
    ];
    for (const type of ["line", "area", "scatter", "heatmap"]) {
      assert.equal(deriveTileDoLane({ ...BAR_SPEC, type }, rows), null);
    }
  });
});

describe("deriveTileDoLane · fires with a concrete action", () => {
  const rows: TileDoFallbackRow[] = [
    { brand: "PCNO(R)", sales: 42.8 },
    { brand: "SAFF GOLD", sales: 15.8 },
    { brand: "NIHAR NHO", sales: 8.7 },
    { brand: "NHR_SRSOH", sales: 0.2 },
  ];

  it("names the leader and the laggard, both bolded", () => {
    const doLane = deriveTileDoLane(BAR_SPEC, rows);
    assert.ok(doLane, "expected a Do lane");
    assert.match(doLane!, /\*\*PCNO\(R\)\*\*/);
    assert.match(doLane!, /\*\*NHR_SRSOH\*\*/);
  });

  it("is a concrete action, not a vague 'monitor/investigate'", () => {
    const doLane = deriveTileDoLane(BAR_SPEC, rows)!;
    assert.doesNotMatch(doLane.toLowerCase(), /\b(monitor|investigate further)\b/);
  });

  it("aggregates duplicate x-buckets and ignores nullish x / non-numeric y", () => {
    const messy: TileDoFallbackRow[] = [
      { brand: "PCNO(R)", sales: 20 },
      { brand: "PCNO(R)", sales: 22.8 }, // same bucket → summed to 42.8
      { brand: "SAFF GOLD", sales: 15.8 },
      { brand: "NIHAR NHO", sales: 8.7 },
      { brand: "", sales: 999 }, // empty x → skipped
      { brand: "BAD", sales: "n/a" }, // non-numeric y → skipped
    ];
    const doLane = deriveTileDoLane(BAR_SPEC, messy);
    assert.ok(doLane, "expected a Do lane");
    assert.match(doLane!, /\*\*PCNO\(R\)\*\*/);
    assert.doesNotMatch(doLane!, /\*\*BAD\*\*/);
  });
});
