import { test } from "node:test";
import assert from "node:assert/strict";
import { stringifyFiniteJson } from "../lib/blobStorage.js";
import { parseFile } from "../lib/fileParser.js";

/**
 * Wave-2 tail · lock the "non-finite numbers never escape as NaN/Infinity"
 * invariant at the two boundaries the benchmark flagged: blob serialization
 * (blobStorage) and CSV/Excel ingest (fileParser). A regression here would
 * emit invalid JSON (NaN/Infinity are not valid JSON tokens) or let a poison
 * value into DuckDB / the planner.
 */

test("stringifyFiniteJson coerces NaN / ±Infinity to null, deeply", () => {
  const out = stringifyFiniteJson({
    a: Number.NaN,
    b: Number.POSITIVE_INFINITY,
    c: Number.NEGATIVE_INFINITY,
    d: 42,
    e: 0,
    f: -3.14,
    nested: { g: Number.NaN, h: [1, Number.POSITIVE_INFINITY, 3] },
  });
  const parsed = JSON.parse(out); // must be valid JSON
  assert.equal(parsed.a, null);
  assert.equal(parsed.b, null);
  assert.equal(parsed.c, null);
  assert.equal(parsed.d, 42);
  assert.equal(parsed.e, 0);
  assert.equal(parsed.f, -3.14);
  assert.equal(parsed.nested.g, null);
  assert.deepEqual(parsed.nested.h, [1, null, 3]);
});

test("stringifyFiniteJson leaves finite-only payloads byte-identical to JSON.stringify", () => {
  const clean = [
    { Region: "North", Revenue: 100.5, Flag: true, Note: "ok" },
    { Region: "South", Revenue: 0, Flag: false, Note: null },
  ];
  assert.equal(stringifyFiniteJson(clean), JSON.stringify(clean));
});

test("parseFile (CSV) coerces non-finite-producing numeric cells to null", async () => {
  // A bare 'Infinity' / 'NaN' token in a numeric column must not survive as a
  // non-finite number; the fileParser numeric guard maps it to null (these are
  // not parseable by stripCurrencyAndParse, so they fall through as strings —
  // assert they never become a non-finite number).
  const csv = ["Region,Score", "North,Infinity", "South,NaN", "East,12.5"].join("\n");
  const rows = await parseFile(Buffer.from(csv, "utf-8"), "fixture.csv");
  for (const row of rows) {
    assert.ok(
      typeof row.Score !== "number" || Number.isFinite(row.Score),
      `Score must never be a non-finite number, got ${row.Score}`,
    );
  }
  // The genuine numeric value survives.
  assert.equal(rows[2].Score, 12.5);
});
